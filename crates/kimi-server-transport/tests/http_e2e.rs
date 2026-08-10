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
    // Also isolate the user-level engine config: config-loading RPCs (e.g.
    // oauth/logout) read `$KIMI_CODE_HOME/config.toml` — without this the
    // tests read the real user config and fail on any broken file there.
    std::env::set_var("KIMI_CODE_HOME", &home);
    home
}

/// Serializes tests that pin the engine config via env vars
/// (`KIMI_CONFIG_PATH` / `KIMI_CODE_HOME`): cargo runs tests in parallel but
/// the process env is global, so config-seeding tests would read each other's
/// files. Other tests only touch `KIMI_CODE_HOME` (via `home()`), which the
/// pinned `KIMI_CONFIG_PATH` overrides. Also covers the oauth/logout config
/// write (a CONFIG_SET that merges + rewrites whichever config file the
/// ambient env points at).
static CONFIG_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// RAII restore of a process env var — drop-safe: the previous value is put
/// back even when the test panics mid-flight, so a failed assertion cannot
/// leave `KIMI_CONFIG_PATH` pinned for other parallel tests.
struct EnvGuard {
    name: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl EnvGuard {
    fn set(name: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
        let previous = std::env::var_os(name);
        std::env::set_var(name, value);
        Self { name, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(previous) => std::env::set_var(self.name, previous),
            None => std::env::remove_var(self.name),
        }
    }
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
async fn host_check_rejects_disallowed_host_headers() {
    home("host-check");
    let server = Server::build().expect("server");
    let processor = Arc::new(server.processor);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let serving = tokio::spawn(async move {
        let state = kimi_server_transport::http::HttpState::with_events(
            processor,
            server.state.event_sender(),
        )
        .with_host_check(kimi_server_transport::http::HostCheckConfig {
            bound_host: Some("127.0.0.1".into()),
            extra: vec![".example.com".into()],
            disable: false,
        });
        let _ = axum::serve(listener, kimi_server_transport::http::router(state)).await;
    });
    let base = format!("http://{addr}");

    // A disallowed Host header → 403 envelope (DNS-rebinding defence).
    let resp = reqwest::Client::new()
        .get(format!("{base}/api/v1/health"))
        .header("Host", "evil.test")
        .send()
        .await
        .expect("request")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 40301, "disallowed host: {resp}");

    // The bound host and an allowed suffix pass.
    for host in ["127.0.0.1", "a.example.com"] {
        let resp = reqwest::Client::new()
            .get(format!("{base}/api/v1/health"))
            .header("Host", host)
            .send()
            .await
            .expect("request")
            .json::<serde_json::Value>()
            .await
            .expect("json");
        assert_eq!(resp["code"], 0, "allowed host {host}: {resp}");
    }

    serving.abort();
}

#[tokio::test]
async fn shutdown_route_gated_on_non_loopback_bind() {
    home("shutdown-gate");
    let server = Server::build().expect("server");
    let processor = Arc::new(server.processor);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let serving = tokio::spawn(async move {
        let state = kimi_server_transport::http::HttpState::with_events(
            processor,
            server.state.event_sender(),
        )
        // Simulate a non-loopback bind: remote shutdown is refused unless
        // explicitly allowed.
        .with_allow_remote_shutdown(false);
        let _ = axum::serve(listener, kimi_server_transport::http::router(state)).await;
    });
    let base = format!("http://{addr}");

    let resp = reqwest::Client::new()
        .post(format!("{base}/api/v1/shutdown"))
        .send()
        .await
        .expect("request")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 40302, "gated shutdown: {resp}");

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

