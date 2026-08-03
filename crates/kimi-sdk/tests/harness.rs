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

    // Context is readable right after create (empty transcript so far).
    let context = session.get_context().await;
    assert!(context.get("error").is_none(), "get_context: {context}");
    assert!(context["result"]["history"].is_array());
    assert_eq!(session.transcript().await.expect("transcript"), None);

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

    // Approval surface: empty list; unknown resolve -> false.
    assert!(harness.approvals(Some("s-events")).await.expect("approvals").is_empty());
    assert_eq!(harness.resolve_approval("nope", true, None).await.expect("resolve"), false);

    // Goal lifecycle on a session handle (pure state ops).
    let mut session = harness.create_session("s-goal").await.expect("create goal session");
    let snapshot = session.create_goal("do the migration").await.expect("create goal");
    assert_eq!(snapshot["objective"], "do the migration", "goal snapshot: {snapshot}");
    // goal_get nests the snapshot under `goal`.
    let goal = session.goal().await.expect("goal");
    assert_eq!(goal["goal"]["objective"], "do the migration", "goal get: {goal}");
    session.pause_goal(Some("offline test")).await.expect("pause goal");
    session.resume_goal(None).await.expect("resume goal");
    session.cancel_goal().await.expect("cancel goal");

    // Mode controls reflect in the status snapshot.
    session.set_plan_mode(true).await.expect("plan mode on");
    session.set_swarm_mode(true).await.expect("swarm mode on");
    session.set_thinking(Some("high")).await.expect("thinking");
    let status = session.get_status().await;
    assert_eq!(status["result"]["plan_mode"], true, "plan_mode: {status}");
    assert_eq!(status["result"]["swarm_mode"], true, "swarm_mode: {status}");
    assert!(session.steer(serde_json::json!([{ "type": "text", "text": "focus" }])).await.expect("steer"));
    // Undo on an empty history reports the engine's "nothing to undo" error.
    let undo = session.undo_history().await;
    assert!(
        undo.is_err() && undo.unwrap_err().to_string().contains("Nothing to undo"),
        "empty-history undo errors cleanly"
    );

    // Skill / plan / usage read surfaces on a fresh session.
    let skills = session.list_skills().await.expect("list_skills");
    assert!(skills["skills"].is_array(), "skills: {skills}");
    session.get_plan().await.expect("get_plan");
    let usage = session.get_usage().await.expect("get_usage");
    assert!(usage.is_object(), "usage: {usage}");

    // list_models returns aliases + default from the merged config.
    let (aliases, default_model) = harness.list_models().await.expect("list_models");
    assert!(aliases.iter().any(|a| !a.is_empty()), "aliases: {aliases:?}");
    assert!(default_model.is_none() || default_model.as_deref().is_some_and(|d| !d.is_empty()));
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
