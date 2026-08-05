//! Remote stdio client end-to-end test — spawn the built
//! `kimi-server-serve` binary and drive it through `AppServerClient::Remote`,
//! the exact path a separate host process would take.

use kimi_server_client::AppServerClient;

fn serve_bin() -> &'static str {
    env!("CARGO_BIN_EXE_kimi-server-serve")
}

#[tokio::test]
async fn remote_client_round_trip() {
    let client = AppServerClient::Remote(Box::new(
        kimi_server_client::stdio_client::StdioClient::spawn(serve_bin())
            .expect("spawn kimi-server-serve"),
    ));

    let body = client.health().await;
    assert_eq!(body["result"]["status"], "ok", "health: {body}");

    let body = client.session_create("s-remote").await;
    assert_eq!(body["result"]["session_id"], "s-remote", "create: {body}");

    let body = client.session_list(10).await;
    let sessions = body["result"]["sessions"].as_array().expect("sessions");
    assert!(
        sessions.iter().any(|s| s["id"] == "s-remote"),
        "created session should be listed: {body}"
    );

    // An unknown method surfaces a JSON-RPC error, not a hang.
    let body = client.call("session/does_not_exist", serde_json::Value::Null).await;
    assert!(body.get("error").is_some(), "unknown method -> error: {body}");

    drop(client);
}

/// Representative method-family smoke over Remote stdio: the read-only
/// control-plane families (config/approval/task/bg) all answer with their
/// wire shapes through the exact process boundary a host would use.
#[tokio::test]
async fn remote_client_method_family_smoke() {
    let client = AppServerClient::Remote(Box::new(
        kimi_server_client::stdio_client::StdioClient::spawn(serve_bin())
            .expect("spawn kimi-server-serve"),
    ));

    let body = client.config_get().await;
    assert!(body.get("error").is_none(), "config/get: {body}");

    let body = client.approval_list(Some("s-smoke")).await;
    assert!(body.get("error").is_none(), "approval_list: {body}");
    assert_eq!(body["result"]["pending"], serde_json::json!([]), "empty approvals: {body}");

    let body = client.call("task/list", serde_json::Value::Null).await;
    assert!(body.get("error").is_none(), "task/list: {body}");
    assert!(body["result"].is_array(), "task/list shape: {body}");

    let body = client.call("bg/list", serde_json::Value::Null).await;
    assert!(body.get("error").is_none(), "bg/list: {body}");
    assert!(body["result"].is_array(), "bg/list shape: {body}");

    let body = client.call("session/get_usage", serde_json::json!({ "session_id": "nope" }))
        .await;
    // Missing session is an engine error, but the envelope round-trips (no
    // hang, no transport failure).
    assert!(body.get("error").is_some(), "missing session errors: {body}");

    drop(client);
}

/// Two calls in flight at once over Remote stdio: the client's background
/// reader routes each response back to its caller by request id, so a
/// slow call (session/create persists) and a fast one (health) can be
/// awaited concurrently without blocking each other.
#[tokio::test]
async fn remote_client_concurrent_calls() {
    let client = AppServerClient::Remote(Box::new(
        kimi_server_client::stdio_client::StdioClient::spawn(serve_bin())
            .expect("spawn kimi-server-serve"),
    ));

    let (created, health) = tokio::join!(
        client.session_create("s-conc"),
        client.health(),
    );
    assert_eq!(created["result"]["session_id"], "s-conc", "create: {created}");
    assert!(created.get("error").is_none(), "create error: {created}");
    assert_eq!(health["result"]["status"], "ok", "health: {health}");

    drop(client);
}

#[tokio::test]
async fn serve_bin_over_websocket() {
    use tokio::io::AsyncBufReadExt;

    // Probe a free port, then hand it to the binary.
    let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("probe");
    let port = probe.local_addr().expect("addr").port();
    drop(probe);

    let mut child = tokio::process::Command::new(serve_bin())
        .arg("--ws")
        .arg(format!("127.0.0.1:{port}"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn kimi-server-serve --ws");
    let stderr = child.stderr.take().expect("stderr");

    // Wait for the "websocket on" banner so the connect races nothing.
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) if line.contains("websocket on") => break,
                Ok(_) => continue,
                Err(e) => return Err(e),
            }
        }
        Ok::<(), std::io::Error>(())
    })
    .await
    .expect("banner within 10s")
    .expect("banner read");

    // The real binary path over WebSocket: health + session lifecycle.
    let client = AppServerClient::RemoteWs(Box::new(
        kimi_server_client::ws_client::WsClient::connect(&format!("127.0.0.1:{port}"))
            .await
            .expect("connect"),
    ));
    let health = client.health().await;
    assert_eq!(health["result"]["status"], "ok", "health: {health}");

    let created = client.session_create("s-ws-bin").await;
    assert_eq!(created["result"]["session_id"], "s-ws-bin", "create: {created}");

    let listed = client.session_list(10).await;
    let sessions = listed["result"]["sessions"].as_array().expect("sessions");
    assert!(
        sessions.iter().any(|s| s["id"] == "s-ws-bin"),
        "created session listed over ws: {listed}"
    );

    child.kill().await.expect("kill");
    drop(child);
}