    // Usage → the v1 zero-valued WireSessionUsage shape (the engine reports
    // an empty structure before any turn; the projection must fill zeros so
    // frontend field reads never see `undefined`).
    let resp = client
        .get(format!("{base}/api/v1/sessions/{sid}/usage"))
        .send()
        .await
        .expect("usage")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "usage: {resp}");
    for field in [
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_creation_tokens",
        "context_tokens",
        "context_limit",
        "turn_count",
    ] {
        assert_eq!(resp["data"][field], 0, "usage {field}: {resp}");
    }
    assert_eq!(resp["data"]["total_cost_usd"], 0.0, "cost: {resp}");

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
async fn http_v1_extended_routes() {
    // The remaining v1 session surface the web client uses: profile updates,
    // goal/warnings reads, messages page, compact/undo/abort, tasks, skill
    // activation, oauth logout, and the colon-suffix route rewrite.
    let (base, serving) = spawn_http("extended").await;
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

    // profile: rename + model + plan mode, returns the updated WireSession.
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}/profile"))
        .json(&serde_json::json!({
            "title": "renamed",
            "agent_config": { "model": "kimi", "plan_mode": true },
        }))
        .send()
        .await
        .expect("profile")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "profile: {resp}");
    assert_eq!(resp["data"]["title"], "renamed", "title applied: {resp}");
    assert_eq!(resp["data"]["agent_config"]["model"], "kimi", "model: {resp}");

    // goal: no active goal -> null data.
    let resp = client
        .get(format!("{base}/api/v1/sessions/{sid}/goal"))
        .send()
        .await
        .expect("goal")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "goal: {resp}");
    assert!(resp["data"].is_null(), "no goal: {resp}");

    // warnings: shape `{ warnings: [...] }`.
    let resp = client
        .get(format!("{base}/api/v1/sessions/{sid}/warnings"))
        .send()
        .await
        .expect("warnings")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "warnings: {resp}");
    assert!(resp["data"]["warnings"].is_array(), "warnings array: {resp}");

    // messages: `{ items, has_more }` page.
    let resp = client
        .get(format!("{base}/api/v1/sessions/{sid}/messages"))
        .send()
        .await
        .expect("messages")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "messages: {resp}");
    assert!(resp["data"]["items"].is_array(), "items: {resp}");
    assert_eq!(resp["data"]["has_more"], false, "has_more: {resp}");

    // Colon-suffix rewrite: `/sessions/{id}:compact` hits the slash route.
    // The engine has no compaction delegate in the test harness, so the
    // response carries the compact-specific error — proving the route
    // matched (a miss would fall through to the session-update handler).
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}:compact"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("compact")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    let msg = resp["msg"].as_str().unwrap_or("");
    assert!(
        msg.contains("compaction") || resp["code"].as_i64() == Some(0),
        "compact route matched: {resp}"
    );

    // undo: empty history errors with the undo-specific message — proving
    // the `/sessions/{id}:undo` colon route hit the undo handler.
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}:undo"))
        .json(&serde_json::json!({ "count": 1 }))
        .send()
        .await
        .expect("undo")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    let msg = resp["msg"].as_str().unwrap_or("");
    assert!(
        msg.contains("undo") || resp["code"].as_i64() == Some(0),
        "undo route matched: {resp}"
    );

    // tasks: empty list in the WirePage shape (`{ items, has_more }`).
    let resp = client
        .get(format!("{base}/api/v1/sessions/{sid}/tasks"))
        .send()
        .await
        .expect("tasks")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "tasks: {resp}");
    assert_eq!(resp["data"]["items"], serde_json::json!([]), "task items: {resp}");
    assert_eq!(resp["data"]["has_more"], false, "task has_more: {resp}");

    // A single unknown task id errors with the not-found code.
    let resp = client
        .get(format!("{base}/api/v1/sessions/{sid}/tasks/nope"))
        .send()
        .await
        .expect("task get")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], -40406, "task not found: {resp}");

    // oauth logout: removes providers.kimi — a config write (CONFIG_SET
    // merges + rewrites whichever config file the ambient env points at), so
    // serialize against the config-seeding tests that pin KIMI_CONFIG_PATH.
    let _logout_guard = CONFIG_LOCK.lock().await;
    let resp = client
        .post(format!("{base}/api/v1/oauth/logout"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("logout")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "logout: {resp}");
    assert_eq!(resp["data"]["logged_out"], true, "logged out: {resp}");

    serving.abort();
}

