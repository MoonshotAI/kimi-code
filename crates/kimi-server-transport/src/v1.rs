//! kap-server v1 wire contract projection — the browser-wire surface.
//!
//! `kimi-web` (and the VS Code webview) speak the kap-server v1 wire
//! contract: `{ items, has_more }`-shaped REST responses with full
//! `WireSession` records, and a WebSocket protocol of
//! `server_hello` / `client_hello` / `subscribe` / `ack` control frames plus
//! `event.*`-prefixed event envelopes. The Rust HTTP projection in `http.rs`
//! originally exposed the engine's JSON-RPC shape directly, which the browser
//! clients cannot consume. This module adapts that surface back to the v1
//! contract — shape mapping on the REST side, and a v1 WebSocket facade that
//! projects engine events (`session.turn.started`, `llm.delta`,
//! `session.turn.ended`, …) onto the `event.*` envelopes the frontend
//! understands.
//!
//! Reference (kept in sync with, never diverged from): the TS definitions in
//! `apps/kimi-web/src/api/daemon/{wire,ws,mappers,agentEventProjector}.ts` and
//! `packages/kap-server/src/transport/ws/v1/wsConnectionV1.ts`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message as AxumMessage, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};

/// All-zero session usage placeholder. The daemon ships placeholders for the
/// heavy session fields on the list/snapshot read paths; live values arrive
/// via `/status` and the WS stream.
fn zero_usage() -> Value {
    json!({
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_creation_tokens": 0,
        "total_cost_usd": 0,
        "context_tokens": 0,
        "context_limit": 0,
        "turn_count": 0,
    })
}

/// Assemble a v1 `WireSession` record from the engine `session/list`,
/// `session/get_status` and `session/get_context` envelopes.
///
/// Every field `toAppSession` (mappers.ts:89) reads is present; `metadata.cwd`
/// is mandatory or the mapper throws. `busy` is supplied by the caller (the
/// engine status has no busy flag; the transport infers it from active turns).
pub fn wire_session(list_entry: &Value, status: &Value, context: &Value, busy: bool) -> Value {
    let id = list_entry["id"].as_str().unwrap_or_default().to_string();
    let work_dir = list_entry["work_dir"].as_str().unwrap_or_default();
    let mut messages: Vec<Value> = context["data"]["history"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    // Strip any tool-result / system framing so the count reflects what the
    // sidebar shows (user + assistant turns).
    messages.retain(|m| {
        matches!(m["role"].as_str(), Some("user" | "assistant"))
    });
    let message_count = messages.len();
    let last_seq = messages.len();
    let model = status["data"]["model"].as_str().unwrap_or_default();

    json!({
        "id": id,
        "title": list_entry["title"].as_str().unwrap_or_default(),
        "created_at": list_entry["created_at"].as_str().unwrap_or_default(),
        "updated_at": list_entry["updated_at"].as_str().unwrap_or_default(),
        "busy": busy,
        "archived": false,
        "metadata": { "cwd": work_dir },
        "agent_config": { "model": model },
        "usage": zero_usage(),
        "permission_rules": [],
        "message_count": message_count,
        "last_seq": last_seq,
    })
}

/// Wrap one engine context message as a v1 `WireMessage` (snapshot path).
/// The engine context items carry `role` + `content` (ContentPart shape,
/// compatible with `WireMessageContent`); ids/timestamps are synthesized.
pub fn wire_message_from_context(m: &Value, session_id: &str, index: usize) -> Value {
    json!({
        "id": format!("msg_ctx_{index}"),
        "session_id": session_id,
        "role": m["role"],
        "content": m["content"],
        "created_at": iso_now(),
    })
}

/// `{ items, has_more }` page wrapper (v1 contract).
pub fn wire_page(items: Vec<Value>) -> Value {
    json!({ "items": items, "has_more": false })
}

/// v1 `WireSessionRuntimeStatus` — the `/sessions/{id}/status` projection.
pub fn wire_session_runtime_status(status: &Value) -> Value {
    let data = &status["data"];
    json!({
        "model": data["model"],
        "thinking_level": data["thinking_level"].as_str().unwrap_or("none"),
        "permission": data["permission"].as_str().unwrap_or("default"),
        "plan_mode": data["plan_mode"].as_bool().unwrap_or(false),
        "swarm_mode": data["swarm_mode"].as_bool().unwrap_or(false),
        "context_tokens": data["context_tokens"].as_u64().unwrap_or(0),
        "max_context_tokens": data["max_context_tokens"].as_u64().unwrap_or(0),
        "context_usage": data["context_usage"].as_f64().unwrap_or(0.0),
    })
}

/// Per-prompt streaming context shared between the async REST prompt submit
/// and the WS event projector for one session.
#[derive(Clone)]
pub struct TurnContext {
    pub prompt_id: String,
    pub user_message_id: String,
    pub assistant_msg_id: String,
    pub prompt_text: String,
    /// Accumulated assistant text for the current turn (deltas append here).
    pub buffer: String,
}

/// Shared per-session turn state (the REST prompt handler writes it, the WS
/// event projector reads/mutates it).
#[derive(Default)]
pub struct V1Shared {
    turns: Mutex<HashMap<String, TurnContext>>,
}

impl V1Shared {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Record a prompt submission so the event projector can tag the incoming
    /// engine turn with prompt/user/assistant message ids.
    pub fn begin_turn(&self, session_id: &str, ctx: TurnContext) {
        self.turns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session_id.to_string(), ctx);
    }

    /// True when a session has an in-flight turn (the transport's busy signal).
    pub fn is_busy(&self, session_id: &str) -> bool {
        self.turns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(session_id)
    }

    /// Access (mutably) the turn context for a session, if any.
    fn with_turn<R>(&self, session_id: &str, f: impl FnOnce(&mut TurnContext) -> R) -> Option<R> {
        let mut turns = self.turns.lock().unwrap_or_else(|e| e.into_inner());
        turns.get_mut(session_id).map(f)
    }

    /// Take (remove) the turn context for a session, if any.
    pub fn take_turn(&self, session_id: &str) -> Option<TurnContext> {
        self.turns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session_id)
    }
}

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Generate a unique id like the TS `ulid` call sites (`conn_`, `msg_`,
/// `prompt_`, …). No external dep — monotonic counter + wall clock is enough
/// for connection/turn-local uniqueness.
pub fn gen_id(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}{millis:x}{n:04x}")
}

