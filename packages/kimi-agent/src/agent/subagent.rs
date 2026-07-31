//! Shared native subagent execution — used by the `Task` interceptor, the
//! `AgentSwarm` tool, and the discussion tool to spawn depth-limited child
//! [`Agent`]s on the same host base callbacks, native-LLM transport, and
//! permission gate.
//!
//! A child is single-shot (goal disabled, one `run_turn`); its final assistant
//! text is captured off the `llm.step.end` event stream (the turn loop does
//! not write assistant output back to context), with a context fallback for
//! host-proxy mode where the capture sink never sees a native event.
//!
//! Swarm children (`run_child_agent_persistent` / `resume_child_agent`) are
//! additionally stamped with a stable `agent_id` (`swarm-<ts>-<rand>`) and
//! persist their conversation to the engine's session store on success, so a
//! later `AgentSwarm` call carrying `resume_agent_ids` can restore that same
//! context and continue it with one more turn.

use std::sync::Arc;

use crate::agent::agent::{Agent, CaptureCallbacks};
use crate::agent::types::{AgentConfig, SubagentModelPreference};
use crate::callbacks::HostCallbacks;
use crate::permission::gate::PermissionGate;
use crate::persistence::session_store::SessionStore;
use crate::persistence::store::SqliteStore;
use crate::rpc::types::NativeLlmConfig;

/// Generate a stable, unique agent id for a spawned swarm child
/// (`swarm-<epoch-millis>-<random>`). Mirrors the engine's `sess-<ts>`
/// convention (main.rs `SESSION_CREATE`) plus a random suffix so parallel
/// spawns within the same millisecond never collide.
pub(crate) fn generate_agent_id() -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    format!("swarm-{ts}-{}", fastrand::u32(..))
}

/// Resolve the model a subagent should bind to given its [`SubagentModelPreference`]
/// and the configured secondary model. `None` means "inherit the parent model":
///
/// - `Primary` (or no preference) → `None` — run on the parent's model.
/// - `Secondary` with a configured secondary model → `Some(secondary)`.
/// - `Secondary` without one → `None` — fall back to the parent's model.
///
/// `parent_model` is the caller's current model name — the inheritance
/// baseline a `None` result keeps. It is carried so callers can pass the
/// model they already hold without re-resolving it; the choice itself only
/// ever resolves the secondary model.
pub(crate) fn resolve_subagent_model(
    parent_model: &str,
    preference: SubagentModelPreference,
    secondary_model: Option<&str>,
) -> Option<String> {
    let _ = parent_model;
    match preference {
        SubagentModelPreference::Primary => None,
        SubagentModelPreference::Secondary => secondary_model.map(str::to_string),
    }
}

/// Resolve the session store backing swarm-child persistence. Mirrors
/// `main.rs::open_session_store()`: `$KIMI_AGENT_HOME/sessions.db` when the
/// env var is set (the engine's durable store — `rust-loop.ts` seeds it to
/// `~/.kimi-code/agent`). Falls back to `<homedir>/.kimi-agent/sessions.db`
/// so callers that only know a homedir (tests, ad-hoc CLI) still persist.
/// `None` when neither is available — spawn-save and resume are no-ops.
fn child_session_store(homedir: &Option<String>) -> Option<SessionStore> {
    let path = match std::env::var("KIMI_AGENT_HOME") {
        Ok(dir) if !dir.trim().is_empty() => {
            std::path::Path::new(dir.trim()).join("sessions.db")
        }
        _ => {
            let home = homedir.as_deref().unwrap_or_default();
            if home.trim().is_empty() {
                return None;
            }
            std::path::Path::new(home)
                .join(".kimi-agent")
                .join("sessions.db")
        }
    };
    // SQLite creates the file but not the parent directory; make sure the
    // store's home exists before opening.
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!(
                "kimi-agent: failed to create session store dir {}: {e}",
                parent.display()
            );
            return None;
        }
    }
    SqliteStore::open(&path).ok().map(SessionStore::new)
}

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
    run_child_agent_core(
        host,
        homedir,
        native_llm,
        permission,
        parent_prompt,
        max_steps,
        depth,
        subagent_type,
        prompt,
        hooks,
        None,
        false,
        None,
    )
    .await
    .map(|(_, text)| text)
}

