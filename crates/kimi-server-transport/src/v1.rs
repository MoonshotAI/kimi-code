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
        // The engine `session/list` summary carries no archived flag today;
        // read it when present so a future engine that reports it projects
        // through (defaults to false otherwise).
        "archived": list_entry["archived"].as_bool().unwrap_or(false),
        "metadata": { "cwd": work_dir },
        "agent_config": { "model": model },
        "usage": zero_usage(),
        "permission_rules": [],
        "message_count": message_count,
        "last_seq": last_seq,
    })
}

/// Map one engine `ContentPart` (kimi-protocol `context::ContentPart`) to the
/// v1 `WireMessageContent` shape the browser consumes (wire.ts
/// `WireMessageContent`, read by mappers.ts `toAppMessageContent`). The engine
/// history carries the provider wire form (`think` / `tool_use` /
/// `tool_result` / `image_url`), which differs from the v1 field names:
/// - `think{think,signature}` → `thinking{thinking,signature}`
/// - `tool_use{id,name,input}` → `tool_use{tool_call_id,tool_name,input}`
/// - `tool_result{tool_use_id,content,is_error}` → `tool_result{tool_call_id,output,is_error}`
/// - `image_url{image_url}` / `video_url{video_url}` → `image`/`video` with a
///   `{kind:"url"}` `source` (the engine media container is a URL)
/// - `text` (and anything unknown — the web mapper tolerates unknown types by
///   folding them to `{ type: "unknown", raw }`) passes through unchanged.
fn map_content_part(part: &Value) -> Value {
    match part["type"].as_str().unwrap_or_default() {
        "think" => {
            let mut out = json!({
                "type": "thinking",
                // Engine Think carries `think: Option<String>` (absent for
                // encrypted blocks); the wire shape wants a string.
                "thinking": part["think"].as_str().unwrap_or(""),
            });
            if let Some(signature) = part.get("signature") {
                out["signature"] = signature.clone();
            }
            out
        }
        "tool_use" => json!({
            "type": "tool_use",
            "tool_call_id": part["id"],
            "tool_name": part["name"],
            "input": part["input"],
        }),
        "tool_result" => {
            let mut out = json!({
                "type": "tool_result",
                "tool_call_id": part["tool_use_id"],
                // Engine content is a part array; the web renderer
                // (normalizeToolOutput) accepts arrays of parts.
                "output": part["content"],
            });
            if let Some(is_error) = part.get("is_error") {
                out["is_error"] = is_error.clone();
            }
            out
        }
        "image_url" => json!({ "type": "image", "source": media_source(&part["image_url"]) }),
        "video_url" => json!({ "type": "video", "source": media_source(&part["video_url"]) }),
        _ => part.clone(),
    }
}

/// Map an engine `MediaContainer` (`{url, id?}`) to the v1 `WireImageSource`
/// `{kind:"url"}` variant (wire.ts `WireImageSource`).
fn media_source(media: &Value) -> Value {
    let mut out = json!({ "kind": "url", "url": media["url"] });
    if let Some(id) = media.get("id") {
        out["id"] = id.clone();
    }
    out
}

/// Wrap one engine context message as a v1 `WireMessage` (snapshot path).
/// The engine context items carry `role` + `content` in the engine
/// `ContentPart` shape; `map_content_part` rewrites them onto the v1
/// `WireMessageContent` shapes the web mapper consumes. ids/timestamps are
/// synthesized.
pub fn wire_message_from_context(m: &Value, session_id: &str, index: usize) -> Value {
    let content = m["content"]
        .as_array()
        .map(|parts| parts.iter().map(map_content_part).collect::<Vec<_>>())
        .unwrap_or_default();
    json!({
        "id": format!("msg_ctx_{index}"),
        "session_id": session_id,
        "role": m["role"],
        "content": content,
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
        // Engine `SessionStatusResult` names the field `thinking_effort`;
        // the v1 contract exposes it as `thinking_level` (wire.ts
        // `WireSessionRuntimeStatus`).
        "thinking_level": data["thinking_effort"].as_str().unwrap_or("none"),
        "permission": data["permission"].as_str().unwrap_or("default"),
        "plan_mode": data["plan_mode"].as_bool().unwrap_or(false),
        "swarm_mode": data["swarm_mode"].as_bool().unwrap_or(false),
        "context_tokens": data["context_tokens"].as_u64().unwrap_or(0),
        "max_context_tokens": data["max_context_tokens"].as_u64().unwrap_or(0),
        "context_usage": data["context_usage"].as_f64().unwrap_or(0.0),
    })
}