#[tokio::test]
async fn http_v1_fs_projection_shapes() {
    // The fs:action routes project the kimi-web wire shapes: fs:list /
    // fs:search return `{ items, truncated }` entry lists, fs:read returns
    // the full file-read record, and fs:git_status errors on non-repos
    // instead of returning a bare `{ unavailable }`.
    let (base, serving) = spawn_http("fs-shapes").await;
    let client = reqwest::Client::new();
    let cwd = std::env::temp_dir().join(format!("kimi-http-fs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&cwd);
    std::fs::create_dir_all(cwd.join("src")).expect("mkdir");
    std::fs::write(cwd.join("hello.txt"), "hi\n").expect("write");
    std::fs::write(cwd.join("src/lib.rs"), "pub fn lib() {}\n").expect("write");
    std::fs::write(cwd.join(".hidden"), "nope").expect("write");
    let cwd = cwd.to_string_lossy().into_owned();

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

    // fs:list → `{ items: WireFsEntry[], truncated }`, dirs first.
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}/fs:list"))
        .json(&serde_json::json!({ "path": "." }))
        .send()
        .await
        .expect("list")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "list: {resp}");
    assert_eq!(resp["data"]["truncated"], false, "truncated: {resp}");
    let items = resp["data"]["items"].as_array().expect("items");
    assert_eq!(items[0]["kind"], "directory", "dirs first: {resp}");
    let file = items.iter().find(|e| e["name"] == "hello.txt").expect("hello.txt");
    assert_eq!(file["path"], "hello.txt", "rel path: {resp}");
    assert_eq!(file["kind"], "file");
    assert_eq!(file["size"], 3);
    assert!(file["modified_at"].is_string(), "mtime: {resp}");
    assert!(file["etag"].is_string(), "etag: {resp}");
    let dir = items.iter().find(|e| e["name"] == "src").expect("src dir");
    assert_eq!(dir["kind"], "directory");
    assert!(
        !items.iter().any(|e| e["name"] == ".hidden"),
        "hidden excluded: {resp}"
    );

    // fs:list of a subdirectory → workspace-relative entry paths.
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}/fs:list"))
        .json(&serde_json::json!({ "path": "src" }))
        .send()
        .await
        .expect("list-src")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "list src: {resp}");
    let items = resp["data"]["items"].as_array().expect("items");
    assert!(
        items.iter().any(|e| e["path"] == "src/lib.rs" && e["kind"] == "file"),
        "nested entry: {resp}"
    );

    // fs:read → the full WireReadFileResult shape.
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}/fs:read"))
        .json(&serde_json::json!({ "path": "hello.txt" }))
        .send()
        .await
        .expect("read")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "read: {resp}");
    assert_eq!(resp["data"]["path"], "hello.txt");
    assert_eq!(resp["data"]["content"], "hi\n");
    assert_eq!(resp["data"]["encoding"], "utf-8");
    assert_eq!(resp["data"]["size"], 3);
    assert_eq!(resp["data"]["truncated"], false);
    assert_eq!(resp["data"]["mime"], "text/plain");
    assert_eq!(resp["data"]["is_binary"], false);
    assert!(resp["data"]["line_count"].is_number(), "line_count: {resp}");

    // fs:read of a missing file → error envelope.
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}/fs:read"))
        .json(&serde_json::json!({ "path": "nope.txt" }))
        .send()
        .await
        .expect("read-missing")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_ne!(resp["code"], 0, "missing read errors: {resp}");

    // fs:search → `{ items, truncated }` with the @-mention entry shape.
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}/fs:search"))
        .json(&serde_json::json!({ "query": "hello" }))
        .send()
        .await
        .expect("search")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "search: {resp}");
    let items = resp["data"]["items"].as_array().expect("items");
    assert_eq!(items.len(), 1, "hit hello.txt only: {resp}");
    assert_eq!(items[0]["path"], "hello.txt");
    assert_eq!(items[0]["name"], "hello.txt");
    assert_eq!(items[0]["kind"], "file");
    assert_eq!(items[0]["score"], 1.0);
    assert!(items[0]["match_positions"].is_array(), "match_positions: {resp}");
    assert_eq!(resp["data"]["truncated"], false, "truncated: {resp}");

    // Empty query → top-level listing, directories first.
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}/fs:search"))
        .json(&serde_json::json!({ "query": "" }))
        .send()
        .await
        .expect("search-empty")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "search empty: {resp}");
    let items = resp["data"]["items"].as_array().expect("items");
    assert_eq!(items[0]["kind"], "directory", "dirs first: {resp}");
    assert!(
        items.iter().any(|e| e["path"] == "hello.txt"),
        "top-level file: {resp}"
    );

    // fs:git_status on a non-repo workspace → error envelope (the web
    // client's defensive catch leaves git UI unset instead of crashing on
    // `Object.entries(entries)`).
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}/fs:git_status"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("git-status")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_ne!(resp["code"], 0, "non-repo git status errors: {resp}");
    assert!(
        resp["msg"].as_str().unwrap_or("").contains("unavailable"),
        "unavailable reason: {resp}"
    );

    // A real repo → the WireGitStatusResult shape: camelCase `pullRequest`,
    // `entries` as an object, no snake_case `pull_request`.
    let repo = std::env::temp_dir().join(format!("kimi-http-git-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&repo);
    std::fs::create_dir_all(&repo).expect("mkdir repo");
    let run_git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .current_dir(&repo)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
    };
    if run_git(&["init", "-q"]).unwrap_or(false) {
        std::fs::write(repo.join("a.txt"), "one\n").expect("write");
        let _ = run_git(&["add", "a.txt"]);
        let _ = run_git(&[
            "-c", "user.name=test", "-c", "user.email=test@test",
            "commit", "-q", "-m", "init",
        ]);
        let resp = client
            .post(format!("{base}/api/v1/sessions"))
            .json(&serde_json::json!({ "metadata": { "cwd": repo.to_string_lossy() } }))
            .send()
            .await
            .expect("create-repo")
            .json::<serde_json::Value>()
            .await
            .expect("json");
        let rsid = resp["data"]["id"].as_str().expect("repo session id").to_string();
        let resp = client
            .post(format!("{base}/api/v1/sessions/{rsid}/fs:git_status"))
            .json(&serde_json::json!({}))
            .send()
            .await
            .expect("git-status-repo")
            .json::<serde_json::Value>()
            .await
            .expect("json");
        assert_eq!(resp["code"], 0, "repo git status: {resp}");
        assert!(resp["data"]["branch"].is_string(), "branch: {resp}");
        assert!(resp["data"]["entries"].is_object(), "entries: {resp}");
        assert!(resp["data"]["additions"].is_number(), "additions: {resp}");
        assert!(resp["data"].get("pullRequest").is_some(), "pullRequest camelCase: {resp}");
        assert!(resp["data"].get("pull_request").is_none(), "no pull_request: {resp}");
    }

    let _ = std::fs::remove_dir_all(&cwd);
    let _ = std::fs::remove_dir_all(&repo);
    serving.abort();
}

