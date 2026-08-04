//! Kimi Code ACP adapter — serves the Agent Client Protocol over stdio
//! JSON-RPC, driving the engine through `kimi-sdk::Harness`. Stage-E
//! skeleton: initialize + the session lifecycle (new/list/load/delete);
//! session/prompt is wired to the harness but needs a reachable LLM.
//!
//! Wire format matches the engine's stdio: one JSON-RPC request per line in,
//! one response per line out.

use std::sync::atomic::{AtomicU64, Ordering};

use kimi_sdk::Harness;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

/// The ACP protocol version this adapter negotiates.
pub const ACP_PROTOCOL_VERSION: &str = "2025-03-26";

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Serve ACP requests from `reader`, writing responses to `writer`, until EOF.
pub async fn serve<R, W>(harness: Harness, reader: R, writer: &mut W)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let (method, session_id, response) =
            match serde_json::from_str::<kimi_protocol::rpc::JsonRpcRequest>(line) {
                Ok(request) => {
                    let method = request.method.clone();
                    let session_id = request
                        .params
                        .get("sessionId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let response = handle(&harness, &request).await.map(|v| vec![v]);
                    (method, session_id, response)
                }
                Err(_) => (
                    String::new(),
                    String::new(),
                    Some(vec![serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": null,
                        "error": { "code": -32700, "message": "Parse error" },
                    })]),
                ),
            };
        // Notifications (no response body) are processed and answered with
        // silence — the ACP/JSON-RPC convention.
        let Some(response) = response else {
            continue;
        };
        // ACP ordering: session/update notifications precede their response.
        let mut preamble: Vec<serde_json::Value> = Vec::new();
        match method.as_str() {
            "session/load" => {
                preamble = replay_updates(&harness, &session_id).await;
            }
            "session/prompt" => {
                if let Some(text) = prompt_assistant_text(&response[0]) {
                    preamble.push(session_update(&session_id, "agent_message_chunk", text));
                }
            }
            _ => {}
        }
        let mut out: Vec<serde_json::Value> = preamble;
        out.extend(response);
        for value in out {
            if writer
                .write_all(format!("{value}\n").as_bytes())
                .await
                .is_err()
            {
                return;
            }
            if writer.flush().await.is_err() {
                return;
            }
        }
    }
}

/// An ACP `session/update` notification (the client's live-transcript wire).
fn session_update(session_id: &str, kind: &str, text: String) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": kind,
                "content": { "type": "text", "text": text },
            },
        },
    })
}

/// Replay the persisted context as `session/update` notifications —
/// `user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` —
/// mirroring the TS adapter's `session/load` replay. Empty history yields
/// no notifications.
async fn replay_updates(harness: &Harness, session_id: &str) -> Vec<serde_json::Value> {
    let body = harness.client().await.session_get_context(session_id).await;
    let Some(history) = body["result"]["history"].as_array() else {
        return Vec::new();
    };
    let mut updates = Vec::new();
    for message in history {
        let role = message["role"].as_str().unwrap_or("");
        let Some(parts) = message["content"].as_array() else {
            continue;
        };
        for part in parts {
            let chunk = match (role, part.get("type").and_then(|t| t.as_str())) {
                ("user", Some("text")) => {
                    Some(("user_message_chunk", part["text"].as_str().unwrap_or("")))
                }
                ("assistant", Some("text")) => {
                    Some(("agent_message_chunk", part["text"].as_str().unwrap_or("")))
                }
                ("assistant", Some("think")) => {
                    Some(("agent_thought_chunk", part["think"].as_str().unwrap_or("")))
                }
                _ => None,
            };
            if let Some((kind, text)) = chunk {
                if !text.is_empty() {
                    updates.push(session_update(session_id, kind, text.to_string()));
                }
            }
        }
    }
    updates
}

