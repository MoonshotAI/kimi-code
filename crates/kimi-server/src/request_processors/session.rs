//! Session method family — the engine's session surface, ported from
//! `packages/kimi-agent/src/main.rs`. The processor owns a
//! `SessionManager` (engine state) exactly as the stdio server does;
//! handlers are the same logic, organized by method family.

use std::sync::Arc;

use base64::Engine;
use kimi_protocol::rpc::JsonRpcError;
use kimi_protocol::wire_types::SessionGoalParams;

use crate::processor::{MessageProcessor, Processor};

/// Serializes tests that touch `KIMI_AGENT_HOME` (process-global env var; the
/// export roundtrip repoints it at a temp store).
#[cfg(test)]
static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Session methods, backed by the shared engine state.
pub struct SessionProcessor {
    state: crate::state::ServerState,
    /// Per-session cancellation flags (create stores; prompt reads).
    cancel: Arc<std::sync::Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    /// Per-session steer queues.
    steer: Arc<std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<Vec<kimi_agent::context::types::ContentPart>>>>>>,
    /// Per-session busy flags (prompt marks; fork/compact check).
    busy: Arc<std::sync::Mutex<std::collections::HashMap<String, bool>>>,
    /// Per-command shell cancel flags.
    shell_cancels: Arc<std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>>,
}

