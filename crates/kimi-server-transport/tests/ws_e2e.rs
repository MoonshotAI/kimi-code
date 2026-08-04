//! End-to-end: a full kimi-server served over WebSocket, driven through the
//! typed `AppServerClient::RemoteWs` — proving the frame transport carries
//! the same JSON-RPC envelope as stdio and in-process.

use std::sync::Arc;

use kimi_server::Server;
use kimi_server_client::AppServerClient;

#[tokio::test]
async fn ws_client_drives_full_server() {
    // Isolated home so session persistence never touches the real config.
    let home = std::env::temp_dir().join(format!("kimi-ws-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("mkdir");
    std::env::set_var("KIMI_AGENT_HOME", &home);

    let server = Server::build().expect("server");
    let processor = Arc::new(server.processor);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let serving = tokio::spawn(async move {
        kimi_server_transport::websocket::serve(&processor, listener).await
    });

    let mut client = AppServerClient::RemoteWs(Box::new(
        kimi_server_client::ws_client::WsClient::connect(&addr.to_string())
            .await
            .expect("connect"),
    ));

    // Health over the frame transport.
    let health = client.health().await;
    assert!(health.get("error").is_none(), "health: {health}");
    assert_eq!(health["result"]["status"], "ok", "health: {health}");

    // Session lifecycle through the same wire.
    let created = client.session_create("ws-e2e-session").await;
    assert!(created.get("error").is_none(), "create: {created}");
    let listed = client.session_list(50).await;
    let ids: Vec<&str> = listed["result"]["sessions"]
        .as_array()
        .map(|sessions| sessions.iter().filter_map(|s| s["id"].as_str()).collect())
        .unwrap_or_default();
    assert!(ids.contains(&"ws-e2e-session"), "listed: {listed}");

    serving.abort();
}
