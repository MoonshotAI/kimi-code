//! Kimi Code non-interactive execution — the `-p`/print path, ported from
//! `apps/kimi-code/src/cli/run-prompt.ts`. Uses the host protocol client
//! (in-process or remote) and shares the engine exactly like the TUI does;
//! only the output handling differs (plain text / JSONL).

use kimi_server_client::AppServerClient;

/// Optional pre-prompt setup applied to the session between create and prompt.
#[derive(Debug, Default, Clone)]
pub struct PromptSetup {
    /// Model alias/id to set on the session (`session/set_model`).
    pub model: Option<String>,
    /// Enable plan mode before prompting (`session/set_plan_mode`).
    pub plan: bool,
    /// Create a goal on the session before prompting (goal mode). Created
    /// AFTER the session create (and any resume load) so neither rebuilds
    /// the agent over it.
    pub goal: Option<String>,
    /// Resume a persisted session: `session/load` after create so the
    /// on-disk context + goal are restored before the setup/prompt.
    pub resume: bool,
}

/// Run one prompt: create a session, prompt it, return the wire result.
/// When no native_llm is supplied, the engine config (`KIMI_MODEL_*` env /
/// config.toml) is self-read so the standalone binary needs no host LLM.
pub async fn run_prompt(
    client: &mut AppServerClient,
    session_id: &str,
    prompt: &str,
    native_llm: Option<kimi_protocol::wire_types::NativeLlmConfig>,
) -> serde_json::Value {
    run_prompt_with_setup(client, session_id, prompt, native_llm, &PromptSetup::default()).await
}

/// `run_prompt` with a setup step (model / plan mode) applied right after
/// the (idempotent) create, before the prompt. Setup failures surface in the
/// returned body like create failures do.
pub async fn run_prompt_with_setup(
    client: &mut AppServerClient,
    session_id: &str,
    prompt: &str,
    native_llm: Option<kimi_protocol::wire_types::NativeLlmConfig>,
    setup: &PromptSetup,
) -> serde_json::Value {
    let mut create_params = serde_json::json!({ "session_id": session_id });
    if let Some(nllm) = native_llm {
        create_params["native_llm"] = serde_json::to_value(&nllm).unwrap_or_default();
    }
    let created = client.call(kimi_protocol::methods::SESSION_CREATE, create_params).await;
    if created.get("error").is_some() {
        return created;
    }
    if setup.resume {
        // Restore the persisted context + goal before any setup overrides.
        let body = client
            .call(
                kimi_protocol::methods::SESSION_LOAD,
                serde_json::json!({ "session_id": session_id }),
            )
            .await;
        if body.get("error").is_some() {
            return body;
        }
    }
    if let Some(model) = &setup.model {
        let body = client
            .call(
                kimi_protocol::methods::SESSION_SET_MODEL,
                serde_json::json!({ "session_id": session_id, "model": model }),
            )
            .await;
        if body.get("error").is_some() {
            return body;
        }
    }
    if setup.plan {
        let body = client
            .call(
                kimi_protocol::methods::SESSION_SET_PLAN_MODE,
                serde_json::json!({ "session_id": session_id, "enabled": true }),
            )
            .await;
        if body.get("error").is_some() {
            return body;
        }
    }
    if let Some(objective) = &setup.goal {
        let body = client
            .call(
                kimi_protocol::methods::SESSION_GOAL_CREATE,
                serde_json::json!({ "session_id": session_id, "objective": objective }),
            )
            .await;
        if body.get("error").is_some() {
            return body;
        }
    }
    client
        .call(
            kimi_protocol::methods::SESSION_PROMPT,
            serde_json::json!({
                "session_id": session_id,
                "input": [{ "type": "text", "text": prompt }],
            }),
        )
        .await
}

/// Self-read the engine's native LLM config (config.toml + `KIMI_MODEL_*`).
pub fn native_llm_from_config() -> Option<kimi_protocol::wire_types::NativeLlmConfig> {
    kimi_agent::config::native_llm::load_native_llm_from_config()
}