#[tokio::test]
async fn http_v1_models_providers_items() {
    // GET /models + /providers project `{ items }` pages (kap-server
    // parity); a seeded engine config produces WireModel/WireProvider rows.
    // The config is pinned via KIMI_CONFIG_PATH (highest config priority) —
    // other parallel tests clobber KIMI_CODE_HOME, so a home-dir seed would
    // race. The env var is restored on exit; CONFIG_LOCK serializes against
    // the other config-seeding test.
    let _config_guard = CONFIG_LOCK.lock().await;
    let (base, serving) = spawn_http("models-providers").await;
    let client = reqwest::Client::new();
    let home = std::env::temp_dir().join(format!("kimi-http-models-providers-{}", std::process::id()));
    std::fs::create_dir_all(&home).expect("mkdir");
    let config_path = home.join("config.toml");
    std::fs::write(
        &config_path,
        "defaultModel = \"m1\"\n\n[providers.mock]\ntype = \"openai\"\nbaseUrl = \"http://localhost:9999/v1\"\napiKey = \"sk-test\"\n\n[models.m1]\nprovider = \"mock\"\nmodel = \"m1-model\"\n\n[models.m2]\nprovider = \"mock\"\nmodel = \"m2-model\"\nmax_tokens = 2048\n",
    )
    .expect("seed config");
    let _path_guard = EnvGuard::set("KIMI_CONFIG_PATH", &config_path);

    async {
        // Sanity: the projected wire config carries the seeded default model;
        // the projection below reads the same field.
        let resp = client
            .get(format!("{base}/api/v1/config"))
            .send()
            .await
            .expect("config")
            .json::<serde_json::Value>()
            .await
            .expect("json");
        assert_eq!(resp["code"], 0, "config: {resp}");
        assert_eq!(resp["data"]["default_model"], "m1", "raw config: {resp}");

        let resp = client
            .get(format!("{base}/api/v1/models"))
            .send()
            .await
            .expect("models")
            .json::<serde_json::Value>()
            .await
            .expect("json");
        assert_eq!(resp["code"], 0, "models: {resp}");
        assert_eq!(resp["data"]["default_model"], "m1", "default: {resp}");
        let items = resp["data"]["items"].as_array().expect("items");
        let m1 = items.iter().find(|m| m["display_name"] == "m1").expect("m1 alias");
        assert_eq!(m1["provider"], "mock");
        assert_eq!(m1["model"], "m1-model");
        assert!(m1["max_context_size"].is_number(), "max_context_size: {resp}");
        let m2 = items.iter().find(|m| m["display_name"] == "m2").expect("m2 alias");
        assert_eq!(m2["max_context_size"], 2048, "max_tokens projected: {resp}");

        let resp = client
            .get(format!("{base}/api/v1/providers"))
            .send()
            .await
            .expect("providers")
            .json::<serde_json::Value>()
            .await
            .expect("json");
        assert_eq!(resp["code"], 0, "providers: {resp}");
        let items = resp["data"]["items"].as_array().expect("items");
        let provider = items.iter().find(|p| p["id"] == "mock").expect("mock provider");
        assert_eq!(provider["type"], "openai");
        assert_eq!(provider["base_url"], "http://localhost:9999/v1");
        assert_eq!(provider["has_api_key"], true);
        assert_eq!(provider["status"], "connected");
        assert!(provider.get("apiKey").is_none(), "no apiKey leak: {resp}");
    }
    .await;

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
        let ty = frame["type"].as_str().expect("event type").to_string();
        assert_eq!(frame["session_id"], sid, "session: {frame}");
        assert!(frame["seq"].is_number(), "seq: {frame}");
        assert!(frame["timestamp"].is_string(), "timestamp: {frame}");
        events.push(frame);
        if ty == "event.session.work_changed" && events.last().unwrap()["payload"]["busy"] == serde_json::json!(false) {
            break;
        }
    }

    // The turn lifecycle must appear: busy on, user + placeholder assistant
    // messages, the raw turn boundary, then the close.
    assert!(
        events.iter().any(|f| f["type"].as_str() == Some("event.session.work_changed")),
        "busy events: {events:?}"
    );
    let created: Vec<&serde_json::Value> = events
        .iter()
        .filter(|f| f["type"].as_str() == Some("event.message.created"))
        .collect();
    assert!(
        created.iter().any(|f| f["payload"]["message"]["role"].as_str() == Some("user")),
        "user message: {events:?}"
    );
    assert!(
        created.iter().any(|f| f["payload"]["message"]["role"].as_str() == Some("assistant")),
        "assistant message: {events:?}"
    );
    // The raw `event.turn.ended` boundary carries the engine fields the web
    // client's agent projector reads (turnActiveChanged → prompt cleanup).
    assert!(
        events.iter().any(|f| f["type"].as_str() == Some("event.turn.ended")),
        "turn boundary: {events:?}"
    );
    let turn_ended = events
        .iter()
        .find(|f| f["type"].as_str() == Some("event.turn.ended"))
        .expect("turn.ended frame");
    assert!(turn_ended["payload"]["stop_reason"].is_string(), "stop_reason: {turn_ended}");
    assert!(turn_ended["payload"]["turn_id"].is_number(), "turn_id: {turn_ended}");
    assert!(
        events.iter().any(|f| f["type"].as_str() == Some("event.message.updated")),
        "message update: {events:?}"
    );
    assert!(
        events.iter().any(|f| f["type"].as_str() == Some("event.assistant.completed")),
        "assistant completed: {events:?}"
    );
    assert_eq!(
        events.last().map(|f| f["type"].as_str()),
        Some(Some("event.session.work_changed")),
        "busy reset last: {events:?}"
    );

    ws.close(None).await.expect("close");
    serving.abort();
}