/// Per-prompt streaming context shared between the async REST prompt submit
/// and the WS event projector for one session. The REST handler writes it
/// (`begin_turn`) before the prompt RPC; each WS projector reads a one-time
/// snapshot at `turn.started` into its connection-local state and never
/// mutates the shared map (the async submit task removes it 100ms after the
/// RPC returns as a fallback).
#[derive(Clone)]
pub struct TurnContext {
    pub prompt_id: String,
    pub user_message_id: String,
    pub assistant_msg_id: String,
    pub prompt_text: String,
    /// Accumulated assistant text for the current turn (deltas append here).
    pub buffer: String,
}

/// Shared per-session turn state written by the REST prompt handler and read
/// by the WS event projectors. Streamed text/think do NOT accumulate here —
/// every projector task owns a connection-local `LocalTurnState` instead, so
/// N connections subscribed to the same session never multiply the buffers or
/// race for the `turn.ended` close-out.
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

/// Connection-local state for one in-flight turn, owned by a single WS
/// projector task. The pre-fix projection accumulated streamed deltas into
/// the process-wide `V1Shared` map: with N connections subscribed to the same
/// session every `llm.delta` was appended N times, and whichever projector
/// task consumed the shared context on `turn.ended` first closed the turn for
/// everyone else (their `message.updated` / `assistant.completed` never
/// fired). Keyed by session id so concurrent turns in different sessions
/// stream independently per connection.
struct LocalTurnState {
    prompt_id: String,
    user_message_id: String,
    assistant_msg_id: String,
    prompt_text: String,
    /// Accumulated assistant text for the current turn (deltas append here).
    text: String,
    /// Accumulated engine thinking text for the current turn (deltas append
    /// here; the turn-end `message.updated` reconstruction reads it to keep
    /// the thinking block visible after the streamed deltas stop).
    think: String,
    /// Wall-clock arrival of `turn.started` (drives `durationMs` on
    /// `turn.ended`).
    started_at: Option<std::time::Instant>,
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
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0) as u64;
    iso_from_ms(millis)
}

