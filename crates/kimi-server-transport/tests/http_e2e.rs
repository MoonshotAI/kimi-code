//! End-to-end: a full kimi-server served over the HTTP/REST `/api/v1`
//! projection, driven through a real HTTP client — the path kimi-web /
//! vscode / kimi-inspect take.
//!
//! The REST surface speaks the kap-server v1 wire contract (`WireSession`
//! records, `{ items, has_more }` pages) and the WS surface is the v1
//! `server_hello` / `client_hello` / `subscribe` facade with `event.*`
//! envelopes — the shapes kimi-web's daemon client actually consumes.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use kimi_protocol::wire_types::{LlmChatRequest, LlmChatResponse, TokenUsage};
use kimi_server::Server;

/// A one-shot fake LLM: text, no tool calls -> EndTurn after one step
/// (mirrors kimi-sdk `fake_llm`).
fn fake_llm() -> kimi_server::callbacks::LlmStep {
    Arc::new(move |_req: LlmChatRequest| {
        Box::pin(async move {
            Ok(LlmChatResponse {
                content: "hello from fake llm".into(),
                tool_calls: vec![],
                finish_reason: Some("stop".into()),
                usage: TokenUsage {
                    input_tokens: 10,
                    output_tokens: 10,
                    total_tokens: 20,
                },
            })
        })
    })
}

/// A fresh isolated engine home (unique per test to avoid cross-test store
/// interference).
fn home(tag: &str) -> std::path::PathBuf {
    let home = std::env::temp_dir().join(format!("kimi-http-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("mkdir");
    std::env::set_var("KIMI_AGENT_HOME", &home);
    home
}

/// Build a full server (fake LLM) and serve the HTTP projection with the
/// engine event source on an ephemeral port.
async fn spawn_http(tag: &str) -> (String, tokio::task::JoinHandle<()>) {
    home(tag);
    let server = Server::build_with_llm_step(fake_llm()).expect("server");
    let processor = Arc::new(server.processor);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let serving = tokio::spawn(async move {
        let _ = kimi_server_transport::http::serve_with_events(
            processor,
            server.state.event_sender(),
            listener,
        )
        .await;
    });
    (format!("http://{addr}"), serving)
}

#[tokio::test]
async fn ws_upgrade_serves_v1_handshake() {
    let (base, serving) = spawn_http("ws-handshake").await;
    let ws_url = base.replace("http://", "ws://");

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("{ws_url}/api/v1/ws"))
        .await
        .expect("connect");

    // The server greets first.
    let frame = ws.next().await.expect("hello").expect("frame");
    let tokio_tungstenite::tungstenite::Message::Text(text) = frame else {
        panic!("expected text frame: {frame:?}");
    };
    let hello: serde_json::Value = serde_json::from_str(&text).expect("json");
    assert_eq!(hello["type"], "server_hello", "hello: {hello}");
    assert!(hello["payload"]["ws_connection_id"].is_string());
    assert!(hello["payload"]["heartbeat_ms"].is_number());

    // client_hello → ack.
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        serde_json::json!({
            "type": "client_hello",
            "id": "c_1",
            "payload": { "client_id": "web_1", "subscriptions": [], "cursors": {} },
        })
        .to_string()
        .into(),
    ))
    .await
    .expect("send client_hello");
    let frame = ws.next().await.expect("ack").expect("frame");
    let tokio_tungstenite::tungstenite::Message::Text(text) = frame else {
        panic!("expected text frame: {frame:?}");
    };
    let ack: serde_json::Value = serde_json::from_str(&text).expect("json");
    assert_eq!(ack["type"], "ack", "ack: {ack}");
    assert_eq!(ack["id"], "c_1", "ack id: {ack}");
    assert_eq!(ack["code"], 0, "ack code: {ack}");

    ws.close(None).await.expect("close");
    serving.abort();
}

#[tokio::test]
async fn bearer_auth_gates_rest_and_ws() {
    home("auth");
    let server = Server::build().expect("server");
    let processor = Arc::new(server.processor);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let auth = kimi_server_transport::http::AuthConfig {
        token: Some("sekret-token".to_string()),
    };
    let serving = tokio::spawn(async move {
        let state = kimi_server_transport::http::HttpState::with_events(
            processor,
            server.state.event_sender(),
        )
        .with_auth(auth);
        let _ = axum::serve(listener, kimi_server_transport::http::router(state)).await;
    });
    let base = format!("http://{addr}");

    // No credential → 401 envelope.
    let resp = reqwest::get(format!("{base}/api/v1/health"))
        .await
        .expect("request")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 40101, "no-auth: {resp}");

    // Correct credential → ok.
    let resp = reqwest::Client::new()
        .get(format!("{base}/api/v1/health"))
        .bearer_auth("sekret-token")
        .send()
        .await
        .expect("request")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "auth: {resp}");

    serving.abort();
}