#[tokio::test]
async fn config_get_projects_wire_shape() {
    // The config is pinned via KIMI_CONFIG_PATH (highest config priority) —
    // other parallel tests clobber KIMI_CODE_HOME, so a home-dir seed would
    // race (same pattern as `http_v1_models_providers_items`); `home()`
    // isolates KIMI_CODE_HOME too so home-dir config reads (e.g.
    // oauth/logout) never touch the real user config. A config exercising
    // every projected domain: top-level `default_model`, a credentialed
    // provider (apiKey/baseUrl/defaultModel), a credential-less provider,
    // `[agent.permission] mode`, a nested camelCase key, and non-provider
    // credentials (`services` / `model_catalog` api keys, `mcp` env).
    let _config_guard = CONFIG_LOCK.lock().await;
    let home = home("config-get");
    let config_path = home.join("config.toml");
    std::fs::write(
        &config_path,
        r#"
default_model = "kimi-k2"

[agent]
max_turns = 8
permission = { mode = "yolo" }

[providers.openai]
type = "openai"
api_key = "sk-secret"
base_url = "https://api.example.com/v1"
default_model = "gpt-4o"

[providers.anthropic]
type = "anthropic"

[services.moonshot]
base_url = "https://api.moonshot.ai/v1"
api_key = "sk-moonshot-secret"

[model_catalog]
endpoint = "https://models.example.com/catalog"
api_key = "sk-catalog-secret"

[mcp.servers.filesystem]
command = "npx"
env = { OPENAI_API_KEY = "sk-env-secret", DATABASE_URL = "postgres://localhost/db" }

[models.m1]
provider = "openai"
model = "gpt-4o"
max_tokens = 2048
"#,
    )
    .expect("write config");
    let _path_guard = EnvGuard::set("KIMI_CONFIG_PATH", &config_path);
    // Neutralize ambient `KIMI_PROVIDER_*` overrides so the `has_api_key`
    // assertions reflect only the config file above.
    for (key, _) in std::env::vars()
        .filter(|(k, _)| k.starts_with("KIMI_PROVIDER_"))
        .collect::<Vec<_>>()
    {
        std::env::remove_var(key);
    }

    let server = Server::build().expect("server");
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
    let base = format!("http://{addr}");

    let resp = reqwest::get(format!("{base}/api/v1/config"))
        .await
        .expect("config")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "config: {resp}");
    let data = &resp["data"];

    // camelCase engine keys → snake_case wire keys.
    assert_eq!(data["default_model"], "kimi-k2", "default_model: {resp}");
    assert!(data.get("defaultModel").is_none(), "no camelCase key: {resp}");
    assert_eq!(data["agent"]["max_turns"], 8, "nested camelCase: {resp}");
    assert!(data["agent"].get("maxTurns").is_none(), "no nested camelCase: {resp}");

    // providers: baseUrl/defaultModel → base_url/default_model; the apiKey is
    // never emitted, `has_api_key` carries the credential presence.
    let openai = &data["providers"]["openai"];
    assert_eq!(openai["type"], "openai", "type: {resp}");
    assert_eq!(openai["base_url"], "https://api.example.com/v1", "base_url: {resp}");
    assert_eq!(openai["default_model"], "gpt-4o", "default_model: {resp}");
    assert_eq!(openai["has_api_key"], true, "has_api_key: {resp}");
    assert!(openai.get("apiKey").is_none(), "apiKey must not leak: {resp}");
    assert!(openai.get("api_key").is_none(), "api_key must not leak: {resp}");
    assert_eq!(
        data["providers"]["anthropic"]["has_api_key"],
        false,
        "no-credential provider: {resp}"
    );

    // `[agent.permission] mode` → `default_permission_mode` + derived `yolo`.
    assert_eq!(data["default_permission_mode"], "yolo", "permission mode: {resp}");
    assert_eq!(data["yolo"], true, "yolo: {resp}");

    // Non-provider credentials are redacted too: the `services.moonshot` and
    // `model_catalog` api keys and env-style keys inside `mcp` env maps never
    // cross the wire; benign neighbors survive untouched.
    let moonshot = &data["services"]["moonshot"];
    assert_eq!(moonshot["base_url"], "https://api.moonshot.ai/v1", "services: {resp}");
    assert!(moonshot.get("api_key").is_none(), "services api_key must not leak: {resp}");
    let catalog = &data["model_catalog"];
    assert_eq!(catalog["endpoint"], "https://models.example.com/catalog", "catalog: {resp}");
    assert!(catalog.get("api_key").is_none(), "catalog api_key must not leak: {resp}");
    let env = &data["mcp"]["servers"]["filesystem"]["env"];
    assert!(env.get("OPENAI_API_KEY").is_none(), "env api key must not leak: {resp}");
    assert_eq!(env["DATABASE_URL"], "postgres://localhost/db", "non-secret env survives: {resp}");
    // No collateral: model-alias `max_tokens` is not a credential.
    assert_eq!(data["models"]["m1"]["max_tokens"], 2048, "max_tokens kept: {resp}");

    serving.abort();
}