/// Spawn a child agent with an explicit model override (subagent model
/// routing). Same as [`run_child_agent`], but the child binds the resolved
/// `model_override` (see [`resolve_subagent_model`]) instead of inheriting
/// the parent's model. `None` behaves exactly like [`run_child_agent`].
pub(crate) async fn run_child_agent_with_model(
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
    model_override: Option<String>,
) -> Result<String, String> {
    run_child_agent_core(
        host,
        homedir,
        native_llm,
        permission,
        parent_prompt,
        max_steps,
        depth,
        subagent_type,
        prompt,
        hooks,
        None,
        false,
        model_override,
    )
    .await
    .map(|(_, text)| text)
}

/// Spawn a swarm child stamped with the given stable `agent_id`, persisting
/// its context to the session store on success. Returns `(agent_id, text)`.
pub(crate) async fn run_child_agent_persistent(
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
    agent_id: &str,
) -> Result<(String, String), String> {
    run_child_agent_core(
        host,
        homedir,
        native_llm,
        permission,
        parent_prompt,
        max_steps,
        depth,
        subagent_type,
        prompt,
        hooks,
        Some(agent_id.to_string()),
        false,
        None,
    )
    .await
}

/// Spawn a swarm child with an explicit model override (subagent model
/// routing). Same as [`run_child_agent_persistent`], but newly spawned
/// children bind the resolved `model_override` (see [`resolve_subagent_model`])
/// instead of inheriting the parent's model. `None` behaves exactly like
/// [`run_child_agent_persistent`].
#[allow(dead_code)] // wired up when the AgentSwarm schema exposes a model parameter
pub(crate) async fn run_child_agent_persistent_with_model(
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
    agent_id: &str,
    model_override: Option<String>,
) -> Result<(String, String), String> {
    run_child_agent_core(
        host,
        homedir,
        native_llm,
        permission,
        parent_prompt,
        max_steps,
        depth,
        subagent_type,
        prompt,
        hooks,
        Some(agent_id.to_string()),
        false,
        model_override,
    )
    .await
}

/// Resume a previously persisted swarm child: restore its context from the
/// session store by `agent_id`, then run one more turn with `prompt`.
/// Returns `(agent_id, text)`. `Err` when persistence is unavailable or no
/// session exists for the id.
pub(crate) async fn resume_child_agent(
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
    agent_id: &str,
) -> Result<(String, String), String> {
    run_child_agent_core(
        host,
        homedir,
        native_llm,
        permission,
        parent_prompt,
        max_steps,
        depth,
        subagent_type,
        prompt,
        hooks,
        Some(agent_id.to_string()),
        true,
        None,
    )
    .await
}