#[tokio::test]
async fn http_v1_session_contract() {
    let (base, serving) = spawn_http("contract").await;
    let client = reqwest::Client::new();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();

    // healthz alias (kimi-web probes this path).
    let resp = reqwest::get(format!("{base}/api/v1/healthz"))
        .await
        .expect("healthz")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "healthz: {resp}");
    assert_eq!(resp["data"]["status"], "ok", "healthz: {resp}");

    // Create with a v1 body → WireSession-shaped response with cwd landed.
    let resp = client
        .post(format!("{base}/api/v1/sessions"))
        .json(&serde_json::json!({
            "metadata": { "cwd": cwd },
            "title": "v1 session",
            "agent_config": { "model": "kimi" },
        }))
        .send()
        .await
        .expect("create")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "create: {resp}");
    let session = &resp["data"];
    assert_eq!(session["metadata"]["cwd"], cwd, "cwd landed: {resp}");
    assert_eq!(session["agent_config"]["model"], "kimi", "model: {resp}");
    assert!(session["metadata"]["cwd"].is_string());
    let sid = session["id"].as_str().expect("session id");

    // Create without cwd → error.
    let resp = client
        .post(format!("{base}/api/v1/sessions"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("create-no-cwd")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_ne!(resp["code"], 0, "no-cwd must fail: {resp}");

    // Create with a nonexistent cwd → error.
    let resp = client
        .post(format!("{base}/api/v1/sessions"))
        .json(&serde_json::json!({ "metadata": { "cwd": "Z:/does/not/exist" } }))
        .send()
        .await
        .expect("create-bad-cwd")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_ne!(resp["code"], 0, "bad-cwd must fail: {resp}");

    // List → `{ items, has_more }` page of WireSession records.
    let resp = client
        .get(format!("{base}/api/v1/sessions"))
        .send()
        .await
        .expect("list")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "list: {resp}");
    assert_eq!(resp["data"]["has_more"], false, "has_more: {resp}");
    let items = resp["data"]["items"].as_array().expect("items");
    assert!(
        items.iter().any(|s| s["id"] == sid),
        "listed contains created: {resp}"
    );
    let listed = items.iter().find(|s| s["id"] == sid).expect("session");
    assert_eq!(listed["metadata"]["cwd"], cwd, "listed cwd: {resp}");
    assert!(listed["usage"]["input_tokens"].is_number(), "usage: {resp}");
    assert!(listed["permission_rules"].is_array(), "rules: {resp}");

    // Detail → full WireSession.
    let resp = client
        .get(format!("{base}/api/v1/sessions/{sid}"))
        .send()
        .await
        .expect("detail")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "detail: {resp}");
    assert_eq!(resp["data"]["metadata"]["cwd"], cwd, "detail cwd: {resp}");

    // Runtime status → WireSessionRuntimeStatus fields.
    let resp = client
        .get(format!("{base}/api/v1/sessions/{sid}/status"))
        .send()
        .await
        .expect("status")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "status: {resp}");
    let status = &resp["data"];
    assert!(status["thinking_level"].is_string(), "thinking: {status}");
    assert!(status["permission"].is_string(), "permission: {status}");
    assert!(status["context_tokens"].is_number(), "tokens: {status}");

    // Snapshot → v1 shape incl. the pending arrays the client maps.
    let resp = client
        .get(format!("{base}/api/v1/sessions/{sid}/snapshot"))
        .send()
        .await
        .expect("snapshot")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "snapshot: {resp}");
    let snapshot = &resp["data"];
    assert_eq!(snapshot["session"]["metadata"]["cwd"], cwd, "snap session: {resp}");
    assert!(snapshot["messages"]["items"].is_array(), "messages: {resp}");
    assert_eq!(snapshot["pending_approvals"].as_array().map(|a| a.len()), Some(0), "approvals: {resp}");
    assert_eq!(snapshot["pending_questions"].as_array().map(|a| a.len()), Some(0), "questions: {resp}");
    assert_eq!(snapshot["subagents"].as_array().map(|a| a.len()), Some(0), "subagents: {resp}");

    serving.abort();
}

#[tokio::test]
async fn http_v1_prompt_async_returns_immediately_and_resets_busy() {
    let (base, serving) = spawn_http("prompt").await;
    let client = reqwest::Client::new();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();

    let resp = client
        .post(format!("{base}/api/v1/sessions"))
        .json(&serde_json::json!({ "metadata": { "cwd": cwd } }))
        .send()
        .await
        .expect("create")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    let sid = resp["data"]["id"].as_str().expect("id").to_string();

    // Async submit returns immediately with prompt ids.
    let submitted = std::time::Instant::now();
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}/prompts"))
        .json(&serde_json::json!({
            "content": [{ "type": "text", "text": "hello" }],
        }))
        .send()
        .await
        .expect("prompt")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "prompt: {resp}");
    assert!(resp["data"]["prompt_id"].is_string(), "prompt_id: {resp}");
    assert!(resp["data"]["user_message_id"].is_string(), "user_message_id: {resp}");
    assert_eq!(resp["data"]["status"], "accepted", "status: {resp}");
    assert!(
        submitted.elapsed() < std::time::Duration::from_secs(2),
        "submit must not block"
    );

    // The background turn completes (fake LLM) → busy flag resets.
    let mut busy = true;
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let resp = client
            .get(format!("{base}/api/v1/sessions/{sid}"))
            .send()
            .await
            .expect("status")
            .json::<serde_json::Value>()
            .await
            .expect("json");
        busy = resp["data"]["busy"].as_bool().unwrap_or(true);
        if !busy {
            break;
        }
    }
    assert!(!busy, "busy must reset after the turn completes");

    // The turn's messages are reflected in the snapshot.
    let resp = client
        .get(format!("{base}/api/v1/sessions/{sid}/snapshot"))
        .send()
        .await
        .expect("snapshot")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    let messages = resp["data"]["messages"]["items"].as_array().expect("messages");
    assert!(
        messages.iter().any(|m| m["role"] == "user" && m["content"][0]["text"] == "hello"),
        "user message in snapshot: {resp}"
    );
    assert!(
        messages.iter().any(|m| m["role"] == "assistant"),
        "assistant message in snapshot: {resp}"
    );

    serving.abort();
}

