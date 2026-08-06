//! End-to-end: a full kimi-server served over the HTTP/REST `/api/v1`
//! projection, driven through a real HTTP client — the path kimi-web /
//! vscode / kimi-inspect take.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use kimi_server::Server;

/// Build a full server and serve the HTTP projection on an ephemeral port.
async fn spawn_http() -> (String, tokio::task::JoinHandle<()>) {
    let server = Server::build().expect("server");
    let processor = Arc::new(server.processor);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let serving = tokio::spawn(async move {
        let _ = kimi_server_transport::http::serve(processor, listener).await;
    });
    (format!("http://{addr}"), serving)
}

#[tokio::test]
async fn ws_upgrade_on_http_projection_serves_json_rpc() {
    let home = std::env::temp_dir().join(format!("kimi-http-ws-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("mkdir");
    std::env::set_var("KIMI_AGENT_HOME", &home);

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

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/api/v1/ws"))
        .await
        .expect("connect");
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"agent/health\",\"params\":null}"
            .to_string()
            .into(),
    ))
    .await
    .expect("send");
    let msg = ws.next().await.expect("response").expect("frame");
    let tokio_tungstenite::tungstenite::Message::Text(text) = msg else {
        panic!("expected text frame: {msg:?}");
    };
    let body: serde_json::Value = serde_json::from_str(&text).expect("json");
    assert_eq!(body["result"]["status"], "ok", "body: {body}");
    ws.close(None).await.expect("close");
    serving.abort();
}

#[tokio::test]
async fn bearer_auth_gates_rest_and_ws() {
    let home = std::env::temp_dir().join(format!("kimi-http-auth-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("mkdir");
    std::env::set_var("KIMI_AGENT_HOME", &home);

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
async fn http_projection_drives_full_server() {
    let home = std::env::temp_dir().join(format!("kimi-http-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("mkdir");
    std::env::set_var("KIMI_AGENT_HOME", &home);

    let (base, serving) = spawn_http().await;

    // Health.
    let resp = reqwest::get(format!("{base}/api/v1/health"))
        .await
        .expect("request")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "health: {resp}");
    assert_eq!(resp["data"]["status"], "ok", "health: {resp}");

    // Config.
    let resp = reqwest::get(format!("{base}/api/v1/config"))
        .await
        .expect("request")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "config: {resp}");

    // Create a session, then list it.
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{base}/api/v1/sessions"))
        .json(&serde_json::json!({ "session_id": "http-session" }))
        .send()
        .await
        .expect("create")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "create: {resp}");

    let resp = client
        .get(format!("{base}/api/v1/sessions"))
        .send()
        .await
        .expect("list")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "list: {resp}");
    let ids: Vec<&str> = resp["data"]["sessions"]
        .as_array()
        .map(|sessions| sessions.iter().filter_map(|s| s["id"].as_str()).collect())
        .unwrap_or_default();
    assert!(ids.contains(&"http-session"), "listed: {resp}");

    // Session status.
    let resp = client
        .get(format!("{base}/api/v1/sessions/http-session"))
        .send()
        .await
        .expect("status")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    assert_eq!(resp["code"], 0, "status: {resp}");

    serving.abort();
}