/// Shared implementation for the three child paths: plain single-shot
/// (`agent_id: None`), swarm spawn (fresh id, persist on success), and swarm
/// resume (restore context by id before the turn). When `model_override` is
/// `Some`, the child binds that model instead of inheriting the parent's:
/// the override is stamped onto both the config alias (host-proxy mode) and
/// the native transport's `model` field (`NativeHttpLlm` reads it off
/// `NativeLlmConfig` each turn). `None` keeps the parent's model.
#[allow(clippy::too_many_arguments)]
async fn run_child_agent_core(
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
    agent_id: Option<String>,
    resume: bool,
    model_override: Option<String>,
) -> Result<(String, String), String> {
    // SubagentStart hooks: fire-and-forget before spawning.
    if let Some(manager) = hooks.as_ref() {
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
    // Swarm paths persist the conversation; resolve the store up front so a
    // missing store fails fast on resume instead of after the turn.
    let store = if agent_id.is_some() {
        child_session_store(&homedir)
    } else {
        None
    };
    let captured = Arc::new(std::sync::Mutex::new(String::new()));
    let child_host: Arc<dyn HostCallbacks> = Arc::new(CaptureCallbacks {
        inner: host,
        last_text: captured.clone(),
    });
    // Route the child to an explicitly requested model: stamp the override
    // onto the config alias (host-proxy mode) and the native transport's
    // `model` field (`NativeHttpLlm` reads it off `NativeLlmConfig` each turn,
    // mirroring `Agent::set_model`). `None` inherits the parent's model.
    let (model_alias, native_llm) = match model_override {
        Some(model) => {
            let mut native_llm = native_llm;
            if let Some(ref mut cfg) = native_llm {
                cfg.model = model.clone();
            }
            (Some(model), native_llm)
        }
        None => (None, native_llm),
    };
    let mut child = Agent::new(
        child_host,
        crate::agent::types::AgentOptions {
            session_id: agent_id.clone(),
            homedir: homedir.clone(),
            config: Some(AgentConfig {
                cwd: homedir.unwrap_or_default(),
                model_alias,
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

    // Resume: restore the previously persisted conversation so the model
    // sees the full history before the new prompt turn runs.
    if resume {
        let id = agent_id.as_deref().unwrap_or_default();
        let outcome = (|| -> Result<(), String> {
            let store = store.as_ref().ok_or_else(|| {
                format!(
                    "AgentSwarm resume failed: no session store available for agent_id `{id}`"
                )
            })?;
            let restored = child.load_session(store, id).map_err(|e| {
                format!("AgentSwarm resume failed: loading session for agent_id `{id}`: {e}")
            })?;
            if !restored {
                return Err(format!(
                    "AgentSwarm resume failed: no persisted session found for agent_id `{id}`"
                ));
            }
            Ok(())
        })();
        if let Err(e) = outcome {
            fire_subagent_stop(&hooks, subagent_type, depth, true).await;
            return Err(e);
        }
    }

    let result = child
        .run_turn(vec![crate::context::types::ContentPart::Text {
            text: prompt.to_string(),
        }])
        .await
        .map_err(|e| format!("Subagent failed: {e}"));

    // SubagentStop hooks: fire-and-forget after the turn settles.
    fire_subagent_stop(&hooks, subagent_type, depth, result.is_err()).await;

    let mut text = captured.lock().unwrap_or_else(|p| p.into_inner()).clone();
    if text.trim().is_empty() {
        // Fallback: context (covers host-proxy mode where the capture sink
        // never sees a native `llm.step.end`).
        text = crate::agent::agent::final_assistant_text(&child);
    }
    let text = if text.trim().is_empty() {
        "(subagent produced no textual output)".to_string()
    } else {
        text
    };

    // Persist the completed conversation under the agent id so a later
    // `resume_agent_ids` call can continue it. Best-effort: a store failure
    // must not fail the swarm — the child's answer is what matters.
    if result.is_ok() {
        if let (Some(id), Some(store)) = (agent_id.as_ref(), store.as_ref()) {
            if let Err(e) = child.save_session(store) {
                eprintln!("kimi-agent: failed to persist swarm child session `{id}`: {e}");
            }
        }
    }

    Ok((agent_id.unwrap_or_default(), text))
}

/// Fire SubagentStop hooks (fire-and-forget) with the given failure flag.
async fn fire_subagent_stop(
    hooks: &Option<Arc<crate::hooks::external::HookManager>>,
    subagent_type: &str,
    depth: u32,
    failed: bool,
) {
    if let Some(manager) = hooks {
        if manager.has_hooks_for(crate::hooks::external::HookEventType::SubagentStop) {
            let input = serde_json::json!({
                "subagent_type": subagent_type,
                "depth": depth,
                "failed": failed,
            });
            manager
                .run_all(crate::hooks::external::HookEventType::SubagentStop, None, &input)
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_agent_ids_are_unique_and_prefixed() {
        let a = generate_agent_id();
        let b = generate_agent_id();
        assert!(a.starts_with("swarm-"));
        assert_ne!(a, b);
    }

    #[test]
    fn resolve_primary_or_no_preference_inherits_parent_model() {
        // Primary preference (or none): never overrides, even with a
        // secondary model configured.
        assert_eq!(
            resolve_subagent_model(
                "parent-model",
                SubagentModelPreference::Primary,
                Some("secondary-model"),
            ),
            None,
        );
    }

    #[test]
    fn resolve_secondary_uses_configured_secondary_model() {
        // Secondary preference with a configured secondary model routes to it.
        assert_eq!(
            resolve_subagent_model(
                "parent-model",
                SubagentModelPreference::Secondary,
                Some("secondary-model"),
            ),
            Some("secondary-model".to_string()),
        );
    }

    #[test]
    fn resolve_secondary_without_config_inherits_parent_model() {
        // Secondary preference without a configured secondary model falls
        // back to inheriting the parent's model.
        assert_eq!(
            resolve_subagent_model("parent-model", SubagentModelPreference::Secondary, None),
            None,
        );
    }
}