#[tokio::test]
async fn config_set_projects_wire_shape() {
    // Pin the engine config file (highest config priority) so the set lands
    // on a temp file (CONFIG_LOCK serializes vs the other config-seeding
    // tests); `home()` isolates KIMI_CODE_HOME so the merge base is empty
    // (a seeded provider keeps the engine's at-least-one-provider validation
    // green). kimi-web's `setConfig` posts a flat snake_case wire patch — the
    // response must be the re-read projected `WireConfig`, not the engine's
    // raw `{ ok, path }` write receipt (kap-server parity).
    let _config_guard = CONFIG_LOCK.lock().await;
    let home = home("config-set");
    let config_path = home.join("config.toml");
    std::fs::write(
        &config_path,
        "default_model = \"kimi-k2\"\n\n[providers.anthropic]\ntype = \"anthropic\"\n",
    )
    .expect("write config");
    let _path_guard = EnvGuard::set("KIMI_CONFIG_PATH", &config_path);
    // Neutralize ambient `KIMI_PROVIDER_*` overrides (same pattern as
    // `config_get_projects_wire_shape`).
    for (key, _) in std::env::vars()
        .filter(|(k, _)| k.starts_with("KIMI_PROVIDER_"))
        .collect::<Vec<_>>()
    {
        std::env::remove_var(key);
    }

    let server = Server::build().expect("server");
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
    let base = format!("http://{addr}");
    let client = reqwest::Client::new();

    // Flat snake_case wire patch — the exact body shape kimi-web's `setConfig`
    // posts (no `{ patch }` wrapper).
    let resp = client
        .post(format!("{base}/api/v1/config"))
        .json(&serde_json::json!({
            "default_model": "kimi-set-1",
            "default_permission_mode": "yolo",
        }))
        .send()
        .await
        .expect("config set")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "config set: {resp}");
    let data = &resp["data"];
    // The response is the projected WireConfig, not the engine's write
    // receipt (`{ ok, path }`) — kimi-web `setConfig` feeds it to `toAppConfig`.
    assert_eq!(data["default_model"], "kimi-set-1", "default_model: {resp}");
    assert!(data.get("defaultModel").is_none(), "no camelCase key: {resp}");
    assert!(data.get("ok").is_none(), "no write receipt: {resp}");
    // `default_permission_mode` → `[agent.permission] mode` on disk, echoed
    // back as `default_permission_mode` + derived `yolo`.
    assert_eq!(data["default_permission_mode"], "yolo", "permission mode: {resp}");
    assert_eq!(data["yolo"], true, "yolo: {resp}");
    assert!(data["providers"].is_object(), "providers: {resp}");

    // The patch persisted: the engine serializes camelCase keys.
    let on_disk = std::fs::read_to_string(&config_path).expect("read back");
    assert!(
        on_disk.contains("defaultModel") && on_disk.contains("kimi-set-1"),
        "persisted: {on_disk}"
    );
    assert!(on_disk.contains("yolo"), "permission persisted: {on_disk}");

    // An empty patch must NOT reach CONFIG_SET: the engine's set merges
    // `load_config_with_env` and rewrites the file, which would bake
    // `KIMI_PROVIDER_*` env overrides into config.toml. Set an override, POST
    // an empty patch, and assert the file is byte-identical (and the response
    // is the projected config, not a write receipt).
    let _bake_guard = EnvGuard::set("KIMI_PROVIDER_MOCK_API_KEY", "sk-env-bake");
    let before = std::fs::read_to_string(&config_path).expect("read before");
    let resp = client
        .post(format!("{base}/api/v1/config"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("empty patch")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "empty patch: {resp}");
    assert_eq!(
        resp["data"]["default_model"], "kimi-set-1",
        "empty patch echoes the projected config: {resp}"
    );
    let after = std::fs::read_to_string(&config_path).expect("read after");
    assert_eq!(before, after, "empty patch must not rewrite config.toml: {after}");

    // And a subsequent GET agrees.
    let resp = reqwest::get(format!("{base}/api/v1/config"))
        .await
        .expect("config")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["data"]["default_model"], "kimi-set-1", "get: {resp}");
    assert_eq!(resp["data"]["yolo"], true, "get yolo: {resp}");

    serving.abort();
}

#[tokio::test]
async fn provider_create_persists_default_model() {
    // POST /api/v1/providers writes the engine's ProviderConfig key
    // (`defaultModel` — a bare `model` key is silently dropped by serde), so
    // the created provider's `default_model` must survive the round-trip into
    // `config/get` (CONFIG_LOCK + `home()` isolate the pinned config; the
    // seeded provider keeps the engine's at-least-one-provider validation
    // green).
    let _config_guard = CONFIG_LOCK.lock().await;
    let home = home("provider-create");
    let config_path = home.join("config.toml");
    std::fs::write(
        &config_path,
        "default_model = \"m1\"\n\n[providers.anthropic]\ntype = \"anthropic\"\n",
    )
    .expect("write config");
    let _path_guard = EnvGuard::set("KIMI_CONFIG_PATH", &config_path);

    let server = Server::build().expect("server");
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
    let base = format!("http://{addr}");
    let client = reqwest::Client::new();

    let resp = client
        .post(format!("{base}/api/v1/providers"))
        .json(&serde_json::json!({
            "id": "mock",
            "type": "openai",
            "api_key": "sk-create",
            "base_url": "http://localhost:9999/v1",
            "default_model": "gpt-4o",
        }))
        .send()
        .await
        .expect("create")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "create: {resp}");

    // Round-trip: `config/get` shows the provider's `default_model` (the
    // engine's `defaultModel` key) and never the credential.
    let resp = reqwest::get(format!("{base}/api/v1/config"))
        .await
        .expect("config")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "config: {resp}");
    let provider = &resp["data"]["providers"]["mock"];
    assert_eq!(provider["default_model"], "gpt-4o", "default_model persisted: {resp}");
    assert_eq!(provider["has_api_key"], true, "has_api_key: {resp}");
    assert!(provider.get("apiKey").is_none(), "no apiKey leak: {resp}");

    serving.abort();
}

