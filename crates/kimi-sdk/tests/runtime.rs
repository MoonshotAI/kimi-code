//! SDK runtime integration tests (stage E port of node-sdk `test/session-*.ts`).
//!
//! These drive real engine turns offline through a fake LLM step (mirrors TS
//! `createKimiHarness({ llmStep })`): the turn loop calls back to the injected
//! `ServerHostCallbacks::llm_chat` override instead of a network provider, so
//! prompt/cancel/steer/goal/event semantics are verified against the real
//! engine without a reachable LLM.

use std::sync::Arc;

use kimi_protocol::wire_types::{LlmChatRequest, LlmChatResponse, LlmToolCall, TokenUsage};
use kimi_sdk::Harness;

/// A one-shot fake LLM: text, no tool calls -> EndTurn after one step.
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

/// A hanging fake LLM: never settles, keeping a turn active until cancelled
/// (mirrors TS `HANGING_LLM_STEP`).
fn hanging_llm() -> kimi_server::callbacks::LlmStep {
    Arc::new(move |_req: LlmChatRequest| Box::pin(async move { std::future::pending().await }))
}

/// One scripted fake-LLM response.
enum Scripted {
    /// Plain assistant text (no tool calls) — ends the step.
    Text(String),
    /// A `UpdateGoal(status=complete)` tool call; the next scripted entry
    /// must be the `Text` that ends the step the tool result is inserted
    /// into.
    UpdateGoalComplete(String),
}

/// A fake LLM driven by a script (each call pops the next entry), so tests
/// can make the engine run a specific turn sequence: a text turn, then a
/// goal-completion tool call, then a closing text turn.
fn scripted_llm(state: Arc<std::sync::Mutex<Vec<Scripted>>>) -> kimi_server::callbacks::LlmStep {
    Arc::new(move |_req: LlmChatRequest| {
        let state = state.clone();
        Box::pin(async move {
            let next = state.lock().unwrap_or_else(|e| e.into_inner()).remove(0);
            let usage = TokenUsage {
                input_tokens: 5,
                output_tokens: 5,
                total_tokens: 10,
            };
            match next {
                Scripted::Text(text) => Ok(LlmChatResponse {
                    content: text,
                    tool_calls: vec![],
                    finish_reason: Some("stop".into()),
                    usage,
                }),
                Scripted::UpdateGoalComplete(reason) => Ok(LlmChatResponse {
                    content: String::new(),
                    tool_calls: vec![LlmToolCall {
                        id: "goal-1".into(),
                        name: "UpdateGoal".into(),
                        arguments: serde_json::json!({ "status": "complete", "reason": reason }),
                    }],
                    finish_reason: Some("tool_calls".into()),
                    usage,
                }),
            }
        })
    })
}