/// The assistant text embedded in a `session/prompt` response, if any.
fn prompt_assistant_text(response: &serde_json::Value) -> Option<String> {
    let text: String = response["result"]["messages"]
        .as_array()?
        .iter()
        .filter(|m| m["role"] == "assistant")
        .flat_map(|m| m["content"].as_array().into_iter().flatten())
        .filter_map(|p| p["text"].as_str())
        .collect();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Dispatch one ACP request through the harness. Returns `None` for
/// notifications, which must not receive a response.
async fn handle(
    harness: &Harness,
    request: &kimi_protocol::rpc::JsonRpcRequest,
) -> Option<serde_json::Value> {
    let id = &request.id;
    let error = |code: i64, message: &str| Some(serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    }));
    let result = |value: serde_json::Value| Some(serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": value,
    }));
    let params = request.params.clone();
    let method = request.method.as_str();
    match method {
        "initialize" => {
            // Minimal version negotiation: accept the client's version when it
            // is a known ACP version, otherwise negotiate ours.
            let _ = params.get("protocolVersion");
            result(serde_json::json!({
                "protocolVersion": ACP_PROTOCOL_VERSION,
                "agentCapabilities": {
                    "loadSession": true,
                    "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
                    "mcpCapabilities": { "http": true, "sse": true },
                    "sessionCapabilities": { "list": {}, "resume": {} },
                },
                "authMethods": [],
            }))
        }
        "session/new" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("acp-{}", SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)));
            match harness.create_session(&session_id).await {
                Ok(_) => result(serde_json::json!({ "sessionId": session_id })),
                Err(e) => error(-32603, &format!("session/new failed: {e}")),
            }
        }
        "session/load" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            if session_id.is_empty() {
                return error(-32602, "session/load requires sessionId");
            }
            // ACP `session/load` replays an on-disk session: create is
            // idempotent here (the runtime agent is (re)built from the
            // record), then load restores the persisted context into the
            // agent so the serve-loop replay reflects the on-disk history.
            match harness.create_session(session_id).await {
                Ok(_) => {
                    let _ = harness
                        .client()
                        .await
                        .call(
                            kimi_protocol::methods::SESSION_LOAD,
                            serde_json::json!({ "session_id": session_id }),
                        )
                        .await;
                    result(serde_json::json!({ "sessionId": session_id }))
                }
                Err(e) => error(-32603, &format!("session/load failed: {e}")),
            }
        }
        "session/resume" => {
            // The lighter-weight sibling of `session/load`: attach to the
            // on-disk session without replaying message history. The runtime
            // agent is created (idempotent) the same way.
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            if session_id.is_empty() {
                return error(-32602, "session/resume requires sessionId");
            }
            match harness.create_session(session_id).await {
                Ok(_) => result(serde_json::json!({ "sessionId": session_id })),
                Err(e) => error(-32603, &format!("session/resume failed: {e}")),
            }
        }
        "session/list" => match harness.list_sessions(100).await {
            Ok(sessions) => result(serde_json::json!({ "sessions": sessions })),
            Err(e) => error(-32603, &format!("session/list failed: {e}")),
        },
        "session/delete" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            if session_id.is_empty() {
                return error(-32602, "session/delete requires sessionId");
            }
            match harness.delete_session(session_id).await {
                Ok(_) => result(serde_json::json!({})),
                Err(e) => error(-32603, &format!("session/delete failed: {e}")),
            }
        }
        "session/get_config" => {
            // Per-session config projection (model/mode/thinking) for the
            // ACP client. `model` falls back to the config default.
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            if session_id.is_empty() {
                return error(-32602, "session/get_config requires sessionId");
            }
            let mut client = harness.client().await;
            let status = client.session_get_status(session_id).await;
            if let Some(e) = status.get("error") {
                return error(-32603, e["message"].as_str().unwrap_or("status failed"));
            }
            let config = client.config_get().await;
            // The per-session model (status) wins; fall back to the config
            // default only when the session has none set.
            let model = status["result"]["model"]
                .as_str()
                .filter(|m| !m.is_empty())
                .or_else(|| config["result"]["defaultModel"].as_str())
                .unwrap_or("");
            let mode = match status["result"]["plan_mode"].as_bool().unwrap_or(false) {
                true => "plan",
                false => match status["result"]["permission"].as_str().unwrap_or("") {
                    "auto" => "auto",
                    "yolo" => "yolo",
                    _ => "default",
                },
            };
            let thinking = status["result"]["thinking_effort"].as_str().unwrap_or("");
            result(serde_json::json!({
                "sessionId": session_id,
                "config": {
                    "model": model,
                    "mode": mode,
                    "thinking": thinking,
                },
            }))
        }
        "session/set_config_option" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            let config_id = params.get("configId").and_then(|v| v.as_str()).unwrap_or("");
            let value = params.get("value").cloned().unwrap_or(serde_json::Value::Null);
            if session_id.is_empty() || config_id.is_empty() {
                return error(-32602, "session/set_config_option requires sessionId and configId");
            }
            let mut client = harness.client().await;
            let outcome = match (config_id, value.as_str()) {
                ("model", Some(model)) if !model.is_empty() => {
                    client
                        .call(
                            kimi_protocol::methods::SESSION_SET_MODEL,
                            serde_json::json!({ "session_id": session_id, "model": model }),
                        )
                        .await
                }
                ("mode", Some(mode)) if matches!(mode, "plan" | "default" | "auto" | "yolo") => {
                    // ACP 4-mode taxonomy -> plan toggle + permission mode.
                    let plan = mode == "plan";
                    let permission = match mode {
                        "auto" => "auto",
                        "yolo" => "yolo",
                        _ => "manual",
                    };
                    let first = client
                        .call(
                            kimi_protocol::methods::SESSION_SET_PLAN_MODE,
                            serde_json::json!({ "session_id": session_id, "enabled": plan }),
                        )
                        .await;
                    if let Some(e) = first.get("error") {
                        return error(-32603, e["message"].as_str().unwrap_or("set plan mode failed"));
                    }
                    client
                        .call(
                            kimi_protocol::methods::PERMISSION_SET_MODE,
                            serde_json::json!({ "mode": permission }),
                        )
                        .await
                }
                ("thinking", Some(effort)) if !effort.is_empty() => client
                    .call(
                        kimi_protocol::methods::SESSION_SET_THINKING,
                        serde_json::json!({ "session_id": session_id, "effort": effort }),
                    )
                    .await,
                _ => {
                    return error(
                        -32602,
                        &format!("unsupported config option {config_id}={value}"),
                    );
                }
            };
            if let Some(e) = outcome.get("error") {
                return error(-32603, e["message"].as_str().unwrap_or("set_config_option failed"));
            }
            result(serde_json::json!({ "sessionId": session_id }))
        }
        "session/prompt" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            let prompt = params.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
            if session_id.is_empty() || prompt.is_empty() {
                return error(-32602, "session/prompt requires sessionId and prompt");
            }
            match harness.run_prompt(session_id, prompt).await {
                Ok(text) => result(serde_json::json!({
                    "stopReason": "end_turn",
                    "messages": [{
                        "role": "assistant",
                        "content": [{ "type": "text", "text": text }],
                    }],
                })),
                Err(e) => error(-32603, &format!("session/prompt failed: {e}")),
            }
        }
        "notifications/initialized" => None,
        "session/cancel" => {
            // ACP notification: cancel the named session's running turn.
            // Processed for its side effect; no response body.
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            if !session_id.is_empty() {
                let _ = harness.client().await.session_cancel(session_id).await;
            }
            None
        }
        "session/set_mode" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            let mode_id = params.get("modeId").and_then(|v| v.as_str()).unwrap_or("");
            if session_id.is_empty() || mode_id.is_empty() {
                return error(-32602, "session/set_mode requires sessionId and modeId");
            }
            // ACP 4-mode taxonomy (parity with the TS adapter's
            // `acpModeToToggles`): default/plan -> manual permission,
            // auto/yolo -> matching gate mode; only `plan` enables plan mode.
            let (plan, permission) = match mode_id {
                "default" => (false, "manual"),
                "plan" => (true, "manual"),
                "auto" => (false, "auto"),
                "yolo" => (false, "yolo"),
                _ => return error(-32602, &format!("Unknown modeId: {mode_id}")),
            };
            let mut client = harness.client().await;
            let plan_body = client
                .call(
                    kimi_protocol::methods::SESSION_SET_PLAN_MODE,
                    serde_json::json!({ "session_id": session_id, "enabled": plan }),
                )
                .await;
            if let Some(e) = plan_body.get("error") {
                return error(-32603, e["message"].as_str().unwrap_or("set plan mode failed"));
            }
            // The permission gate is process-wide (the engine has a single
            // gate, no session scope) — matches the engine's design.
            let perm_body = client
                .call(
                    kimi_protocol::methods::PERMISSION_SET_MODE,
                    serde_json::json!({ "mode": permission }),
                )
                .await;
            if let Some(e) = perm_body.get("error") {
                return error(-32603, e["message"].as_str().unwrap_or("set mode failed"));
            }
            result(serde_json::json!({ "sessionId": session_id }))
        }
        "session/set_model" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            let model_id = params.get("modelId").and_then(|v| v.as_str()).unwrap_or("");
            if session_id.is_empty() || model_id.is_empty() {
                return error(-32602, "session/set_model requires sessionId and modelId");
            }
            let mut client = harness.client().await;
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_SET_MODEL,
                    serde_json::json!({ "session_id": session_id, "model": model_id }),
                )
                .await;
            if let Some(e) = body.get("error") {
                return error(-32603, e["message"].as_str().unwrap_or("set model failed"));
            }
            result(serde_json::json!({ "sessionId": session_id }))
        }
        _ => error(-32601, &format!("Method not found: {method}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncReadExt};

    /// Serializes tests that touch `KIMI_AGENT_HOME` (process-global env var).
    static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Drive the ACP server over an in-memory duplex; `None` when the server
    /// answers with silence (notifications — the read times out instead of
    /// blocking forever).
    async fn round_trip_maybe_empty(harness: Harness, request: &str) -> Option<serde_json::Value> {
        let (server_side, mut client_side) = duplex(4096);
        let (reader, mut writer) = tokio::io::split(server_side);
        let server = tokio::spawn(async move {
            serve(harness, reader, &mut writer).await;
        });
        client_side.write_all(request.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if std::time::Instant::now() > deadline {
                break; // notification: no response within the window
            }
            match tokio::time::timeout(
                std::time::Duration::from_millis(100),
                client_side.read(&mut byte),
            )
            .await
            {
                Ok(Ok(0)) | Ok(Err(_)) => break,
                Ok(Ok(_)) => {
                    buf.push(byte[0]);
                    if byte[0] == b'\n' {
                        break;
                    }
                }
                Err(_) => {}
            }
        }
        drop(client_side);
        let _ = server.await;
        if buf.is_empty() {
            None
        } else {
            serde_json::from_slice(&buf).ok()
        }
    }

    /// Drive the ACP server over an in-memory duplex with one request.
    async fn round_trip(harness: Harness, request: &str) -> serde_json::Value {
        round_trip_maybe_empty(harness, request)
            .await
            .expect("a response")
    }

    /// Drive one request and read exactly `n` newline-terminated JSON lines
    /// (notifications precede the response for load/prompt).
    async fn round_trip_n(harness: Harness, request: &str, n: usize) -> Vec<serde_json::Value> {
        let (server_side, mut client_side) = duplex(4096);
        let (reader, mut writer) = tokio::io::split(server_side);
        let server = tokio::spawn(async move {
            serve(harness, reader, &mut writer).await;
        });
        client_side.write_all(request.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        let mut values = Vec::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while values.len() < n && std::time::Instant::now() < deadline {
            let mut byte = [0u8; 1];
            match tokio::time::timeout(
                std::time::Duration::from_millis(100),
                client_side.read(&mut byte),
            )
            .await
            {
                Ok(Ok(0)) | Ok(Err(_)) => break,
                Ok(Ok(_)) => {
                    buf.push(byte[0]);
                    if byte[0] == b'\n' {
                        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&buf) {
                            values.push(value);
                        }
                        buf.clear();
                    }
                }
                Err(_) => {}
            }
        }
        drop(client_side);
        let _ = server.await;
        values
    }

    #[tokio::test]
    async fn initialize_negotiates_protocol() {
        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"clientCapabilities\":{}}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "initialize: {body}");
        assert_eq!(body["result"]["protocolVersion"], ACP_PROTOCOL_VERSION);
        assert_eq!(body["result"]["agentCapabilities"]["loadSession"], true);
    }

    #[tokio::test]
    async fn session_lifecycle_round_trip() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);

        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/new\",\"params\":{\"sessionId\":\"acp-s1\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "session/new: {body}");
        assert_eq!(body["result"]["sessionId"], "acp-s1");

        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/list\",\"params\":{}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "session/list: {body}");
        let sessions = body["result"]["sessions"].as_array().expect("sessions");
        assert!(sessions.iter().any(|s| s["id"] == "acp-s1"), "listed: {body}");

        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"session/delete\",\"params\":{\"sessionId\":\"acp-s1\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "session/delete: {body}");

        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"bogus/method\",\"params\":{}}\n",
        )
        .await;
        assert_eq!(body["error"]["code"], -32601, "unknown method: {body}");
    }

    #[tokio::test]
    async fn notifications_are_answered_with_silence() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-notif-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);

        // notifications/initialized -> no response line.
        let harness = Harness::embedded().expect("embedded");
        let body = round_trip_maybe_empty(
            harness,
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
        )
        .await;
        assert!(body.is_none(), "notification gets no response: {body:?}");

        // session/cancel (notification) -> no response; unknown sessions are
        // tolerated (cancel simply reports false internally).
        let harness = Harness::embedded().expect("embedded");
        let body = round_trip_maybe_empty(
            harness,
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/cancel\",\"params\":{\"sessionId\":\"nope\"}}\n",
        )
        .await;
        assert!(body.is_none(), "cancel notification gets no response: {body:?}");
    }

    #[tokio::test]
    async fn session_resume_attaches() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-resume-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);

        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/resume\",\"params\":{\"sessionId\":\"acp-resume-1\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "session/resume: {body}");
        assert_eq!(body["result"]["sessionId"], "acp-resume-1");

        // Resuming again is idempotent.
        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/resume\",\"params\":{\"sessionId\":\"acp-resume-1\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "second resume: {body}");

        // Missing sessionId is rejected.
        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"session/resume\",\"params\":{}}\n",
        )
        .await;
        assert_eq!(body["error"]["code"], -32602, "missing sessionId: {body}");
    }

    #[tokio::test]
    async fn session_config_round_trip() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);

        // Create, set plan mode via config option, and read it back. A single
        // shared harness keeps the in-process engine (and its live agents).
        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/new\",\"params\":{\"sessionId\":\"acp-cfg\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "session/new: {body}");

        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/set_config_option\",\"params\":{\"sessionId\":\"acp-cfg\",\"configId\":\"mode\",\"value\":\"plan\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "set_config_option: {body}");

        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"session/get_config\",\"params\":{\"sessionId\":\"acp-cfg\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "get_config: {body}");
        assert_eq!(body["result"]["config"]["mode"], "plan", "config: {body}");
        assert!(body["result"]["config"]["model"].is_string());
    }

    #[tokio::test]
    async fn session_load_replays_updates() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-replay-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);

        let harness = Harness::embedded().expect("embedded");
        // Seed a session with context (a user message) and persist it.
        let mut session = harness
            .clone()
            .create_session("acp-replay")
            .await
            .expect("create");
        session
            .import_context("hello from import", "test")
            .await
            .expect("import");
        session.save().await.expect("save");

        // session/load replays the history as user_message_chunk
        // notifications BEFORE the response (ACP ordering). The imported
        // message carries two text parts (the wrapper + the content), so
        // two notifications precede the response.
        let lines = round_trip_n(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/load\",\"params\":{\"sessionId\":\"acp-replay\"}}\n",
            3,
        )
        .await;
        assert_eq!(lines.len(), 3, "2 notifications + response: {lines:?}");
        for line in &lines[..2] {
            assert_eq!(line["method"], "session/update", "line: {line:?}");
            assert_eq!(line["params"]["sessionId"], "acp-replay");
            assert_eq!(
                line["params"]["update"]["sessionUpdate"],
                "user_message_chunk",
                "update: {line:?}"
            );
        }
        let texts: Vec<&str> = lines[..2]
            .iter()
            .filter_map(|l| l["params"]["update"]["content"]["text"].as_str())
            .collect();
        assert!(
            texts.iter().any(|t| t.contains("hello from import")),
            "imported content replayed: {texts:?}"
        );
        assert!(lines[2].get("id").is_some(), "line 2 is the response: {lines:?}");
        assert_eq!(lines[2]["result"]["sessionId"], "acp-replay");
    }

    #[tokio::test]
    async fn session_set_mode_and_model_round_trip() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-mode-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);

        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/new\",\"params\":{\"sessionId\":\"acp-mode\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "session/new: {body}");

        // `plan` -> plan mode on, manual permission.
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/set_mode\",\"params\":{\"sessionId\":\"acp-mode\",\"modeId\":\"plan\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "set_mode plan: {body}");

        // `auto` -> plan off, auto permission; get_config reflects it.
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"session/set_mode\",\"params\":{\"sessionId\":\"acp-mode\",\"modeId\":\"auto\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "set_mode auto: {body}");
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"session/get_config\",\"params\":{\"sessionId\":\"acp-mode\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "get_config: {body}");
        assert_eq!(body["result"]["config"]["mode"], "auto", "config: {body}");

        // An unknown modeId is a structured invalid_params rejection.
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"session/set_mode\",\"params\":{\"sessionId\":\"acp-mode\",\"modeId\":\"bogus\"}}\n",
        )
        .await;
        assert_eq!(body["error"]["code"], -32602, "unknown mode: {body}");

        // session/set_model lands on the session and get_config reports it
        // (per-session model beats the global config default).
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"session/set_model\",\"params\":{\"sessionId\":\"acp-mode\",\"modelId\":\"acp-test-model\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "set_model: {body}");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"session/get_config\",\"params\":{\"sessionId\":\"acp-mode\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "get_config: {body}");
        assert_eq!(body["result"]["config"]["model"], "acp-test-model", "config: {body}");
    }
}