#[tokio::test]
async fn http_v1_fs_open_reveal_download_and_workspace_children() {
    // Never pop the OS file manager on the test machine: the handler skips
    // the actual spawn when KIMI_TEST_NO_SPAWN is set (the command shape is
    // covered by the `open_command` unit test).
    std::env::set_var("KIMI_TEST_NO_SPAWN", "1");
    // fs:open / fs:reveal / fs:open-in answer ok (the local file-manager
    // spawn is best-effort and not asserted on), fs:download streams the raw
    // file bytes with an attachment disposition, and /workspaces/{id}/children
    // lists the workspace's subdirectories in the fs:list entry shape.
    let (base, serving) = spawn_http("fs-open").await;
    let client = reqwest::Client::new();
    let cwd = std::env::temp_dir().join(format!("kimi-http-fs-open-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&cwd);
    std::fs::create_dir_all(cwd.join("sub")).expect("mkdir sub");
    std::fs::write(cwd.join("hello.txt"), "hi\n").expect("write hello");
    std::fs::write(cwd.join("sub/inner.txt"), "inner").expect("write inner");
    let cwd_str = cwd.to_string_lossy().into_owned();

    let resp = client
        .post(format!("{base}/api/v1/sessions"))
        .json(&serde_json::json!({ "metadata": { "cwd": cwd_str } }))
        .send()
        .await
        .expect("create")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    let sid = resp["data"]["id"].as_str().expect("id").to_string();

    // fs:open → `{ opened: true }` (line is advisory).
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}/fs:open"))
        .json(&serde_json::json!({ "path": "hello.txt", "line": 3 }))
        .send()
        .await
        .expect("open")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "open: {resp}");
    assert_eq!(resp["data"]["opened"], true, "open: {resp}");

    // fs:reveal → `{ revealed: true }`.
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}/fs:reveal"))
        .json(&serde_json::json!({ "path": "hello.txt" }))
        .send()
        .await
        .expect("reveal")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "reveal: {resp}");
    assert_eq!(resp["data"]["revealed"], true, "reveal: {resp}");

    // fs:open-in → `{ opened: true }` (the app id is advisory — the engine
    // exposes no app registry, so the platform default is used).
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}/fs:open-in"))
        .json(&serde_json::json!({ "app_id": "default", "path": "sub" }))
        .send()
        .await
        .expect("open-in")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "open-in: {resp}");
    assert_eq!(resp["data"]["opened"], true, "open-in: {resp}");

    // fs:open of a missing path → error envelope (not a bare 404).
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}/fs:open"))
        .json(&serde_json::json!({ "path": "nope.txt" }))
        .send()
        .await
        .expect("open-missing")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_ne!(resp["code"], 0, "open missing errors: {resp}");

    // Download → raw bytes with attachment disposition.
    let resp = client
        .get(format!("{base}/api/v1/sessions/{sid}/fs/hello.txt:download"))
        .send()
        .await
        .expect("download")
        .error_for_status()
        .expect("download ok");
    assert_eq!(
        resp.headers().get("content-type").map(|v| v.to_str().unwrap_or("")),
        Some("text/plain"),
        "download mime"
    );
    let disposition = resp
        .headers()
        .get("content-disposition")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(disposition.starts_with("attachment"), "disposition: {disposition}");
    assert_eq!(&resp.bytes().await.expect("bytes")[..], b"hi\n", "download body");

    // Nested path download (the colon rewrite handles the `:download` suffix
    // on any segment).
    let resp = client
        .get(format!("{base}/api/v1/sessions/{sid}/fs/sub/inner.txt:download"))
        .send()
        .await
        .expect("download nested")
        .error_for_status()
        .expect("download nested ok");
    assert_eq!(&resp.bytes().await.expect("bytes")[..], b"inner", "nested body");

    // Download without the `:download` suffix → error envelope.
    let resp = client
        .get(format!("{base}/api/v1/sessions/{sid}/fs/hello.txt"))
        .send()
        .await
        .expect("download no suffix")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_ne!(resp["code"], 0, "no-suffix download errors: {resp}");

    // Download of a missing file → error envelope.
    let resp = client
        .get(format!("{base}/api/v1/sessions/{sid}/fs/nope.txt:download"))
        .send()
        .await
        .expect("download missing")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_ne!(resp["code"], 0, "missing download errors: {resp}");

    // Workspaces → the session's root; children lists its subdirectories.
    let resp = client
        .get(format!("{base}/api/v1/workspaces"))
        .send()
        .await
        .expect("workspaces")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "workspaces: {resp}");
    let ws = resp["data"]["workspaces"]
        .as_array()
        .expect("workspaces array")
        .iter()
        .find(|w| w["path"] == cwd_str)
        .expect("workspace for cwd")
        .clone();
    let ws_id = ws["id"].as_str().expect("workspace id").to_string();

    let resp = client
        .get(format!("{base}/api/v1/workspaces/{ws_id}/children"))
        .send()
        .await
        .expect("children")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "children: {resp}");
    assert_eq!(resp["data"]["truncated"], false, "children truncated: {resp}");
    let items = resp["data"]["items"].as_array().expect("children items");
    assert_eq!(items.len(), 1, "only the sub directory: {resp}");
    assert_eq!(items[0]["name"], "sub", "child name: {resp}");
    assert_eq!(items[0]["kind"], "directory", "child kind: {resp}");
    assert_eq!(items[0]["path"], "sub", "child rel path: {resp}");
    assert!(
        !items.iter().any(|e| e["name"] == "hello.txt"),
        "files are not workspace children: {resp}"
    );

    // Unknown workspace → error envelope.
    let resp = client
        .get(format!("{base}/api/v1/workspaces/wd_999/children"))
        .send()
        .await
        .expect("children unknown")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_ne!(resp["code"], 0, "unknown workspace errors: {resp}");

    let _ = std::fs::remove_dir_all(&cwd);
    serving.abort();
}