#[tokio::test]
async fn ws_v1_streams_turn_events_after_subscribe() {
    let (base, serving) = spawn_http("ws-stream").await;
    let ws_url = base.replace("http://", "ws://");
    let client = reqwest::Client::new();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();

    let resp = client
        .post(format!("{base}/api/v1/sessions"))
        .json(&serde_json::json!({ "metadata": { "cwd": cwd } }))
        .send()
        .await
        .expect("create")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    let sid = resp["data"]["id"].as_str().expect("id").to_string();

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("{ws_url}/api/v1/ws"))
        .await
        .expect("connect");
    // server_hello first.
    let hello = next_frame(&mut ws).await;
    assert_eq!(hello["type"], "server_hello", "hello: {hello}");

    // client_hello → ack.
    ws.send(text_frame(serde_json::json!({
        "type": "client_hello",
        "id": "c_1",
        "payload": { "client_id": "web_1", "subscriptions": [], "cursors": {} },
    })))
    .await
    .expect("send hello");
    let ack = next_frame(&mut ws).await;
    assert_eq!(ack["type"], "ack", "ack: {ack}");

    // subscribe → ack.
    ws.send(text_frame(serde_json::json!({
        "type": "subscribe",
        "id": "c_2",
        "payload": { "session_ids": [sid], "cursors": {} },
    })))
    .await
    .expect("send subscribe");
    let ack = next_frame(&mut ws).await;
    assert_eq!(ack["type"], "ack", "ack: {ack}");
    assert_eq!(ack["payload"]["accepted_subscriptions"][0], sid, "accepted: {ack}");

    // Submit a prompt over REST; the WS should carry the v1 event stream.
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}/prompts"))
        .json(&serde_json::json!({ "content": [{ "type": "text", "text": "hello" }] }))
        .send()
        .await
        .expect("prompt")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "prompt: {resp}");

    // Collect the projected envelopes until the busy flag resets.
    let mut events = Vec::new();
    for _ in 0..16 {
        let frame = next_frame(&mut ws).await;
        let ty = frame["type"].as_str().expect("event type");
        assert_eq!(frame["session_id"], sid, "session: {frame}");
        assert!(frame["seq"].is_number(), "seq: {frame}");
        assert!(frame["timestamp"].is_string(), "timestamp: {frame}");
        events.push(ty.to_string());
        if ty == "event.session.work_changed" && frame["payload"]["busy"] == serde_json::json!(false) {
            break;
        }
    }

    // The turn lifecycle must appear: busy on, user message, then the close.
    assert!(
        events.iter().any(|t| t == "event.session.work_changed"),
        "busy events: {events:?}"
    );
    assert!(
        events.iter().any(|t| t == "event.message.created"),
        "user message: {events:?}"
    );
    assert!(
        events.iter().any(|t| t == "event.message.updated"),
        "message update: {events:?}"
    );
    assert!(
        events.iter().any(|t| t == "event.assistant.completed"),
        "assistant completed: {events:?}"
    );
    assert_eq!(events.last().map(String::as_str), Some("event.session.work_changed"), "busy reset last: {events:?}");

    ws.close(None).await.expect("close");
    serving.abort();
}

// ── WS helpers ───────────────────────────────────────────────────────────

fn text_frame(value: serde_json::Value) -> tokio_tungstenite::tungstenite::Message {
    tokio_tungstenite::tungstenite::Message::Text(value.to_string().into())
}

async fn next_frame<S>(ws: &mut S) -> serde_json::Value
where
    S: futures_util::Stream<Item = Result<tokio_tungstenite::tungstenite::Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
{
    let frame = tokio::time::timeout(std::time::Duration::from_secs(10), ws.next())
        .await
        .expect("frame within 10s")
        .expect("stream alive")
        .expect("frame ok");
    let tokio_tungstenite::tungstenite::Message::Text(text) = frame else {
        panic!("expected text frame: {frame:?}");
    };
    serde_json::from_str(&text).expect("json")
}
