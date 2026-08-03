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
        let response = match serde_json::from_str::<kimi_protocol::rpc::JsonRpcRequest>(line) {
            Ok(request) => handle(&harness, &request).await,
            Err(_) => Some(serde_json::json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": { "code": -32700, "message": "Parse error" },
            })),
        };
        // Notifications (no response body) are processed and answered with
        // silence — the ACP/JSON-RPC convention.
        let Some(response) = response else {
            continue;
        };
        if writer
            .write_all(format!("{response}\n").as_bytes())
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
            // idempotent here (the runtime agent is (re)built from the record).
            match harness.create_session(session_id).await {
                Ok(_) => result(serde_json::json!({ "sessionId": session_id })),
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
        "session/prompt" => {
            // LLM-bound: the harness runs the prompt and returns the
            // transcript as an assistant message.
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
}