/// Current UTC time as an ISO-8601 timestamp (`YYYY-MM-DDTHH:MM:SS.mmmZ`),
/// computed without a chrono dependency.
pub fn iso_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_millis())
        .unwrap_or(0);
    let days = secs / 86_400;
    let secs_of_day = secs % 86_400;
    // Howard Hinnant's civil-from-days (days is u64, so z is never negative).
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let h = secs_of_day / 3600;
    let mi = (secs_of_day % 3600) / 60;
    let s = secs_of_day % 60;
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

// ── Engine event → v1 event projection ───────────────────────────────────

/// Project one engine event into zero or more v1 `event.*` envelopes.
///
/// Returns `(session_id, type, payload)` triples; the WS facade assigns the
/// per-connection `seq` and `timestamp` at send time. The projection keeps a
/// v1-friendly message lifecycle: `message.created` (user) fires at
/// `turn.started` so `assistant.delta` frames always have a message to attach
/// to, and `message.updated` + `assistant.completed` close the turn.
fn project_event(shared: &V1Shared, ev: &Value) -> Vec<(String, String, Value)> {
    let Some(ty) = ev["type"].as_str() else {
        return Vec::new();
    };
    let Some(session_id) = ev["session_id"].as_str() else {
        return Vec::new();
    };
    let sid = session_id.to_string();
    match ty {
        "session.turn.started" => {
            // The REST prompt submit already registered a TurnContext; tag the
            // engine turn with the ids and open the user message + busy flag.
            let ctx = shared.with_turn(&sid, |c| c.clone());
            let Some(ctx) = ctx else {
                return Vec::new();
            };
            vec![
                (
                    sid.clone(),
                    "event.session.work_changed".into(),
                    json!({
                        "busy": true,
                        "main_turn_active": true,
                        "pending_interaction": "none",
                        "current_prompt_id": ctx.prompt_id,
                    }),
                ),
                (
                    sid.clone(),
                    "event.message.created".into(),
                    json!({
                        "message": {
                            "id": ctx.user_message_id,
                            "session_id": sid,
                            "role": "user",
                            "content": [{ "type": "text", "text": ctx.prompt_text }],
                            "created_at": iso_now(),
                            "prompt_id": ctx.prompt_id,
                            "parent_message_id": null,
                        }
                    }),
                ),
            ]
        }
        "llm.delta" => {
            let part = &ev["part"];
            let part_type = part["type"].as_str().unwrap_or("");
            let text = part["text"].as_str().unwrap_or_default().to_string();
            if text.is_empty() {
                return Vec::new();
            }
            let assistant_msg_id = shared.with_turn(&sid, |c| c.assistant_msg_id.clone());
            let Some(assistant_msg_id) = assistant_msg_id else {
                return Vec::new();
            };
            match part_type {
                "text" => {
                    shared.with_turn(&sid, |c| c.buffer.push_str(&text));
                    vec![(
                        sid,
                        "event.assistant.delta".into(),
                        json!({
                            "message_id": assistant_msg_id,
                            "content_index": 0,
                            "delta": { "text": text },
                        }),
                    )]
                }
                "thinking" => {
                    shared.with_turn(&sid, |c| c.buffer.push_str(&text));
                    vec![(
                        sid,
                        "event.assistant.delta".into(),
                        json!({
                            "message_id": assistant_msg_id,
                            "content_index": 0,
                            "delta": { "thinking": text },
                        }),
                    )]
                }
                _ => Vec::new(),
            }
        }
        "session.turn.ended" => {
            let stop_reason = ev["stop_reason"].as_str().unwrap_or("Completed");
            let finish_reason = match stop_reason {
                "Aborted" | "Cancelled" => "cancelled",
                "Failed" | "Error" => "error",
                _ => "stop",
            };
            let last_turn_reason = match finish_reason {
                "cancelled" => "cancelled",
                "error" => "failed",
                _ => "completed",
            };
            // Close-out events need the turn context; the busy reset does not,
            // so it is emitted unconditionally (a REST-only turn whose context
            // the async-submit task already cleared must still release busy).
            let mut out = Vec::new();
            if let Some(ctx) = shared.take_turn(&sid) {
                out.push((
                    sid.clone(),
                    "event.message.updated".into(),
                    json!({
                        "message_id": ctx.assistant_msg_id,
                        "content": [{ "type": "text", "text": ctx.buffer }],
                        "status": "completed",
                    }),
                ));
                out.push((
                    sid.clone(),
                    "event.assistant.completed".into(),
                    json!({
                        "message_id": ctx.assistant_msg_id,
                        "finish_reason": finish_reason,
                    }),
                ));
            }
            out.push((
                sid,
                "event.session.work_changed".into(),
                json!({
                    "busy": false,
                    "main_turn_active": false,
                    "pending_interaction": "none",
                    "last_turn_reason": last_turn_reason,
                }),
            ));
            out
        }
        _ => Vec::new(),
    }
}

