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

    // Register run_turn handler
    let s = server.clone();
    let cm = cancel_map.clone();
    RpcServer::register_arc(&s.clone(), types::methods::RUN_TURN, move |params| {
        let server = s.clone();
        let cancel_map = cm.clone();
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
                Box::new(
                    HostLlmProxy::new(input.system_prompt.clone(), input.model_name.clone())
                        .with_callbacks(callbacks.clone()),
                )
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

    let mgr = session_manager.clone();
    let srv = server.clone();
    let sc = session_cancel.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_CREATE, move |params| {
        let mgr = mgr.clone();
        let srv = srv.clone();
        let sc = sc.clone();
        Box::pin(async move {
            let input: types::SessionCreateParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
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
            let callbacks: Arc<dyn HostCallbacks> =
                Arc::new(RpcHostCallbacks { server: srv.clone() });
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
                        ..Default::default()
                    },
                )
                .map_err(|e| types::JsonRpcError::internal_error(e.to_string()))?;
            sc.lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id.clone(), agent.cancellation.clone());
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
            let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                types::JsonRpcError::internal_error(format!(
                    "no agent for session: {}",
                    input.session_id
                ))
            })?;
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

    let sc = session_cancel.clone();
    RpcServer::register_arc(&server, types::methods::SESSION_CANCEL, move |params| {
        let sc = sc.clone();
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
            Ok(serde_json::json!({ "cancelled": cancelled }))
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
                .map_err(|e| types::JsonRpcError::internal_error(e.to_string()))?;
            Ok(serde_json::json!({ "sessions": sessions }))
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

    // ── Cron handlers ──────────────────────────────────────────────────────────

    // Initialize CronManager (shared state) and start the scheduler
    let cron_manager = Arc::new(Mutex::new(CronManager::new(None)));
    {
        let mut cm = cron_manager.lock().unwrap_or_else(|e| e.into_inner());
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

    // Initialize BackgroundManager (shared state)
    let bg_manager = Arc::new(Mutex::new(BackgroundManager::new(None)));

    // bg/register
    let bm = bg_manager.clone();
    RpcServer::register_arc(&server, types::methods::BG_REGISTER, move |params| {
        let bm = bm.clone();
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

    // bg/output
    let bm = bg_manager.clone();
    RpcServer::register_arc(&server, types::methods::BG_OUTPUT, move |params| {
        let bm = bm.clone();
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
                None => Ok(serde_json::to_value(&types::BgOutputResult {
                    output_path: None,
                    output_size_bytes: 0,
                    preview_bytes: 0,
                    truncated: false,
                    full_output_available: false,
                    preview: String::new(),
                    error: Some(format!("Task not found: {}", input.task_id)),
                })
                .unwrap()),
            }
        })
    });

    // bg/append_output
    let bm = bg_manager.clone();
    RpcServer::register_arc(&server, types::methods::BG_APPEND_OUTPUT, move |params| {
        let bm = bm.clone();
        Box::pin(async move {
            let input: types::BgAppendOutputParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let mut manager = bm.lock().unwrap_or_else(|e| e.into_inner());
            match manager.append_output(&input.task_id, &input.chunk) {
                Ok(()) => Ok(serde_json::json!({ "ok": true })),
                Err(e) => Err(types::JsonRpcError::internal_error(e)),
            }
        })
    });

    // bg/settle
    let bm = bg_manager.clone();
    RpcServer::register_arc(&server, types::methods::BG_SETTLE, move |params| {
        let bm = bm.clone();
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
                Ok(()) => Ok(serde_json::json!({ "ok": true })),
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
