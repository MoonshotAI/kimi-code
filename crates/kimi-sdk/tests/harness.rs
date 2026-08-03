//! SDK integration tests — drive a real Harness over both transports.

use kimi_sdk::Harness;

#[tokio::test]
async fn embedded_harness_creates_sessions() {
    let mut harness = Harness::embedded().expect("embedded engine");
    assert_eq!(harness.health().await.expect("health"), "ok");

    let mut session = harness.create_session("s-sdk").await.expect("create");
    assert_eq!(session.id(), "s-sdk");
    // The status snapshot carries engine state (no session_id field).
    let status = session.get_status().await;
    assert!(status.get("error").is_none(), "get_status: {status}");
    assert!(status["result"]["plan_mode"].is_boolean(), "status fields: {status}");

    let context = session.get_context().await;
    assert!(context.get("error").is_none(), "get_context: {context}");
    assert!(context["result"]["history"].is_array());

    // Cancel of a created session reports true (flag registered at create).
    assert_eq!(session.cancel().await["result"]["cancelled"], true);
}

#[tokio::test]
async fn remote_harness_over_stdio() {
    // The built serve binary lives in target/debug (one level above deps/).
    let serve = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().and_then(|d| d.parent()).map(|d| d.to_path_buf()))
        .map(|d| d.join(if cfg!(windows) { "kimi-server-serve.exe" } else { "kimi-server-serve" }));
    let Some(serve) = serve.filter(|p| p.exists()) else {
        eprintln!("skipping: kimi-server-serve binary not built");
        return;
    };
    let mut harness = Harness::remote(serve.to_str().unwrap()).expect("remote engine");
    assert_eq!(harness.health().await.expect("health"), "ok");

    let mut session = harness.create_session("s-sdk-remote").await.expect("create");
    let status = session.get_status().await;
    assert!(status.get("error").is_none(), "get_status: {status}");
    assert!(status["result"]["context_tokens"].is_u64());
}