/// Format an epoch-millis timestamp as ISO-8601 (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
/// Shared by `iso_now` and engine timestamps that arrive as raw millis
/// (e.g. `created_at_ms` on approval events).
fn iso_from_ms(ms: u64) -> String {
    let secs = ms / 1000;
    let millis = ms % 1000;
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
/// v1-friendly message lifecycle: `message.created` (user + a placeholder
/// assistant message) fires at `turn.started` so `assistant.delta` frames
/// always have a message to attach to, and the raw `turn.ended` boundary is
/// forwarded first (the web client's agent projector keys its prompt-cleanup
/// chain off it) followed by `message.updated` + `assistant.completed`.
///
/// All turn-scoped accumulation (assistant text, thinking text) happens in
/// `local` — the connection-owned state, keyed by session id — never in the
/// shared `V1Shared` map (which belongs to the REST prompt handler). The
/// caller must filter by subscription before calling so unsubscribed
/// sessions never touch projector state.
fn project_event(
    shared: &V1Shared,
    local: &mut HashMap<String, LocalTurnState>,
    ev: &Value,
) -> Vec<(String, String, Value)> {
    let Some(ty) = ev["type"].as_str() else {
        return Vec::new();
    };
    let Some(session_id) = ev["session_id"].as_str() else {
        return Vec::new();
    };
    let sid = session_id.to_string();
    match ty {
        "session.turn.started" => {
            // The REST prompt submit already registered a TurnContext
            // (`begin_turn` runs before the prompt RPC, so the snapshot is
            // always visible by the time the engine's `turn.started` streams
            // out); snapshot it into the connection-local state in one read.
            // A fresh turn also discards any connection state left over from
            // a turn whose `turn.ended` never arrived. Without a context (a
            // host-driven turn the transport never saw submitted) nothing is
            // projected.
            let ctx = shared.with_turn(&sid, |c| c.clone());
            let Some(ctx) = ctx else {
                return Vec::new();
            };
            local.insert(
                sid.clone(),
                LocalTurnState {
                    prompt_id: ctx.prompt_id,
                    user_message_id: ctx.user_message_id,
                    assistant_msg_id: ctx.assistant_msg_id,
                    prompt_text: ctx.prompt_text,
                    text: ctx.buffer,
                    think: String::new(),
                    started_at: Some(std::time::Instant::now()),
                },
            );
            // Envelopes below read the ids back from the connection-local
            // snapshot (the same snapshot the streamed deltas accumulate
            // against).
            let state = local.get(&sid).expect("just inserted");
            vec![
                (
                    sid.clone(),
                    "event.session.work_changed".into(),
                    json!({
                        "busy": true,
                        "main_turn_active": true,
                        "pending_interaction": "none",
                        "current_prompt_id": state.prompt_id,
                    }),
                ),
                (
                    sid.clone(),
                    "event.message.created".into(),
                    json!({
                        "message": {
                            "id": state.user_message_id,
                            "session_id": sid.clone(),
                            "role": "user",
                            "content": [{ "type": "text", "text": state.prompt_text }],
                            "created_at": iso_now(),
                            "prompt_id": state.prompt_id,
                            "parent_message_id": null,
                        }
                    }),
                ),
                (
                    sid.clone(),
                    "event.message.created".into(),
                    json!({
                        "message": {
                            "id": state.assistant_msg_id,
                            "session_id": sid,
                            "role": "assistant",
                            "content": [],
                            "created_at": iso_now(),
                            "prompt_id": state.prompt_id,
                            "parent_message_id": null,
                        }
                    }),
                ),
            ]
        }
        "llm.delta" => {
            let part = &ev["part"];
            let part_type = part["type"].as_str().unwrap_or("");
            let text = part["text"].as_str().unwrap_or_default();
            let think = part["think"].as_str().unwrap_or_default();
            let Some(state) = local.get_mut(&sid) else {
                return Vec::new();
            };
            let assistant_msg_id = state.assistant_msg_id.clone();
            match part_type {
                "text" if !text.is_empty() => {
                    state.text.push_str(text);
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
                // Engine thinking parts arrive as `part.type == "think"` with
                // the text in `part.think` (llm/http.rs). Stream them as a
                // `thinking` delta so the reducer accumulates a thinking block;
                // the text is kept out of the reply buffer.
                "think" if !think.is_empty() => {
                    state.think.push_str(think);
                    vec![(
                        sid,
                        "event.assistant.delta".into(),
                        json!({
                            "message_id": assistant_msg_id,
                            "content_index": 0,
                            "delta": { "thinking": think },
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
            // The web client routes this envelope to its agent projector,
            // which reads camelCase `turnId` / `reason` / `durationMs`
            // (agentEventProjector.ts turn.ended arm; classifyFrame routes
            // event.turn.ended to the raw-agent path). `reason` maps the
            // engine's Debug-spelled stop reason onto the client vocabulary;
            // the snake_case fields stay for parity with older consumers.
            let reason = match stop_reason {
                "Aborted" | "Cancelled" => "cancelled",
                _ => "completed",
            };
            let state = local.remove(&sid);
            let duration_ms = state
                .as_ref()
                .and_then(|s| s.started_at)
                .map(|t| t.elapsed().as_millis() as u64);
            // The raw turn boundary goes out first: the web client's agent
            // projector turns it into turnActiveChanged(false), which drives
            // the prompt-cleanup chain (gated on the frame seq advancing the
            // per-session cursor — this envelope's seq is the batch's lowest).
            // Close-out events need the turn context; the busy reset does not,
            // so it is emitted unconditionally (a REST-only turn whose context
            // the async-submit task already cleared must still release busy).
            let mut out = vec![(
                sid.clone(),
                "event.turn.ended".into(),
                json!({
                    "turn_id": ev["turn_id"],
                    "stop_reason": stop_reason,
                    "turnId": ev["turn_id"],
                    "reason": reason,
                    "durationMs": duration_ms,
                    "steps": ev["steps"],
                }),
            )];
            if let Some(state) = state {
                // Reconstruct the final content with the streamed thinking
                // block (if any) ahead of the reply text, mirroring the delta
                // order the reducer accumulated.
                let mut content = Vec::new();
                if !state.think.is_empty() {
                    content.push(json!({ "type": "thinking", "thinking": state.think }));
                }
                content.push(json!({ "type": "text", "text": state.text }));
                out.push((
                    sid.clone(),
                    "event.message.updated".into(),
                    json!({
                        "message_id": state.assistant_msg_id,
                        "content": content,
                        "status": "completed",
                    }),
                ));
                out.push((
                    sid.clone(),
                    "event.assistant.completed".into(),
                    json!({
                        "message_id": state.assistant_msg_id,
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
        "session.usage.updated" => {
            // Engine event (agent.rs): `input_tokens` / `output_tokens` /
            // `total_tokens` per turn. The v1 envelope carries the full
            // `WireSessionUsage` plus a `WireSessionUsageDelta`; the engine
            // does not report cache/context numbers on this event, so those
            // pad to zero (live totals arrive via `session/get_status`).
            vec![(
                sid,
                "event.session.usage_updated".into(),
                json!({
                    "usage": {
                        "input_tokens": ev["input_tokens"],
                        "output_tokens": ev["output_tokens"],
                        "cache_read_tokens": 0,
                        "cache_creation_tokens": 0,
                        "total_cost_usd": 0,
                        "context_tokens": 0,
                        "context_limit": 0,
                        "turn_count": 0,
                    },
                    "delta": {
                        "input_tokens": ev["input_tokens"],
                        "output_tokens": ev["output_tokens"],
                        "cache_read_tokens": 0,
                        "cache_creation_tokens": 0,
                        "cost_usd": 0,
                    },
                }),
            )]
        }
        "session.goal.updated" => {
            // Engine event (agent.rs `emit_goal_status`): `snapshot` (a
            // camelCase `GoalSnapshot` — already the v1 wire shape) plus a
            // bare `status` string for diagnostics. The v1 envelope carries
            // just the snapshot; the web mapper reads `payload.snapshot`
            // (mappers.ts `toAppEvent`), null meaning no active goal.
            vec![(
                sid,
                "event.goal.updated".into(),
                json!({ "snapshot": ev["snapshot"] }),
            )]
        }
        "session.approval.requested" => {
            // Engine event (approval/mod.rs): approval_id / tool_call_id /
            // tool_name / arguments / approval_rule / created_at_ms. The wire
            // payload is the v1 WireApprovalRequest the web mapper reads:
            // `action` ← approval_rule, `tool_input_display` ← arguments,
            // `created_at` ← iso(created_at_ms). expires_at is intentionally
            // omitted — toAppApprovalRequest tolerates the absence.
            vec![(
                sid.clone(),
                "event.approval.requested".into(),
                json!({
                    "approval_id": ev["approval_id"],
                    "session_id": sid,
                    "tool_call_id": ev["tool_call_id"],
                    "tool_name": ev["tool_name"],
                    "action": ev["approval_rule"],
                    "tool_input_display": ev["arguments"],
                    "created_at": iso_from_ms(ev["created_at_ms"].as_u64().unwrap_or(0)),
                }),
            )]
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
            // Connection-local turn state, keyed by session id (one entry per
            // session with an in-flight turn). Subscription filtering happens
            // BEFORE projection so unsubscribed sessions never touch it.
            let mut local: HashMap<String, LocalTurnState> = HashMap::new();
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        let Some(sid) = event["session_id"].as_str() else {
                            continue;
                        };
                        if !conn.is_subscribed(sid) {
                            continue;
                        }
                        for (sid, ty, payload) in project_event(&shared, &mut local, &event) {
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
        let mut local = HashMap::new();
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

        let started = project_event(&shared, &mut local, &json!({
            "type": "session.turn.started",
            "session_id": sid,
            "turn_id": "t_1",
        }));
        assert_eq!(started.len(), 3);
        assert_eq!(started[0].1, "event.session.work_changed");
        assert!(started[0].2["busy"] == json!(true));
        assert_eq!(started[1].1, "event.message.created");
        assert_eq!(started[1].2["message"]["role"], "user");
        assert_eq!(started[1].2["message"]["id"], "m_user");
        // The placeholder assistant message is what the streamed deltas attach
        // to; without it the reducer drops every assistant.delta.
        assert_eq!(started[2].1, "event.message.created");
        assert_eq!(started[2].2["message"]["role"], "assistant");
        assert_eq!(started[2].2["message"]["id"], "m_assistant");
        assert_eq!(started[2].2["message"]["content"].as_array().map(|a| a.len()), Some(0));
        assert!(started[2].2["message"]["created_at"].is_string());

        let delta = project_event(&shared, &mut local, &json!({
            "type": "llm.delta",
            "session_id": sid,
            "part": { "type": "text", "text": "hi " },
        }));
        assert_eq!(delta.len(), 1);
        assert_eq!(delta[0].1, "event.assistant.delta");
        assert_eq!(delta[0].2["delta"]["text"], "hi ");

        let delta2 = project_event(&shared, &mut local, &json!({
            "type": "llm.delta",
            "session_id": sid,
            "part": { "type": "text", "text": "there" },
        }));
        assert_eq!(delta2[0].2["delta"]["text"], "there");

        // Engine thinking parts are `type: "think"` with `part.think`
        // (llm/http.rs); they stream as a `thinking` delta, not text.
        let think = project_event(&shared, &mut local, &json!({
            "type": "llm.delta",
            "session_id": sid,
            "part": { "type": "think", "think": "hmm " },
        }));
        assert_eq!(think.len(), 1);
        assert_eq!(think[0].1, "event.assistant.delta");
        assert_eq!(think[0].2["delta"]["thinking"], "hmm ");
        assert!(think[0].2["delta"].get("text").is_none());

        let ended = project_event(&shared, &mut local, &json!({
            "type": "session.turn.ended",
            "session_id": sid,
            "turn_id": 7,
            "stop_reason": "Completed",
            "steps": 3,
        }));
        assert_eq!(ended.len(), 4);
        // The raw turn boundary leads the batch so the web client's agent
        // projector revives the turnActiveChanged(false) / prompt cleanup.
        assert_eq!(ended[0].1, "event.turn.ended");
        assert_eq!(ended[0].2["turn_id"], 7);
        assert_eq!(ended[0].2["stop_reason"], "Completed");
        assert_eq!(ended[0].2["steps"], 3);
        // The agent projector reads the camelCase fields (turnId / reason /
        // durationMs); an unknown stop reason maps onto "completed".
        assert_eq!(ended[0].2["turnId"], 7);
        assert_eq!(ended[0].2["reason"], "completed");
        assert!(ended[0].2["durationMs"].is_number());
        assert_eq!(ended[1].1, "event.message.updated");
        // The thinking block survives the final content reconstruction.
        assert_eq!(ended[1].2["content"][0]["type"], "thinking");
        assert_eq!(ended[1].2["content"][0]["thinking"], "hmm ");
        assert_eq!(ended[1].2["content"][1]["text"], "hi there");
        assert_eq!(ended[2].1, "event.assistant.completed");
        assert_eq!(ended[2].2["finish_reason"], "stop");
        assert_eq!(ended[3].1, "event.session.work_changed");
        assert!(ended[3].2["busy"] == json!(false));

        // The projector path never mutated the shared map: the REST handler's
        // context (empty buffer — no N-fold delta accumulation) still awaits
        // the async-submit 100ms fallback take_turn.
        let ctx = shared.take_turn(sid).expect("ctx reserved for http.rs fallback");
        assert_eq!(ctx.buffer, "");
    }

    #[test]
    fn turn_ended_reason_maps_to_client_vocabulary() {
        let shared = V1Shared::new();
        let mut local = HashMap::new();
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
        project_event(&shared, &mut local, &json!({
            "type": "session.turn.started",
            "session_id": sid,
            "turn_id": 1,
        }));

        let aborted = project_event(&shared, &mut local, &json!({
            "type": "session.turn.ended",
            "session_id": sid,
            "turn_id": 1,
            "stop_reason": "Aborted",
            "steps": 0,
        }));
        // Aborted → "cancelled" on the projector-facing reason field; the
        // pre-existing snake_case / work_changed mappings keep their values.
        assert_eq!(aborted[0].2["reason"], "cancelled");
        assert_eq!(aborted[0].2["turnId"], 1);
        assert_eq!(aborted[0].2["stop_reason"], "Aborted");
        assert_eq!(aborted[2].2["finish_reason"], "cancelled");
        assert_eq!(aborted[3].2["last_turn_reason"], "cancelled");
        // The close-out consumed the connection-local state.
        assert!(local.is_empty());
    }

    #[test]
    fn concurrent_projectors_keep_per_connection_buffers() {
        // Two connections subscribed to the same session race the same
        // broadcast event sequence. Each must accumulate its own text/think
        // and receive its own turn.ended close-out — the shared V1Shared map
        // is never written by the projector path (regression: the pre-fix
        // shared buffering appended every delta once per connection and let
        // whichever projector consumed the shared context first close the
        // turn for everyone else).
        let shared = V1Shared::new();
        shared.begin_turn(
            "sess_1",
            TurnContext {
                prompt_id: "p_1".into(),
                user_message_id: "m_user".into(),
                assistant_msg_id: "m_assistant".into(),
                prompt_text: "hello".into(),
                buffer: String::new(),
            },
        );

        let events: Vec<Value> = vec![
            json!({ "type": "session.turn.started", "session_id": "sess_1", "turn_id": 1 }),
            json!({ "type": "llm.delta", "session_id": "sess_1", "part": { "type": "think", "think": "hmm " } }),
            json!({ "type": "llm.delta", "session_id": "sess_1", "part": { "type": "text", "text": "hi " } }),
            json!({ "type": "llm.delta", "session_id": "sess_1", "part": { "type": "text", "text": "there" } }),
            json!({ "type": "session.turn.ended", "session_id": "sess_1", "turn_id": 1, "stop_reason": "EndTurn", "steps": 2 }),
        ];

        let run = |events: &[Value], shared: &V1Shared| {
            let mut local = HashMap::new();
            events
                .iter()
                .flat_map(|ev| project_event(shared, &mut local, ev))
                .collect::<Vec<_>>()
        };

        // Truly concurrent: the projector tasks are not synchronized and race
        // the shared-map reads; each thread's output depends only on its own
        // connection-local state.
        let (a, b) = std::thread::scope(|scope| {
            let a = scope.spawn(|| run(&events, &shared));
            let b = scope.spawn(|| run(&events, &shared));
            (a.join().unwrap(), b.join().unwrap())
        });

        for out in [&a, &b] {
            // Each connection saw the full lifecycle with its own buffers.
            let updated = out
                .iter()
                .find(|e| e.1 == "event.message.updated")
                .expect("every connection gets its own close-out");
            assert_eq!(updated.2["content"][0]["type"], "thinking");
            assert_eq!(updated.2["content"][0]["thinking"], "hmm ");
            assert_eq!(updated.2["content"][1]["text"], "hi there");
            assert!(out.iter().any(|e| e.1 == "event.assistant.completed"));
            let ended = out.iter().find(|e| e.1 == "event.turn.ended").unwrap();
            assert_eq!(ended.2["reason"], "completed");
            assert_eq!(ended.2["turnId"], 1);
            assert!(ended.2["durationMs"].is_number());
            assert!(out
                .iter()
                .any(|e| e.1 == "event.session.work_changed" && e.2["busy"].as_bool() == Some(false)));
        }

        // The shared map is untouched by the projector path: the REST
        // handler's context (empty buffer — no N-fold accumulation) still
        // awaits the async-submit 100ms fallback take_turn.
        let ctx = shared.take_turn("sess_1").expect("ctx not consumed by projectors");
        assert_eq!(ctx.buffer, "");
    }

    #[test]
    fn approval_requested_projects_to_v1_envelope() {
        let shared = V1Shared::new();
        let mut local = HashMap::new();
        let out = project_event(&shared, &mut local, &json!({
            "type": "session.approval.requested",
            "session_id": "sess_1",
            "approval_id": "approval-1-c1",
            "tool_call_id": "call_1",
            "tool_name": "Write",
            "arguments": { "path": "/tmp/x", "content": "hi" },
            "approval_rule": "Write(path=/tmp/x)",
            "created_at_ms": 1762560000000u64,
        }));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].1, "event.approval.requested");
        let p = &out[0].2;
        assert_eq!(p["approval_id"], "approval-1-c1");
        assert_eq!(p["session_id"], "sess_1");
        assert_eq!(p["tool_call_id"], "call_1");
        assert_eq!(p["tool_name"], "Write");
        // `action` ← approval_rule, `tool_input_display` ← arguments.
        assert_eq!(p["action"], "Write(path=/tmp/x)");
        assert_eq!(p["tool_input_display"]["path"], "/tmp/x");
        // `created_at` ← iso(created_at_ms); expires_at may be absent.
        assert_eq!(p["created_at"], iso_from_ms(1762560000000));
        assert!(p.get("expires_at").is_none());
    }

    #[test]
    fn unknown_events_project_to_nothing() {
        let shared = V1Shared::new();
        let mut local = HashMap::new();
        assert!(project_event(&shared, &mut local, &json!({ "type": "session.tool.started" })).is_empty());
        assert!(project_event(&shared, &mut local, &json!({ "type": "whatever" })).is_empty());
        // Events without a session_id never project.
        assert!(project_event(&shared, &mut local, &json!({ "type": "session.turn.started" })).is_empty());
        // A delta without a preceding turn.started snapshot projects nothing
        // and leaves no local state behind (missed-turn joiners).
        assert!(project_event(&shared, &mut local, &json!({
            "type": "llm.delta",
            "session_id": "sess_1",
            "part": { "type": "text", "text": "hi" },
        }))
        .is_empty());
        assert!(local.is_empty());
    }

    #[test]
    fn content_parts_map_to_wire_shapes() {
        let msg = json!({
            "role": "assistant",
            "content": [
                { "type": "think", "think": "hmm", "signature": "sig_1" },
                { "type": "text", "text": "hi" },
                { "type": "tool_use", "id": "call_1", "name": "Grep", "input": { "q": "x" } },
                { "type": "image_url", "image_url": { "url": "https://example.com/a.png", "id": "img_1" } },
                { "type": "video_url", "video_url": { "url": "https://example.com/a.mp4" } },
            ],
        });
        let m = wire_message_from_context(&msg, "sess_1", 0);
        let content = m["content"].as_array().unwrap();
        assert_eq!(content.len(), 5);
        // think → thinking, with the engine field name dropped.
        assert_eq!(content[0]["type"], "thinking");
        assert_eq!(content[0]["thinking"], "hmm");
        assert_eq!(content[0]["signature"], "sig_1");
        assert!(content[0].get("think").is_none());
        // text passes through.
        assert_eq!(content[1]["type"], "text");
        assert_eq!(content[1]["text"], "hi");
        // tool_use → v1 tool_call_id / tool_name.
        assert_eq!(content[2]["type"], "tool_use");
        assert_eq!(content[2]["tool_call_id"], "call_1");
        assert_eq!(content[2]["tool_name"], "Grep");
        assert_eq!(content[2]["input"]["q"], "x");
        assert!(content[2].get("id").is_none());
        assert!(content[2].get("name").is_none());
        // image_url → image with a url-kind source.
        assert_eq!(content[3]["type"], "image");
        assert_eq!(content[3]["source"]["kind"], "url");
        assert_eq!(content[3]["source"]["url"], "https://example.com/a.png");
        assert_eq!(content[3]["source"]["id"], "img_1");
        // video_url → video; absent id is omitted.
        assert_eq!(content[4]["type"], "video");
        assert_eq!(content[4]["source"]["url"], "https://example.com/a.mp4");
        assert!(content[4]["source"].get("id").is_none());
    }

    #[test]
    fn tool_result_parts_map_with_output_and_error_flag() {
        let msg = json!({
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "call_2",
                    "content": [{ "type": "text", "text": "ok" }],
                    "is_error": false,
                },
                {
                    "type": "tool_result",
                    "tool_use_id": "call_3",
                    "content": [{ "type": "text", "text": "boom" }],
                    "is_error": true,
                },
                { "type": "audio_url", "audio_url": { "url": "https://example.com/a.mp3" } },
            ],
        });
        let m = wire_message_from_context(&msg, "sess_1", 0);
        let content = m["content"].as_array().unwrap();
        // tool_result → v1 tool_call_id / output (the engine part array).
        assert_eq!(content[0]["type"], "tool_result");
        assert_eq!(content[0]["tool_call_id"], "call_2");
        assert_eq!(content[0]["output"][0]["text"], "ok");
        assert_eq!(content[0]["is_error"], false);
        assert_eq!(content[1]["tool_call_id"], "call_3");
        assert_eq!(content[1]["is_error"], true);
        // Unknown part types pass through raw (the web mapper folds them to
        // `{ type: "unknown", raw }`).
        assert_eq!(content[2]["type"], "audio_url");
        // Messages without content project an empty array, not null.
        let empty = wire_message_from_context(&json!({ "role": "user" }), "sess_1", 1);
        assert_eq!(empty["content"].as_array().map(|a| a.len()), Some(0));
    }

    #[test]
    fn runtime_status_reads_engine_thinking_effort() {
        // The engine `SessionStatusResult` exposes `thinking_effort` (not
        // `thinking_level`); the v1 projection renames it onto the wire field.
        let status = json!({
            "data": {
                "model": "kimi",
                "thinking_effort": "high",
                "permission": "acceptEdits",
                "plan_mode": true,
            }
        });
        let wire = wire_session_runtime_status(&status);
        assert_eq!(wire["model"], "kimi");
        assert_eq!(wire["thinking_level"], "high");
        assert_eq!(wire["permission"], "acceptEdits");
        assert_eq!(wire["plan_mode"], true);
        // Absent effort falls back to "none" like the old field did.
        let empty = wire_session_runtime_status(&json!({ "data": {} }));
        assert_eq!(empty["thinking_level"], "none");
    }

    #[test]
    fn archived_reads_list_entry_flag() {
        let list = json!({
            "id": "sess_1",
            "title": "t",
            "created_at": "2026-01-01T00:00:00.000Z",
            "updated_at": "2026-01-01T00:00:00.000Z",
            "work_dir": "G:/repo",
            "archived": true,
        });
        let status = json!({ "data": { "model": "kimi" } });
        let context = json!({ "data": { "history": [] } });
        let ws = wire_session(&list, &status, &context, false);
        assert_eq!(ws["archived"], true);
        // Absent flag (today's engine summary) keeps the false default.
        let plain = json!({
            "id": "sess_1",
            "title": "t",
            "created_at": "2026-01-01T00:00:00.000Z",
            "updated_at": "2026-01-01T00:00:00.000Z",
            "work_dir": "G:/repo",
        });
        let ws = wire_session(&plain, &status, &context, false);
        assert_eq!(ws["archived"], false);
    }

    #[test]
    fn usage_updated_projects_to_v1_envelope() {
        let shared = V1Shared::new();
        let mut local = HashMap::new();
        let out = project_event(&shared, &mut local, &json!({
            "type": "session.usage.updated",
            "session_id": "sess_1",
            "turn_id": "t_1",
            "input_tokens": 12,
            "output_tokens": 34,
            "total_tokens": 46,
        }));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].1, "event.session.usage_updated");
        let p = &out[0].2;
        assert_eq!(p["usage"]["input_tokens"], json!(12));
        assert_eq!(p["usage"]["output_tokens"], json!(34));
        // Engine gaps pad to zero.
        assert_eq!(p["usage"]["cache_read_tokens"], json!(0));
        assert_eq!(p["usage"]["cache_creation_tokens"], json!(0));
        assert_eq!(p["usage"]["total_cost_usd"], json!(0));
        assert_eq!(p["usage"]["context_tokens"], json!(0));
        assert_eq!(p["usage"]["context_limit"], json!(0));
        assert_eq!(p["usage"]["turn_count"], json!(0));
        assert_eq!(p["delta"]["input_tokens"], json!(12));
        assert_eq!(p["delta"]["output_tokens"], json!(34));
        assert_eq!(p["delta"]["cache_read_tokens"], json!(0));
        assert_eq!(p["delta"]["cache_creation_tokens"], json!(0));
        assert_eq!(p["delta"]["cost_usd"], json!(0));
    }

    #[test]
    fn goal_updated_projects_snapshot() {
        let shared = V1Shared::new();
        let mut local = HashMap::new();
        let out = project_event(&shared, &mut local, &json!({
            "type": "session.goal.updated",
            "session_id": "sess_1",
            "status": "active",
            "snapshot": {
                "goalId": "g_1",
                "objective": "fix tests",
                "status": "active",
                "turnsUsed": 3,
            },
        }));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].1, "event.goal.updated");
        // The camelCase snapshot passes through untouched.
        let p = &out[0].2;
        assert_eq!(p["snapshot"]["goalId"], "g_1");
        assert_eq!(p["snapshot"]["objective"], "fix tests");
        assert_eq!(p["snapshot"]["status"], "active");
        assert_eq!(p["snapshot"]["turnsUsed"], json!(3));

        // A cleared goal (snapshot null) still projects.
        let out = project_event(&shared, &mut local, &json!({
            "type": "session.goal.updated",
            "session_id": "sess_1",
            "status": "none",
            "snapshot": null,
        }));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].1, "event.goal.updated");
        assert!(out[0].2["snapshot"].is_null());
    }
}