#[tokio::test]
async fn http_v1_providers_refresh_and_unsupported_surfaces() {
    // providers:refresh answers the no-op `{ changed, unchanged, failed }`
    // shape (the engine manages models from config; nothing auto-discovers),
    // and the deliberately unsupported surfaces (terminals, questions)
    // answer a clear error envelope instead of a bare 404.
    let (base, serving) = spawn_http("refresh-unsupported").await;
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

    // providers:refresh (the colon suffix is rewritten to slash form).
    let resp = client
        .post(format!("{base}/api/v1/providers:refresh"))
        .send()
        .await
        .expect("refresh all")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "refresh all: {resp}");
    assert_eq!(resp["data"]["changed"].as_array().map(|a| a.len()), Some(0), "changed: {resp}");
    assert!(resp["data"]["unchanged"].is_array(), "unchanged: {resp}");
    assert_eq!(resp["data"]["failed"].as_array().map(|a| a.len()), Some(0), "failed: {resp}");

    // providers/{id}:refresh → unchanged: [id].
    let resp = client
        .post(format!("{base}/api/v1/providers/kimi:refresh"))
        .send()
        .await
        .expect("refresh one")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "refresh one: {resp}");
    assert_eq!(resp["data"]["unchanged"], serde_json::json!(["kimi"]), "unchanged: {resp}");

    // providers:refresh_oauth → same no-op shape.
    let resp = client
        .post(format!("{base}/api/v1/providers:refresh_oauth"))
        .send()
        .await
        .expect("refresh oauth")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "refresh oauth: {resp}");
    assert!(resp["data"]["unchanged"].is_array(), "oauth unchanged: {resp}");

    // Terminals — every route answers the `-32601` envelope with HTTP 200.
    for (method, url) in [
        ("GET", format!("{base}/api/v1/sessions/{sid}/terminals")),
        ("POST", format!("{base}/api/v1/sessions/{sid}/terminals")),
        ("GET", format!("{base}/api/v1/sessions/{sid}/terminals/t-1")),
        ("POST", format!("{base}/api/v1/sessions/{sid}/terminals/t-1")),
        ("POST", format!("{base}/api/v1/sessions/{sid}/terminals/t-1:close")),
    ] {
        let resp = match method {
            "GET" => client.get(&url).send().await.expect("terminal").json::<serde_json::Value>().await.expect("json"),
            _ => client.post(&url).json(&serde_json::json!({})).send().await.expect("terminal").json::<serde_json::Value>().await.expect("json"),
        };
        assert_eq!(resp["code"], -32601, "terminal envelope {url}: {resp}");
        assert!(
            resp["msg"].as_str().unwrap_or("").contains("terminal"),
            "terminal msg {url}: {resp}"
        );
    }

    // Questions — answer and dismiss both answer the `-32601` envelope.
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}/questions/q-1"))
        .json(&serde_json::json!({ "answer": "ok" }))
        .send()
        .await
        .expect("question")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], -32601, "question envelope: {resp}");
    assert!(
        resp["msg"].as_str().unwrap_or("").contains("question"),
        "question msg: {resp}"
    );
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}/questions/q-1:dismiss"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("question dismiss")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], -32601, "question dismiss envelope: {resp}");

    // HTTP status is 200 for all envelopes (a bare 404 would fail parsing).
    let resp = client
        .post(format!("{base}/api/v1/sessions/{sid}/terminals"))
        .send()
        .await
        .expect("terminal status");
    assert_eq!(resp.status().as_u16(), 200, "envelope status");

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
