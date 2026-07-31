/// kimi-agent — Rust agent engine with stdio JSON-RPC bridge.
///
/// Usage:
///   kimi-agent [--health] [--test]
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use clap::Parser;

use kimi_agent::{
    background::{
        manager::BackgroundManager,
        persist::BackgroundTaskPersistence,
        types::{
            BackgroundTaskKind, BackgroundTaskSettlement, BackgroundTaskSettlementStatus,
            RegisterOptions,
        },
    },
    callbacks::{HostCallbacks, NativeToolCallbacks, RpcHostCallbacks},
    cron::{manager::CronManager, types::CronTaskInit},
    llm::{
        http::NativeHttpLlm,
        multi::{LlmProvider, MultiLLM},
        proxy::HostLlmProxy,
    },
    rpc::{
        server::RpcServer,
        types::{self, CancelTurnParams, HealthStatus, RunTurnResult, TokenUsage},
    },
    turn_loop::{run_turn::run_turn, types::*},
};

#[derive(Parser)]
#[command(
    name = "kimi-agent",
    version = "0.1.0",
    about = "Kimi Agent engine (Rust)"
)]
struct Cli {
    /// Run a health check and exit
    #[arg(long)]
    health: bool,

    /// Run a self-test and exit
    #[arg(long)]
    test: bool,

    #[command(subcommand)]
    command: Option<CliCommand>,
}

#[derive(clap::Subcommand)]
enum CliCommand {
    /// Manage persisted sessions (`$KIMI_AGENT_HOME/sessions.db`).
    #[command(subcommand)]
    Session(kimi_agent::session::commands::SessionCommand),
}

