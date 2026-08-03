//! Remote stdio client end-to-end test — spawn the built
//! `kimi-server-serve` binary and drive it through `AppServerClient::Remote`,
//! the exact path a separate host process would take.

use kimi_server_client::AppServerClient;

fn serve_bin() -> &'static str {
    env!("CARGO_BIN_EXE_kimi-server-serve")
}

#[tokio::test]
async fn remote_client_round_trip() {
    let mut client = AppServerClient::Remote(
        kimi_server_client::stdio_client::StdioClient::spawn(serve_bin())
            .expect("spawn kimi-server-serve"),
    );

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
