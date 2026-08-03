//! SDK integration tests — drive a real Harness over both transports.

use kimi_sdk::Harness;

#[tokio::test]
async fn embedded_harness_creates_sessions() {
    // Point the session store at a temp dir so session/export (which opens
    // the store per call) sees the session created by the harness.
    let home = std::env::temp_dir().join(format!("kimi-sdk-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("mkdir");
    std::env::set_var("KIMI_AGENT_HOME", &home);

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

    // Persistence + lifecycle ops on the typed session handle. (compact is
    // skipped: the bare server has no compaction delegate, so the engine
    // correctly reports "No compaction delegate set".)
    session.save().await.expect("save");
    session.load().await.expect("load");
    session.set_model("sdk-test-model").await.expect("set_model");

    // Harness facade: config parses, the session is listed, export yields a
    // zip, and delete removes the persisted record.
    assert!(harness.config().await.expect("config").is_object());
    let sessions = harness.list_sessions(50).await.expect("list");
    assert!(sessions.iter().any(|s| s["id"] == "s-sdk"), "listed: {sessions:?}");
    let zip = harness.export_session("s-sdk").await.expect("export");
    assert_eq!(&zip[..2], b"PK", "zip magic");
    assert!(harness.delete_session("s-sdk").await.expect("delete"));
    let sessions = harness.list_sessions(50).await.expect("list");
    assert!(!sessions.iter().any(|s| s["id"] == "s-sdk"), "deleted: {sessions:?}");
}

#[tokio::test]
async fn harness_exposes_engine_events() {
    let home = std::env::temp_dir().join(format!("kimi-sdk-events-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("mkdir");
    std::env::set_var("KIMI_AGENT_HOME", &home);

    let mut harness = Harness::embedded().expect("embedded engine");
    // Subscribe BEFORE driving the session so no event is missed.
    let mut guard = harness.events().await;
    let mut events = guard.as_mut().expect("embedded exposes an event source");

    harness.create_session("s-events").await.expect("create");
    harness.client().await.call(
        kimi_protocol::methods::SESSION_LOAD,
        serde_json::json!({ "session_id": "s-events" }),
    ).await;

    // session/load emits a goal.updated event on the harness stream.
    let event = tokio::time::timeout(std::time::Duration::from_secs(5), events.next())
        .await
        .expect("event within 5s")
        .expect("stream alive");
    assert_eq!(event["type"], "session.goal.updated", "event: {event}");
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