/// Open the session store: `$KIMI_AGENT_HOME/sessions.db` when set, else an
/// in-memory store. Shared by the RPC server and the `session` subcommands
/// so both faces see the same records.
fn open_session_store() -> anyhow::Result<kimi_agent::persistence::SqliteStore> {
    match std::env::var("KIMI_AGENT_HOME") {
        Ok(dir) if !dir.trim().is_empty() => {
            let path = std::path::Path::new(dir.trim()).join("sessions.db");
            kimi_agent::persistence::SqliteStore::open(&path)
        }
        _ => kimi_agent::persistence::SqliteStore::in_memory(),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    if cli.health {
        let status = HealthStatus {
            status: "ok".into(),
            version: "0.1.0".into(),
        };
        println!("{}", serde_json::to_string(&status)?);
        return Ok(());
    }

    if cli.test {
        return run_self_test().await;
    }

    // `session` subcommands run against the shared store and exit — no RPC
    // server is started for offline session management.
    if let Some(CliCommand::Session(command)) = cli.command {
        let mut manager = kimi_agent::session::manager::SessionManager::new(
            kimi_agent::persistence::SessionStore::new(open_session_store()?),
        );
        println!("{}", command.execute(&mut manager)?);
        return Ok(());
    }

    // Build the RPC server and register handlers
    let server = Arc::new(RpcServer::new());

    // Shared map of turn_id → cancellation flag, so CANCEL_TURN can
    // signal a running turn to abort before its next step.
    let cancel_map: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Shared background-task manager: created before the RUN_TURN handler so
    // native `run_in_background` Bash and the bg/* RPC surface share state.
    let bg_manager = Arc::new(Mutex::new(BackgroundManager::new(None)));

    // Native permission gate (mode from KIMI_PERMISSION_MODE). Lets the engine
    // approve/deny gated tool calls locally; interactive Ask defers to host.
    let permission_gate = kimi_agent::permission::gate::PermissionGate::from_env();

    // Register run_turn handler
    let s = server.clone();
    let cm = cancel_map.clone();
    let run_turn_bg = bg_manager.clone();
    let run_turn_perm = permission_gate.clone();
    RpcServer::register_arc(&s.clone(), types::methods::RUN_TURN, move |params| {
        let server = s.clone();
        let cancel_map = cm.clone();
        let bg_manager = run_turn_bg.clone();
        let permission_gate = run_turn_perm.clone();
        Box::pin(async move {
            let input: types::RunTurnParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;

            let turn_id = input.turn_id.clone();
            let max_steps = input.max_steps.unwrap_or(10);

            // Create and register a cancellation flag for this turn.
            let cancel_flag = Arc::new(AtomicBool::new(false));
            {
                let mut map = cancel_map.lock().unwrap_or_else(|e| e.into_inner());
                map.insert(turn_id.clone(), cancel_flag.clone());
            }

            // Build the HostCallbacks from the RPC server, optionally
            // wrapped so read-only tools execute natively inside the
            // workspace sandbox.
            let base_callbacks: Arc<dyn HostCallbacks> = Arc::new(RpcHostCallbacks {
                server: server.clone(),
            });
            let callbacks: Arc<dyn HostCallbacks> =
                match (input.native_tools, input.workspace_root.as_deref()) {
                    (true, Some(root)) => match kimi_agent::tools::NativeToolset::new(root) {
                        Some(toolset) => Arc::new(NativeToolCallbacks {
                            inner: base_callbacks.clone(),
                            toolset: Arc::new(toolset),
                            background: Some(bg_manager.clone()),
                            permission: Some(permission_gate.clone()),
                            hooks: None,
                        }),
                        None => base_callbacks.clone(),
                    },
                    _ => base_callbacks.clone(),
                };

            // Build the LLM — native HTTP, MultiLLM, or host proxy.
            let llm: Box<dyn LLM> = if let Some(cfg) = input.native_llm.clone() {
                let sink_callbacks = callbacks.clone();
                Box::new(
                    NativeHttpLlm::new(cfg, input.system_prompt.clone())
                        .with_sink(Arc::new(move |event| sink_callbacks.emit_event(event))),
                )
            } else if input.providers.is_empty() {
                // 1a: when the host did not supply a native_llm config, self-read
                // the config file + `KIMI_MODEL_*` env and derive a native HTTP
                // LLM so the standalone binary needs no host for the LLM. Fall
                // back to the host proxy when nothing qualifies.
                match kimi_agent::config::native_llm::load_native_llm_from_config() {
                    Some(cfg) => {
                        let sink_callbacks = callbacks.clone();
                        Box::new(
                            NativeHttpLlm::new(cfg, input.system_prompt.clone())
                                .with_sink(Arc::new(move |event| {
                                    sink_callbacks.emit_event(event)
                                })),
                        )
                    }
                    None => Box::new(
                        HostLlmProxy::new(
                            input.system_prompt.clone(),
                            input.model_name.clone(),
                        )
                        .with_callbacks(callbacks.clone()),
                    ),
                }
            } else {
                let providers: Vec<LlmProvider> = input
                    .providers
                    .iter()
                    .map(|p| LlmProvider {
                        name: p.name.clone(),
                        system_prompt: p.system_prompt.clone(),
                        model: p.model.clone(),
                        callbacks: callbacks.clone(),
                    })
                    .collect();
                let multi = MultiLLM::new(providers);
                Box::new(multi)
            };

            let messages: Vec<LLMMessage> = input
                .messages
                .into_iter()
                .map(|m| LLMMessage {
                    role: m.role,
                    content: m.content,
                    blocks: m.blocks,
                    tool_calls: m
                        .tool_calls
                        .into_iter()
                        .map(|tc| ToolCall {
                            id: tc.id,
                            name: tc.name,
                            arguments: tc.arguments,
                        })
                        .collect(),
                    tool_call_id: m.tool_call_id,
                })
                .collect();

            let tool_defs: Vec<ToolInfo> = input
                .tools
                .into_iter()
                .map(|t| ToolInfo {
                    name: t.name,
                    description: t.description,
                    input_schema: t.input_schema,
                })
                .collect();

            let tools: Vec<&dyn ExecutableTool> = vec![];

            let run_input = RunTurnInput {
                turn_id: turn_id.clone(),
                llm: &*llm,
                messages,
                tools: &tools,
                tool_defs,
                hooks: None,
                max_steps,
                goal: input.goal,
                cancellation: Some(cancel_flag.clone()),
 steer_queue: None,
            };

            let result = run_turn(run_input, &callbacks).await;

            // Clean up the cancellation flag.
            {
                let mut map = cancel_map.lock().unwrap_or_else(|e| e.into_inner());
                map.remove(&turn_id);
            }

            match result {
                Ok(res) => {
                    let output = RunTurnResult {
                        stop_reason: format!("{:?}", res.stop_reason),
                        steps: res.steps,
                        usage: res.usage,
                    };
                    serde_json::to_value(&output).map_err(|e| {
                        types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
                    })
                }
                Err(e) => {
                    let output = RunTurnResult {
                        stop_reason: format!("Error: {e}"),
                        steps: 0,
                        usage: TokenUsage::default(),
                    };
                    serde_json::to_value(&output).map_err(|_| {
                        types::JsonRpcError::internal_error(format!("Turn failed: {e}"))
                    })
                }
            }
        })
    });

    // Register cancel_turn handler
    let cm = cancel_map.clone();
    RpcServer::register_arc(&server, types::methods::CANCEL_TURN, move |params| {
        let cancel_map = cm.clone();
        Box::pin(async move {
            let input: CancelTurnParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;

            let cancelled = {
                let map = cancel_map.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(flag) = map.get(&input.turn_id) {
                    flag.store(true, Ordering::Relaxed);
                    true
                } else {
                    false
                }
            };

            let result = serde_json::json!({ "cancelled": cancelled });
            Ok(result)
        })
    });

    // ── Session-owned agent surface (phase D: the thin-client protocol) ──
    // The engine owns sessions, agents, goal driving, and persistence; the
    // host only renders and answers `host/*` callbacks. Storage goes to
    // `$KIMI_AGENT_HOME/sessions.db` when set, else stays in memory.
    let session_store = open_session_store()?;
    let session_manager = Arc::new(tokio::sync::Mutex::new(
        kimi_agent::session::manager::SessionManager::new(
            kimi_agent::persistence::SessionStore::new(session_store),
        ),
    ));
    // Per-session cancellation flags, reachable while `session/prompt` holds
    // the manager lock — a cancel must never need that lock.
    let session_cancel: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    // Shared steer queues per session, so `session/steer` can push while a
    // prompt is running (which holds the manager lock). Mirrors `session_cancel`.
    #[allow(clippy::type_complexity)]
    let session_steer: Arc<
        Mutex<HashMap<String, Arc<std::sync::Mutex<Vec<kimi_agent::context::types::ContentPart>>>>>,
    > = Arc::new(Mutex::new(HashMap::new()));
    // Per-`commandId` cancel flags for streaming `!` shell commands, reachable
    // without the manager lock so `session/cancel_shell_command` can kill a
    // command while `session/run_shell` streams outside the lock.
    let shell_cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let mgr = session_manager.clone();
    let srv = server.clone();
    let sc = session_cancel.clone();
    let ss = session_steer.clone();
    let create_perm = permission_gate.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_CREATE, move |params| {
        let mgr = mgr.clone();
        let srv = srv.clone();
        let sc = sc.clone();
        let ss = ss.clone();
        let create_perm = create_perm.clone();
        Box::pin(async move {
            let input: types::SessionCreateParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut input = input;
            let id = input.session_id.unwrap_or_else(|| {
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
                    provider: input.provider.unwrap_or_default(),
                    model: input.model.clone().unwrap_or_default(),
                    max_tokens: None,
                },
            );
            // Record the workspace so `session/list` can filter by directory.
            manager.set_work_dir(&id, input.homedir.as_deref().unwrap_or(""));
            let callbacks: Arc<dyn HostCallbacks> =
                Arc::new(RpcHostCallbacks { server: srv.clone() });
            let mcp_servers = std::mem::take(&mut input.mcp_servers);
            let skills = std::mem::take(&mut input.skills);
            let external_hooks = std::mem::take(&mut input.hooks);
            let (mcp_runtime, cancellation, steer_queue) = {
                let agent = manager
                    .create_agent(
                        &id,
                        callbacks,
                        kimi_agent::agent::types::AgentOptions {
                            session_id: Some(id.clone()),
                            homedir: input.homedir.clone(),
                            config: Some(kimi_agent::agent::types::AgentConfig {
                                cwd: input.homedir.unwrap_or_default(),
                                model_alias: input.model,
                                system_prompt: input.system_prompt.unwrap_or_default(),
                                has_provider: true,
                                has_model: true,
                            }),
                            goal_enabled: input.goal_enabled.unwrap_or(true),
                            native_llm: input.native_llm,
                            host_tools: input
                                .tools
                                .into_iter()
                                .map(|t| kimi_agent::turn_loop::types::ToolInfo {
                                    name: t.name,
                                    description: t.description,
                                    input_schema: t.input_schema,
                                })
                                .collect(),
                            // Share the process-wide gate so `permission/*` RPC
                            // governs every session agent, not a per-agent copy.
                            permission: Some(create_perm.clone()),
                            // Host-resolved external lifecycle hooks — the
                            // engine executes them natively on this session.
                            external_hooks,
                            ..Default::default()
                        },
                    )
                    .map_err(|e| types::JsonRpcError::internal_error(e.to_string()))?;
                // Populate the session's skill registry (sync — no await while
                // borrowing the agent) so the native `Skill` tool can activate.
                for skill in skills {
                    agent.skill_manager.registry.register(skill.into_metadata());
                }
                (agent.mcp.clone(), agent.cancellation.clone(), agent.steer_queue.clone())
            };
            // Release the manager lock before the (async, possibly slow) MCP
            // connects so other RPCs are not blocked on server startup.
            drop(manager);

            // Register host-resolved MCP servers into this session's runtime.
            // `register` connects the transport, whose stdio channel holds a
            // `!Send` receiver across its internal awaits — so the registration
            // future is not `Send` and cannot be awaited directly in this
            // (Send-bound) RPC handler. Drive it on a blocking thread via
            // `Handle::block_on` (no Send bound on the future); the outer
            // handler only awaits the Send `JoinHandle`. Failures surface as
            // `failed` entries; the turn still runs.
            if !mcp_servers.is_empty() {
                let mcp_started = std::time::Instant::now();
                let rt_handle = mcp_runtime.clone();
                let handle = tokio::runtime::Handle::current();
                let _ = tokio::task::spawn_blocking(move || {
                    handle.block_on(async move {
                        let mut runtime = rt_handle.lock().await;
                        for server in mcp_servers {
                            let (name, spec, source) = server.into_registration();
                            let _ = runtime.register(&name, spec, source).await;
                        }
                    });
                })
                .await;
                // Record the connect duration back onto the agent so
                // `session/get_mcp_startup_metrics` can report it.
                let elapsed_ms = mcp_started.elapsed().as_millis() as u64;
                if let Some(agent) = mgr.lock().await.get_agent(&id) {
                    agent.mcp_startup_ms = elapsed_ms;
                }
            }
            sc.lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id.clone(), cancellation);
            ss.lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id.clone(), steer_queue);
            // SessionStart hooks: fire-and-forget after the session is fully
            // wired (agent + MCP + skills + hooks).
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

    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_PROMPT, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionPromptParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let parts: Vec<kimi_agent::context::types::ContentPart> =
                serde_json::from_value(input.input).map_err(|e| {
                    types::JsonRpcError::internal_error(format!("Invalid input parts: {e}"))
                })?;
            let mut manager = mgr.lock().await;
            // Side-question routing: an `agent_id` of the form `btw-<sid>`
            // drives the session's side agent instead of the main agent.
            let agent = match input.agent_id.as_deref() {
                Some(id) if id.starts_with("btw-") => {
                    manager.get_btw_agent(&input.session_id).ok_or_else(|| {
                        types::JsonRpcError::internal_error(format!(
                            "no side agent for session: {}",
                            input.session_id
                        ))
                    })?
                }
                _ => manager.get_agent(&input.session_id).ok_or_else(|| {
                    types::JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?,
            };
            // Goal-aware driving: `run_prompt` runs continuation turns while
            // a goal stays active, exactly like the in-process driver.
            let result = agent.run_prompt(parts).await.map_err(|e| {
                types::JsonRpcError::internal_error(format!("run_prompt failed: {e}"))
            })?;
            Ok(serde_json::json!({
                "stop_reason": format!("{:?}", result.stop_reason),
                "steps": result.steps,
                "usage": result.usage,
            }))
        })
    });

    // Spawn a side-question subagent (SDK `Session.startBtw` parity): the
    // child inherits the main transport config, carries a projection of the
    // context plus the side-channel reminder, and runs with no tools. The
    // returned id is passed back as `agent_id` on `session/prompt` calls.
    let mgr = session_manager.clone();
    let srv = server.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_START_BTW, move |params| {
        let mgr = mgr.clone();
        let srv = srv.clone();
        Box::pin(async move {
            let input: types::SessionIdParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let callbacks: Arc<dyn HostCallbacks> =
                Arc::new(RpcHostCallbacks { server: srv });
            let btw_id = manager
                .start_btw(&input.session_id, callbacks)
                .map_err(|e| types::JsonRpcError::internal_error(e))?;
            Ok(serde_json::json!({ "btw_id": btw_id }))
        })
    });

    // Destroy the active side-question subagent.
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_END_BTW, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionIdParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let ended = manager.end_btw(&input.session_id);
            Ok(serde_json::json!({ "ended": ended }))
        })
    });

    let sc = session_cancel.clone();
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_CANCEL, move |params| {
        let sc = sc.clone();
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionIdParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let cancelled = {
                let map = sc.lock().unwrap_or_else(|e| e.into_inner());
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
                let mgr = mgr.clone();
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

    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_SET_MODEL, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionSetModelParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            agent.set_model(input.model);
            Ok(serde_json::json!({ "ok": true }))
        })
    });

    // ── Goal lifecycle RPCs (session/goal_*) ──
    // Deterministic user/host control surface over the session agent's
    // GoalMode; terminal statuses stay model-owned (UpdateGoal tool).
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_GOAL_CREATE, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionGoalCreateParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
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
                .map_err(types::JsonRpcError::internal_error)?;
            serde_json::to_value(&snapshot)
                .map_err(|e| types::JsonRpcError::internal_error(e.to_string()))
        })
    });

    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_GOAL_GET, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionGoalParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            serde_json::to_value(agent.goal_get())
                .map_err(|e| types::JsonRpcError::internal_error(e.to_string()))
        })
    });

    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_GOAL_PAUSE, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionGoalReasonParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            let snapshot = agent
                .goal_pause(input.reason)
                .map_err(types::JsonRpcError::internal_error)?;
            serde_json::to_value(&snapshot)
                .map_err(|e| types::JsonRpcError::internal_error(e.to_string()))
        })
    });

    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_GOAL_RESUME, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionGoalReasonParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            let snapshot = agent
                .goal_resume(input.reason)
                .map_err(types::JsonRpcError::internal_error)?;
            serde_json::to_value(&snapshot)
                .map_err(|e| types::JsonRpcError::internal_error(e.to_string()))
        })
    });

    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_GOAL_CANCEL, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionGoalParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            let snapshot = agent
                .goal_cancel()
                .map_err(types::JsonRpcError::internal_error)?;
            serde_json::to_value(&snapshot)
                .map_err(|e| types::JsonRpcError::internal_error(e.to_string()))
        })
    });

    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_SET_SWARM_MODE, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionSetSwarmModeParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let trigger = match input.trigger.as_deref() {
                None | Some("manual") => kimi_agent::swarm::SwarmModeTrigger::Manual,
                Some("task") => kimi_agent::swarm::SwarmModeTrigger::Task,
                Some("tool") => kimi_agent::swarm::SwarmModeTrigger::Tool,
                Some(other) => {
                    return Err(types::JsonRpcError::internal_error(format!(
                        "invalid swarm trigger: {other}"
                    )));
                }
            };
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            let active = agent.set_swarm_mode(input.enabled, trigger);
            Ok(serde_json::json!({ "active": active }))
        })
    });

    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_SET_PLAN_MODE, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionSetPlanModeParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            let plan_mode = agent
                .set_plan_mode(input.enabled)
                .map_err(types::JsonRpcError::internal_error)?;
            Ok(serde_json::json!({ "plan_mode": plan_mode }))
        })
    });

    // Live status snapshot (SDK `getStatus` parity; reuses SessionGoalParams
    // as a plain `{ session_id }` shape).
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_GET_STATUS, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionGoalParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            Ok(agent.session_status())
        })
    });

    // Per-server MCP views (SDK `listMcpServers` parity).
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_LIST_MCP_SERVERS, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionGoalParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mcp = {
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    types::JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                agent.mcp.clone()
            };
            // Lock the runtime outside the manager lock so a slow MCP call
            // in a running turn cannot deadlock against this listing.
            let servers: Vec<serde_json::Value> = mcp
                .lock()
                .await
                .list()
                .into_iter()
                .map(|entry| {
                    serde_json::json!({
                        "name": entry.name,
                        "transport": entry.transport.as_str(),
                        "status": entry.status.as_str(),
                        "tool_count": entry.tool_count,
                        "error": entry.error,
                    })
                })
                .collect();
            Ok(serde_json::json!({ "servers": servers }))
        })
    });

    // Registered skills (SDK `listSkills` parity). Sorted by name for stable
    // output, mirroring the MCP listing convention.
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_LIST_SKILLS, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionGoalParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            let mut skills = agent.skill_manager.registry.list_skills();
            skills.sort_by(|a, b| a.name.cmp(&b.name));
            let skills: Vec<serde_json::Value> = skills
                .into_iter()
                .map(|s| {
                    serde_json::json!({
                        "name": s.name,
                        "description": s.description,
                        "skill_type": s.skill_type,
                        "source": s.source,
                        "path": s.path,
                        "dir": s.dir,
                    })
                })
                .collect();
            Ok(serde_json::json!({ "skills": skills }))
        })
    });

    // Session warnings (SDK `getSessionWarnings` parity). The engine has no
    // AGENTS.md-size check yet; the real signal it owns is MCP connection
    // health, so a failed / needs-auth server surfaces as a warning.
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_GET_WARNINGS, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionGoalParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mcp = {
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    types::JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                agent.mcp.clone()
            };
            // Same lock-after-release order as list_mcp_servers.
            use kimi_agent::mcp::connection_manager::McpServerStatus;
            let warnings: Vec<serde_json::Value> = mcp
                .lock()
                .await
                .list()
                .into_iter()
                .filter(|e| matches!(e.status, McpServerStatus::Failed | McpServerStatus::NeedsAuth))
                .map(|e| {
                    let (code, detail) = match e.status {
                        McpServerStatus::NeedsAuth => (
                            "mcp-server-needs-auth",
                            e.error.clone().unwrap_or_else(|| "authentication required".to_string()),
                        ),
                        _ => (
                            "mcp-server-failed",
                            e.error.clone().unwrap_or_else(|| "connection failed".to_string()),
                        ),
                    };
                    serde_json::json!({
                        "code": code,
                        "message": format!("MCP server \"{}\": {}", e.name, detail),
                        "severity": "warning",
                    })
                })
                .collect();
            Ok(serde_json::json!({ "warnings": warnings }))
        })
    });

    // Cumulative usage snapshot (SDK `getUsage` parity). Empty object when no
    // usage has accrued yet (mirrors UsageRecorder::status() → None).
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_GET_USAGE, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionGoalParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            serde_json::to_value(agent.usage.data())
                .map_err(|e| types::JsonRpcError::internal_error(e.to_string()))
        })
    });

    // Manual context compaction (SDK `compact` parity). Requires a native-LLM
    // summarizer; a missing provider surfaces as a JSON-RPC error.
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_COMPACT, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionCompactParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            agent
                .compact(input.instruction)
                .await
                .map_err(types::JsonRpcError::internal_error)
        })
    });

    // Full context snapshot (SDK `getContext` parity): raw history + measured
    // token count. Wire is serde snake_case; the TS client maps to the SDK's
    // camelCase `AgentContextData`.
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_GET_CONTEXT, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionGoalParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            serde_json::to_value(agent.context.data())
                .map_err(|e| types::JsonRpcError::internal_error(format!("serialize context: {e}")))
        })
    });

    // Clear the session's model context (SDK `clearContext` parity).
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_CLEAR_CONTEXT, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionGoalParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            let cleared = agent.context.clear().is_some();
            Ok(serde_json::json!({ "cleared": cleared }))
        })
    });

    // Append imported transcript text to the context (SDK `importContext`).
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_IMPORT_CONTEXT, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionImportContextParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            agent
                .context
                .import_context(&input.content, &input.source)
                .map_err(types::JsonRpcError::internal_error)?;
            Ok(serde_json::json!({ "imported": true }))
        })
    });

    // Undo the last N user turns (SDK `undoHistory` parity). All-or-nothing:
    // when the requested count is not fully available (or would cross a
    // compaction boundary), the engine reports the shortfall as an error and
    // leaves the history untouched, matching the SDK's throwing contract.
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_UNDO_HISTORY, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionUndoHistoryParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            if let Some(reason) = agent.context.undo_unavailable_message(input.count) {
                return Err(types::JsonRpcError::internal_error(reason));
            }
            let cut = agent.context.undo(input.count);
            Ok(serde_json::json!({ "undone_turns": cut.removed_count, "cut_index": cut.cut_index }))
        })
    });

    // Active plan snapshot (SDK `getPlan` parity): id/content/path or null. The
    // plan file content is read live from disk each call.
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_GET_PLAN, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionGoalParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            let plan = agent.get_plan().map_err(types::JsonRpcError::internal_error)?;
            match plan {
                Some(p) => serde_json::to_value(p).map_err(|e| {
                    types::JsonRpcError::internal_error(format!("serialize plan: {e}"))
                }),
                None => Ok(serde_json::Value::Null),
            }
        })
    });

    // Clear the active plan's file content (SDK `clearPlan` parity).
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_CLEAR_PLAN, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionGoalParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            agent.clear_plan().map_err(types::JsonRpcError::internal_error)?;
            Ok(serde_json::json!({ "cleared": true }))
        })
    });

    // Activate a skill (SDK `activateSkill` parity): render the skill prompt +
    // run a turn. Holds the manager lock across the turn like session/prompt.
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_ACTIVATE_SKILL, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionActivateSkillParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            let result = agent
                .activate_skill(input.name, input.args)
                .await
                .map_err(|e| types::JsonRpcError::internal_error(format!("activate_skill failed: {e}")))?;
            Ok(serde_json::json!({
                "stop_reason": format!("{:?}", result.stop_reason),
                "steps": result.steps,
                "usage": result.usage,
            }))
        })
    });

    // MCP startup timing (SDK `getMcpStartupMetrics` parity): the connect
    // duration recorded at session/create.
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_GET_MCP_STARTUP_METRICS, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionGoalParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            Ok(serde_json::json!({ "duration_ms": agent.mcp_startup_ms }))
        })
    });

    // Generate AGENTS.md (SDK `Session.init` parity): spawn an init subagent
    // with native Read/Write tools to explore the project and write the file,
    // then inject the completion reminder into the parent context.
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_INIT, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionInitParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            agent
                .init_agents_md()
                .await
                .map_err(|e| types::JsonRpcError::internal_error(format!("init failed: {e}")))?;
            Ok(serde_json::json!({ "ok": true }))
        })
    });

    // Reconnect a single MCP server (SDK `reconnectMcpServer` parity). Clones
    // the runtime handle inside the manager lock, then reconnects outside it so
    // a slow reconnect cannot deadlock against a running turn (same order as
    // list_mcp_servers / get_warnings).
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_RECONNECT_MCP_SERVER, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionReconnectMcpParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mcp = {
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    types::JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                agent.mcp.clone()
            };
            // `reconnect` connects the transport, whose stdio channel holds a
            // `!Send` receiver across awaits — drive it on a blocking thread via
            // `Handle::block_on` and only await the Send `JoinHandle` here (same
            // technique as the session/create registration).
            let name = input.name.clone();
            let handle = tokio::runtime::Handle::current();
            let entry = tokio::task::spawn_blocking(move || {
                handle.block_on(async move { mcp.lock().await.reconnect(&name).await })
            })
            .await
            .map_err(|e| types::JsonRpcError::internal_error(format!("reconnect join: {e}")))?
            .map_err(types::JsonRpcError::internal_error)?;
            Ok(serde_json::json!({
                "name": entry.name,
                "transport": entry.transport.as_str(),
                "status": entry.status.as_str(),
                "tool_count": entry.tool_count,
                "error": entry.error,
            }))
        })
    });

    let ss = session_steer.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_STEER, move |params| {
        let ss = ss.clone();
        Box::pin(async move {
            let input: types::SessionSteerParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let parts: Vec<kimi_agent::context::types::ContentPart> =
                serde_json::from_value(input.input).map_err(|e| {
                    types::JsonRpcError::internal_error(format!("Invalid input parts: {e}"))
                })?;
            // Push onto the session's shared steer queue without the manager
            // lock, so a steer can land while a prompt is running; the queue is
            // drained at the start of the next turn (incl. goal continuation).
            let queued = {
                let map = ss.lock().unwrap_or_else(|e| e.into_inner());
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

    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_SET_THINKING, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionSetThinkingParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            agent.set_thinking(input.effort);
            Ok(serde_json::json!({ "ok": true }))
        })
    });

    let mgr = session_manager.clone();
    let shc = shell_cancels.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_RUN_SHELL, move |params| {
        let mgr = mgr.clone();
        let shc = shc.clone();
        Box::pin(async move {
            let input: types::SessionRunShellParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            // Capture what the streaming run needs, then release the manager lock
            // so a slow command does not block other RPCs (notably the cancel).
            let (callbacks, cwd) = {
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    types::JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                (agent.callbacks.clone(), agent.config.cwd.clone())
            };
            let runner = match kimi_agent::tools::bash::BashRunner::detect() {
                Some(r) => r,
                // No native shell → tell the host to run it (mirrors tool fallback).
                None => {
                    return Ok(serde_json::json!({ "output": null, "is_error": false, "unavailable": true }));
                }
            };
            match input.command_id {
                Some(command_id) => {
                    // Streaming path: register a cancel flag, emit `shell.output`
                    // chunks as they arrive, and unregister on completion.
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
                // No commandId → non-streaming whole-output run.
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
                    Ok(serde_json::json!({ "output": outcome.output, "is_error": outcome.is_error }))
                }
            }
        })
    });

    // Cancel a streaming `!` shell command by its commandId (SDK
    // `cancelShellCommand` parity). Sets the shared flag the run loop polls; a
    // no-op for an unknown / already-finished command.
    let shc = shell_cancels.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_CANCEL_SHELL_COMMAND, move |params| {
        let shc = shc.clone();
        Box::pin(async move {
            let input: types::SessionCancelShellParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let flag = shc
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&input.command_id)
                .cloned();
            let found = flag.is_some();
            if let Some(flag) = flag {
                flag.store(true, Ordering::Relaxed);
            }
            Ok(serde_json::json!({ "cancelled": found }))
        })
    });

    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_ADD_DIR, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionAddDirParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            let success = agent.add_additional_dir(input.path);
            let result = types::SessionAddDirResult {
                success,
                additional_dirs: agent.additional_dirs().to_vec(),
            };
            Ok(serde_json::to_value(result).unwrap())
        })
    });

    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_REMOVE_DIR, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionRemoveDirParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            let success = agent.remove_additional_dir(&input.path);
            let result = types::SessionRemoveDirResult {
                success,
                additional_dirs: agent.additional_dirs().to_vec(),
            };
            Ok(serde_json::to_value(result).unwrap())
        })
    });

    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_UPDATE_METADATA, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionUpdateMetadataParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            if !input.metadata.is_object() {
                return Err(types::JsonRpcError::internal_error(
                    "metadata must be a JSON object".to_string(),
                ));
            }
            let mut manager = mgr.lock().await;
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
            agent.update_metadata(input.metadata);
            Ok(serde_json::json!({ "ok": true, "metadata": agent.metadata }))
        })
    });

    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_SAVE, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionIdParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            manager
                .save_agent_session(&input.session_id)
                .map_err(|e| types::JsonRpcError::internal_error(e.to_string()))?;
            Ok(serde_json::json!({ "ok": true }))
        })
    });

    // Destroy a session's agent (SDK close parity): SessionEnd hooks fire
    // first (fire-and-forget), then the in-memory agent + side agent are
    // dropped. The persisted record is intentionally left for later
    // `session/load` — destroy is a runtime teardown, not a delete.
    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_DESTROY, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionIdParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
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
                .map_err(|e| types::JsonRpcError::internal_error(e.to_string()))?;
            Ok(serde_json::json!({ "destroyed": existed }))
        })
    });

    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_LOAD, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionIdParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = mgr.lock().await;
            let found = manager
                .load_agent_session(&input.session_id)
                .map_err(|e| types::JsonRpcError::internal_error(e.to_string()))?;
            Ok(serde_json::json!({ "found": found }))
        })
    });

    let mgr = session_manager.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_LIST, move |params| {
        let mgr = mgr.clone();
        Box::pin(async move {
            let input: types::SessionListParams =
                serde_json::from_value(params).unwrap_or_default();
            let manager = mgr.lock().await;
            let sessions = manager
                .list_persisted(input.limit.unwrap_or(50), input.offset.unwrap_or(0))
                .map_err(|e| types::JsonRpcError::internal_error(e.to_string()))?
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
                    serde_json::json!({
                        "id": record.id,
                        "created_at": record.created_at,
                        "updated_at": record.updated_at,
                        "title": rich.title,
                        "work_dir": rich.work_dir,
                    })
                })
                .collect::<Vec<_>>();
            Ok(serde_json::json!({ "sessions": sessions }))
        })
    });

    // ── Permission configuration handlers ──────────────────────────────────
    // Configure the process-wide native gate at runtime (RUN_TURN + all
    // session agents share it). Lets the TUI/host set the mode or record a
    // session approval instead of only seeding from KIMI_PERMISSION_MODE.
    let perm = permission_gate.clone();
    RpcServer::register_arc(&server, types::methods::PERMISSION_GET, move |_| {
        let perm = perm.clone();
        Box::pin(async move {
            serde_json::to_value(perm.manager().data()).map_err(|e| {
                types::JsonRpcError::internal_error(format!("Serialize error: {e}"))
            })
        })
    });

    let perm = permission_gate.clone();
    RpcServer::register_arc(&server, types::methods::PERMISSION_SET_MODE, move |params| {
        let perm = perm.clone();
        Box::pin(async move {
            let mode: kimi_agent::permission::types::PermissionMode =
                serde_json::from_value(params.get("mode").cloned().unwrap_or(params))
                    .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid mode: {e}")))?;
            perm.set_mode(mode);
            Ok(serde_json::json!({ "ok": true, "mode": mode }))
        })
    });

    let perm = permission_gate.clone();
    RpcServer::register_arc(&server, types::methods::PERMISSION_ADD_RULE, move |params| {
        let perm = perm.clone();
        Box::pin(async move {
            let rule: kimi_agent::permission::types::PermissionRule =
                serde_json::from_value(params)
                    .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid rule: {e}")))?;
            perm.add_rule(rule);
            Ok(serde_json::json!({ "ok": true }))
        })
    });

    // Register git/status — working-tree status (v2 `IGitService.status`
    // parity). Requires `cwd`; a non-repo cwd surfaces `{unavailable}` rather
    // than failing the whole RPC.
    RpcServer::register_arc(&server, types::methods::GIT_STATUS, |params| {
        Box::pin(async move {
            let input: types::GitStatusParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let service = kimi_agent::git::GitService::new();
            let cwd = kimi_agent::git::absolutize(&input.cwd);
            match service.status(&cwd, None).await {
                Ok(status) => serde_json::to_value(status)
                    .map_err(|e| types::JsonRpcError::internal_error(e.to_string())),
                Err(e) => Ok(serde_json::json!({ "unavailable": e.to_string() })),
            }
        })
    });

    // Register git/diff — diff of one repo-relative path (v2
    // `IGitService.diff` parity).
    RpcServer::register_arc(&server, types::methods::GIT_DIFF, |params| {
        Box::pin(async move {
            let input: types::GitDiffParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let service = kimi_agent::git::GitService::new();
            let cwd = kimi_agent::git::absolutize(&input.cwd);
            match service.diff(&cwd, &input.path).await {
                Ok((diff, truncated)) => {
                    serde_json::to_value(serde_json::json!({
                        "path": input.path,
                        "diff": diff,
                        "truncated": truncated,
                    }))
                    .map_err(|e| types::JsonRpcError::internal_error(e.to_string()))
                }
                Err(e) => Ok(serde_json::json!({ "unavailable": e.to_string() })),
            }
        })
    });

    // Register health handler
    RpcServer::register_arc(&server, types::methods::HEALTH, |_| {
        Box::pin(async move {
            let status = HealthStatus {
                status: "ok".into(),
                version: "0.1.0".into(),
            };
            serde_json::to_value(&status).map_err(|e| {
                types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
            })
        })
    });

    // Register shutdown handler
    RpcServer::register_arc(&server, types::methods::SHUTDOWN, |_| {
        Box::pin(async move {
            std::process::exit(0);
        })
    });

    // ── Task domain handlers ────────────────────────────────────────────────

    // ── Cron handlers ──────────────────────────────────────────────────────────

    // Open a shared task database for cron / background / task persistence:
    // `$KIMI_AGENT_HOME/agent_tasks.db` when set, else in-memory.
    let tasks_store: Arc<kimi_agent::persistence::SqliteStore> = Arc::new(
        match std::env::var("KIMI_AGENT_HOME") {
            Ok(dir) if !dir.trim().is_empty() => {
                let path = std::path::Path::new(dir.trim()).join("agent_tasks.db");
                kimi_agent::persistence::SqliteStore::open(&path)?
            }
            _ => kimi_agent::persistence::SqliteStore::in_memory()?,
        },
    );

    // ── Plugin handlers (SDK listPlugins/getPluginInfo, read-only) ───────────────
    // Separate DB handle (`plugins.db`) so the plugin store does not contend
    // with the task store's connection mutex. Install/enable/remove are not
    // exposed yet — this is the read surface the TUI's `/plugins` view + slash
    // autocomplete consume.
    fn plugin_source_str(s: &kimi_agent::plugin::types::PluginSource) -> &'static str {
        use kimi_agent::plugin::types::PluginSource;
        match s {
            PluginSource::Github { .. } => "github",
            PluginSource::Local { .. } => "local-path",
            PluginSource::Url { .. } => "zip-url",
        }
    }
    fn plugin_summary_json(r: &kimi_agent::plugin::types::PluginRecord) -> serde_json::Value {
        let enabled = r.is_enabled();
        serde_json::json!({
            "id": r.id,
            "display_name": r.name,
            "version": r.version,
            "enabled": enabled,
            // The engine tracks enabled/disabled, not a health state, so a
            // present record is always "ok".
            "state": "ok",
            "skill_count": r.skills.len(),
            "mcp_server_count": r.mcp_servers.len(),
            // No per-server enable flag on disk yet: a disabled plugin
            // contributes none; an enabled one contributes all.
            "enabled_mcp_server_count": if enabled { r.mcp_servers.len() } else { 0 },
            "hook_count": r.hooks.len(),
            "command_count": 0,
            "has_errors": false,
            "source": plugin_source_str(&r.source),
        })
    }
    fn plugin_info_json(r: &kimi_agent::plugin::types::PluginRecord) -> serde_json::Value {
        let mut base = plugin_summary_json(r);
        let root = match &r.source {
            kimi_agent::plugin::types::PluginSource::Local { path } => path.clone(),
            _ => String::new(),
        };
        let mcp_servers: Vec<serde_json::Value> = r
            .mcp_servers
            .iter()
            .map(|m| {
                serde_json::json!({
                    "name": m.name,
                    "runtime_name": m.name,
                    "enabled": r.is_enabled(),
                    "transport": m.transport,
                    "command": m.command,
                    "url": m.url,
                })
            })
            .collect();
        if let Some(obj) = base.as_object_mut() {
            obj.insert("root".into(), serde_json::json!(root));
            obj.insert("installed_at".into(), serde_json::json!(r.installed_at));
            obj.insert("mcp_servers".into(), serde_json::json!(mcp_servers));
            obj.insert("diagnostics".into(), serde_json::json!([]));
        }
        base
    }

    let plugin_store: Arc<kimi_agent::plugin::store::PluginStore> = Arc::new(
        kimi_agent::plugin::store::PluginStore::new(match std::env::var("KIMI_AGENT_HOME") {
            Ok(dir) if !dir.trim().is_empty() => {
                let path = std::path::Path::new(dir.trim()).join("plugins.db");
                kimi_agent::persistence::SqliteStore::open(&path)?
            }
            _ => kimi_agent::persistence::SqliteStore::in_memory()?,
        }),
    );
    let _ = plugin_store.init();

    let ps = plugin_store.clone();
    RpcServer::register_arc(&server, types::methods::PLUGIN_LIST, move |_| {
        let ps = ps.clone();
        Box::pin(async move {
            let records = ps
                .list()
                .map_err(|e| types::JsonRpcError::internal_error(format!("plugin list: {e}")))?;
            let plugins: Vec<serde_json::Value> = records.iter().map(plugin_summary_json).collect();
            Ok(serde_json::json!({ "plugins": plugins }))
        })
    });

    let ps = plugin_store.clone();
    RpcServer::register_arc(&server, types::methods::PLUGIN_GET, move |params| {
        let ps = ps.clone();
        Box::pin(async move {
            let input: types::PluginGetParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            match ps
                .get(&input.id)
                .map_err(|e| types::JsonRpcError::internal_error(format!("plugin get: {e}")))?
            {
                Some(r) => Ok(plugin_info_json(&r)),
                None => Ok(serde_json::Value::Null),
            }
        })
    });

    // ── Task domain handlers ────────────────────────────────────────────────

    // Shared TaskService with SQLite persistence: task records from a previous
    // session come back as ghosts (`list` surfaces them, output is served from
    // SQLite). The service is currently registry-only on the RPC surface —
    // turn-loop integration (task/track from `run_turn`) is the next step.
    let task_service = Arc::new(Mutex::new(kimi_agent::task::TaskService::new(
        kimi_agent::task::TaskServiceConfig::default(),
    )));
    {
        let mut ts = task_service.lock().unwrap_or_else(|e| e.into_inner());
        match kimi_agent::persistence::SqliteTaskStore::new(tasks_store.clone()) {
            Ok(store) => {
                ts.set_persistence(Box::new(store));
                // Merge the on-disk registry into the ghost set (without
                // replacing anything already restored), then mark records
                // still claiming to run as lost.
                if let Err(e) = ts.load_from_disk(false) {
                    eprintln!("[task] restore from disk failed: {e}");
                }
                ts.reconcile();
            }
            Err(e) => eprintln!("[task] SQLite store unavailable, running without persistence: {e}"),
        }
    }

    // task/list
    let ts = task_service.clone();
    RpcServer::register_arc(&server, types::methods::TASK_LIST, move |_| {
        let ts = ts.clone();
        Box::pin(async move {
            let service = ts.lock().unwrap_or_else(|e| e.into_inner());
            let tasks = service.list(false, None);
            serde_json::to_value(&tasks)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Serialize error: {e}")))
        })
    });

    // Initialize CronManager (shared state), wire native persistence, and start
    // the scheduler. `add_task` mirrors to the persist store automatically;
    // `load_from_disk` rehydrates tasks persisted by a previous session so
    // cron survives an engine restart.
    let cron_manager = Arc::new(Mutex::new(CronManager::new(None)));
    {
        let mut cm = cron_manager.lock().unwrap_or_else(|e| e.into_inner());
        cm.set_persist_store(Box::new(kimi_agent::persistence::SqliteCronStore::new(
            tasks_store.clone(),
        )));
        if let Err(e) = cm.load_from_disk() {
            eprintln!("[cron] restore from disk failed: {e}");
        }
        cm.start();
    }

    // cron/create
    let cm = cron_manager.clone();
    RpcServer::register_arc(&server, types::methods::CRON_CREATE, move |params| {
        let cm = cm.clone();
        Box::pin(async move {
            let input: types::CronCreateParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = cm.lock().unwrap_or_else(|e| e.into_inner());
            let task = manager.add_task(CronTaskInit {
                cron: input.cron,
                prompt: input.prompt,
                recurring: input.recurring,
            });
            let recurring = task.is_recurring();
            serde_json::to_value(&types::CronCreateResult {
                id: task.id,
                cron: task.cron,
                prompt: task.prompt,
                created_at: task.created_at,
                recurring,
            })
            .map_err(|e| types::JsonRpcError::internal_error(format!("Serialize error: {e}")))
        })
    });

    // cron/delete
    let cm = cron_manager.clone();
    RpcServer::register_arc(&server, types::methods::CRON_DELETE, move |params| {
        let cm = cm.clone();
        Box::pin(async move {
            let input: types::CronDeleteParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let ids: Vec<&str> = input.ids.iter().map(|s| s.as_str()).collect();
            let mut manager = cm.lock().unwrap_or_else(|e| e.into_inner());
            let removed = manager.remove_tasks(&ids);
            serde_json::to_value(&types::CronDeleteResult { removed })
                .map_err(|e| types::JsonRpcError::internal_error(format!("Serialize error: {e}")))
        })
    });

    // cron/list
    let cm = cron_manager.clone();
    RpcServer::register_arc(&server, types::methods::CRON_LIST, move |_| {
        let cm = cm.clone();
        Box::pin(async move {
            let mut manager = cm.lock().unwrap_or_else(|e| e.into_inner());
            let snapshots = manager.list_task_snapshots();
            let tasks: Vec<types::CronTaskSnapshotRpc> = snapshots
                .into_iter()
                .map(|s| types::CronTaskSnapshotRpc {
                    id: s.id,
                    cron: s.cron,
                    recurring: s.recurring,
                    created_at: s.created_at,
                    last_fired_at: s.last_fired_at,
                    next_fire_at: s.next_fire_at,
                })
                .collect();
            serde_json::to_value(&types::CronListResult { tasks })
                .map_err(|e| types::JsonRpcError::internal_error(format!("Serialize error: {e}")))
        })
    });

    // cron/get_next_fire
    let cm = cron_manager.clone();
    RpcServer::register_arc(&server, types::methods::CRON_GET_NEXT_FIRE, move |params| {
        let cm = cm.clone();
        Box::pin(async move {
            let input: types::CronGetNextFireParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = cm.lock().unwrap_or_else(|e| e.into_inner());
            let next_fire_at = match input.task_id {
                Some(id) => manager.get_next_fire_for_task(&id),
                None => manager.get_next_fire_time(),
            };
            serde_json::to_value(&types::CronGetNextFireResult { next_fire_at })
                .map_err(|e| types::JsonRpcError::internal_error(format!("Serialize error: {e}")))
        })
    });

    // ── Background task handlers ───────────────────────────────────────────────

    // Native persistence for the shared BackgroundManager (created above,
    // before the RUN_TURN handler). The write-path handlers below mirror task
    // metadata/output into `agent_tasks.db` for RPC-registered tasks; the
    // manager itself mirrors natively-spawned tasks through `set_persist`.
    let bg_persist = Arc::new(
        kimi_agent::persistence::SqliteBackgroundStore::new(tasks_store.clone())
            .map_err(anyhow::Error::msg)?,
    );
    // Natively-spawned tasks (run_in_background Bash) persist through the
    // manager; RPC-registered tasks persist through the handlers below.
    // Tasks persisted by a previous session come back as ghosts (visible in
    // `list_ghosts` / `bg/list`-style introspection; their output is served
    // from SQLite via the `bg/output` fallback below).
    {
        let mut mgr = bg_manager.lock().unwrap_or_else(|e| e.into_inner());
        match bg_persist.list() {
            Ok(infos) => {
                for info in infos {
                    mgr.add_ghost(info);
                }
            }
            Err(e) => eprintln!("[background] restore from disk failed: {e}"),
        }
        mgr.set_persist(bg_persist.clone());
    }

    // bg/register
    let bm = bg_manager.clone();
    let bp = bg_persist.clone();
    RpcServer::register_arc(&server, types::methods::BG_REGISTER, move |params| {
        let bm = bm.clone();
        let bp = bp.clone();
        Box::pin(async move {
            let input: types::BgRegisterParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let kind = match input.kind.as_str() {
                "process" => BackgroundTaskKind::Process,
                "agent" => BackgroundTaskKind::Agent,
                "question" => BackgroundTaskKind::Question,
                other => {
                    return Ok(serde_json::to_value(&types::BgRegisterResult {
                        task_id: None,
                        error: Some(format!("Unknown task kind: {other}")),
                    })
                    .unwrap());
                }
            };
            let mut manager = bm.lock().unwrap_or_else(|e| e.into_inner());
            let opts = RegisterOptions {
                detached: input.detached.unwrap_or(false),
                timeout_ms: input.timeout_ms,
                ..Default::default()
            };
            let task_id = manager.register(&input.prefix, kind, input.description, Some(opts));
            if let Some(ref tid) = task_id {
                if let Some(t) = manager.get(tid) {
                    let _ = bp.write_info(&t.to_info());
                }
            }
            serde_json::to_value(&types::BgRegisterResult {
                task_id,
                error: None,
            })
            .map_err(|e| types::JsonRpcError::internal_error(format!("Serialize error: {e}")))
        })
    });

    // bg/list
    let bm = bg_manager.clone();
    RpcServer::register_arc(&server, types::methods::BG_LIST, move |_| {
        let bm = bm.clone();
        Box::pin(async move {
            let manager = bm.lock().unwrap_or_else(|e| e.into_inner());
            let infos = manager.list_infos();
            serde_json::to_value(&infos)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Serialize error: {e}")))
        })
    });

    // bg/get
    let bm = bg_manager.clone();
    RpcServer::register_arc(&server, types::methods::BG_GET, move |params| {
        let bm = bm.clone();
        Box::pin(async move {
            let input: types::BgGetParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let manager = bm.lock().unwrap_or_else(|e| e.into_inner());
            let task = manager.get(&input.task_id);
            match task {
                Some(t) => serde_json::to_value(&t.to_info()).map_err(|e| {
                    types::JsonRpcError::internal_error(format!("Serialize error: {e}"))
                }),
                None => Err(types::JsonRpcError::internal_error(format!(
                    "Task not found: {}",
                    input.task_id
                ))),
            }
        })
    });

    // bg/stop
    let bm = bg_manager.clone();
    RpcServer::register_arc(&server, types::methods::BG_STOP, move |params| {
        let bm = bm.clone();
        Box::pin(async move {
            let input: types::BgStopParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = bm.lock().unwrap_or_else(|e| e.into_inner());
            match manager.stop(&input.task_id, input.reason) {
                Ok(()) => Ok(serde_json::json!({ "ok": true })),
                Err(e) => Err(types::JsonRpcError::internal_error(e)),
            }
        })
    });

    // bg/detach
    let bm = bg_manager.clone();
    RpcServer::register_arc(&server, types::methods::BG_DETACH, move |params| {
        let bm = bm.clone();
        Box::pin(async move {
            let input: types::BgGetParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = bm.lock().unwrap_or_else(|e| e.into_inner());
            match manager.detach(&input.task_id) {
                Some(info) => serde_json::to_value(&info).map_err(|e| {
                    types::JsonRpcError::internal_error(format!("Serialize error: {e}"))
                }),
                None => Ok(serde_json::Value::Null),
            }
        })
    });

    // bg/output
    // Serves the in-memory ring first; tasks restored from a previous session
    // (ghosts) fall back to the persisted output in SQLite.
    let bm = bg_manager.clone();
    let bp = bg_persist.clone();
    RpcServer::register_arc(&server, types::methods::BG_OUTPUT, move |params| {
        let bm = bm.clone();
        let bp = bp.clone();
        Box::pin(async move {
            let input: types::BgOutputParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let manager = bm.lock().unwrap_or_else(|e| e.into_inner());
            let snapshot = manager.get_output_snapshot(&input.task_id);
            match snapshot {
                Some(s) => serde_json::to_value(&types::BgOutputResult {
                    output_path: s.output_path,
                    output_size_bytes: s.output_size_bytes,
                    preview_bytes: s.preview_bytes,
                    truncated: s.truncated,
                    full_output_available: s.full_output_available,
                    preview: s.preview,
                    error: None,
                })
                .map_err(|e| types::JsonRpcError::internal_error(format!("Serialize error: {e}"))),
                None => {
                    // Ghost (restored) task — rebuild the preview from the
                    // persisted output.
                    let output = bp.read_output(&input.task_id);
                    match output {
                        Ok(text) => {
                            let max_preview = 1024 * 1024usize;
                            let preview: String = text
                                .chars()
                                .take(max_preview)
                                .collect::<String>();
                            let size = text.len() as u64;
                            Ok(serde_json::to_value(&types::BgOutputResult {
                                output_path: None,
                                output_size_bytes: size,
                                preview_bytes: preview.len() as u64,
                                truncated: size > max_preview as u64,
                                full_output_available: true,
                                preview,
                                error: None,
                            })
                            .map_err(|e| {
                                types::JsonRpcError::internal_error(format!(
                                    "Serialize error: {e}"
                                ))
                            })?)
                        }
                        Err(e) => Ok(serde_json::to_value(&types::BgOutputResult {
                            output_path: None,
                            output_size_bytes: 0,
                            preview_bytes: 0,
                            truncated: false,
                            full_output_available: false,
                            preview: String::new(),
                            error: Some(format!("Task not found: {} ({e})", input.task_id)),
                        })
                        .unwrap()),
                    }
                }
            }
        })
    });

    // bg/append_output
    let bm = bg_manager.clone();
    let bp = bg_persist.clone();
    RpcServer::register_arc(&server, types::methods::BG_APPEND_OUTPUT, move |params| {
        let bm = bm.clone();
        let bp = bp.clone();
        Box::pin(async move {
            let input: types::BgAppendOutputParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = bm.lock().unwrap_or_else(|e| e.into_inner());
            match manager.append_output(&input.task_id, &input.chunk) {
                Ok(()) => {
                    let _ = bp.append_output(&input.task_id, &input.chunk);
                    Ok(serde_json::json!({ "ok": true }))
                }
                Err(e) => Err(types::JsonRpcError::internal_error(e)),
            }
        })
    });

    // bg/settle
    let bm = bg_manager.clone();
    let bp = bg_persist.clone();
    RpcServer::register_arc(&server, types::methods::BG_SETTLE, move |params| {
        let bm = bm.clone();
        let bp = bp.clone();
        Box::pin(async move {
            let input: types::BgSettleParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let settlement_status = match input.status.as_str() {
                "completed" => BackgroundTaskSettlementStatus::Completed,
                "failed" => BackgroundTaskSettlementStatus::Failed,
                "timed_out" => BackgroundTaskSettlementStatus::TimedOut,
                "killed" => BackgroundTaskSettlementStatus::Killed,
                other => {
                    return Err(types::JsonRpcError::internal_error(format!(
                        "Unknown settlement status: {other}"
                    )));
                }
            };
            let mut manager = bm.lock().unwrap_or_else(|e| e.into_inner());
            match manager.settle(
                &input.task_id,
                BackgroundTaskSettlement {
                    status: settlement_status,
                    stop_reason: input.stop_reason,
                },
            ) {
                Ok(()) => {
                    if let Some(t) = manager.get(&input.task_id) {
                        let _ = bp.write_info(&t.to_info());
                    }
                    Ok(serde_json::json!({ "ok": true }))
                }
                Err(e) => Err(types::JsonRpcError::internal_error(e)),
            }
        })
    });

    eprintln!("kimi-agent ready, listening on stdin/stdout");

    // Handlers hold Arc clones of the server (self-referential by design: the
    // RUN_TURN handler captures a server clone to spawn tool/LLM callbacks), so
    // the strong count is never 1 here. Keep the Arc and run on it directly.
    server.run().await
}