impl SessionProcessor {
    /// Create with a fresh engine session manager (own store).
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self::with_state(crate::state::ServerState::new()?))
    }

    /// Create from shared server state.
    pub fn with_state(state: crate::state::ServerState) -> Self {
        Self {
            state,
            cancel: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            steer: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            busy: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            shell_cancels: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    /// Expose the shared manager (for tests / future processors).
    pub fn manager(&self) -> Arc<tokio::sync::Mutex<kimi_agent::session::manager::SessionManager>> {
        self.state.manager.clone()
    }
}

impl Processor for SessionProcessor {
    fn register(&self, processor: &mut MessageProcessor) {
        // `session/create` — create a session + agent (main.rs parity).
        let mgr = self.state.manager.clone();
        let callbacks = self.state.callbacks.clone();
        let approval = self.state.approval.clone();
        let permission = self.state.permission.clone();
        let cancel = self.cancel.clone();
        let steer = self.steer.clone();
        processor.register(kimi_protocol::methods::SESSION_CREATE, move |params| {
            let mgr = mgr.clone();
            let callbacks = callbacks.clone();
            let approval = approval.clone();
            let permission = permission.clone();
            let cancel = cancel.clone();
            let steer = steer.clone();
            Box::pin(async move {
                let mut input: kimi_agent::rpc::types::SessionCreateParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let id = input.session_id.take().unwrap_or_else(|| {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis();
                    format!("sess-{now}")
                });
                let mut manager = mgr.lock().await;
                manager.create_session(
                    &id,
                    kimi_agent::session::types::ModelConfig {
                        provider: input.provider.clone().unwrap_or_default(),
                        model: input.model.clone().unwrap_or_default(),
                        max_tokens: None,
                    },
                );
                manager.set_work_dir(&id, input.homedir.as_deref().unwrap_or(""));
                let rpc_callbacks = callbacks;
                let mcp_servers = std::mem::take(&mut input.mcp_servers);
                let workspace_trusted = input.workspace_trusted;
                let skills = std::mem::take(&mut input.skills);
                let external_hooks = std::mem::take(&mut input.hooks);
                let native_tools = input.native_tools;
                let homedir = input.homedir.clone();
                let (mcp_runtime, cancellation, steer_queue) = {
                    let secondary_native_llm = input.native_llm.as_ref().and_then(|primary| {
                        let env_map: std::collections::HashMap<String, String> =
                            std::env::vars().collect();
                        kimi_agent::config::loader::load_config_with_env()
                            .ok()
                            .and_then(|config| {
                                kimi_agent::config::native_llm::resolve_secondary_native_llm(
                                    Some(&config),
                                    primary,
                                    &env_map,
                                )
                            })
                    });
                    let agent = manager
                        .create_agent(
                            &id,
                            rpc_callbacks,
                            kimi_agent::agent::types::AgentOptions {
                                session_id: Some(id.clone()),
                                homedir: homedir.clone(),
                                config: Some(kimi_agent::agent::types::AgentConfig {
                                    cwd: homedir.clone().unwrap_or_default(),
                                    model_alias: input.model.take(),
                                    system_prompt: input.system_prompt.take().unwrap_or_default(),
                                    has_provider: true,
                                    has_model: true,
                                }),
                                goal_enabled: input.goal_enabled.unwrap_or(true),
                                native_llm: input.native_llm.take(),
                                secondary_native_llm,
                                host_tools: std::mem::take(&mut input.tools)
                                    .into_iter()
                                    .map(|t| kimi_agent::turn_loop::types::ToolInfo {
                                        name: t.name,
                                        description: t.description,
                                        input_schema: t.input_schema,
                                    })
                                    .collect(),
                                permission: Some(permission),
                                external_hooks,
                                approval: Some(approval),
                                ..Default::default()
                            },
                        )
                        .map_err(|e| JsonRpcError::internal_error(e.to_string()))?;
                    if native_tools {
                        if let Some(home) = homedir.as_deref() {
                            if let Some(toolset) = kimi_agent::tools::NativeToolset::new(home) {
                                let gated = kimi_agent::callbacks::NativeToolCallbacks {
                                    inner: agent.callbacks.clone(),
                                    toolset: std::sync::Arc::new(toolset),
                                    background: Some(agent.background.clone()),
                                    permission: Some(agent.permission.clone()),
                                    hooks: None,
                                    approval: Some(agent.approval.clone()),
                                };
                                agent.callbacks = std::sync::Arc::new(gated);
                            }
                        }
                    }
                    for skill in skills {
                        agent.skill_manager.registry.register(skill.into_metadata());
                    }
                    if let Some(max_context_size) = input.max_context_size {
                        if max_context_size > 0 {
                            agent.compaction.set_model(
                                kimi_agent::compaction::strategy::ProfileModelContext {
                                    max_size: max_context_size,
                                    ..Default::default()
                                },
                            );
                        }
                    }
                    (agent.mcp.clone(), agent.cancellation.clone(), agent.steer_queue.clone())
                };
                drop(manager);
                if !mcp_servers.is_empty() {
                    let mcp_started = std::time::Instant::now();
                    let rt_handle = mcp_runtime.clone();
                    let handle = tokio::runtime::Handle::current();
                    let _ = tokio::task::spawn_blocking(move || {
                        handle.block_on(async move {
                            let mut runtime = rt_handle.lock().await;
                            runtime.set_workspace_trusted(workspace_trusted);
                            for server in mcp_servers {
                                let (name, spec, source) = server.into_registration();
                                let _ = runtime.register(&name, spec, source).await;
                            }
                        });
                    })
                    .await;
                    let elapsed_ms = mcp_started.elapsed().as_millis() as u64;
                    if let Some(agent) = mgr.lock().await.get_agent(&id) {
                        agent.mcp_startup_ms = elapsed_ms;
                    }
                }
                cancel
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(id.clone(), cancellation);
                steer
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(id.clone(), steer_queue);
                {
                    let mut manager = mgr.lock().await;
                    if let Some(agent) = manager.get_agent(&id) {
                        agent
                            .fire_lifecycle_hook(
                                kimi_agent::hooks::external::HookEventType::SessionStart,
                                serde_json::json!({ "session_id": id }),
                            )
                            .await;
                    }
                }
                Ok(serde_json::json!({ "session_id": id }))
            })
        });

        // `session/prompt` — run a turn on the session agent.
        let mgr = self.state.manager.clone();
        let busy = self.busy.clone();
        processor.register(kimi_protocol::methods::SESSION_PROMPT, move |params| {
            let mgr = mgr.clone();
            let busy = busy.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionPromptParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let parts: Vec<kimi_agent::context::types::ContentPart> =
                    serde_json::from_value(input.input).map_err(|e| {
                        JsonRpcError::internal_error(format!("Invalid input parts: {e}"))
                    })?;
                let mut manager = mgr.lock().await;
                // Side-question routing: an `agent_id` of the form `btw-<sid>`
                // drives the session's side agent instead of the main agent.
                let agent = match input.agent_id.as_deref() {
                    Some(id) if id.starts_with("btw-") => {
                        manager.get_btw_agent(&input.session_id).ok_or_else(|| {
                            JsonRpcError::internal_error(format!(
                                "no side agent for session: {}",
                                input.session_id
                            ))
                        })?
                    }
                    _ => manager.get_agent(&input.session_id).ok_or_else(|| {
                        JsonRpcError::internal_error(format!(
                            "no agent for session: {}",
                            input.session_id
                        ))
                    })?,
                };
                // Mark the session busy so fork/compact can reject it
                // immediately instead of blocking for the whole turn.
                {
                    let mut busy = busy.lock().unwrap_or_else(|e| e.into_inner());
                    busy.insert(input.session_id.clone(), true);
                }
                let result = agent.run_prompt(parts).await.map_err(|e| {
                    JsonRpcError::internal_error(format!("run_prompt failed: {e}"))
                });
                {
                    let mut busy = busy.lock().unwrap_or_else(|e| e.into_inner());
                    busy.remove(&input.session_id);
                }
                let result = result?;
                Ok(serde_json::json!({
                    "stop_reason": format!("{:?}", result.stop_reason),
                    "steps": result.steps,
                    "usage": result.usage,
                }))
            })
        });

        // `session/cancel` — flag the running turn for cancellation.
        let cancel = self.cancel.clone();
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_CANCEL, move |params| {
            let cancel = cancel.clone();
            let mgr = mgr.clone();
            Box::pin(async move {
                use std::sync::atomic::Ordering;
                let input: kimi_protocol::wire_types::SessionIdParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let cancelled = {
                    let map = cancel.lock().unwrap_or_else(|e| e.into_inner());
                    match map.get(&input.session_id) {
                        Some(flag) => {
                            flag.store(true, Ordering::Relaxed);
                            true
                        }
                        None => false,
                    }
                };
                // Interrupt hooks: fire-and-forget when the cancel actually took
                // effect (a flag existed for this session).
                if cancelled {
                    let mut manager = mgr.lock().await;
                    if let Some(agent) = manager.get_agent(&input.session_id) {
                        agent
                            .fire_lifecycle_hook(
                                kimi_agent::hooks::external::HookEventType::Interrupt,
                                serde_json::json!({
                                    "session_id": input.session_id,
                                    "reason": "user_cancelled",
                                }),
                            )
                            .await;
                    }
                }
                Ok(serde_json::json!({ "cancelled": cancelled }))
            })
        });

        // `session/set_model` — switch the agent's model.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_SET_MODEL, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionSetModelParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                agent.set_model(input.model);
                Ok(serde_json::json!({ "ok": true }))
            })
        });

        // `session/clear_context` — clear the session's model context.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_CLEAR_CONTEXT, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: SessionGoalParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                let cleared = agent.context.clear().is_some();
                Ok(serde_json::json!({ "cleared": cleared }))
            })
        });

        // `session/set_thinking` — reasoning effort.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_SET_THINKING, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionSetThinkingParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                agent.set_thinking(input.effort);
                Ok(serde_json::json!({ "ok": true }))
            })
        });

        // `session/set_swarm_mode` — toggle the swarm state machine.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_SET_SWARM_MODE, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionSetSwarmModeParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let trigger = match input.trigger.as_deref() {
                    None | Some("manual") => kimi_agent::swarm::SwarmModeTrigger::Manual,
                    Some("task") => kimi_agent::swarm::SwarmModeTrigger::Task,
                    Some("tool") => kimi_agent::swarm::SwarmModeTrigger::Tool,
                    Some(other) => {
                        return Err(JsonRpcError::internal_error(format!(
                            "invalid swarm trigger: {other}"
                        )));
                    }
                };
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                let active = agent.set_swarm_mode(input.enabled, trigger);
                Ok(serde_json::json!({ "active": active }))
            })
        });

        // `session/set_plan_mode` — toggle plan mode.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_SET_PLAN_MODE, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionSetPlanModeParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                let plan_mode = agent
                    .set_plan_mode(input.enabled)
                    .map_err(JsonRpcError::internal_error)?;
                Ok(serde_json::json!({ "plan_mode": plan_mode }))
            })
        });

        // `session/get_context` — full context snapshot.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_GET_CONTEXT, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: SessionGoalParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                serde_json::to_value(agent.context.data())
                    .map_err(|e| JsonRpcError::internal_error(format!("serialize context: {e}")))
            })
        });

        // `session/undo_history` — undo the last N user turns.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_UNDO_HISTORY, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionUndoHistoryParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                let cut = agent
                    .undo_history(input.count)
                    .map_err(JsonRpcError::internal_error)?;
                Ok(serde_json::json!({
                    "undone_turns": cut.removed_count,
                    "cut_index": cut.cut_index,
                }))
            })
        });

        // `session/import_context` — append imported transcript text.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_IMPORT_CONTEXT, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionImportContextParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                agent
                    .context
                    .import_context(
                        &input.content,
                        &input.source,
                        Some(agent.compaction.strategy().max_size()),
                    )
                    .map_err(JsonRpcError::internal_error)?;
                Ok(serde_json::json!({ "imported": true }))
            })
        });

        // `session/activate_skill` — render a skill prompt + run a turn.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_ACTIVATE_SKILL, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionActivateSkillParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                let result = agent
                    .activate_skill(input.name, input.args)
                    .await
                    .map_err(|e| {
                        JsonRpcError::internal_error(format!("activate_skill failed: {e}"))
                    })?;
                Ok(serde_json::json!({
                    "stop_reason": format!("{:?}", result.stop_reason),
                    "steps": result.steps,
                    "usage": result.usage,
                }))
            })
        });

        // `session/steer` — push user input into the running goal turn.
        let steer = self.steer.clone();
        processor.register(kimi_protocol::methods::SESSION_STEER, move |params| {
            let steer = steer.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionSteerParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let parts: Vec<kimi_agent::context::types::ContentPart> =
                    serde_json::from_value(input.input).map_err(|e| {
                        JsonRpcError::internal_error(format!("Invalid input parts: {e}"))
                    })?;
                // Push onto the shared steer queue without the manager lock.
                let queued = {
                    let map = steer.lock().unwrap_or_else(|e| e.into_inner());
                    match map.get(&input.session_id) {
                        Some(q) => {
                            q.lock().unwrap_or_else(|e| e.into_inner()).extend(parts);
                            true
                        }
                        None => false,
                    }
                };
                Ok(serde_json::json!({ "queued": queued }))
            })
        });

        // `session/goal_create` — create (or replace) the session goal.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_GOAL_CREATE, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionGoalCreateParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                let snapshot = agent
                    .goal_create(kimi_agent::goal::CreateGoalInput {
                        objective: input.objective,
                        completion_criterion: input.completion_criterion,
                        replace: input.replace,
                    })
                    .map_err(JsonRpcError::internal_error)?;
                serde_json::to_value(&snapshot)
                    .map_err(|e| JsonRpcError::internal_error(e.to_string()))
            })
        });

        // `session/goal_get` — current goal snapshot (null when none).
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_GOAL_GET, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: SessionGoalParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                serde_json::to_value(agent.goal_get())
                    .map_err(|e| JsonRpcError::internal_error(e.to_string()))
            })
        });

        // `session/goal_pause` / `goal_resume` / `goal_cancel` — goal lifecycle.
        for (method, op) in [
            (kimi_protocol::methods::SESSION_GOAL_PAUSE, "pause" as &str),
            (kimi_protocol::methods::SESSION_GOAL_RESUME, "resume" as &str),
            (kimi_protocol::methods::SESSION_GOAL_CANCEL, "cancel" as &str),
        ] {
            let mgr = self.state.manager.clone();
            processor.register(method, move |params| {
                let mgr = mgr.clone();
                Box::pin(async move {
                    let input: kimi_protocol::wire_types::SessionGoalReasonParams =
                        serde_json::from_value(params)
                            .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                    let mut manager = mgr.lock().await;
                    let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                        JsonRpcError::internal_error(format!(
                            "no agent for session: {}",
                            input.session_id
                        ))
                    })?;
                    let snapshot = match op {
                        "pause" => agent.goal_pause(input.reason),
                        "resume" => agent.goal_resume(input.reason),
                        _ => agent.goal_cancel(),
                    }
                    .map_err(JsonRpcError::internal_error)?;
                    serde_json::to_value(&snapshot)
                        .map_err(|e| JsonRpcError::internal_error(e.to_string()))
                })
            });
        }

        // `session/save` — persist the session agent state.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_SAVE, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionIdParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                manager
                    .save_agent_session(&input.session_id)
                    .map_err(|e| JsonRpcError::internal_error(e.to_string()))?;
                Ok(serde_json::json!({ "ok": true }))
            })
        });

        // `session/delete` — permanently delete a persisted session.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_DELETE, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionIdParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let deleted = manager
                    .delete_persisted_session(&input.session_id)
                    .map_err(|e| JsonRpcError::internal_error(e.to_string()))?;
                Ok(serde_json::json!({ "deleted": deleted }))
            })
        });

        // `session/load` — rebuild an agent from its persisted record.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_LOAD, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionIdParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let found = manager
                    .load_agent_session(&input.session_id)
                    .map_err(|e| JsonRpcError::internal_error(e.to_string()))?;
                Ok(serde_json::json!({ "found": found }))
            })
        });

        // `session/fork` — copy a persisted session under a new id.
        let mgr = self.state.manager.clone();
        let busy = self.busy.clone();
        processor.register(kimi_protocol::methods::SESSION_FORK, move |params| {
            let mgr = mgr.clone();
            let busy = busy.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionForkParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                // Reject a busy session WITHOUT taking the manager lock: a
                // running prompt holds it for the whole turn.
                {
                    let busy = busy.lock().unwrap_or_else(|e| e.into_inner());
                    if busy.get(&input.session_id).copied().unwrap_or(false) {
                        return Err(JsonRpcError::internal_error(
                            "session has an active turn; cancel it before forking".to_string(),
                        ));
                    }
                }
                let mut manager = mgr.lock().await;
                let forked = manager
                    .fork_session(
                        &input.session_id,
                        &input.fork_id,
                        input.title.as_deref(),
                        input.turn_index,
                    )
                    .map_err(|e| JsonRpcError::internal_error(e.to_string()))?;
                Ok(serde_json::json!({ "forked": forked.is_some() }))
            })
        });

        // `session/compact` — manually compact the session context.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_COMPACT, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionCompactParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                agent
                    .compact(input.instruction)
                    .await
                    .map_err(JsonRpcError::internal_error)
            })
        });

        // `session/start_btw` — spawn a side-question subagent.
        let mgr = self.state.manager.clone();
        let callbacks = self.state.callbacks.clone();
        processor.register(kimi_protocol::methods::SESSION_START_BTW, move |params| {
            let mgr = mgr.clone();
            let callbacks = callbacks.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionIdParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let btw_id = manager
                    .start_btw(&input.session_id, callbacks)
                    .map_err(|e| JsonRpcError::internal_error(e))?;
                Ok(serde_json::json!({ "btw_id": btw_id }))
            })
        });

        // `session/end_btw` — destroy the side-question subagent.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_END_BTW, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionIdParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let ended = manager.end_btw(&input.session_id);
                Ok(serde_json::json!({ "ended": ended }))
            })
        });

        // `session/run_shell` — run a `!` shell command (streaming or not).
        let mgr = self.state.manager.clone();
        let shc = self.shell_cancels.clone();
        processor.register(kimi_protocol::methods::SESSION_RUN_SHELL, move |params| {
            let mgr = mgr.clone();
            let shc = shc.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionRunShellParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                // Capture what the streaming run needs, then release the lock.
                let (callbacks, cwd) = {
                    let mut manager = mgr.lock().await;
                    let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                        JsonRpcError::internal_error(format!(
                            "no agent for session: {}",
                            input.session_id
                        ))
                    })?;
                    (agent.callbacks.clone(), agent.config.cwd.clone())
                };
                let runner = match kimi_agent::tools::bash::BashRunner::detect() {
                    Some(r) => r,
                    None => {
                        return Ok(serde_json::json!({
                            "output": null, "is_error": false, "unavailable": true
                        }));
                    }
                };
                use std::sync::atomic::AtomicBool;
                match input.command_id {
                    Some(command_id) => {
                        let cancel = std::sync::Arc::new(AtomicBool::new(false));
                        shc.lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(command_id.clone(), cancel.clone());
                        let session_id = input.session_id.clone();
                        let cid = command_id.clone();
                        let outcome = runner
                            .run_streaming(
                                &input.command,
                                std::path::Path::new(&cwd),
                                input.timeout_s,
                                cancel,
                                |chunk| {
                                    callbacks.emit_event(serde_json::json!({
                                        "type": "session.shell.output",
                                        "session_id": session_id,
                                        "command_id": cid,
                                        "chunk": chunk,
                                    }));
                                },
                            )
                            .await;
                        shc.lock().unwrap_or_else(|e| e.into_inner()).remove(&command_id);
                        Ok(serde_json::json!({
                            "output": outcome.output,
                            "is_error": outcome.is_error,
                            "cancelled": outcome.cancelled,
                        }))
                    }
                    None => {
                        let cancel = std::sync::Arc::new(AtomicBool::new(false));
                        let outcome = runner
                            .run_streaming(
                                &input.command,
                                std::path::Path::new(&cwd),
                                input.timeout_s,
                                cancel,
                                |_chunk| {},
                            )
                            .await;
                        Ok(serde_json::json!({
                            "output": outcome.output,
                            "is_error": outcome.is_error,
                        }))
                    }
                }
            })
        });

        // `session/cancel_shell_command` — flag a streaming command to stop.
        let shc = self.shell_cancels.clone();
        processor.register(kimi_protocol::methods::SESSION_CANCEL_SHELL_COMMAND, move |params| {
            let shc = shc.clone();
            Box::pin(async move {
                use std::sync::atomic::Ordering;
                let input: kimi_protocol::wire_types::SessionCancelShellParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let flag = shc
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&input.command_id)
                    .cloned();
                if let Some(flag_ref) = flag.as_ref() {
                    flag_ref.store(true, Ordering::Relaxed);
                }
                Ok(serde_json::json!({ "cancelled": flag.is_some() }))
            })
        });

        // `session/export` — zip the session's records + files.
        processor.register(kimi_protocol::methods::SESSION_EXPORT, move |params| {
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionExportParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let store = crate::state::open_session_store()
                    .map_err(|e| JsonRpcError::internal_error(format!("open store: {e}")))?;
                let record_store = kimi_agent::persistence::RecordStore::new(store);
                let session_dir = input
                    .homedir
                    .clone()
                    .map(std::path::PathBuf::from)
                    .or_else(|| std::env::current_dir().ok())
                    .unwrap_or_default();
                let zip_bytes = kimi_agent::session::export::export_session_with_web_log(
                    &input.session_id,
                    &session_dir,
                    &record_store,
                    input.web_log.as_deref(),
                )
                .map_err(|e| JsonRpcError::internal_error(format!("export: {e}")))?;
                Ok(serde_json::json!({
                    "session_id": input.session_id,
                    "zip_base64": base64::engine::general_purpose::STANDARD.encode(&zip_bytes),
                }))
            })
        });

        // `session/list_skills` — registered skills (sorted by name).
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_LIST_SKILLS, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: SessionGoalParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                let mut skills = agent.skill_manager.registry.list_skills();
                skills.sort_by(|a, b| a.name.cmp(&b.name));
                let skills: Vec<kimi_protocol::wire_types::SkillSummaryRpc> = skills
                    .into_iter()
                    .map(|s| kimi_protocol::wire_types::SkillSummaryRpc {
                        name: s.name.clone(),
                        description: s.description.clone(),
                        skill_type: s.skill_type.clone(),
                        source: s.source.clone(),
                        path: s.path.clone(),
                        dir: s.dir.clone(),
                    })
                    .collect();
                serde_json::to_value(kimi_protocol::wire_types::SkillListResult { skills })
                    .map_err(|e| {
                        JsonRpcError::internal_error(format!("list_skills serialize failed: {e}"))
                    })
            })
        });

        // `session/get_status` — live engine status snapshot.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_GET_STATUS, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: SessionGoalParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                serde_json::to_value(agent.session_status())
                    .map_err(|e| JsonRpcError::internal_error(format!("serialize: {e}")))
            })
        });

        // `session/list` — persisted session summaries.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_LIST, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionListParams =
                    serde_json::from_value(params).unwrap_or_default();
                let manager = mgr.lock().await;
                let sessions = manager
                    .list_persisted(input.limit.unwrap_or(50), input.offset.unwrap_or(0))
                    .map_err(|e| JsonRpcError::internal_error(e.to_string()))?
                    .into_iter()
                    .map(|record| {
                        // The rich session record (work_dir/title) lives inside
                        // state_json; degrade gracefully to the id-only shape.
                        let rich =
                            serde_json::from_value::<kimi_agent::session::types::SessionRecord>(
                                record.state_json.clone(),
                            )
                            .unwrap_or_else(|_| {
                                kimi_agent::session::types::SessionRecord::new(
                                    record.id.clone(),
                                    kimi_agent::session::types::ModelConfig::default(),
                                )
                            });
                        kimi_protocol::wire_types::SessionSummaryRpc {
                            id: record.id,
                            created_at: record.created_at,
                            updated_at: record.updated_at,
                            title: rich.title,
                            work_dir: rich.work_dir,
                        }
                    })
                    .collect::<Vec<_>>();
                serde_json::to_value(kimi_protocol::wire_types::SessionListResult { sessions })
                    .map_err(|e| JsonRpcError::internal_error(format!("session/list serialize failed: {e}")))
            })
        });

        // `session/get_usage` — cumulative token usage.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_GET_USAGE, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: SessionGoalParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                serde_json::to_value(agent.usage.data())
                    .map_err(|e| JsonRpcError::internal_error(e.to_string()))
            })
        });

        // `session/get_plan` — active plan snapshot (null when none).
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_GET_PLAN, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: SessionGoalParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                let plan = agent.get_plan().map_err(JsonRpcError::internal_error)?;
                match plan {
                    Some(p) => serde_json::to_value(p)
                        .map_err(|e| JsonRpcError::internal_error(format!("serialize plan: {e}"))),
                    None => Ok(serde_json::Value::Null),
                }
            })
        });

        // `session/get_warnings` — failed / needs-auth MCP servers surface as
        // session warnings (the engine's own signal).
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_GET_WARNINGS, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: SessionGoalParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mcp = {
                    let mut manager = mgr.lock().await;
                    let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                        JsonRpcError::internal_error(format!(
                            "no agent for session: {}",
                            input.session_id
                        ))
                    })?;
                    agent.mcp.clone()
                };
                // Same lock-after-release order as list_mcp_servers.
                use kimi_agent::mcp::connection_manager::McpServerStatus;
                let warnings: Vec<kimi_protocol::wire_types::SessionWarning> = mcp
                    .lock()
                    .await
                    .list()
                    .into_iter()
                    .filter(|e| {
                        matches!(e.status, McpServerStatus::Failed | McpServerStatus::NeedsAuth)
                    })
                    .map(|e| {
                        let (code, detail) = match e.status {
                            McpServerStatus::NeedsAuth => (
                                "mcp-server-needs-auth",
                                e.error
                                    .clone()
                                    .unwrap_or_else(|| "authentication required".to_string()),
                            ),
                            _ => (
                                "mcp-server-failed",
                                e.error
                                    .clone()
                                    .unwrap_or_else(|| "connection failed".to_string()),
                            ),
                        };
                        kimi_protocol::wire_types::SessionWarning {
                            code: code.to_string(),
                            message: format!("MCP server \"{}\": {}", e.name, detail),
                            severity: "warning".to_string(),
                        }
                    })
                    .collect();
                serde_json::to_value(kimi_protocol::wire_types::WarningsResult { warnings })
                    .map_err(|e| {
                        JsonRpcError::internal_error(format!("get_warnings serialize failed: {e}"))
                    })
            })
        });

        // `session/list_mcp_servers` — per-server views.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_LIST_MCP_SERVERS, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: SessionGoalParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mcp = {
                    let mut manager = mgr.lock().await;
                    let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                        JsonRpcError::internal_error(format!(
                            "no agent for session: {}",
                            input.session_id
                        ))
                    })?;
                    agent.mcp.clone()
                };
                // Lock the runtime outside the manager lock so a slow MCP call
                // in a running turn cannot deadlock against this listing.
                let servers: Vec<kimi_protocol::wire_types::McpServerInfoRpc> = mcp
                    .lock()
                    .await
                    .list()
                    .into_iter()
                    .map(|entry| kimi_protocol::wire_types::McpServerInfoRpc {
                        name: entry.name,
                        transport: entry.transport.as_str().to_string(),
                        status: entry.status.as_str().to_string(),
                        tool_count: entry.tool_count,
                        error: entry.error,
                    })
                    .collect();
                serde_json::to_value(kimi_protocol::wire_types::McpServerListResult { servers })
                    .map_err(|e| {
                        JsonRpcError::internal_error(format!("list_mcp_servers serialize failed: {e}"))
                    })
            })
        });

        // `session/clear_plan` — clear the active plan's file content (SDK
        // `clearPlan` parity).
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_CLEAR_PLAN, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: SessionGoalParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                agent
                    .clear_plan()
                    .map_err(JsonRpcError::internal_error)?;
                Ok(serde_json::json!({ "cleared": true }))
            })
        });

        // `session/get_mcp_startup_metrics` — the connect duration recorded at
        // session/create (SDK `getMcpStartupMetrics` parity).
        let mgr = self.state.manager.clone();
        processor.register(
            kimi_protocol::methods::SESSION_GET_MCP_STARTUP_METRICS,
            move |params| {
                let mgr = mgr.clone();
                Box::pin(async move {
                    let input: SessionGoalParams = serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                    let mut manager = mgr.lock().await;
                    let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                        JsonRpcError::internal_error(format!(
                            "no agent for session: {}",
                            input.session_id
                        ))
                    })?;
                    serde_json::to_value(
                        kimi_protocol::wire_types::McpStartupMetricsResult {
                            duration_ms: agent.mcp_startup_ms,
                        },
                    )
                    .map_err(|e| {
                        JsonRpcError::internal_error(format!(
                            "get_mcp_startup_metrics serialize failed: {e}"
                        ))
                    })
                })
            },
        );

        // `session/init` — generate AGENTS.md (SDK `Session.init` parity): the
        // engine explores the project with native Read/Write tools and writes
        // the file.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_INIT, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionInitParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                agent
                    .init_agents_md()
                    .await
                    .map_err(|e| JsonRpcError::internal_error(format!("init failed: {e}")))?;
                Ok(serde_json::json!({ "ok": true }))
            })
        });

        // `session/reconnect_mcp_server` — reconnect a single MCP server (SDK
        // `reconnectMcpServer` parity). Clones the runtime handle inside the
        // manager lock, then reconnects outside it so a slow reconnect cannot
        // deadlock against a running turn (same order as list_mcp_servers).
        let mgr = self.state.manager.clone();
        processor.register(
            kimi_protocol::methods::SESSION_RECONNECT_MCP_SERVER,
            move |params| {
                let mgr = mgr.clone();
                Box::pin(async move {
                    let input: kimi_protocol::wire_types::SessionReconnectMcpParams =
                        serde_json::from_value(params).map_err(|e| {
                            JsonRpcError::internal_error(format!("Invalid params: {e}"))
                        })?;
                    let mcp = {
                        let mut manager = mgr.lock().await;
                        let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                            JsonRpcError::internal_error(format!(
                                "no agent for session: {}",
                                input.session_id
                            ))
                        })?;
                        agent.mcp.clone()
                    };
                    // `reconnect` connects the transport, whose stdio channel
                    // holds a `!Send` receiver across awaits — drive it on a
                    // blocking thread via `Handle::block_on` and only await the
                    // Send `JoinHandle` here (same technique as session/create).
                    let name = input.name.clone();
                    let handle = tokio::runtime::Handle::current();
                    let entry = tokio::task::spawn_blocking(move || {
                        handle.block_on(async move { mcp.lock().await.reconnect(&name).await })
                    })
                    .await
                    .map_err(|e| {
                        JsonRpcError::internal_error(format!("reconnect join: {e}"))
                    })?
                    .map_err(JsonRpcError::internal_error)?;
                    serde_json::to_value(kimi_protocol::wire_types::McpServerInfoRpc {
                        name: entry.name,
                        transport: entry.transport.as_str().to_string(),
                        status: entry.status.as_str().to_string(),
                        tool_count: entry.tool_count,
                        error: entry.error,
                    })
                    .map_err(|e| {
                        JsonRpcError::internal_error(format!(
                            "reconnect_mcp_server serialize failed: {e}"
                        ))
                    })
                })
            },
        );

        // `session/update_metadata` — patch the session's metadata blob (SDK
        // `updateMetadata` parity).
        let mgr = self.state.manager.clone();
        processor.register(
            kimi_protocol::methods::SESSION_UPDATE_METADATA,
            move |params| {
                let mgr = mgr.clone();
                Box::pin(async move {
                    let input: kimi_protocol::wire_types::SessionUpdateMetadataParams =
                        serde_json::from_value(params).map_err(|e| {
                            JsonRpcError::internal_error(format!("Invalid params: {e}"))
                        })?;
                    if !input.metadata.is_object() {
                        return Err(JsonRpcError::internal_error(
                            "metadata must be a JSON object".to_string(),
                        ));
                    }
                    let mut manager = mgr.lock().await;
                    let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                        JsonRpcError::internal_error(format!(
                            "no agent for session: {}",
                            input.session_id
                        ))
                    })?;
                    agent.update_metadata(input.metadata);
                    Ok(serde_json::json!({ "ok": true, "metadata": agent.metadata }))
                })
            },
        );

        // `session/destroy` — runtime teardown (SDK close parity): SessionEnd
        // hooks fire first (fire-and-forget), then the in-memory agent + side
        // agent are dropped. The persisted record is intentionally left for
        // later `session/load` — destroy is not a delete.
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_DESTROY, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionIdParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let existed = manager.get_agent(&input.session_id).is_some()
                    || manager.get_btw_agent(&input.session_id).is_some();
                if let Some(agent) = manager.get_agent(&input.session_id) {
                    agent
                        .fire_lifecycle_hook(
                            kimi_agent::hooks::external::HookEventType::SessionEnd,
                            serde_json::json!({ "session_id": input.session_id }),
                        )
                        .await;
                }
                manager
                    .destroy_agent(&input.session_id)
                    .map_err(|e| JsonRpcError::internal_error(e.to_string()))?;
                Ok(serde_json::json!({ "destroyed": existed }))
            })
        });

        // `session/list_tools` — native tool definitions for the session
        // workspace (web `GET /tools` parity).
        processor.register(kimi_protocol::methods::SESSION_LIST_TOOLS, move |params| {
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionListToolsParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let root = input.homedir.clone().unwrap_or_default();
                let mut defs: Vec<kimi_protocol::wire_types::ToolDef> =
                    kimi_agent::tools::NativeToolset::new(&root)
                        .map(|ts| {
                            ts.tool_definitions()
                                .into_iter()
                                .map(|td| kimi_protocol::wire_types::ToolDef {
                                    name: td.name,
                                    description: td.description,
                                    input_schema: td.input_schema.unwrap_or(serde_json::Value::Null),
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                // Goal tools advertised with an active goal (mirror agent.rs).
                defs.extend(
                    kimi_agent::agent::agent::goal_tool_definitions()
                        .into_iter()
                        .map(|td| kimi_protocol::wire_types::ToolDef {
                            name: td.name,
                            description: td.description,
                            input_schema: td.input_schema,
                        }),
                );
                serde_json::to_value(kimi_protocol::wire_types::ListToolsResult { tools: defs })
                    .map_err(|e| {
                        JsonRpcError::internal_error(format!("list_tools serialize failed: {e}"))
                    })
            })
        });

        // `session/add_additional_dir` / `session/remove_additional_dir` — the
        // session's extra workspace dirs (SDK `addAdditionalDir` parity).
        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_ADD_DIR, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionAddDirParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                let success = agent.add_additional_dir(input.path);
                let result = kimi_protocol::wire_types::SessionAddDirResult {
                    success,
                    additional_dirs: agent.additional_dirs().to_vec(),
                };
                Ok(serde_json::to_value(result).unwrap())
            })
        });

        let mgr = self.state.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_REMOVE_DIR, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionRemoveDirParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                let success = agent.remove_additional_dir(&input.path);
                let result = kimi_protocol::wire_types::SessionRemoveDirResult {
                    success,
                    additional_dirs: agent.additional_dirs().to_vec(),
                };
                Ok(serde_json::to_value(result).unwrap())
            })
        });
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use kimi_protocol::rpc::JsonRpcRequest;

    #[tokio::test]
    async fn get_status_missing_session_yields_engine_error() {
        let processor = SessionProcessor::new().expect("session processor");
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/get_status".into(),
                params: serde_json::json!({ "session_id": "does-not-exist" }),
            })
            .await;
        assert_eq!(body["error"]["message"], "no agent for session: does-not-exist");
    }

    #[tokio::test]
    async fn list_returns_empty_page() {
        // Serialize with tests that touch `KIMI_AGENT_HOME`: that env var is
        // process-global, and the export test repoints it at a temp store.
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let processor = SessionProcessor::new().expect("session processor");
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/list".into(),
                params: serde_json::json!({ "limit": 5 }),
            })
            .await;
        assert!(body.get("error").is_none(), "session/list should not error: {body}");
        assert_eq!(body["result"]["sessions"], serde_json::json!([]));
    }


    #[tokio::test]
    async fn get_usage_missing_session_yields_engine_error() {
        let processor = SessionProcessor::new().expect("session processor");
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/get_usage".into(),
                params: serde_json::json!({ "session_id": "nope" }),
            })
            .await;
        assert_eq!(body["error"]["message"], "no agent for session: nope");
    }
}