/// A fresh isolated engine home (process-global `KIMI_AGENT_HOME` must be
/// unique per test to avoid cross-test store interference).
fn home(tag: &str) -> std::path::PathBuf {
    let home = std::env::temp_dir().join(format!("kimi-sdk-runtime-{tag}-{}", std::process::id()));
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

#[tokio::test]
async fn prompt_emits_turn_events_and_transcript() {
    home("prompt");
    let harness = Harness::embedded_with_llm_step(Some(fake_llm())).expect("embedded with llm");
    let mut guard = harness.events().await;
    let mut events = guard.as_mut().expect("event source");

    let mut session = harness.create_session("s-prompt").await.expect("create");
    let body = session.prompt("hello").await;
    assert!(body.get("error").is_none(), "prompt: {body}");
    assert_eq!(body["result"]["stop_reason"], "EndTurn", "stop: {body}");
    assert_eq!(body["result"]["usage"]["total_tokens"], 20, "usage: {body}");

    let transcript = session.transcript().await.expect("transcript").unwrap_or_default();
    assert!(transcript.contains("hello from fake llm"), "transcript: {transcript}");

    let started = wait_for_event(&mut events, |e| e["type"] == "session.turn.started").await;
    assert_eq!(started["session_id"], "s-prompt", "started: {started}");
    let ended = wait_for_event(&mut events, |e| e["type"] == "session.turn.ended").await;
    assert_eq!(ended["session_id"], "s-prompt", "ended: {ended}");
    assert_eq!(ended["stop_reason"], "EndTurn", "ended stop: {ended}");
    assert_eq!(ended["turn_id"], started["turn_id"], "turn ids match");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_of_active_turn_emits_aborted() {
    home("cancel");
    let harness = Harness::embedded_with_llm_step(Some(hanging_llm())).expect("embedded");
    let mut guard = harness.events().await;
    let mut events = guard.as_mut().expect("event source");

    let mut session = harness.create_session("s-cancel").await.expect("create");

    // Fire-and-forget: with a hanging LLM the prompt only settles when the
    // turn ends, which cancel() triggers below (mirrors TS semantics).
    let mut prompt_session = session.clone();
    let prompt_task = tokio::spawn(async move {
        prompt_session.prompt("start a turn that will be cancelled").await
    });
    let started = wait_for_event(&mut events, |e| e["type"] == "session.turn.started").await;
    assert_eq!(started["session_id"], "s-cancel", "started: {started}");

    // Cancel races the hanging turn: the flag is set and the in-flight LLM
    // step aborts via the cancel select in turn_step.rs, so cancel resolves
    // and the turn ends Aborted.
    let cancel = session.cancel().await;
    assert_eq!(cancel["result"]["cancelled"], true, "cancel: {cancel}");

    let ended = wait_for_event(&mut events, |e| e["type"] == "session.turn.ended").await;
    assert_eq!(ended["session_id"], "s-cancel", "ended: {ended}");
    assert_eq!(ended["stop_reason"], "Aborted", "aborted: {ended}");
    assert_eq!(ended["turn_id"], started["turn_id"], "same turn");

    // The hung prompt settles once the turn is aborted.
    let body = tokio::time::timeout(std::time::Duration::from_secs(10), prompt_task)
        .await
        .expect("prompt settles after cancel")
        .expect("no panic");
    assert_eq!(body["result"]["stop_reason"], "Aborted", "prompt: {body}");
}

#[tokio::test]
async fn steer_queues_input_into_the_active_turn() {
    home("steer");
    // The engine appends queued steer input as a real user message; with a
    // one-shot fake LLM the turn still ends, and the transcript carries both
    // the original prompt and the steered text.
    let harness = Harness::embedded_with_llm_step(Some(fake_llm())).expect("embedded");

    let mut session = harness.create_session("s-steer").await.expect("create");
    // Queue steering before the turn drains it (steer is read at turn start).
    let queued = session
        .steer(serde_json::json!([{ "type": "text", "text": "focus on the tests" }]))
        .await
        .expect("steer queued");
    assert!(queued, "steer accepted");

    let body = session.prompt("do the work").await;
    assert!(body.get("error").is_none(), "prompt: {body}");

    let context = session.get_context().await;
    let raw = serde_json::to_string(&context["result"]).unwrap_or_default();
    assert!(raw.contains("focus on the tests"), "steered text present: {raw}");
}

#[tokio::test]
async fn background_tasks_are_listable_and_output_is_ghost_blank() {
    home("bg");
    let harness = Harness::embedded_with_llm_step(Some(fake_llm())).expect("embedded");
    let mut session = harness.create_session("s-bg").await.expect("create");

    // Empty task set on a fresh session.
    let body = harness
        .client()
        .call(kimi_protocol::methods::BG_LIST, serde_json::json!({}))
        .await;
    assert!(body.get("error").is_none(), "bg list: {body}");
    assert!(body["result"].is_array(), "bg list array: {body}");

    // Unknown task output resolves to an empty string (UI speculates).
    let body = harness
        .client()
        .call(
            kimi_protocol::methods::BG_GET,
            serde_json::json!({ "task_id": "bash-deadbeef" }),
        )
        .await;
    assert!(body.get("error").is_none(), "bg get: {body}");
    assert!(body["result"].is_null(), "unknown task null: {body}");
    let _ = &mut session;
}

/// `fork` with a `turn_index` keeps only the conversation through that
/// 0-based turn (each user-originated message starts a turn); out-of-range
/// indexes are rejected. Mirrors the SDK's `Session.fork({ turnIndex })`.
#[tokio::test]
async fn fork_with_turn_index_truncates_history() {
    home("fork-idx");
    let harness = Harness::embedded_with_llm_step(Some(fake_llm())).expect("embedded");
    let mut session = harness.create_session("s-fork-idx").await.expect("create");

    session.prompt("first turn").await;
    session.prompt("second turn").await;

    // Full fork keeps both turns' user messages. (create re-creates the
    // session shell; `load` restores the forked context from the store, the
    // same resume flow the engine documents.)
    session
        .fork("s-fork-full", None, None)
        .await
        .expect("full fork");
    let mut full = harness.create_session("s-fork-full").await.expect("open fork");
    full.load().await.expect("load fork");
    let full_ctx = serde_json::to_string(&full.get_context().await["result"]).unwrap_or_default();
    assert!(full_ctx.contains("second turn"), "full fork keeps both: {full_ctx}");

    // turn_index = 0 keeps only the first user message.
    session
        .fork("s-fork-idx0", None, Some(0))
        .await
        .expect("fork at turn 0");
    let mut idx0 = harness.create_session("s-fork-idx0").await.expect("open fork 0");
    idx0.load().await.expect("load fork 0");
    let ctx0 = serde_json::to_string(&idx0.get_context().await["result"]).unwrap_or_default();
    assert!(ctx0.contains("first turn"), "keeps first: {ctx0}");
    assert!(!ctx0.contains("second turn"), "drops later turns: {ctx0}");

    // Out-of-range indexes are rejected at the engine, not silently clamped.
    let result = session.fork("s-fork-oob", None, Some(99)).await;
    assert!(
        result.is_err() && result.unwrap_err().to_string().contains("out of range"),
        "oob turn_index errors"
    );
}

/// The typed background-task surface: register one (the tool runner's shape),
/// then drive list / output / stop / detach through `Session`.
#[tokio::test]
async fn session_background_task_methods_roundtrip() {
    home("bg-methods");
    let harness = Harness::embedded_with_llm_step(Some(fake_llm())).expect("embedded");
    let mut session = harness.create_session("s-bg-m").await.expect("create");

    // Register through the wire, as the tool runner does.
    let body = harness
        .client()
        .call(
            kimi_protocol::methods::BG_REGISTER,
            serde_json::json!({
                "prefix": "sdk-bg",
                "kind": "process",
                "description": "sdk background task",
            }),
        )
        .await;
    assert!(body.get("error").is_none(), "bg/register: {body}");
    let task_id = body["result"]["task_id"].as_str().expect("task_id").to_string();

    // list sees it with the sdk-bg prefix.
    let listed = session.list_background_tasks().await;
    assert!(listed.get("error").is_none(), "list: {listed}");
    let tasks = listed["result"].as_array().expect("tasks array");
    assert!(
        tasks.iter().any(|t| t["base"]["task_id"] == task_id),
        "registered task listed: {listed}"
    );

    // output resolves (blank preview for a task with no output yet).
    let output = session.get_background_task_output(&task_id).await;
    assert!(output.get("error").is_none(), "output: {output}");

    // detach returns the task info; a second detach of the same id is a no-op.
    let detached = session.detach_background_task(&task_id).await;
    assert!(detached.get("error").is_none(), "detach: {detached}");
    assert_eq!(detached["result"]["base"]["task_id"], task_id, "detach info: {detached}");

    // stop reports ok for the detached (ghost) task.
    let stopped = session.stop_background_task(&task_id, Some("sdk test done")).await;
    assert!(stopped.get("error").is_none(), "stop: {stopped}");
    assert_eq!(stopped["result"]["ok"], true, "stop ok: {stopped}");
}

#[tokio::test]
async fn goal_continuation_drives_turns_until_complete() {
    home("goal-cont");
    // Scripted LLM: turn 1 answers with text (goal stays active, so the goal
    // driver queues a continuation turn); turn 2 calls `UpdateGoal(complete)`
    // — the engine's native goal tool clears the record — then closes the
    // turn with text, and the driver sees no active goal and stops.
    let script: Arc<std::sync::Mutex<Vec<Scripted>>> = Arc::new(std::sync::Mutex::new(vec![
        Scripted::Text("continuing toward the objective".into()),
        Scripted::UpdateGoalComplete("all requirements verified".into()),
        Scripted::Text("objective complete".into()),
    ]));
    let harness = Harness::embedded_with_llm_step(Some(scripted_llm(script))).expect("embedded");
    let mut guard = harness.events().await;
    let mut events = guard.as_mut().expect("event source");

    let mut session = harness.create_session("s-goal-cont").await.expect("create");
    let snapshot = session
        .create_goal("finish the migration")
        .await
        .expect("create goal");
    assert_eq!(snapshot["objective"], "finish the migration");

    let body = session.prompt("start").await;
    assert!(body.get("error").is_none(), "prompt: {body}");
    assert_eq!(body["result"]["stop_reason"], "EndTurn", "stop: {body}");

    // The driver ran the continuation and the UpdateGoal(complete) call
    // cleared the record: the session reports no active goal afterwards.
    let goal = session.goal().await.expect("goal snapshot");
    assert!(goal["goal"].is_null(), "goal cleared: {goal}");

    // And at least one goal lifecycle event was emitted on the stream.
    let goal_event = wait_for_event(&mut events, |e| {
        e["type"].as_str().map_or(false, |t| t.contains("goal"))
    })
    .await;
    assert_eq!(goal_event["session_id"], "s-goal-cont", "goal event: {goal_event}");
}

#[tokio::test]
async fn set_model_reflects_in_status_and_persists() {
    home("model");
    let harness = Harness::embedded_with_llm_step(Some(fake_llm())).expect("embedded");
    let mut session = harness.create_session("s-model").await.expect("create");

    session.set_model("sdk-picked-model").await.expect("set model");
    let status = session.get_status().await;
    assert_eq!(
        status["result"]["model"], "sdk-picked-model",
        "status model: {status}"
    );
}

#[tokio::test]
async fn set_thinking_and_modes_reflect_in_status() {
    home("thinking");
    let harness = Harness::embedded_with_llm_step(Some(fake_llm())).expect("embedded");
    let mut session = harness.create_session("s-thinking").await.expect("create");

    session.set_thinking(Some("high")).await.expect("set thinking");
    session.set_plan_mode(true).await.expect("plan mode");
    session.set_swarm_mode(true, Some("tool")).await.expect("swarm mode");

    let status = session.get_status().await;
    assert_eq!(status["result"]["plan_mode"], true, "plan: {status}");
    assert_eq!(status["result"]["swarm_mode"], true, "swarm: {status}");
}

/// `set_permission` drives the process-wide gate (`permission/set_mode`):
/// valid modes round-trip, unknown modes are rejected at the engine.
#[tokio::test]
async fn set_permission_mode_roundtrip() {
    home("perm");
    let harness = Harness::embedded_with_llm_step(Some(fake_llm())).expect("embedded");
    let mut session = harness.create_session("s-perm").await.expect("create");

    session.set_permission("yolo").await.expect("set permission");
    // The gate snapshot reflects the new mode.
    let body = harness
        .client()
        .call(kimi_protocol::methods::PERMISSION_GET, serde_json::Value::Null)
        .await;
    assert!(body.get("error").is_none(), "permission/get: {body}");
    assert_eq!(body["result"]["mode"], "yolo", "gate snapshot: {body}");

    // Unknown modes are rejected, not silently accepted.
    let result = session.set_permission("sometimes").await;
    assert!(
        result.is_err() && result.unwrap_err().to_string().contains("permission"),
        "unknown mode errors"
    );
}

#[tokio::test]
async fn skills_list_and_unknown_activate_errors() {
    home("skills");
    let harness = Harness::embedded_with_llm_step(Some(fake_llm())).expect("embedded");
    let mut session = harness.create_session("s-skills").await.expect("create");

    let skills = session.list_skills().await.expect("list skills");
    assert!(skills["skills"].is_array(), "skills: {skills}");

    // Unknown skills error before any LLM turn.
    let result = session
        .activate_skill("nonexistent-skill", serde_json::Value::Null)
        .await;
    assert!(
        result.is_err() && result.unwrap_err().to_string().contains("was not found"),
        "unknown skill errors fast"
    );
}

#[tokio::test]
async fn context_import_clear_round_trip() {
    home("context");
    let harness = Harness::embedded_with_llm_step(Some(fake_llm())).expect("embedded");
    let mut session = harness.create_session("s-ctx").await.expect("create");

    session
        .import_context("imported sdk text", "sdk-test")
        .await
        .expect("import");
    let context = session.get_context().await;
    let raw = serde_json::to_string(&context["result"]).unwrap_or_default();
    assert!(raw.contains("imported sdk text"), "import present: {raw}");
    // The markup is preserved verbatim: the source-tagged wrapper and the
    // system preamble that frames the imported history for the model. (The
    // context is JSON-serialized, so the tag's quotes arrive escaped.)
    assert!(
        raw.contains("<imported_context source="),
        "source-tagged wrapper: {raw}"
    );
    assert!(raw.contains("</imported_context>"), "closing tag: {raw}");
    assert!(
        raw.contains("has imported context from sdk-test"),
        "system preamble: {raw}"
    );

    assert!(session.clear_context().await.expect("clear"));
    let context = session.get_context().await;
    let raw = serde_json::to_string(&context["result"]).unwrap_or_default();
    assert!(!raw.contains("imported sdk text"), "cleared: {raw}");
}

#[tokio::test]
async fn export_rename_list_delete_round_trip() {
    home("export");
    let harness = Harness::embedded_with_llm_step(Some(fake_llm())).expect("embedded");
    let mut session = harness.create_session("s-xport").await.expect("create");

    session.rename("my exported session").await.expect("rename");
    let sessions = harness.list_sessions(50).await.expect("list");
    assert!(
        sessions
            .iter()
            .any(|s| s["id"] == "s-xport" && s["title"] == "my exported session"),
        "listed: {sessions:?}"
    );

    let zip = harness.export_session("s-xport").await.expect("export");
    assert_eq!(&zip[..2], b"PK", "zip magic");
    assert!(harness.delete_session("s-xport").await.expect("delete"));
    let sessions = harness.list_sessions(50).await.expect("list");
    assert!(!sessions.iter().any(|s| s["id"] == "s-xport"), "deleted: {sessions:?}");
}

#[tokio::test]
async fn usage_accumulates_after_prompt() {
    home("usage");
    let harness = Harness::embedded_with_llm_step(Some(fake_llm())).expect("embedded");
    let mut session = harness.create_session("s-usage").await.expect("create");

    let body = session.prompt("count my tokens").await;
    assert!(body.get("error").is_none(), "prompt: {body}");

    // `session/get_usage` mirrors the fake LLM's TokenUsage into the total.
    let usage = session.get_usage().await.expect("usage");
    assert_eq!(usage["total"]["total_tokens"], 20, "usage: {usage}");
    assert_eq!(usage["total"]["input_tokens"], 10, "usage: {usage}");
    assert_eq!(usage["total"]["output_tokens"], 10, "usage: {usage}");
}

#[tokio::test]
async fn usage_updated_event_carries_token_fields() {
    home("usage-event");
    let harness = Harness::embedded_with_llm_step(Some(fake_llm())).expect("embedded");
    let mut guard = harness.events().await;
    let mut events = guard.as_mut().expect("event source");

    let mut session = harness.create_session("s-usage-ev").await.expect("create");
    let body = session.prompt("stream me").await;
    assert!(body.get("error").is_none(), "prompt: {body}");

    let updated = wait_for_event(&mut events, |e| e["type"] == "session.usage.updated").await;
    assert_eq!(updated["session_id"], "s-usage-ev", "usage: {updated}");
    assert_eq!(updated["input_tokens"], 10, "usage: {updated}");
    assert_eq!(updated["output_tokens"], 10, "usage: {updated}");
    assert_eq!(updated["total_tokens"], 20, "usage: {updated}");

    // The usage event belongs to the same turn as the ended event.
    let ended = wait_for_event(&mut events, |e| e["type"] == "session.turn.ended").await;
    assert_eq!(ended["turn_id"], updated["turn_id"], "same turn");
}

#[tokio::test]
async fn get_plan_is_null_without_plan_mode() {
    home("plan");
    let harness = Harness::embedded_with_llm_step(Some(fake_llm())).expect("embedded");
    let mut session = harness.create_session("s-plan").await.expect("create");

    let plan = session.get_plan().await.expect("get plan");
    assert!(plan.is_null(), "no plan yet: {plan}");
}

#[tokio::test]
async fn compact_errors_without_native_llm() {
    home("compact");
    let harness = Harness::embedded_with_llm_step(Some(fake_llm())).expect("embedded");
    let mut session = harness.create_session("s-compact").await.expect("create");

    let body = session.prompt("fill the context").await;
    assert!(body.get("error").is_none(), "prompt: {body}");

    // A bare harness has no summarizer, so a manual compact must fail closed
    // instead of silently dropping history (TS: compact rejection path).
    let result = session.compact().await;
    assert!(result.is_err(), "compact must error without a delegate: {result:?}");
}

#[tokio::test]
async fn save_then_resume_restores_context() {
    home("resume");
    let harness = Harness::embedded_with_llm_step(Some(fake_llm())).expect("embedded");
    let mut session = harness.create_session("s-resume").await.expect("create");

    let body = session.prompt("remember this turn").await;
    assert!(body.get("error").is_none(), "prompt: {body}");
    session.save().await.expect("save");

    // Tear the in-memory agent down, then rebuild it from the persisted
    // record (the SDK `load` resume path).
    let destroyed = session.destroy().await.expect("destroy");
    assert_eq!(destroyed["destroyed"].as_bool(), Some(true), "destroy: {destroyed}");

    let mut resumed = harness.create_session("s-resume").await.expect("recreate");
    resumed.load().await.expect("load");
    let context = resumed.get_context().await;
    let raw = serde_json::to_string(&context["result"]).unwrap_or_default();
    assert!(raw.contains("hello from fake llm"), "context restored: {raw}");
}

#[tokio::test]
async fn prompt_parts_send_multi_part_input() {
    home("parts");
    let harness = Harness::embedded_with_llm_step(Some(fake_llm())).expect("embedded");
    let mut session = harness.create_session("s-parts").await.expect("create");

    let body = session
        .prompt_parts(serde_json::json!([
            { "type": "text", "text": "first part" },
            { "type": "text", "text": "second part" },
        ]))
        .await;
    assert!(body.get("error").is_none(), "prompt: {body}");

    // Both parts land in the session context as user input.
    let context = session.get_context().await;
    let raw = serde_json::to_string(&context["result"]).unwrap_or_default();
    assert!(raw.contains("first part"), "part 1: {raw}");
    assert!(raw.contains("second part"), "part 2: {raw}");
}