/// Self-test: runs the turn loop with a mock LLM.
async fn run_self_test() -> anyhow::Result<()> {
    eprintln!("Running self-test...");

    // Create a mock LLM that returns a simple response
    let mock_llm = MockLlm {
        system_prompt: "You are a helpful assistant.".into(),
        model_name: "test-model".into(),
    };

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: "Hello!".into(),
        ..Default::default()
    }];

    let input = RunTurnInput {
        turn_id: "test-turn-1".into(),
        llm: &mock_llm,
        messages,
        tools: &[],
        tool_defs: vec![],
        hooks: None,
        max_steps: 5,
        goal: None,
        cancellation: None,
 steer_queue: None,
    };

    // Create a minimal server for the test
    let server = Arc::new(RpcServer::new());
    let callbacks: Arc<dyn HostCallbacks> = Arc::new(RpcHostCallbacks { server });

    let result = run_turn(input, &callbacks).await;

    match result {
        Ok(res) => {
            eprintln!("  Turn completed: {:?}", res.stop_reason);
            eprintln!("  Steps: {}", res.steps);
            eprintln!(
                "  Usage: {} in / {} out / {} total",
                res.usage.input_tokens, res.usage.output_tokens, res.usage.total_tokens
            );
            eprintln!("Self-test PASSED");
            Ok(())
        }
        Err(e) => {
            eprintln!("  Turn failed: {e}");
            eprintln!("Self-test FAILED");
            Err(anyhow::anyhow!("{e}"))
        }
    }
}

/// A mock LLM that returns a fixed response without tool calls.
#[allow(dead_code)]
struct MockLlm {
    system_prompt: String,
    model_name: String,
}

impl LLM for MockLlm {
    fn system_prompt(&self) -> &str {
        &self.system_prompt
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }

    fn is_retryable_error(&self, _error: &str) -> bool {
        false
    }

    fn chat(
        &self,
        _params: LLMChatParams,
    ) -> kimi_agent::rpc::types::BoxFuture<
        '_,
        Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>,
    > {
        Box::pin(async move {
            Ok(LLMChatResponse {
                content: String::new(),
                tool_calls: vec![],
                finish_reason: Some("stop".into()),
                usage: TokenUsage {
                    input_tokens: 10,
                    output_tokens: 5,
                    total_tokens: 15,
                },
            })
        })
    }
}
