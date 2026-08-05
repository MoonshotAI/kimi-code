//! Cancel semantics against a hanging LLM step: `session/cancel` must
//! interrupt an in-progress prompt turn.
//!
//! Pointer-consistency of the cancel flag: `session/create` registers the
//! agent's `cancellation` `Arc` in the server's per-session map, and the
//! running turn polls that same `Arc` (the manager lock guarantees create/
//! destroy cannot race a turn, and the flag is never replaced). This test
//! verifies that by behavior: a cancel issued while the turn is hung inside
//! the LLM step flips the flag the turn is polling, so the in-flight step
//! aborts via the cancel select in `turn_step::execute_loop_step_with_retry`.

use std::sync::Arc;

use kimi_protocol::wire_types::LlmChatRequest;
use kimi_sdk::Harness;

/// A fake LLM that never settles — keeps the turn active until cancelled.
fn hanging_llm() -> kimi_server::callbacks::LlmStep {
    Arc::new(move |_req: LlmChatRequest| Box::pin(async move { std::future::pending().await }))
}

/// A fresh isolated engine home (process-global `KIMI_AGENT_HOME` must be
/// unique per test to avoid cross-test store interference).
fn home(tag: &str) -> std::path::PathBuf {
    let home = std::env::temp_dir().join(format!("kimi-probe-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("mkdir");
    std::env::set_var("KIMI_AGENT_HOME", &home);
    home
}

/// Drain the harness event stream until `predicate` matches (or timeout).
async fn wait_for_event(
    events: &mut kimi_ui::EventSource,
    predicate: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    for _ in 0..64 {
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), events.next())
            .await
            .expect("event within 5s")
            .expect("stream alive");
        if predicate(&event) {
            return event;
        }
    }
    panic!("event predicate never matched");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_aborts_a_hung_prompt_turn() {
    home("cancel");
    let harness = Harness::embedded_with_llm_step(Some(hanging_llm())).expect("embedded");
    let mut guard = harness.events().await;
    let mut events = guard.as_mut().expect("event source");

    let mut session = harness.create_session("s-probe").await.expect("create");

    // Pre-cancel: the cancel flag is registered at session/create, so an
    // idle session reports `cancelled: true` before any turn has run.
    let pre = session.cancel().await;
    assert_eq!(pre["result"]["cancelled"], true, "pre-cancel: {pre}");

    // The flag is reset at turn start (`run_turn_with_origin` stores false),
    // so the pre-cancel does not prevent the turn from starting — the LLM
    // then hangs, keeping the turn active.
    let mut prompt_session = session.clone();
    let prompt_task = tokio::spawn(async move {
        prompt_session.prompt("start a turn that will be cancelled").await
    });
    let started = wait_for_event(&mut events, |e| e["type"] == "session.turn.started").await;
    assert_eq!(started["session_id"], "s-probe", "started: {started}");

    // Mid-turn cancel: sets the same flag the running turn polls. The hung
    // LLM step aborts through the cancel select, so the turn ends Aborted
    // and the (previously hanging) prompt settles.
    let cancel = session.cancel().await;
    assert_eq!(cancel["result"]["cancelled"], true, "cancel: {cancel}");

    let ended = wait_for_event(&mut events, |e| e["type"] == "session.turn.ended").await;
    assert_eq!(ended["session_id"], "s-probe", "ended: {ended}");
    assert_eq!(ended["stop_reason"], "Aborted", "aborted: {ended}");
    assert_eq!(ended["turn_id"], started["turn_id"], "same turn");

    let body = tokio::time::timeout(std::time::Duration::from_secs(10), prompt_task)
        .await
        .expect("prompt settles after cancel")
        .expect("no panic");
    assert_eq!(body["result"]["stop_reason"], "Aborted", "prompt: {body}");
}
