//! Shared native subagent execution — used by the `Task` interceptor and the
//! `AgentSwarm` tool to spawn depth-limited child [`Agent`]s on the same host
//! base callbacks, native-LLM transport, and permission gate.
//!
//! A child is single-shot (goal disabled, one `run_turn`); its final assistant
//! text is captured off the `llm.step.end` event stream (the turn loop does
//! not write assistant output back to context), with a context fallback for
//! host-proxy mode where the capture sink never sees a native event.

use std::sync::Arc;

use crate::agent::agent::{Agent, CaptureCallbacks};
use crate::agent::types::AgentConfig;
use crate::callbacks::HostCallbacks;
use crate::permission::gate::PermissionGate;
use crate::rpc::types::NativeLlmConfig;

/// Spawn a child agent, drive it to completion, and return its final answer
/// text. `Err` means the child turn failed outright.
pub(crate) async fn run_child_agent(
    host: Arc<dyn HostCallbacks>,
    homedir: Option<String>,
    native_llm: Option<NativeLlmConfig>,
    permission: PermissionGate,
    parent_prompt: &str,
    max_steps: u32,
    depth: u32,
    subagent_type: &str,
    prompt: &str,
    hooks: Option<Arc<crate::hooks::external::HookManager>>,
) -> Result<String, String> {
    // SubagentStart hooks: fire-and-forget before spawning.
    if let Some(ref manager) = hooks {
        if manager.has_hooks_for(crate::hooks::external::HookEventType::SubagentStart) {
            let input = serde_json::json!({
                "subagent_type": subagent_type,
                "prompt": prompt,
                "depth": depth,
            });
            manager
                .run_all(crate::hooks::external::HookEventType::SubagentStart, None, &input)
                .await;
        }
    }
    let system_prompt = format!(
        "{parent_prompt}\n\nYou are a `{subagent_type}` subagent. Complete the delegated \
         task below and report a concise final answer.",
    );
    // Git context for fresh subagents (v2 explore-agent parity): a
    // `<git-context>` block (branch / dirty files / recent commits) is
    // prepended so the child can orient itself before searching. Best-effort
    // and time-boxed — a slow git probe never blocks the spawn.
    let git_context = if let Some(ref home) = homedir {
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            crate::git::context::collect_git_context(home),
        )
        .await
        .ok()
        .flatten()
    } else {
        None
    };
    let system_prompt = match git_context {
        Some(ref block) => format!("{block}\n\n{system_prompt}"),
        None => system_prompt,
    };
    let captured = Arc::new(std::sync::Mutex::new(String::new()));
    let child_host: Arc<dyn HostCallbacks> = Arc::new(CaptureCallbacks {
        inner: host,
        last_text: captured.clone(),
    });
    let mut child = Agent::new(
        child_host,
        crate::agent::types::AgentOptions {
            homedir: homedir.clone(),
            config: Some(AgentConfig {
                cwd: homedir.unwrap_or_default(),
                model_alias: None,
                system_prompt,
                has_provider: true,
                has_model: true,
            }),
            goal_enabled: false,
            native_llm,
            max_steps_per_turn: max_steps,
            permission: Some(permission),
            ..Default::default()
        },
    );
    child.subagent_depth = depth;

    let result = child
        .run_turn(vec![crate::context::types::ContentPart::Text {
            text: prompt.to_string(),
        }])
        .await
        .map_err(|e| format!("Subagent failed: {e}"));

    // SubagentStop hooks: fire-and-forget after the turn settles.
    if let Some(ref manager) = hooks {
        if manager.has_hooks_for(crate::hooks::external::HookEventType::SubagentStop) {
            let input = serde_json::json!({
                "subagent_type": subagent_type,
                "depth": depth,
                "failed": result.is_err(),
            });
            manager
                .run_all(crate::hooks::external::HookEventType::SubagentStop, None, &input)
                .await;
        }
    }

    let mut text = captured.lock().unwrap_or_else(|p| p.into_inner()).clone();
    if text.trim().is_empty() {
        // Fallback: context (covers host-proxy mode where the capture sink
        // never sees a native `llm.step.end`).
        text = crate::agent::agent::final_assistant_text(&child);
    }
    Ok(if text.trim().is_empty() {
        "(subagent produced no textual output)".to_string()
    } else {
        text
    })
}
