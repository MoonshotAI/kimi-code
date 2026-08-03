//! Session method family — the engine's session surface, ported from
//! `packages/kimi-agent/src/main.rs`. The processor owns a
//! `SessionManager` (engine state) exactly as the stdio server does;
//! handlers are the same logic, organized by method family.

use std::sync::Arc;

use kimi_protocol::rpc::JsonRpcError;
use kimi_protocol::wire_types::SessionGoalParams;

use crate::processor::{MessageProcessor, Processor};

/// Session methods, backed by the shared engine state.
pub struct SessionProcessor {
    state: crate::state::ServerState,
    /// Per-session cancellation flags (create stores; prompt reads).
    cancel: Arc<std::sync::Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    /// Per-session steer queues.
    steer: Arc<std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<Vec<kimi_agent::context::types::ContentPart>>>>>>,
    /// Per-session busy flags (prompt marks; fork/compact check).
    busy: Arc<std::sync::Mutex<std::collections::HashMap<String, bool>>>,
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
}