// ── v1 WebSocket facade ──────────────────────────────────────────────────

/// Per-connection v1 protocol state.
struct V1Conn {
    ws_connection_id: String,
    seq: AtomicU64,
    subscriptions: Mutex<HashSet<String>>,
    got_client_hello: AtomicBool,
}

impl V1Conn {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            ws_connection_id: gen_id("conn_"),
            seq: AtomicU64::new(0),
            subscriptions: Mutex::new(HashSet::new()),
            got_client_hello: AtomicBool::new(false),
        })
    }

    fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn subscribe(&self, session_ids: &[String]) -> Vec<String> {
        let mut subs = self.subscriptions.lock().unwrap_or_else(|e| e.into_inner());
        let mut accepted = Vec::new();
        for sid in session_ids {
            if subs.insert(sid.clone()) {
                accepted.push(sid.clone());
            }
        }
        accepted
    }

    fn unsubscribe(&self, session_ids: &[String]) {
        let mut subs = self.subscriptions.lock().unwrap_or_else(|e| e.into_inner());
        for sid in session_ids {
            subs.remove(sid);
        }
    }

    fn is_subscribed(&self, session_id: &str) -> bool {
        self.subscriptions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(session_id)
    }
}

/// Wrap a projected event in the v1 envelope: `{ type, seq, session_id,
/// timestamp, payload }` (wire.ts `WireEventBase`).
fn envelope(conn: &V1Conn, ty: &str, session_id: &str, payload: Value) -> Value {
    json!({
        "type": ty,
        "seq": conn.next_seq(),
        "session_id": session_id,
        "timestamp": iso_now(),
        "payload": payload,
    })
}

/// Build a `server_hello` frame (wsConnectionV1 `buildServerHello` + the
/// optional `heartbeat_ms` the web client honours).
fn server_hello(conn: &V1Conn) -> Value {
    json!({
        "type": "server_hello",
        "timestamp": iso_now(),
        "payload": {
            "ws_connection_id": conn.ws_connection_id,
            "protocol_version": 1,
            "max_event_buffer_size": 1000,
            "capabilities": { "event_batching": false, "compression": false },
            "heartbeat_ms": 30_000,
        },
    })
}

