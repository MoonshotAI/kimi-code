/// Agent — the core orchestration struct.
///
/// Corresponds to the `Agent` class in `packages/agent-core/src/agent/index.ts`.
///
/// The Agent owns all subsystems (turn flow, context, config, hooks) and
/// provides the main interface for running turns.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::agent::turn_flow::TurnFlow;
use crate::agent::types::*;
use crate::callbacks::HostCallbacks;
use crate::callbacks::NativeToolCallbacks;
use crate::context::context_memory::ContextMemory;
use crate::goal::{CreateGoalInput, GoalActor, GoalMode};
use crate::rpc::types::{BoxFuture, LlmChatRequest, LlmChatResponse, ToolExecuteRequest, ToolExecuteResponse};
use crate::tools::NativeToolset;
use crate::turn_loop::types as loop_types;

// ── Goal interceptor + tools ──────────────────────────────────────────────

/// The session surface's tool render channel: every tool call — wherever it
/// settles (engine-native, goal, MCP, knowledge, or host) — reports
/// `session.tool.started` / `session.tool.settled` over `host/event`, so a
/// thin client can draw tool cards without owning the loop. Sits outermost
/// on the interceptor chain to observe all of it.
struct ToolEventInterceptor {
    inner: Arc<dyn HostCallbacks>,
    session_id: Option<String>,
}
impl HostCallbacks for ToolEventInterceptor {
    fn supports_tool_lifecycle(&self) -> bool { self.inner.supports_tool_lifecycle() }
    fn llm_chat(&self, r: LlmChatRequest) -> BoxFuture<'static, Result<LlmChatResponse, String>> { self.inner.llm_chat(r) }
    fn execute_tool(&self, req: ToolExecuteRequest) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        let inner = self.inner.clone();
        let session_id = self.session_id.clone();
        Box::pin(async move {
            let tool_call_id = req.tool_call_id.clone();
            let tool_name = req.tool_name.clone();
            inner.emit_event(serde_json::json!({
                "type": "session.tool.started",
                "session_id": session_id,
                "tool_call_id": tool_call_id,
                "tool_name": tool_name,
                "arguments": req.arguments,
            }));
            let result = inner.execute_tool(req).await;
            let (content, is_error) = match &result {
                Ok(resp) => (truncate_for_event(&resp.content), resp.is_error),
                Err(error) => (truncate_for_event(error), true),
            };
            inner.emit_event(serde_json::json!({
                "type": "session.tool.settled",
                "session_id": session_id,
                "tool_call_id": tool_call_id,
                "tool_name": tool_name,
                "content": content,
                "is_error": is_error,
            }));
            result
        })
    }
    fn emit_event(&self, e: serde_json::Value) { self.inner.emit_event(e); }
    fn prepare_tool_execution(&self, r: crate::rpc::types::PrepareToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::PrepareToolResponse>, String>> { self.inner.prepare_tool_execution(r) }
    fn authorize_tool_execution(&self, r: crate::rpc::types::AuthorizeToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::AuthorizeToolResponse>, String>> { self.inner.authorize_tool_execution(r) }
    fn finalize_tool_result(&self, r: crate::rpc::types::FinalizeToolRequest) -> BoxFuture<'static, Result<crate::rpc::types::FinalizeToolResponse, String>> { self.inner.finalize_tool_result(r) }
}

/// Event payloads are for rendering, not transcripts: cap the content so a
/// huge tool output cannot flood the notification channel.
fn truncate_for_event(content: &str) -> String {
    const MAX: usize = 2000;
    if content.chars().count() <= MAX {
        return content.to_string();
    }
    let kept: String = content.chars().take(MAX).collect();
    format!("{kept}\n… (truncated for event)")
}

struct GoalToolInterceptor { inner: Arc<dyn HostCallbacks>, goal: std::sync::Mutex<Option<GoalMode>> }
impl GoalToolInterceptor {
    fn new(inner: Arc<dyn HostCallbacks>) -> Self { Self { inner, goal: std::sync::Mutex::new(None) } }
    fn bind_goal(&self, g: Option<GoalMode>) { *self.goal.lock().unwrap_or_else(|e| e.into_inner()) = g; }
    fn take_goal(&self) -> Option<GoalMode> { self.goal.lock().unwrap_or_else(|e| e.into_inner()).take() }
}
impl HostCallbacks for GoalToolInterceptor {
    fn supports_tool_lifecycle(&self) -> bool { self.inner.supports_tool_lifecycle() }
    fn llm_chat(&self, r: LlmChatRequest) -> BoxFuture<'static, Result<LlmChatResponse, String>> { self.inner.llm_chat(r) }
    fn execute_tool(&self, req: ToolExecuteRequest) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        if req.tool_name == "CreateGoal" || req.tool_name == "GoalStatus" || req.tool_name == "UpdateGoal" {
            let result = handle_goal_tool(req.tool_name.clone(), req.arguments.clone(), &self.goal);
            return Box::pin(async move { result });
        }
        self.inner.execute_tool(req)
    }
    fn emit_event(&self, e: serde_json::Value) { self.inner.emit_event(e); }
    fn prepare_tool_execution(&self, r: crate::rpc::types::PrepareToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::PrepareToolResponse>, String>> { self.inner.prepare_tool_execution(r) }
    fn authorize_tool_execution(&self, r: crate::rpc::types::AuthorizeToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::AuthorizeToolResponse>, String>> { self.inner.authorize_tool_execution(r) }
    fn finalize_tool_result(&self, r: crate::rpc::types::FinalizeToolRequest) -> BoxFuture<'static, Result<crate::rpc::types::FinalizeToolResponse, String>> { self.inner.finalize_tool_result(r) }
}

fn handle_goal_tool(tool_name: String, args: serde_json::Value, goal_lock: &std::sync::Mutex<Option<GoalMode>>) -> Result<ToolExecuteResponse, String> {
    let mut guard = goal_lock.lock().map_err(|e| e.to_string())?;
    let goal_mode = guard.as_mut().ok_or("Goal mode is not enabled")?;
    match tool_name.as_str() {
        "CreateGoal" => {
            let obj = args.get("objective").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let crit = args.get("completion_criterion").and_then(|v| v.as_str()).map(|s| s.to_string());
            let rep = args.get("replace").and_then(|v| v.as_bool()).unwrap_or(false);
            let input = CreateGoalInput { objective: obj, completion_criterion: crit, replace: rep };
            match goal_mode.create_goal(input, GoalActor::Model) {
                Ok(s) => Ok(ToolExecuteResponse { content: format!("Goal created: {}", s.objective), is_error: false, is_prediction: false, stop_turn: false }),
                Err(e) => Ok(ToolExecuteResponse { content: format!("Failed: {e}"), is_error: true, is_prediction: false, stop_turn: false }),
            }
        }
        "GoalStatus" => match goal_mode.get_active_goal() {
            Some(s) => Ok(ToolExecuteResponse { content: format!("Goal: {}\nStatus: {:?}\nTurns: {}", s.objective, s.status, s.turns_used), is_error: false, is_prediction: false, stop_turn: false }),
            None => Ok(ToolExecuteResponse { content: "No active goal".to_string(), is_error: false, is_prediction: false, stop_turn: false }),
        },
        // GOAL.md: the model may only set `complete` or `blocked` — never
        // `active` (resume is user-only), `paused`, or the budget states.
        "UpdateGoal" => {
            let status = args.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let reason = args.get("reason").and_then(|v| v.as_str()).map(str::to_string);
            match status {
                "complete" => {
                    let had_active = goal_mode.get_active_goal().is_some();
                    match goal_mode.mark_complete(reason, GoalActor::Model) {
                        Some(s) => Ok(ToolExecuteResponse {
                            content: format!(
                                "Goal complete: {}. The goal record is cleared — give the user a \
                                 short final summary of what was done and what was verified.",
                                s.objective
                            ),
                            is_error: false, is_prediction: false, stop_turn: false,
                        }),
                        None if had_active => Ok(ToolExecuteResponse {
                            // The independent verifier rejected the claim (the
                            // rejection is recorded on the goal). Completion
                            // must be proven, not asserted.
                            content: "Completion was NOT accepted: the independent verification \
                                      rejected the claim. The goal stays active — continue working, \
                                      and only mark complete again with concrete evidence that every \
                                      requirement is satisfied.".to_string(),
                            is_error: true, is_prediction: false, stop_turn: false,
                        }),
                        None => Ok(ToolExecuteResponse { content: "No active goal to complete".to_string(), is_error: true, is_prediction: false, stop_turn: false }),
                    }
                }
                "blocked" => {
                    // The 3-turn blocked audit is enforced prompt-side
                    // (continuation.md); the runtime records the attempt for
                    // the streak audit trail and accepts the mark.
                    let _ = goal_mode.record_blocked_attempt();
                    match goal_mode.mark_blocked(reason, GoalActor::Model) {
                        Some(s) => Ok(ToolExecuteResponse {
                            content: format!(
                                "Goal blocked: {}. Autonomous pursuit stops — tell the user what is \
                                 blocking and what input or external change would unblock it.",
                                s.objective
                            ),
                            is_error: false, is_prediction: false, stop_turn: false,
                        }),
                        None => Ok(ToolExecuteResponse { content: "No active goal to block".to_string(), is_error: true, is_prediction: false, stop_turn: false }),
                    }
                }
                other => Ok(ToolExecuteResponse {
                    content: format!(
                        "UpdateGoal only accepts status \"complete\" or \"blocked\" (got \"{other}\"). \
                         Pausing and resuming are user actions."
                    ),
                    is_error: true, is_prediction: false, stop_turn: false,
                }),
            }
        }
        _ => Err(format!("Unknown goal tool: {tool_name}")),
    }
}

fn goal_tool_definitions() -> Vec<loop_types::ToolInfo> {
    vec![
        loop_types::ToolInfo { name: "CreateGoal".into(), description: "Create or replace a goal".into(), input_schema: serde_json::json!({"type":"object","properties":{"objective":{"type":"string"},"completion_criterion":{"type":"string"},"replace":{"type":"boolean","default":false}},"required":["objective"]}) },
        loop_types::ToolInfo { name: "UpdateGoal".into(), description: "Mark the active goal complete or blocked. Only these two statuses are allowed; resuming is a user action. Complete requires every requirement to be done and verified; blocked requires the 3-turn blocked audit.".into(), input_schema: serde_json::json!({"type":"object","properties":{"status":{"type":"string","enum":["complete","blocked"]},"reason":{"type":"string"}},"required":["status"]}) },
        loop_types::ToolInfo { name: "GoalStatus".into(), description: "Check goal status and budget".into(), input_schema: serde_json::json!({"type":"object","properties":{},"required":[]}) },
    ]
}

// ── Knowledge & MCP interceptors ────────────────────────────────────────

pub(crate) struct KnowledgeInterceptor { pub inner: Arc<dyn HostCallbacks>, pub knowledge: std::sync::Arc<crate::knowledge::KnowledgeService> }
impl HostCallbacks for KnowledgeInterceptor {
    fn supports_tool_lifecycle(&self) -> bool { self.inner.supports_tool_lifecycle() }
    fn llm_chat(&self, r: LlmChatRequest) -> BoxFuture<'static, Result<LlmChatResponse, String>> { self.inner.llm_chat(r) }
    fn execute_tool(&self, req: ToolExecuteRequest) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        if req.tool_name == "SearchKnowledge" {
            let q = req.arguments.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
            // KnowledgeService::search is a no-op (empty result) until a
            // delegate is wired; "No results." is then the honest answer.
            let query = crate::knowledge::KnowledgeQuery { text: q, max_results: Some(5), category: None, scope: None, min_confidence: None };
            let c = match self.knowledge.search(&query) {
                Ok(r) if !r.entries.is_empty() => r.entries.iter().enumerate()
                    .map(|(i, e)| format!("{}. {}", i + 1, e.title.as_deref().unwrap_or(&e.content)))
                    .collect::<Vec<_>>().join("\n"),
                _ => "No results.".into(),
            };
            return Box::pin(async move { Ok(ToolExecuteResponse { content: c, is_error: false, is_prediction: false, stop_turn: false }) });
        }
        self.inner.execute_tool(req)
    }
    fn emit_event(&self, e: serde_json::Value) { self.inner.emit_event(e); }
    fn prepare_tool_execution(&self, r: crate::rpc::types::PrepareToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::PrepareToolResponse>, String>> { self.inner.prepare_tool_execution(r) }
    fn authorize_tool_execution(&self, r: crate::rpc::types::AuthorizeToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::AuthorizeToolResponse>, String>> { self.inner.authorize_tool_execution(r) }
    fn finalize_tool_result(&self, r: crate::rpc::types::FinalizeToolRequest) -> BoxFuture<'static, Result<crate::rpc::types::FinalizeToolResponse, String>> { self.inner.finalize_tool_result(r) }
}

pub(crate) struct McpToolInterceptor { pub inner: Arc<dyn HostCallbacks>, pub mcp: std::sync::Arc<tokio::sync::Mutex<crate::mcp::runtime::McpRuntime>> }
impl HostCallbacks for McpToolInterceptor {
    fn supports_tool_lifecycle(&self) -> bool { self.inner.supports_tool_lifecycle() }
    fn llm_chat(&self, r: LlmChatRequest) -> BoxFuture<'static, Result<LlmChatResponse, String>> { self.inner.llm_chat(r) }
    fn execute_tool(&self, req: ToolExecuteRequest) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        if req.tool_name.starts_with("mcp__") {
            let mcp = self.mcp.clone(); let n = req.tool_name.clone(); let a = req.arguments.clone();
            // tokio::sync::Mutex: the guard is held across the call_tool await,
            // which a std MutexGuard cannot do inside this Send future.
            return Box::pin(async move {
                let mut m = mcp.lock().await;
                m.call_tool(&n, Some(a)).await.map(|r| ToolExecuteResponse {
                    content: crate::mcp::types::mcp_content_to_text(&r.content),
                    is_error: r.is_error.unwrap_or(false),
                    is_prediction: false,
                    stop_turn: false,
                })
            });
        }
        self.inner.execute_tool(req)
    }
    fn emit_event(&self, e: serde_json::Value) { self.inner.emit_event(e); }
    fn prepare_tool_execution(&self, r: crate::rpc::types::PrepareToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::PrepareToolResponse>, String>> { self.inner.prepare_tool_execution(r) }
    fn authorize_tool_execution(&self, r: crate::rpc::types::AuthorizeToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::AuthorizeToolResponse>, String>> { self.inner.authorize_tool_execution(r) }
    fn finalize_tool_result(&self, r: crate::rpc::types::FinalizeToolRequest) -> BoxFuture<'static, Result<crate::rpc::types::FinalizeToolResponse, String>> { self.inner.finalize_tool_result(r) }
}

/// The core Agent struct.
pub struct Agent {
    /// Agent type: "main", "sub", or "independent".
    pub agent_type: String,
    /// Session id used as the persistence key (`save_session`).
    pub session_id: Option<String>,
    /// Agent home directory for persistence.
    pub homedir: Option<String>,
    /// Agent configuration.
    pub config: AgentConfig,
    /// Turn flow (step loop manager).
    pub turn_flow: TurnFlow,
    /// Context memory (message history).
    pub context: ContextMemory,
    /// Host callbacks (JS bridge).
    pub callbacks: Arc<dyn HostCallbacks>,
    /// Agent hooks (permission, injection, etc.).
    pub hooks: AgentHooks,
    /// Optional turn runner override.
    pub run_turn_override: Option<Arc<dyn AgentTurnOverride + Send + Sync>>,
    /// Cancellation flag for the current turn.
    pub cancellation: Arc<AtomicBool>,
    /// Maximum steps per turn.
    pub max_steps_per_turn: u32,
    /// Maximum retries per step.
    pub max_retries_per_step: u32,
    /// Host-provided tool definitions, presented to the model alongside the
    /// engine's own tools; calls settle at the host via `execute_tool`.
    pub host_tools: Vec<loop_types::ToolInfo>,
    /// Whether goal mode is enabled.
    pub goal_enabled: bool,
    /// Goal mode state machine (active goal lifecycle).
    pub goal: Option<GoalMode>,
    pub native_llm: Option<crate::rpc::types::NativeLlmConfig>,
    pub mcp: std::sync::Arc<tokio::sync::Mutex<crate::mcp::runtime::McpRuntime>>,
    pub compaction: crate::compaction::FullCompaction,
    pub injector: crate::injection::InjectionManager,
    pub skill_manager: crate::skill::SkillManager,
    pub knowledge: std::sync::Arc<crate::knowledge::KnowledgeService>,
    /// Monotonic turn ID counter.
    turn_id_counter: u32,
    /// Whether the agent has an active turn.
    has_active_turn: bool,
}

impl Agent {
    /// Create a new Agent.
    pub fn new(
        callbacks: Arc<dyn HostCallbacks>,
        options: AgentOptions,
    ) -> Self {
        Self {
            agent_type: "main".to_string(),
            session_id: options.session_id.clone(),
            homedir: options.homedir.clone(),
            config: options.config.unwrap_or_else(|| AgentConfig {
                cwd: String::new(),
                model_alias: None,
                system_prompt: String::new(),
                has_provider: false,
                has_model: false,
            }),
            turn_flow: TurnFlow::new(),
            context: ContextMemory::new(),
            callbacks,
            hooks: AgentHooks::default(),
            run_turn_override: options.run_turn_override,
            cancellation: Arc::new(AtomicBool::new(false)),
            max_steps_per_turn: options.max_steps_per_turn,
            max_retries_per_step: options.max_retries_per_step,
            host_tools: options.host_tools.clone(),
            goal_enabled: options.goal_enabled,
            goal: if options.goal_enabled { Some(GoalMode::new()) } else { None },
            native_llm: options.native_llm.clone(),
            mcp: std::sync::Arc::new(tokio::sync::Mutex::new(
                crate::mcp::runtime::McpRuntime::new(false, options.homedir.clone(), None)
            )),
            compaction: crate::compaction::FullCompaction::new(
                crate::compaction::CompactionConfig::default(), Default::default()
            ),
            injector: crate::injection::InjectionManager::new(true),
            skill_manager: crate::skill::SkillManager::new(crate::skill::SkillRegistry::new()),
            knowledge: std::sync::Arc::new(crate::knowledge::KnowledgeService::new()),
            turn_id_counter: 0,
            has_active_turn: false,
        }
    }

    /// Run a single turn with the given user input.
    ///
    /// Returns the turn result on success, or an error if the turn could not start.
    pub async fn run_turn(
        &mut self,
        input: Vec<crate::context::types::ContentPart>,
    ) -> Result<TurnResult, Box<dyn std::error::Error + Send + Sync>> {
        self.run_turn_with_origin(input, crate::context::types::MessageOrigin::User).await
    }

    /// Run a single turn, appending `input` with the given origin — the goal
    /// driver uses a system-trigger origin for continuation prompts so they
    /// are never mistaken for real user input.
    pub async fn run_turn_with_origin(
        &mut self,
        input: Vec<crate::context::types::ContentPart>,
        origin: crate::context::types::MessageOrigin,
    ) -> Result<TurnResult, Box<dyn std::error::Error + Send + Sync>> {
        let turn_id = self.next_turn_id();
        self.has_active_turn = true;
        self.cancellation.store(false, Ordering::Relaxed);
        // Lifecycle event for thin clients (session-owned surface): the host
        // renders from these instead of owning the loop.
        self.callbacks.emit_event(serde_json::json!({
            "type": "session.turn.started",
            "session_id": self.session_id,
            "turn_id": turn_id,
        }));

        // Append user input to context.
        self.context.append_user_message(&input, origin);

        // Build RunTurnInput for the loop.
        // LLM: native HTTP (reqwest) when configured, else the host-bridge
        // proxy — the same `HostLlmProxy` the napi path uses. (The former
        // `AgentLlm` stub errored on every chat, so the built-in loop could
        // never reach a model without an override.)
        let llm: Box<dyn loop_types::LLM> = if let Some(ref cfg) = self.native_llm {
            // Streaming sink: in native-LLM mode Rust talks to the provider
            // directly, so `llm.step.begin` / `llm.delta` / `llm.step.end`
            // must be forwarded over `host/event` or the host renders
            // nothing. The session id is stamped on so multi-session thin
            // clients can route the stream. (Host-proxy mode needs no sink:
            // the host executes `host/llm_chat` itself and already owns the
            // token stream.)
            let sink_callbacks = self.callbacks.clone();
            let sink_session = self.session_id.clone();
            Box::new(
                crate::llm::http::NativeHttpLlm::new(cfg.clone(), self.config.system_prompt.clone())
                    .with_sink(std::sync::Arc::new(move |event: serde_json::Value| {
                        sink_callbacks.emit_event(stamp_session_id(event, &sink_session));
                    })),
            )
        } else {
            Box::new(
                crate::llm::proxy::HostLlmProxy::new(
                    self.config.system_prompt.clone(),
                    self.config.model_alias.clone().unwrap_or_else(|| "default".to_string()),
                )
                .with_callbacks(self.callbacks.clone()),
            )
        };

        // ── Callback chain: Host → NativeToolCallbacks → GoalInterceptor ──
        // The standalone agent enables native Bash (`with_shell`): there is
        // no JS Bash on this path, and the approval gate still runs through
        // the host lifecycle hooks in the gated executor.
        let toolset = self.homedir.as_deref().map(NativeToolset::new).flatten()
            .map(NativeToolset::with_shell);
        let mut callbacks: Arc<dyn HostCallbacks> = if let Some(ref ts) = toolset {
            Arc::new(NativeToolCallbacks { inner: self.callbacks.clone(), toolset: Arc::new(ts.clone()) })
        } else {
            self.callbacks.clone()
        };
        // Knowledge interceptor (SearchKnowledge).
        let k = self.knowledge.clone();
        callbacks = Arc::new(KnowledgeInterceptor { inner: callbacks, knowledge: k });
        // MCP interceptor (mcp__* tools).
        let m = self.mcp.clone();
        callbacks = Arc::new(McpToolInterceptor { inner: callbacks, mcp: m });
        // Intercept goal tools locally.
        let goal_interceptor = Arc::new(GoalToolInterceptor::new(callbacks));
        let goal_temp = self.goal.take();
        goal_interceptor.bind_goal(goal_temp);
        callbacks = goal_interceptor.clone();
        // Outermost: report every tool call over `host/event` so thin
        // clients can render tool cards without owning the loop.
        callbacks = Arc::new(ToolEventInterceptor {
            inner: callbacks,
            session_id: self.session_id.clone(),
        });

        // ── Tool definitions: native + goal ──
        let mut tool_defs: Vec<loop_types::ToolInfo> = toolset.as_ref()
            .map(|ts| ts.tool_definitions().into_iter().map(|td| loop_types::ToolInfo {
                name: td.name, description: td.description,
                input_schema: td.input_schema.unwrap_or(serde_json::Value::Null),
            }).collect()).unwrap_or_default();
        if self.goal_enabled { tool_defs.extend(goal_tool_definitions()); }
        // MCP tools. The engine-facing name lives on the definition; the
        // description/schema live on the server's own tool record.
        for td in self.mcp.lock().await.tool_definitions() {
            tool_defs.push(loop_types::ToolInfo {
                name: td.name,
                description: td.tool.description.unwrap_or_default(),
                input_schema: td.tool.input_schema.unwrap_or(serde_json::Value::Null),
            });
        }
        // Skills carry no tool schemas (SkillMetadata is name/description
        // metadata only); activation goes through the host's Skill tool, so
        // there are no per-skill tool definitions to register here.
        // Knowledge search tool.
        tool_defs.push(loop_types::ToolInfo { name: "SearchKnowledge".into(), description: "Search knowledge base".into(), input_schema: serde_json::json!({"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}) });
        // Host-registered tools (session surface): presented to the model,
        // executed at the host. Engine-side names win on collision.
        for host_tool in &self.host_tools {
            if !tool_defs.iter().any(|td| td.name == host_tool.name) {
                tool_defs.push(host_tool.clone());
            }
        }

        // ── Compaction ──
        let msg_count = self.context.messages().len() as u64;
        if self.compaction.should_compact(msg_count * 50) {
            let _ = self.compaction.compaction_round(&self.context.messages(), msg_count * 50, crate::compaction::CompactionSource::Auto, None);
        }
        // ── Turn-boundary injection (system reminders) ──
        // InjectionManager appends its reminders into the context directly;
        // snapshot the messages only afterwards so the loop input includes
        // both the injected reminders and any compaction rewrite above.
        let _ = self.injector.inject_with_tracking(&mut self.context);
        let messages = self.context.messages();

        let loop_hooks = self.build_loop_hooks();

        let run_turn_input = loop_types::RunTurnInput {
            turn_id: turn_id.to_string(),
            llm: &*llm,
            messages: messages_to_loop_messages(&messages),
            tools: &[],
            // The assembled table (native + goal + MCP + knowledge + host):
            // this is what the model actually sees. It was previously
            // dropped (`vec![]`), leaving the model blind to every tool.
            tool_defs,
            hooks: loop_hooks.as_ref(),
            max_steps: self.max_steps_per_turn,
            goal: None,
            cancellation: Some(self.cancellation.clone()),
        };

        // Run the turn (use override if present, otherwise use built-in).
        // Both runners get the full interceptor chain (native tools →
        // knowledge → MCP → goal), not the raw host callbacks — an override
        // is an alternative loop, not an alternative tool stack.
        let result = if let Some(ref override_fn) = self.run_turn_override {
            override_fn.run_turn(run_turn_input, callbacks.as_ref()).await
        } else {
            crate::turn_loop::run_turn::run_turn(
                run_turn_input,
                &callbacks,
            ).await.map_err(|e| Box::new(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())) as Box<dyn std::error::Error + Send + Sync>)
        }?;

        self.has_active_turn = false;

        // Restore goal from interceptor and update bookkeeping.
        self.goal = goal_interceptor.take_goal();
        if let Some(ref mut goal) = self.goal {
            goal.increment_turn();
            goal.record_token_usage(result.usage.total_tokens.max(0) as u64);
        }

        self.callbacks.emit_event(serde_json::json!({
            "type": "session.turn.ended",
            "session_id": self.session_id,
            "turn_id": turn_id,
            "stop_reason": format!("{:?}", result.stop_reason),
            "steps": result.steps,
        }));

        Ok(TurnResult {
            stop_reason: result.stop_reason,
            steps: result.steps,
            usage: result.usage,
        })
    }

    /// Run a prompt and, when a goal is (or becomes) active, drive it as a
    /// sequence of continuation turns — the Rust port of the TS goal driver
    /// (`TurnFlow.driveGoal`, agent-core `turn/index.ts`). Each iteration runs
    /// one ordinary turn, then reads the goal state the model set via the
    /// goal tools:
    /// - goal gone or non-active → stop (the model settled it, or none exists)
    /// - over budget → mark `budgetLimited` and stop (resumable after a new
    ///   budget is configured)
    /// - aborted turn or a cancel between turns → pause the goal with
    ///   interrupt semantics and stop
    /// - failed turn → pause the goal with runtime-error semantics, propagate
    /// - still active → append the continuation prompt (goal reminder + the
    ///   standing instruction, system-trigger origin) and run the next turn
    pub async fn run_prompt(
        &mut self,
        input: Vec<crate::context::types::ContentPart>,
    ) -> Result<TurnResult, Box<dyn std::error::Error + Send + Sync>> {
        let mut result = match self.run_turn(input).await {
            Ok(result) => result,
            Err(error) => {
                self.pause_goal("A runtime error interrupted the goal");
                return Err(error);
            }
        };
        loop {
            if matches!(result.stop_reason, crate::turn_loop::types::LoopTurnStopReason::Aborted) {
                self.pause_goal("Paused after an interruption");
                return Ok(result);
            }
            // Only a still-active goal continues; complete clears the record,
            // blocked/paused/budgetLimited stop autonomous pursuit.
            let Some(snapshot) = self.goal.as_ref().and_then(|g| g.get_active_goal()) else {
                self.emit_goal_status();
                return Ok(result);
            };
            // Budget hard-stop at the turn boundary (turn accounting already
            // ran inside `run_turn`), matching the TS driver's pre-turn check.
            if snapshot.budget.over_budget {
                if let Some(ref mut goal) = self.goal {
                    goal.mark_budget_limited(
                        Some("A configured budget was reached".to_string()),
                        GoalActor::System,
                    );
                }
                self.emit_goal_status();
                return Ok(result);
            }
            // A cancel that lands between turns pauses instead of silently
            // starting another continuation. (The per-turn reset in
            // `run_turn_with_origin` makes this boundary check load-bearing.)
            if self.cancellation.load(Ordering::Relaxed) {
                self.pause_goal("Paused after an interruption");
                return Ok(result);
            }
            // Continuation input, rendered from the canonical `continuation.md`
            // steering template (GOAL.md: Codex-derived, carrying the tuned
            // completion audit and the 3-turn blocked audit) — a system-
            // triggered input, not a lighter per-status reminder.
            let prompt = crate::goal::steering::render_continuation(
                &snapshot.objective,
                snapshot.tokens_used,
                snapshot.budget.token_budget,
            );
            result = match self
                .run_turn_with_origin(
                    vec![crate::context::types::ContentPart::Text { text: prompt }],
                    crate::context::types::MessageOrigin::SystemTrigger {
                        name: "goal_continuation".to_string(),
                    },
                )
                .await
            {
                Ok(result) => result,
                Err(error) => {
                    self.pause_goal("A runtime error interrupted the goal");
                    return Err(error);
                }
            };
        }
    }

    /// Pause a still-active goal (interrupt / runtime-error semantics). The
    /// paused record survives for a later `resume_goal`.
    fn pause_goal(&mut self, reason: &str) {
        if let Some(ref mut goal) = self.goal {
            let _ = goal.pause_active_goal(Some(reason.to_string()), GoalActor::System);
        }
        self.emit_goal_status();
    }

    /// Emit the current goal for thin clients: the full snapshot for
    /// rendering (null when no goal record exists — e.g. right after a
    /// completion cleared it) plus the bare status string for quick host
    /// diagnostics. Snapshot field names are the engine's serde form; the
    /// TS translator maps them onto the SDK `goal.updated` shape.
    fn emit_goal_status(&self) {
        let snapshot = self.goal.as_ref().and_then(|g| g.get_goal().goal);
        let status = snapshot
            .as_ref()
            .map(|s| format!("{:?}", s.status))
            .unwrap_or_else(|| "none".to_string());
        let snapshot_json = snapshot
            .as_ref()
            .and_then(|s| serde_json::to_value(s).ok())
            .unwrap_or(serde_json::Value::Null);
        self.callbacks.emit_event(serde_json::json!({
            "type": "session.goal.updated",
            "session_id": self.session_id,
            "snapshot": snapshot_json,
            "status": status,
        }));
    }

    // ── Session persistence ──

    /// The agent's durable state (context history + goal) as a JSON blob —
    /// the storage-agnostic half of `save_session`, so the SessionManager
    /// can embed it in its own record instead of writing a second one.
    pub fn durable_state(&self) -> serde_json::Value {
        serde_json::json!({
            "goal": self.goal.as_ref().and_then(|g| g.persisted_state()),
            "context": self.context.messages(),
        })
    }

    /// Restore state produced by `durable_state`. Applies the GOAL.md restart
    /// rule via `GoalMode::restore_persisted` (active → paused).
    pub fn restore_durable_state(&mut self, state: &serde_json::Value) {
        if let Some(messages) = state.get("context").and_then(|v| v.as_array()) {
            for value in messages {
                if let Ok(message) =
                    serde_json::from_value::<crate::context::types::ContextMessage>(value.clone())
                {
                    let _ = self.context.append_message(message);
                }
            }
        }
        if let Some(goal_value) = state.get("goal") {
            if !goal_value.is_null() {
                if let Some(ref mut goal) = self.goal {
                    goal.restore_persisted(goal_value);
                }
            }
        }
        self.emit_goal_status();
    }

    /// Persist the agent's durable state (context history + goal) into the
    /// session store under this agent's session id.
    pub fn save_session(
        &self,
        store: &crate::persistence::session_store::SessionStore,
    ) -> anyhow::Result<()> {
        let id = self.session_id.clone().unwrap_or_else(|| "default".to_string());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis().to_string())
            .unwrap_or_default();
        store.save_session(&crate::persistence::session_store::SessionRecord {
            id,
            created_at: now.clone(),
            updated_at: now,
            config_json: serde_json::json!({
                "cwd": self.config.cwd,
                "model": self.config.model_alias,
            }),
            state_json: self.durable_state(),
        })
    }

    /// Restore state saved by `save_session`. Returns false when no record
    /// exists. An `active` goal comes back `paused` (GOAL.md restart rule:
    /// the previous process's active turn cannot still be alive, so a
    /// restored session never auto-continues).
    pub fn load_session(
        &mut self,
        store: &crate::persistence::session_store::SessionStore,
        id: &str,
    ) -> anyhow::Result<bool> {
        let Some(record) = store.load_session(id)? else {
            return Ok(false);
        };
        if let Some(messages) = record.state_json.get("context").and_then(|v| v.as_array()) {
            for value in messages {
                if let Ok(message) =
                    serde_json::from_value::<crate::context::types::ContextMessage>(value.clone())
                {
                    let _ = self.context.append_message(message);
                }
            }
        }
        if let Some(goal_value) = record.state_json.get("goal") {
            if !goal_value.is_null() {
                if let Some(ref mut goal) = self.goal {
                    goal.restore_persisted(goal_value);
                }
            }
        }
        self.session_id = Some(id.to_string());
        self.emit_goal_status();
        Ok(true)
    }

    /// Cancel the current turn.
    pub fn cancel(&self) {
        self.cancellation.store(true, Ordering::Relaxed);
    }

    /// Check if the agent has an active turn.
    pub fn has_active_turn(&self) -> bool {
        self.has_active_turn
    }

    /// Set the system prompt.
    pub fn set_system_prompt(&mut self, prompt: String) {
        self.config.system_prompt = prompt;
    }

    /// Get the next turn ID.
    fn next_turn_id(&mut self) -> u32 {
        let id = self.turn_id_counter;
        self.turn_id_counter += 1;
        id
    }

    /// Build LoopHooks from the agent's hook system.
    fn build_loop_hooks(&self) -> Option<loop_types::LoopHooks> {
        let before_step = self.hooks.before_step.as_ref().map(|_| {
            let hooks = loop_types::LoopHooks::default();
            hooks
        });
        // For now, return None hooks if there are no custom hooks.
        // The JS side provides the real hook closures through the run_turn_override.
        if self.hooks.before_step.is_some() || self.hooks.after_step.is_some() {
            // Simplified: when we need to integrate with Rust hooks,
            // we wrap the closures here.
            None
        } else {
            None
        }
    }
}

/// Stamp the owning session id onto a streaming event so multi-session thin
/// clients can route the stream. Non-object events pass through unchanged.
fn stamp_session_id(
    mut event: serde_json::Value,
    session_id: &Option<String>,
) -> serde_json::Value {
    if let Some(object) = event.as_object_mut() {
        object.insert(
            "session_id".to_string(),
            serde_json::to_value(session_id).unwrap_or(serde_json::Value::Null),
        );
    }
    event
}

/// Project context messages onto the loop wire. Text parts concatenate into
/// `content`; image parts become blocks (text blocks ride along so mixed
/// messages keep their reading order); think parts are model-internal and
/// never resent; tool calls and tool-result linkage carry through
/// structurally so multi-step tool turns project faithfully.
fn messages_to_loop_messages(
    messages: &[crate::context::types::ContextMessage],
) -> Vec<loop_types::LLMMessage> {
    use crate::context::types::ContentPart;
    messages
        .iter()
        .map(|message| {
            let mut content = String::new();
            let mut blocks: Vec<crate::rpc::types::ContentBlock> = Vec::new();
            let mut has_media = false;
            let mut push_text = |content: &mut String, text: &str| {
                if !content.is_empty() {
                    content.push('\n');
                }
                content.push_str(text);
            };
            for part in &message.content {
                match part {
                    ContentPart::Text { text } => {
                        push_text(&mut content, text);
                        blocks.push(crate::rpc::types::ContentBlock::Text { text: text.clone() });
                    }
                    ContentPart::ImageUrl { image_url } => {
                        has_media = true;
                        blocks.push(crate::rpc::types::ContentBlock::ImageUrl {
                            url: image_url.url.clone(),
                        });
                    }
                    ContentPart::ToolResult { content: inner_parts, .. } => {
                        for inner in inner_parts {
                            if let ContentPart::Text { text } = inner {
                                push_text(&mut content, text);
                            }
                        }
                    }
                    // Think parts stay out of the wire; audio/video have no
                    // host-proxy projection and are represented by their
                    // surrounding text.
                    _ => {}
                }
            }
            loop_types::LLMMessage {
                role: message.role.clone(),
                content,
                blocks: if has_media { blocks } else { Vec::new() },
                tool_calls: message
                    .tool_calls
                    .iter()
                    .map(|tc| loop_types::ToolCall {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        arguments: tc.arguments.clone(),
                    })
                    .collect(),
                tool_call_id: message.tool_call_id.clone(),
                ..Default::default()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::goal::completion_verifier::{GoalVerifier, VerificationResult};
    use crate::goal::{GoalSnapshot, GoalStatus};

    fn goal_lock_with_active(objective: &str) -> std::sync::Mutex<Option<GoalMode>> {
        let mut goal = GoalMode::new();
        goal.create_goal(
            CreateGoalInput {
                objective: objective.to_string(),
                completion_criterion: None,
                replace: false,
            },
            GoalActor::User,
        )
        .expect("create goal");
        std::sync::Mutex::new(Some(goal))
    }

    fn update(lock: &std::sync::Mutex<Option<GoalMode>>, status: &str) -> ToolExecuteResponse {
        handle_goal_tool(
            "UpdateGoal".to_string(),
            serde_json::json!({ "status": status, "reason": "test" }),
            lock,
        )
        .expect("goal tool")
    }

    #[test]
    fn update_goal_complete_clears_the_record() {
        let lock = goal_lock_with_active("ship it");
        let response = update(&lock, "complete");
        assert!(!response.is_error, "{}", response.content);
        assert!(response.content.contains("Goal complete"));
        let cleared = lock.lock().unwrap().as_ref().unwrap().get_goal().goal.is_none();
        assert!(cleared, "complete must clear the goal record");
    }

    #[test]
    fn update_goal_blocked_stops_pursuit_and_records_the_streak() {
        let lock = goal_lock_with_active("ship it");
        let response = update(&lock, "blocked");
        assert!(!response.is_error, "{}", response.content);
        let guard = lock.lock().unwrap();
        let snapshot = guard.as_ref().unwrap().get_goal().goal.expect("record kept");
        assert!(matches!(snapshot.status, GoalStatus::Blocked));
        assert_eq!(snapshot.blocked_streak, Some(1));
    }

    #[test]
    fn update_goal_rejects_model_only_statuses() {
        // GOAL.md: the model may only set complete or blocked — active,
        // paused, and the budget states are runtime/user transitions.
        for status in ["active", "paused", "budgetLimited", "usageLimited", ""] {
            let lock = goal_lock_with_active("ship it");
            let response = update(&lock, status);
            assert!(response.is_error, "status {status:?} must be rejected");
            let still_active =
                lock.lock().unwrap().as_ref().unwrap().get_active_goal().is_some();
            assert!(still_active, "a rejected status must not disturb the goal");
        }
    }

    #[test]
    fn a_rejected_completion_keeps_the_goal_active() {
        struct RejectAll;
        impl GoalVerifier for RejectAll {
            fn verify(&self, _: &GoalSnapshot, _: &str) -> Result<VerificationResult, String> {
                Ok(VerificationResult { passed: false, feedback: "not proven".into() })
            }
        }
        let lock = goal_lock_with_active("ship it");
        lock.lock().unwrap().as_mut().unwrap().set_verifier(Box::new(RejectAll));
        let response = update(&lock, "complete");
        assert!(response.is_error);
        assert!(response.content.contains("NOT accepted"));
        let still_active = lock.lock().unwrap().as_ref().unwrap().get_active_goal().is_some();
        assert!(still_active, "a rejected completion must keep the goal active");
    }

    // ── Goal driver integration (run_prompt) ──────────────────────────

    /// Host stub: the goal interceptor answers the goal tools before any of
    /// these are reached, so every method is an explicit dead end.
    struct NoopHost;
    impl HostCallbacks for NoopHost {
        fn llm_chat(
            &self,
            _r: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            Box::pin(async { Err("llm_chat must not be reached".into()) })
        }
        fn execute_tool(
            &self,
            r: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            Box::pin(async move { Err(format!("unexpected host tool: {}", r.tool_name)) })
        }
        fn emit_event(&self, _e: serde_json::Value) {}
    }

    /// Scripted turn runner: per turn, drives one goal tool through the
    /// interceptor chain it receives, then ends the turn. This exercises the
    /// real `run_prompt` continuation loop end to end.
    struct ScriptedDriver {
        turn: std::sync::atomic::AtomicUsize,
        script: Vec<&'static str>,
    }
    impl AgentTurnOverride for ScriptedDriver {
        fn run_turn(
            &self,
            _input: crate::turn_loop::types::RunTurnInput,
            callbacks: &dyn HostCallbacks,
        ) -> crate::rpc::types::BoxFuture<
            'static,
            Result<crate::turn_loop::types::TurnResult, Box<dyn std::error::Error + Send + Sync>>,
        > {
            let index = self.turn.fetch_add(1, Ordering::SeqCst);
            let action = self.script.get(index).copied().unwrap_or("noop");
            let call = |name: &str, args: serde_json::Value| ToolExecuteRequest {
                turn_id: index.to_string(),
                tool_call_id: format!("c{index}"),
                tool_name: name.to_string(),
                arguments: args,
                force_precise: false,
            };
            let pending = match action {
                "create" => Some(callbacks.execute_tool(call(
                    "CreateGoal",
                    serde_json::json!({ "objective": "ship it" }),
                ))),
                "complete" => Some(callbacks.execute_tool(call(
                    "UpdateGoal",
                    serde_json::json!({ "status": "complete", "reason": "done" }),
                ))),
                "blocked" => Some(callbacks.execute_tool(call(
                    "UpdateGoal",
                    serde_json::json!({ "status": "blocked", "reason": "stuck" }),
                ))),
                _ => None,
            };
            Box::pin(async move {
                if let Some(pending) = pending {
                    pending.await.map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
                        Box::new(std::io::Error::other(e))
                    })?;
                }
                Ok(crate::turn_loop::types::TurnResult {
                    stop_reason: crate::turn_loop::types::LoopTurnStopReason::EndTurn,
                    steps: 1,
                    usage: crate::rpc::types::TokenUsage::default(),
                })
            })
        }
    }

    fn driver_agent(script: Vec<&'static str>) -> (Agent, Arc<ScriptedDriver>) {
        let driver = Arc::new(ScriptedDriver {
            turn: std::sync::atomic::AtomicUsize::new(0),
            script,
        });
        let agent = Agent::new(
            Arc::new(NoopHost),
            AgentOptions {
                goal_enabled: true,
                run_turn_override: Some(driver.clone()),
                ..AgentOptions::default()
            },
        );
        (agent, driver)
    }

    fn text_input(text: &str) -> Vec<crate::context::types::ContentPart> {
        vec![crate::context::types::ContentPart::Text { text: text.to_string() }]
    }

    fn turns_run(driver: &ScriptedDriver) -> usize {
        driver.turn.load(Ordering::SeqCst)
    }

    fn context_contains(agent: &Agent, needle: &str) -> bool {
        agent.context.messages().iter().any(|m| {
            m.content.iter().any(|part| {
                matches!(part, crate::context::types::ContentPart::Text { text } if text.contains(needle))
            })
        })
    }

    #[tokio::test]
    async fn the_driver_continues_until_the_model_completes_the_goal() {
        let (mut agent, driver) = driver_agent(vec!["create", "complete"]);
        let result = agent.run_prompt(text_input("do the thing")).await.expect("prompt");
        assert!(matches!(
            result.stop_reason,
            crate::turn_loop::types::LoopTurnStopReason::EndTurn
        ));
        assert_eq!(turns_run(&driver), 2, "one user turn + one continuation");
        // Complete cleared the record.
        assert!(agent.goal.as_ref().unwrap().get_goal().goal.is_none());
        // The continuation input came from the canonical continuation.md
        // template, audits included.
        assert!(context_contains(&agent, "Continue working toward the active thread goal"));
        assert!(context_contains(&agent, "The audit must prove completion"));
    }

    #[tokio::test]
    async fn the_driver_stops_when_the_model_marks_blocked() {
        let (mut agent, driver) = driver_agent(vec!["create", "blocked"]);
        agent.run_prompt(text_input("do the thing")).await.expect("prompt");
        assert_eq!(turns_run(&driver), 2);
        let snapshot = agent.goal.as_ref().unwrap().get_goal().goal.expect("record kept");
        assert!(matches!(snapshot.status, GoalStatus::Blocked));
    }

    #[tokio::test]
    async fn an_over_budget_goal_stops_at_the_boundary_as_budget_limited() {
        let (mut agent, driver) = driver_agent(vec!["noop"]);
        // Pre-created goal with a 1-turn budget: the single user turn consumes
        // it (increment_turn runs inside run_turn), so the driver must mark
        // budgetLimited at the boundary instead of running a continuation.
        {
            let goal = agent.goal.as_mut().unwrap();
            goal.create_goal(
                CreateGoalInput {
                    objective: "bounded".into(),
                    completion_criterion: None,
                    replace: false,
                },
                GoalActor::User,
            )
            .unwrap();
            goal.set_budget_limits(crate::goal::GoalBudgetLimits {
                token_budget: None,
                turn_budget: Some(1),
                wall_clock_budget_ms: None,
            })
            .unwrap();
        }
        agent.run_prompt(text_input("go")).await.expect("prompt");
        assert_eq!(turns_run(&driver), 1, "no continuation past the budget");
        let snapshot = agent.goal.as_ref().unwrap().get_goal().goal.expect("record kept");
        assert!(matches!(snapshot.status, GoalStatus::BudgetLimited));
    }

    #[test]
    fn streaming_events_are_stamped_with_the_session_id() {
        let stamped = stamp_session_id(
            serde_json::json!({ "type": "llm.delta", "part": { "type": "text", "text": "hi" } }),
            &Some("sess-9".to_string()),
        );
        assert_eq!(stamped["session_id"], "sess-9");
        assert_eq!(stamped["part"]["text"], "hi");
        // No session id → explicit null, and non-objects pass through.
        let anonymous = stamp_session_id(serde_json::json!({ "type": "llm.step.begin" }), &None);
        assert!(anonymous["session_id"].is_null());
        let scalar = stamp_session_id(serde_json::json!("raw"), &Some("s".into()));
        assert_eq!(scalar, serde_json::json!("raw"));
    }

    #[tokio::test]
    async fn a_session_roundtrip_restores_history_and_downgrades_the_active_goal() {
        let store = crate::persistence::session_store::SessionStore::new(
            crate::persistence::store::SqliteStore::in_memory().unwrap(),
        );

        // One turn that creates a goal (still active), then persist.
        let (mut agent, _driver) = driver_agent(vec!["create"]);
        agent.session_id = Some("sess-goal".into());
        agent.run_turn(text_input("do the thing")).await.expect("turn");
        assert!(agent.goal.as_ref().unwrap().get_active_goal().is_some());
        agent.save_session(&store).expect("save");

        // A fresh process: restore into a brand-new agent.
        let (mut revived, _driver2) = driver_agent(vec![]);
        assert!(revived.load_session(&store, "sess-goal").expect("load"));
        // GOAL.md restart rule: active comes back paused, resumable.
        let snapshot = revived.goal.as_ref().unwrap().get_goal().goal.expect("record kept");
        assert!(matches!(snapshot.status, GoalStatus::Paused));
        // History survived the roundtrip.
        assert!(context_contains(&revived, "do the thing"));
        // Unknown ids report absence instead of fabricating a session.
        assert!(!revived.load_session(&store, "missing").expect("load"));
    }
}