/// Run one prompt against a freshly built in-process server (convenience for
/// tests / embedded hosts).
pub async fn run_prompt_in_process(prompt: &str) -> anyhow::Result<serde_json::Value> {
    let server = kimi_server::Server::build()?;
    let mut client = AppServerClient::InProcess(kimi_server::in_process::spawn(server.processor));
    Ok(run_prompt(&mut client, "kimi-exec", prompt, native_llm_from_config()).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn run_prompt_creates_then_prompts() {
        let server = kimi_server::Server::build().expect("server");
        let mut client = AppServerClient::InProcess(kimi_server::in_process::spawn(server.processor));
        let result = run_prompt(&mut client, "s-exec", "hello", native_llm_from_config()).await;
        // Create succeeded; prompt fails with not-configured LLM (no
        // native_llm) — the pipeline (create -> prompt) is exercised.
        assert!(result.get("error").is_some(), "expected engine error without LLM: {result}");
        let msg = result["error"]["message"].as_str().unwrap_or("");
        assert!(
            msg.contains("run_prompt failed") || msg.contains("LLM"),
            "unexpected error: {msg}"
        );
    }

    #[tokio::test]
    async fn run_prompt_in_process_builds_server() {
        let result = run_prompt_in_process("hi").await.expect("run");
        assert!(result.get("error").is_some(), "no LLM -> engine error expected");
    }

    #[tokio::test]
    async fn run_prompt_with_setup_applies_model_and_plan() {
        let server = kimi_server::Server::build().expect("server");
        let mut client = AppServerClient::InProcess(kimi_server::in_process::spawn(server.processor));
        let setup = PromptSetup {
            model: Some("setup-test-model".into()),
            plan: true,
            goal: Some("setup goal".into()),
            resume: false,
        };
        let result =
            run_prompt_with_setup(&mut client, "s-setup", "hello", native_llm_from_config(), &setup).await;
        // The pipeline runs create -> set_model -> set_plan_mode -> goal ->
        // prompt; the prompt itself fails (no reachable LLM) but setup landed
        // first.
        assert!(result.get("error").is_some(), "no LLM -> prompt errors: {result}");
        let status = client
            .call(
                kimi_protocol::methods::SESSION_GET_STATUS,
                serde_json::json!({ "session_id": "s-setup" }),
            )
            .await;
        assert_eq!(status["result"]["plan_mode"], true, "plan mode set: {status}");
        assert_eq!(status["result"]["model"], "setup-test-model", "model set: {status}");
        // The goal survived the create (created after it, so the agent
        // rebuild could not wipe it).
        let goal = client
            .call(
                kimi_protocol::methods::SESSION_GOAL_GET,
                serde_json::json!({ "session_id": "s-setup" }),
            )
            .await;
        assert_eq!(goal["result"]["goal"]["objective"], "setup goal", "goal set: {goal}");
    }

    #[tokio::test]
    async fn run_prompt_resume_restores_persisted_goal() {
        let server = kimi_server::Server::build().expect("server");
        let mut client = AppServerClient::InProcess(kimi_server::in_process::spawn(server.processor));
        // Seed a persisted session with a goal.
        let created = client.session_create("s-resume").await;
        assert!(created.get("error").is_none(), "create: {created}");
        let goal = client
            .call(
                kimi_protocol::methods::SESSION_GOAL_CREATE,
                serde_json::json!({ "session_id": "s-resume", "objective": "persisted goal" }),
            )
            .await;
        assert!(goal.get("error").is_none(), "goal: {goal}");
        client
            .call(
                kimi_protocol::methods::SESSION_SAVE,
                serde_json::json!({ "session_id": "s-resume" }),
            )
            .await;

        // A resume (create -> load -> prompt) must restore the persisted goal
        // even though the prompt itself fails without an LLM.
        let setup = PromptSetup { resume: true, ..Default::default() };
        let result =
            run_prompt_with_setup(&mut client, "s-resume", "hi", native_llm_from_config(), &setup).await;
        assert!(result.get("error").is_some(), "no LLM -> prompt errors: {result}");
        let goal = client
            .call(
                kimi_protocol::methods::SESSION_GOAL_GET,
                serde_json::json!({ "session_id": "s-resume" }),
            )
            .await;
        assert_eq!(
            goal["result"]["goal"]["objective"], "persisted goal",
            "resume restores the persisted goal: {goal}"
        );
    }
}