/// Build an `ack` frame (`{ type, id, code, msg, payload }`).
fn ack(id: &str, code: i64, payload: Value) -> Value {
    json!({ "type": "ack", "id": id, "code": code, "msg": if code == 0 { "success" } else { "error" }, "payload": payload })
}

/// Serve one upgraded WebSocket connection speaking the v1 protocol.
pub async fn serve_v1_ws(
    socket: WebSocket,
    events: Option<tokio::sync::broadcast::Sender<serde_json::Value>>,
    shared: Arc<V1Shared>,
) {
    let (sink, mut source) = socket.split();
    let sink = Arc::new(tokio::sync::Mutex::new(sink));
    let conn = V1Conn::new();

    // Handshake first.
    {
        let mut sink = sink.lock().await;
        let _ = sink
            .send(AxumMessage::Text(server_hello(&conn).to_string().into()))
            .await;
    }

    // Forward projected engine events to this client when the event source is
    // attached. Ends when the channel closes or the connection drops.
    if let Some(events) = events {
        let sink = sink.clone();
        let conn = conn.clone();
        let shared = shared.clone();
        tokio::spawn(async move {
            let mut rx = events.subscribe();
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        for (sid, ty, payload) in project_event(&shared, &event) {
                            if !conn.is_subscribed(&sid) {
                                continue;
                            }
                            let frame = envelope(&conn, &ty, &sid, payload);
                            let mut sink = sink.lock().await;
                            if sink
                                .send(AxumMessage::Text(frame.to_string().into()))
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    // Inbound control frames.
    while let Some(msg) = source.next().await {
        let Ok(msg) = msg else { break };
        match msg {
            AxumMessage::Text(text) => {
                handle_control_frame(&conn, &sink, &text).await;
            }
            AxumMessage::Close(_) => break,
            _ => {}
        }
    }
}

/// Send one text frame to the socket (lock + send).
async fn send_frame<S>(sink: &Arc<tokio::sync::Mutex<S>>, frame: Value)
where
    S: futures_util::Sink<AxumMessage> + Send + Unpin,
    S::Error: std::fmt::Debug,
{
    let mut sink = sink.lock().await;
    let _ = sink.send(AxumMessage::Text(frame.to_string().into())).await;
}

/// Handle one inbound v1 control frame (`client_hello`, `subscribe`,
/// `unsubscribe`, `ping`, …). Unknown frames are dropped silently, matching
/// wsConnectionV1's switch.
async fn handle_control_frame<S>(conn: &V1Conn, sink: &Arc<tokio::sync::Mutex<S>>, text: &str)
where
    S: futures_util::Sink<AxumMessage> + Send + Unpin,
    S::Error: std::fmt::Debug,
{
    let Ok(frame) = serde_json::from_str::<Value>(text) else {
        return; // non-JSON frame — drop
    };
    let Some(ty) = frame["type"].as_str() else {
        return;
    };
    let id = frame["id"].as_str().unwrap_or("").to_string();
    let payload = frame["payload"].clone();
    match ty {
        "client_hello" => {
            if conn.got_client_hello.swap(true, Ordering::Relaxed) {
                return;
            }
            // Handshake only — inline subscriptions are legacy; the modern web
            // client subscribes separately. Accept them anyway for parity.
            let subscriptions = payload["subscriptions"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let accepted = conn.subscribe(&subscriptions);
            let resp = ack(&id, 0, json!({
                "accepted_subscriptions": accepted,
                "resync_required": [],
                "cursors": {},
            }));
            send_frame(sink, resp).await;
        }
        "subscribe" => {
            if !conn.got_client_hello.load(Ordering::Relaxed) {
                return;
            }
            let session_ids = payload["session_ids"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let accepted = conn.subscribe(&session_ids);
            let resp = ack(&id, 0, json!({
                "accepted_subscriptions": accepted,
                "not_found": [],
                "resync_required": [],
                "cursors": {},
            }));
            send_frame(sink, resp).await;
        }
        "unsubscribe" => {
            let session_ids = payload["session_ids"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            conn.unsubscribe(&session_ids);
            let resp = ack(&id, 0, json!({ "unsubscribed": session_ids }));
            send_frame(sink, resp).await;
        }
        "ping" => {
            let resp = json!({
                "type": "pong",
                "payload": { "nonce": payload["nonce"] },
            });
            send_frame(sink, resp).await;
        }
        _ => {
            // Unknown control frames (terminal_*, abort, …) — ignore for now.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_now_is_iso8601() {
        let s = iso_now();
        // YYYY-MM-DDTHH:MM:SS.mmmZ — 24 chars.
        assert_eq!(s.len(), 24);
        assert!(s.ends_with('Z'));
        assert!(s.chars().nth(4) == Some('-'));
        assert!(s.chars().nth(10) == Some('T'));
    }

    #[test]
    fn gen_id_has_prefix_and_is_unique() {
        let a = gen_id("msg_");
        let b = gen_id("msg_");
        assert!(a.starts_with("msg_"));
        assert_ne!(a, b);
    }

    #[test]
    fn wire_session_carries_mandatory_fields() {
        let list = json!({
            "id": "sess_1",
            "title": "t",
            "created_at": "2026-01-01T00:00:00.000Z",
            "updated_at": "2026-01-01T00:00:00.000Z",
            "work_dir": "G:/repo",
        });
        let status = json!({ "data": { "model": "kimi", "busy": false, "archived": false } });
        let context = json!({ "data": { "history": [
            { "role": "user" },
            { "role": "assistant" },
            { "role": "tool" },
        ] } });
        let ws = wire_session(&list, &status, &context, false);
        assert_eq!(ws["id"], "sess_1");
        assert_eq!(ws["metadata"]["cwd"], "G:/repo");
        assert_eq!(ws["agent_config"]["model"], "kimi");
        assert_eq!(ws["message_count"], 2);
        assert!(ws["usage"]["input_tokens"].is_number());
        assert_eq!(ws["permission_rules"].as_array().map(|a| a.len()), Some(0));
        let busy = wire_session(&list, &status, &context, true);
        assert!(busy["busy"] == json!(true));
    }

    #[test]
    fn turn_lifecycle_projects_to_v1_envelopes() {
        let shared = V1Shared::new();
        let sid = "sess_1";
        shared.begin_turn(
            sid,
            TurnContext {
                prompt_id: "p_1".into(),
                user_message_id: "m_user".into(),
                assistant_msg_id: "m_assistant".into(),
                prompt_text: "hello".into(),
                buffer: String::new(),
            },
        );

        let started = project_event(&shared, &json!({
            "type": "session.turn.started",
            "session_id": sid,
            "turn_id": "t_1",
        }));
        assert_eq!(started.len(), 2);
        assert_eq!(started[0].1, "event.session.work_changed");
        assert!(started[0].2["busy"] == json!(true));
        assert_eq!(started[1].1, "event.message.created");
        assert_eq!(started[1].2["message"]["role"], "user");
        assert_eq!(started[1].2["message"]["id"], "m_user");

        let delta = project_event(&shared, &json!({
            "type": "llm.delta",
            "session_id": sid,
            "part": { "type": "text", "text": "hi " },
        }));
        assert_eq!(delta.len(), 1);
        assert_eq!(delta[0].1, "event.assistant.delta");
        assert_eq!(delta[0].2["delta"]["text"], "hi ");

        let delta2 = project_event(&shared, &json!({
            "type": "llm.delta",
            "session_id": sid,
            "part": { "type": "text", "text": "there" },
        }));
        assert_eq!(delta2[0].2["delta"]["text"], "there");

        let ended = project_event(&shared, &json!({
            "type": "session.turn.ended",
            "session_id": sid,
            "turn_id": "t_1",
            "stop_reason": "Completed",
        }));
        assert_eq!(ended.len(), 3);
        assert_eq!(ended[0].1, "event.message.updated");
        assert_eq!(ended[0].2["content"][0]["text"], "hi there");
        assert_eq!(ended[1].1, "event.assistant.completed");
        assert_eq!(ended[1].2["finish_reason"], "stop");
        assert_eq!(ended[2].1, "event.session.work_changed");
        assert!(ended[2].2["busy"] == json!(false));
    }

    #[test]
    fn unknown_events_project_to_nothing() {
        let shared = V1Shared::new();
        assert!(project_event(&shared, &json!({ "type": "session.tool.started" })).is_empty());
        assert!(project_event(&shared, &json!({ "type": "whatever" })).is_empty());
        // Events without a session_id never project.
        assert!(project_event(&shared, &json!({ "type": "session.turn.started" })).is_empty());
    }
}