#[cfg(test)]
mod create_tests {
    use super::*;
    use kimi_protocol::rpc::JsonRpcRequest;

    #[tokio::test]
    async fn create_then_list_shows_session() {
        let state = crate::state::ServerState::new().expect("state");
        let processor = SessionProcessor::with_state(state);
        let mut server = MessageProcessor::new();
        processor.register(&mut server);

        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/create".into(),
                params: serde_json::json!({ "session_id": "s-test-create" }),
            })
            .await;
        assert!(body.get("error").is_none(), "create failed: {body}");
        assert_eq!(body["result"]["session_id"], "s-test-create");

        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "session/list".into(),
                params: serde_json::json!({ "limit": 50 }),
            })
            .await;
        let sessions = body["result"]["sessions"].as_array().expect("sessions");
        assert!(
            sessions.iter().any(|s| s["id"] == "s-test-create"),
            "created session should appear in list: {body}"
        );
    }

    #[tokio::test]
    async fn extended_session_methods_roundtrip() {
        let state = crate::state::ServerState::new().expect("state");
        let processor = SessionProcessor::with_state(state);
        let mut server = MessageProcessor::new();
        processor.register(&mut server);

        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/create".into(),
                params: serde_json::json!({ "session_id": "s-test-ext" }),
            })
            .await;
        assert!(body.get("error").is_none(), "create failed: {body}");

        // update_metadata merges a JSON object and echoes it back.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "session/update_metadata".into(),
                params: serde_json::json!({
                    "session_id": "s-test-ext",
                    "metadata": { "kind": "test" },
                }),
            })
            .await;
        assert!(body.get("error").is_none(), "update_metadata failed: {body}");
        assert_eq!(body["result"]["metadata"]["kind"], "test");

        // get_mcp_startup_metrics exposes a duration_ms counter.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(3),
                method: "session/get_mcp_startup_metrics".into(),
                params: serde_json::json!({ "session_id": "s-test-ext" }),
            })
            .await;
        assert!(body.get("error").is_none(), "metrics failed: {body}");
        assert!(body["result"]["duration_ms"].is_u64());

        // clear_plan succeeds even without an active plan.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(4),
                method: "session/clear_plan".into(),
                params: serde_json::json!({ "session_id": "s-test-ext" }),
            })
            .await;
        assert!(body.get("error").is_none(), "clear_plan failed: {body}");
        assert_eq!(body["result"]["cleared"], true);

        // add/remove additional dir roundtrip on a real temp dir.
        let tmp = std::env::temp_dir().join(format!("kimi-ext-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).expect("mkdir");
        let dir = tmp.to_string_lossy().to_string();
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(5),
                method: "session/add_additional_dir".into(),
                params: serde_json::json!({
                    "session_id": "s-test-ext",
                    "path": dir,
                }),
            })
            .await;
        assert!(body.get("error").is_none(), "add_additional_dir failed: {body}");
        assert_eq!(body["result"]["success"], true);
        assert!(
            body["result"]["additional_dirs"].as_array().is_some_and(|a| a.len() >= 1),
            "dir should be listed: {body}"
        );
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(6),
                method: "session/remove_additional_dir".into(),
                params: serde_json::json!({
                    "session_id": "s-test-ext",
                    "path": dir,
                }),
            })
            .await;
        assert!(body.get("error").is_none(), "remove_additional_dir failed: {body}");
        assert_eq!(body["result"]["success"], true);
        let _ = std::fs::remove_dir_all(&tmp);

        // destroy tears down the runtime agent (persisted record stays).
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(7),
                method: "session/destroy".into(),
                params: serde_json::json!({ "session_id": "s-test-ext" }),
            })
            .await;
        assert!(body.get("error").is_none(), "destroy failed: {body}");
        assert_eq!(body["result"]["destroyed"], true);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(8),
                method: "session/destroy".into(),
                params: serde_json::json!({ "session_id": "s-test-ext" }),
            })
            .await;
        assert_eq!(body["result"]["destroyed"], false);
    }



    #[tokio::test]
    async fn prompt_missing_session_yields_engine_error() {
        let state = crate::state::ServerState::new().expect("state");
        let processor = SessionProcessor::with_state(state);
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/prompt".into(),
                params: serde_json::json!({
                    "session_id": "nope",
                    "input": [ { "type": "text", "text": "hi" } ],
                }),
            })
            .await;
        assert_eq!(body["error"]["message"], "no agent for session: nope");
    }


    #[tokio::test]
    async fn cancel_unknown_session_returns_false() {
        let state = crate::state::ServerState::new().expect("state");
        let processor = SessionProcessor::with_state(state);
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/cancel".into(),
                params: serde_json::json!({ "session_id": "nope" }),
            })
            .await;
        assert!(body.get("error").is_none(), "cancel should not error: {body}");
        assert_eq!(body["result"]["cancelled"], false);
    }

    #[tokio::test]
    async fn list_skills_and_get_plan_empty_states() {
        let state = crate::state::ServerState::new().expect("state");
        let processor = SessionProcessor::with_state(state);
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/create".into(),
                params: serde_json::json!({ "session_id": "s-skills" }),
            })
            .await;
        assert!(body.get("error").is_none(), "create failed: {body}");

        // A fresh session has no skills registered.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "session/list_skills".into(),
                params: serde_json::json!({ "session_id": "s-skills" }),
            })
            .await;
        assert!(body.get("error").is_none(), "list_skills failed: {body}");
        assert!(body["result"]["skills"].is_array());

        // And no active plan yet (get_plan returns an empty result, no error).
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(3),
                method: "session/get_plan".into(),
                params: serde_json::json!({ "session_id": "s-skills" }),
            })
            .await;
        assert!(body.get("error").is_none(), "get_plan failed: {body}");
    }

    #[tokio::test]
    async fn list_tools_returns_native_and_goal_tools() {
        let state = crate::state::ServerState::new().expect("state");
        let processor = SessionProcessor::with_state(state);
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/list_tools".into(),
                params: serde_json::json!({
                    "session_id": "s-tools",
                    "homedir": std::env::temp_dir().to_string_lossy(),
                }),
            })
            .await;
        assert!(body.get("error").is_none(), "list_tools failed: {body}");
        let tools = body["result"]["tools"].as_array().expect("tools array");
        // Native toolset (Read/Glob/Write/…) plus goal tools.
        assert!(tools.len() >= 4, "expected the native toolset: {body}");
        assert!(
            tools.iter().any(|t| t["name"] == "Read") && tools.iter().any(|t| t["name"] == "Glob"),
            "native tools present: {body}"
        );
    }

    #[tokio::test]
    async fn goal_roundtrip_on_session() {
        let state = crate::state::ServerState::new().expect("state");
        let processor = SessionProcessor::with_state(state);
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/create".into(),
                params: serde_json::json!({ "session_id": "s-goal-srv" }),
            })
            .await;
        assert!(body.get("error").is_none(), "create failed: {body}");

        // Create -> snapshot carries the objective.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "session/goal_create".into(),
                params: serde_json::json!({
                    "session_id": "s-goal-srv",
                    "objective": "finish the migration",
                }),
            })
            .await;
        assert!(body.get("error").is_none(), "goal_create failed: {body}");
        assert_eq!(body["result"]["objective"], "finish the migration");

        // goal_get nests the snapshot under `goal`.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(3),
                method: "session/goal_get".into(),
                params: serde_json::json!({ "session_id": "s-goal-srv" }),
            })
            .await;
        assert!(body.get("error").is_none(), "goal_get failed: {body}");
        assert_eq!(body["result"]["goal"]["objective"], "finish the migration");

        // Pause / resume / cancel complete the lifecycle.
        for method in ["session/goal_pause", "session/goal_resume"] {
            let body = server
                .handle(JsonRpcRequest {
                    jsonrpc: "2.0".into(),
                    id: serde_json::json!(4),
                    method: method.into(),
                    params: serde_json::json!({ "session_id": "s-goal-srv" }),
                })
                .await;
            assert!(body.get("error").is_none(), "{method} failed: {body}");
        }
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(5),
                method: "session/goal_cancel".into(),
                params: serde_json::json!({ "session_id": "s-goal-srv" }),
            })
            .await;
        assert!(body.get("error").is_none(), "goal_cancel failed: {body}");
    }

    #[tokio::test]
    async fn steer_queues_input_for_existing_session() {
        let state = crate::state::ServerState::new().expect("state");
        let processor = SessionProcessor::with_state(state);
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/create".into(),
                params: serde_json::json!({ "session_id": "s-steer" }),
            })
            .await;
        assert!(body.get("error").is_none(), "create failed: {body}");

        // Steer queues input parts for the session (drained at next turn).
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "session/steer".into(),
                params: serde_json::json!({
                    "session_id": "s-steer",
                    "input": [{ "type": "text", "text": "go faster" }],
                }),
            })
            .await;
        assert!(body.get("error").is_none(), "steer failed: {body}");
        assert_eq!(body["result"]["queued"], true);

        // Unknown sessions report queued=false (no error).
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(3),
                method: "session/steer".into(),
                params: serde_json::json!({
                    "session_id": "nope",
                    "input": [{ "type": "text", "text": "x" }],
                }),
            })
            .await;
        assert!(body.get("error").is_none(), "steer unknown should not error: {body}");
        assert_eq!(body["result"]["queued"], false);
    }

    #[tokio::test]
    async fn fork_copies_persisted_session() {
        // Serialized against other store-sensitive tests (env var + shared
        // file store for the fork's per-call store opens).
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-fork-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        let previous = std::env::var_os("KIMI_AGENT_HOME");
        std::env::set_var("KIMI_AGENT_HOME", &home);

        let result = async {
            let state = crate::state::ServerState::new().expect("state");
            let processor = SessionProcessor::with_state(state);
            let mut server = MessageProcessor::new();
            processor.register(&mut server);
            let body = server
                .handle(JsonRpcRequest {
                    jsonrpc: "2.0".into(),
                    id: serde_json::json!(1),
                    method: "session/create".into(),
                    params: serde_json::json!({ "session_id": "s-fork-src" }),
                })
                .await;
            assert!(body.get("error").is_none(), "create failed: {body}");

            // Fork into a new id.
            let body = server
                .handle(JsonRpcRequest {
                    jsonrpc: "2.0".into(),
                    id: serde_json::json!(2),
                    method: "session/fork".into(),
                    params: serde_json::json!({
                        "session_id": "s-fork-src",
                        "fork_id": "s-fork-dst",
                        "title": "forked",
                    }),
                })
                .await;
            assert!(body.get("error").is_none(), "fork failed: {body}");

            // Both the source and the fork are listed.
            let body = server
                .handle(JsonRpcRequest {
                    jsonrpc: "2.0".into(),
                    id: serde_json::json!(3),
                    method: "session/list".into(),
                    params: serde_json::json!({ "limit": 50 }),
                })
                .await;
            let sessions = body["result"]["sessions"].as_array().expect("sessions");
            assert!(
                sessions.iter().any(|s| s["id"] == "s-fork-src"),
                "source listed: {body}"
            );
            assert!(
                sessions.iter().any(|s| s["id"] == "s-fork-dst"),
                "fork listed: {body}"
            );
        }
        .await;

        match previous {
            Some(v) => std::env::set_var("KIMI_AGENT_HOME", v),
            None => std::env::remove_var("KIMI_AGENT_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
        result;
    }

    #[tokio::test]
    async fn save_load_roundtrip_restores_session() {
        // Serialized against other store-sensitive tests (env var + shared
        // file store so load can re-open the persisted record).
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-saveload-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        let previous = std::env::var_os("KIMI_AGENT_HOME");
        std::env::set_var("KIMI_AGENT_HOME", &home);

        let result = async {
            let state = crate::state::ServerState::new().expect("state");
            let processor = SessionProcessor::with_state(state);
            let mut server = MessageProcessor::new();
            processor.register(&mut server);
            let body = server
                .handle(JsonRpcRequest {
                    jsonrpc: "2.0".into(),
                    id: serde_json::json!(1),
                    method: "session/create".into(),
                    params: serde_json::json!({ "session_id": "s-saveload" }),
                })
                .await;
            assert!(body.get("error").is_none(), "create failed: {body}");

            // Persist, then destroy the runtime agent.
            let body = server
                .handle(JsonRpcRequest {
                    jsonrpc: "2.0".into(),
                    id: serde_json::json!(2),
                    method: "session/save".into(),
                    params: serde_json::json!({ "session_id": "s-saveload" }),
                })
                .await;
            assert!(body.get("error").is_none(), "save failed: {body}");
            let body = server
                .handle(JsonRpcRequest {
                    jsonrpc: "2.0".into(),
                    id: serde_json::json!(3),
                    method: "session/destroy".into(),
                    params: serde_json::json!({ "session_id": "s-saveload" }),
                })
                .await;
            assert_eq!(body["result"]["destroyed"], true);

            // Loading rehydrates the runtime agent from the persisted record.
            let body = server
                .handle(JsonRpcRequest {
                    jsonrpc: "2.0".into(),
                    id: serde_json::json!(4),
                    method: "session/load".into(),
                    params: serde_json::json!({ "session_id": "s-saveload" }),
                })
                .await;
            assert!(body.get("error").is_none(), "load failed: {body}");
            let body = server
                .handle(JsonRpcRequest {
                    jsonrpc: "2.0".into(),
                    id: serde_json::json!(5),
                    method: "session/get_status".into(),
                    params: serde_json::json!({ "session_id": "s-saveload" }),
                })
                .await;
            assert!(body.get("error").is_none(), "status after load: {body}");
        }
        .await;

        match previous {
            Some(v) => std::env::set_var("KIMI_AGENT_HOME", v),
            None => std::env::remove_var("KIMI_AGENT_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
        result;
    }

    #[tokio::test]
    async fn export_roundtrip_yields_zip() {
        // Point the store at a temp dir so session/export (which opens the
        // store per call) sees the session created below. Serialized against
        // other store-sensitive tests via STORE_LOCK; the old value is
        // restored so parallel tests never see the temp store.
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("kimi-export-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).expect("mkdir");
        let previous = std::env::var_os("KIMI_AGENT_HOME");
        std::env::set_var("KIMI_AGENT_HOME", &tmp);

        let result = async {
            let state = crate::state::ServerState::new().expect("state");
            let processor = SessionProcessor::with_state(state);
            let mut server = MessageProcessor::new();
            processor.register(&mut server);
            let body = server
                .handle(JsonRpcRequest {
                    jsonrpc: "2.0".into(),
                    id: serde_json::json!(1),
                    method: "session/create".into(),
                    params: serde_json::json!({ "session_id": "s-test-export" }),
                })
                .await;
            assert!(body.get("error").is_none(), "create failed: {body}");

            let body = server
                .handle(JsonRpcRequest {
                    jsonrpc: "2.0".into(),
                    id: serde_json::json!(2),
                    method: "session/export".into(),
                    params: serde_json::json!({ "session_id": "s-test-export" }),
                })
                .await;
            assert!(body.get("error").is_none(), "export failed: {body}");
            let b64 = body["result"]["zip_base64"].as_str().expect("zip_base64 string");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .expect("valid base64");
            assert_eq!(&bytes[..2], b"PK", "zip magic bytes");
        }
        .await;

        match previous {
            Some(v) => std::env::set_var("KIMI_AGENT_HOME", v),
            None => std::env::remove_var("KIMI_AGENT_HOME"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
        result;
    }


    #[tokio::test]
    async fn run_shell_reaches_bash_runner() {
        let state = crate::state::ServerState::new().expect("state");
        let processor = SessionProcessor::with_state(state.clone());
        let mut server = MessageProcessor::new();
        processor.register(&mut server);

        server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/create".into(),
                params: serde_json::json!({ "session_id": "s-shell" }),
            })
            .await;

        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "session/run_shell".into(),
                params: serde_json::json!({
                    "session_id": "s-shell",
                    "command": "echo hi",
                    "command_id": "c1",
                }),
            })
            .await;
        // Either ran natively (output present) or reported unavailable (no
        // bash detected) — both are valid; the pipeline must not RPC-error.
        assert!(body.get("error").is_none(), "run_shell failed: {body}");
    }
}
