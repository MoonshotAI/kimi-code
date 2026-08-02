/// Agent — the core orchestration struct.
///
/// Corresponds to the `Agent` class in `packages/agent-core/src/agent/index.ts`.
///
/// The Agent owns all subsystems (turn flow, context, config, hooks) and
/// provides the main interface for running turns.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::agent::subagent::{run_child_agent, run_child_agent_with_model};
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

/// Forwards session task lifecycle onto the host event channel so thin
/// clients (web) can render task cards and progress without polling.
struct TaskEventDelegate {
    callbacks: Arc<dyn HostCallbacks>,
    session_id: Option<String>,
}

impl crate::task::TaskDelegate for TaskEventDelegate {
    fn on_task_started(&self, info: &crate::task::TaskInfoBase) {
        self.callbacks.emit_event(serde_json::json!({
            "type": "session.task.started",
            "session_id": self.session_id,
            "task_id": info.task_id,
            "description": info.description,
            "kind": info.kind,
            "started_at_ms": info.started_at,
        }));
    }
    fn on_task_terminated(&self, info: &crate::task::TaskInfoBase, _tail: Option<&str>) {
        self.callbacks.emit_event(serde_json::json!({
            "type": "session.task.terminated",
            "session_id": self.session_id,
            "task_id": info.task_id,
            "status": info.status.as_str(),
            "description": info.description,
            "kind": info.kind,
            "ended_at_ms": info.ended_at,
        }));
    }
}

/// Stamps the owning session id onto every host-bound request so a
/// multi-session thin client (kap-server, TUI) can route host callbacks
/// (llm_chat / execute_tool / prepare / authorize / finalize) back to the
/// session that issued them. Sits at the base of the interceptor chain —
/// only the raw host callbacks pass through it.
struct SessionStampingCallbacks {    inner: Arc<dyn HostCallbacks>,
    session_id: Option<String>,
}

impl SessionStampingCallbacks {
    fn new(inner: Arc<dyn HostCallbacks>, session_id: Option<String>) -> Arc<dyn HostCallbacks> {
        Arc::new(Self { inner, session_id })
    }
}

impl HostCallbacks for SessionStampingCallbacks {
    fn supports_tool_lifecycle(&self) -> bool { self.inner.supports_tool_lifecycle() }
    fn llm_chat(&self, mut r: LlmChatRequest) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
        r.session_id = self.session_id.clone();
        self.inner.llm_chat(r)
    }
    fn execute_tool(&self, mut req: ToolExecuteRequest) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        req.session_id = self.session_id.clone();
        self.inner.execute_tool(req)
    }
    fn emit_event(&self, e: serde_json::Value) { self.inner.emit_event(e); }
    fn prepare_tool_execution(&self, mut r: crate::rpc::types::PrepareToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::PrepareToolResponse>, String>> {
        r.session_id = self.session_id.clone();
        self.inner.prepare_tool_execution(r)
    }
    fn authorize_tool_execution(&self, mut r: crate::rpc::types::AuthorizeToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::AuthorizeToolResponse>, String>> {
        r.session_id = self.session_id.clone();
        self.inner.authorize_tool_execution(r)
    }
    fn finalize_tool_result(&self, mut r: crate::rpc::types::FinalizeToolRequest) -> BoxFuture<'static, Result<crate::rpc::types::FinalizeToolResponse, String>> {
        r.session_id = self.session_id.clone();
        self.inner.finalize_tool_result(r)
    }
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
                Ok(s) => Ok(ToolExecuteResponse { content: format!("Goal created: {}", s.objective), is_error: false, is_prediction: false, stop_turn: false, media: Vec::new() }),
                Err(e) => Ok(ToolExecuteResponse { content: format!("Failed: {e}"), is_error: true, is_prediction: false, stop_turn: false, media: Vec::new() }),
            }
        }
        "GoalStatus" => match goal_mode.get_active_goal() {
            Some(s) => Ok(ToolExecuteResponse { content: format!("Goal: {}\nStatus: {:?}\nTurns: {}", s.objective, s.status, s.turns_used), is_error: false, is_prediction: false, stop_turn: false, media: Vec::new() }),
            None => Ok(ToolExecuteResponse { content: "No active goal".to_string(), is_error: false, is_prediction: false, stop_turn: false, media: Vec::new() }),
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
                            is_error: false, is_prediction: false, stop_turn: false, media: Vec::new(),
                        }),
                        None if had_active => Ok(ToolExecuteResponse {
                            // The independent verifier rejected the claim (the
                            // rejection is recorded on the goal). Completion
                            // must be proven, not asserted.
                            content: "Completion was NOT accepted: the independent verification \
                                      rejected the claim. The goal stays active — continue working, \
                                      and only mark complete again with concrete evidence that every \
                                      requirement is satisfied.".to_string(),
                            is_error: true, is_prediction: false, stop_turn: false, media: Vec::new(),
                        }),
                        None => Ok(ToolExecuteResponse { content: "No active goal to complete".to_string(), is_error: true, is_prediction: false, stop_turn: false, media: Vec::new() }),
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
                            is_error: false, is_prediction: false, stop_turn: false, media: Vec::new(),
                        }),
                        None => Ok(ToolExecuteResponse { content: "No active goal to block".to_string(), is_error: true, is_prediction: false, stop_turn: false, media: Vec::new() }),
                    }
                }
                other => Ok(ToolExecuteResponse {
                    content: format!(
                        "UpdateGoal only accepts status \"complete\" or \"blocked\" (got \"{other}\"). \
                         Pausing and resuming are user actions."
                    ),
                    is_error: true, is_prediction: false, stop_turn: false, media: Vec::new(),
                }),
            }
        }
        _ => Err(format!("Unknown goal tool: {tool_name}")),
    }
}

pub fn goal_tool_definitions() -> Vec<loop_types::ToolInfo> {
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
            return Box::pin(async move { Ok(ToolExecuteResponse { content: c, is_error: false, is_prediction: false, stop_turn: false, media: Vec::new() }) });
        }
        self.inner.execute_tool(req)
    }
    fn emit_event(&self, e: serde_json::Value) { self.inner.emit_event(e); }
    fn prepare_tool_execution(&self, r: crate::rpc::types::PrepareToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::PrepareToolResponse>, String>> { self.inner.prepare_tool_execution(r) }
    fn authorize_tool_execution(&self, r: crate::rpc::types::AuthorizeToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::AuthorizeToolResponse>, String>> { self.inner.authorize_tool_execution(r) }
    fn finalize_tool_result(&self, r: crate::rpc::types::FinalizeToolRequest) -> BoxFuture<'static, Result<crate::rpc::types::FinalizeToolResponse, String>> { self.inner.finalize_tool_result(r) }
}

/// Intercepts the model-facing `Skill` tool and activates the skill natively
/// from the session's registry (populated at `session/create`), returning the
/// rendered skill prompt as the tool result — no host round-trip. Only added
/// to the chain when the session has skills; otherwise `Skill` falls to host.
pub(crate) struct SkillToolInterceptor {
    pub inner: Arc<dyn HostCallbacks>,
    pub registry: crate::skill::SkillRegistry,
}

impl HostCallbacks for SkillToolInterceptor {
    fn supports_tool_lifecycle(&self) -> bool { self.inner.supports_tool_lifecycle() }
    fn llm_chat(&self, r: LlmChatRequest) -> BoxFuture<'static, Result<LlmChatResponse, String>> { self.inner.llm_chat(r) }
    fn execute_tool(&self, req: ToolExecuteRequest) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        if req.tool_name == "Skill" {
            let registry = self.registry.clone();
            let name = req.arguments.get("skill").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let args = req.arguments.get("args").and_then(|v| v.as_str()).map(|s| s.to_string());
            return Box::pin(async move {
                let mut manager = crate::skill::SkillManager::new(registry);
                match manager.activate(crate::skill::ActivateSkillPayload { name, args }) {
                    Ok((_origin, prompt)) => Ok(ToolExecuteResponse {
                        content: prompt,
                        is_error: false,
                        is_prediction: false,
                        stop_turn: false,
                        media: Vec::new(),
                    }),
                    Err(e) => Ok(ToolExecuteResponse {
                        content: e,
                        is_error: true,
                        is_prediction: false,
                        stop_turn: false,
                        media: Vec::new(),
                    }),
                }
            });
        }
        self.inner.execute_tool(req)
    }
    fn emit_event(&self, e: serde_json::Value) { self.inner.emit_event(e); }
    fn prepare_tool_execution(&self, r: crate::rpc::types::PrepareToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::PrepareToolResponse>, String>> { self.inner.prepare_tool_execution(r) }
    fn authorize_tool_execution(&self, r: crate::rpc::types::AuthorizeToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::AuthorizeToolResponse>, String>> { self.inner.authorize_tool_execution(r) }
    fn finalize_tool_result(&self, r: crate::rpc::types::FinalizeToolRequest) -> BoxFuture<'static, Result<crate::rpc::types::FinalizeToolResponse, String>> { self.inner.finalize_tool_result(r) }
}

pub(crate) struct McpToolInterceptor { pub inner: Arc<dyn HostCallbacks>, pub mcp: std::sync::Arc<tokio::sync::Mutex<crate::mcp::runtime::McpRuntime>> }

/// Split an MCP tool result into a native tool response: text blocks become the
/// content, image blocks become `media` (delivered to the model as a follow-up
/// user image message) instead of the old `[Image: N bytes]` text placeholder.
pub(crate) fn mcp_result_to_tool_response(r: &crate::mcp::types::MCPToolCallResult) -> ToolExecuteResponse {
    use crate::mcp::types::MCPContentBlock;
    let mut text_parts: Vec<String> = Vec::new();
    let mut media: Vec<crate::rpc::types::ContentBlock> = Vec::new();
    for block in &r.content {
        match block {
            MCPContentBlock::Image { data, mime_type } => media.push(crate::rpc::types::ContentBlock::Image {
                media_type: mime_type.clone(),
                data: data.clone(),
            }),
            other => text_parts.push(crate::mcp::types::mcp_content_to_text(std::slice::from_ref(other))),
        }
    }
    ToolExecuteResponse {
        content: text_parts.join("\n"),
        is_error: r.is_error.unwrap_or(false),
        is_prediction: false,
        stop_turn: false,
        media,
    }
}

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
                m.call_tool(&n, Some(a)).await.map(|r| mcp_result_to_tool_response(&r))
            });
        }
        self.inner.execute_tool(req)
    }
    fn emit_event(&self, e: serde_json::Value) { self.inner.emit_event(e); }
    fn prepare_tool_execution(&self, r: crate::rpc::types::PrepareToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::PrepareToolResponse>, String>> { self.inner.prepare_tool_execution(r) }
    fn authorize_tool_execution(&self, r: crate::rpc::types::AuthorizeToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::AuthorizeToolResponse>, String>> { self.inner.authorize_tool_execution(r) }
    fn finalize_tool_result(&self, r: crate::rpc::types::FinalizeToolRequest) -> BoxFuture<'static, Result<crate::rpc::types::FinalizeToolResponse, String>> { self.inner.finalize_tool_result(r) }
}

/// Maximum subagent nesting depth (root = 0). A `Task` call at or beyond this
/// depth is refused rather than spawning another child.
pub(crate) const MAX_SUBAGENT_DEPTH: u32 = 2;

/// `/init` prompt (mirrors `profile/default/init.md`): a `coder` subagent
/// explores the project and writes `AGENTS.md` in the project root.
pub(crate) const DEFAULT_INIT_PROMPT: &str = "You are a software engineering expert with many years of programming experience. Please explore the current project directory to understand the project's architecture and main details.

Task requirements:
1. Analyze the project structure and identify key configuration files (such as pyproject.toml, package.json, Cargo.toml, etc.).
2. Understand the project's technology stack, build process and runtime architecture.
3. Identify how the code is organized and main module divisions.
4. Discover project-specific development conventions, testing strategies, and deployment processes.

After the exploration, do a thorough summary of your findings and write it to the `AGENTS.md` file in the project root, replacing the file's previous content. If the file already exists, read it first and carry forward whatever is still accurate — the result should be one coherent, up-to-date file, not an append.

For your information, `AGENTS.md` is a file intended to be read by AI coding agents. Expect the reader of this file to know nothing about the project.

You should compose this file according to the actual project content. Do not make any assumptions or generalizations. Ensure the information is accurate and useful. You must use the natural language that is mainly used in the project's comments and documentation.

Popular sections that people usually write in `AGENTS.md` are:

- Project overview
- Build and test commands
- Code style guidelines
- Testing instructions
- Security considerations";

/// A host-callbacks decorator that captures the latest `llm.step.end` content
/// (the assistant's final text for a step). Used to read a subagent's answer
/// without depending on context write-back, which the turn loop does not do.
pub(crate) struct CaptureCallbacks {
    pub(crate) inner: Arc<dyn HostCallbacks>,
    pub(crate) last_text: std::sync::Arc<std::sync::Mutex<String>>,
}

impl HostCallbacks for CaptureCallbacks {
    fn supports_tool_lifecycle(&self) -> bool { self.inner.supports_tool_lifecycle() }
    fn llm_chat(&self, r: LlmChatRequest) -> BoxFuture<'static, Result<LlmChatResponse, String>> { self.inner.llm_chat(r) }
    fn execute_tool(&self, r: ToolExecuteRequest) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> { self.inner.execute_tool(r) }
    fn emit_event(&self, e: serde_json::Value) {
        if e.get("type").and_then(|t| t.as_str()) == Some("llm.step.end") {
            if let Some(text) = e.get("content").and_then(|c| c.as_str()) {
                if !text.is_empty() {
                    *self.last_text.lock().unwrap_or_else(|p| p.into_inner()) = text.to_string();
                }
            }
        }
        self.inner.emit_event(e);
    }
    fn prepare_tool_execution(&self, r: crate::rpc::types::PrepareToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::PrepareToolResponse>, String>> { self.inner.prepare_tool_execution(r) }
    fn authorize_tool_execution(&self, r: crate::rpc::types::AuthorizeToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::AuthorizeToolResponse>, String>> { self.inner.authorize_tool_execution(r) }
    fn finalize_tool_result(&self, r: crate::rpc::types::FinalizeToolRequest) -> BoxFuture<'static, Result<crate::rpc::types::FinalizeToolResponse, String>> { self.inner.finalize_tool_result(r) }
}

/// Intercepts the `Task` tool and runs the subagent **natively** — it spawns a
/// child [`Agent`] that reuses the same host base callbacks, native-LLM
/// transport, and permission gate, drives it to completion, and returns the
/// child's final assistant text. No JS host subagent host is involved.
///
/// The child is single-shot (goal disabled, one `run_turn`) and depth-limited.
pub(crate) struct SubagentInterceptor {
    pub inner: Arc<dyn HostCallbacks>,
    /// Raw host callbacks handed to the child so its own native chain sits on
    /// top of the host (not on the parent's interceptor chain).
    pub host: Arc<dyn HostCallbacks>,
    pub homedir: Option<String>,
    pub native_llm: Option<crate::rpc::types::NativeLlmConfig>,
    /// Secondary-model config for subagent spawns (A12). A `Task` subagent
    /// whose `subagent_type` resolves to `model_preference: secondary` binds
    /// this model instead of inheriting the parent's.
    pub secondary_native_llm: Option<crate::rpc::types::NativeLlmConfig>,
    pub permission: crate::permission::gate::PermissionGate,
    pub system_prompt: String,
    pub max_steps_per_turn: u32,
    pub depth: u32,
    /// Shared swarm-mode state: while active, the `Agent` tool is denied.
    pub swarm: Arc<std::sync::Mutex<crate::swarm::SwarmMode>>,
    /// External lifecycle hooks (optional): SubagentStart/Stop fire around
    /// each child turn.
    pub hooks: Option<Arc<crate::hooks::external::HookManager>>,
    /// Agent-profile registry for custom-agent model preferences (A12).
    pub profile_registry: std::sync::Arc<
        std::sync::Mutex<crate::profile::registry::AgentProfileRegistry>,
    >,
    /// Session-wide task service: `Task` tool calls register a detached
    /// tracked task, append the child's result, and settle it — so subagent
    /// work is visible, persistent, and notifiable like any background task.
    pub task_service: Option<std::sync::Arc<std::sync::Mutex<crate::task::TaskService>>>,
}

impl HostCallbacks for SubagentInterceptor {
    fn supports_tool_lifecycle(&self) -> bool { self.inner.supports_tool_lifecycle() }
    fn llm_chat(&self, r: LlmChatRequest) -> BoxFuture<'static, Result<LlmChatResponse, String>> { self.inner.llm_chat(r) }
    fn execute_tool(&self, req: ToolExecuteRequest) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        if !req.tool_name.eq_ignore_ascii_case("task") {
            return self.inner.execute_tool(req);
        }
        // Swarm mode denies the single-agent `Task` tool outright — the model
        // must use AgentSwarm to dispatch subagents in parallel instead.
        if self
            .swarm
            .lock()
            .map(|sw| sw.is_active())
            .unwrap_or(false)
        {
            let message = crate::swarm::SwarmVetoMessages::default()
                .agent_denied_in_swarm_mode
                .clone();
            return Box::pin(async move {
                Ok(ToolExecuteResponse {
                    content: message,
                    is_error: true,
                    is_prediction: false,
                    stop_turn: false,
                    media: Vec::new(),
                })
            });
        }
        // Depth guard: never recurse past the cap.
        if self.depth >= MAX_SUBAGENT_DEPTH {
            return Box::pin(async move {
                Ok(ToolExecuteResponse {
                    content: "Subagent depth limit reached; run the work in the current agent.".into(),
                    is_error: true,
                    is_prediction: false,
                    stop_turn: false,
                    media: Vec::new(),
                })
            });
        }
        // The prompt is required; accept `prompt` or `description`.
        let prompt = req
            .arguments
            .get("prompt")
            .or_else(|| req.arguments.get("description"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        if prompt.trim().is_empty() {
            return Box::pin(async move {
                Ok(ToolExecuteResponse {
                    content: "Task requires a non-empty `prompt`.".into(),
                    is_error: true,
                    is_prediction: false,
                    stop_turn: false,
                    media: Vec::new(),
                })
            });
        }
        let subagent_type = req
            .arguments
            .get("subagent_type")
            .and_then(|v| v.as_str())
            .unwrap_or("general")
            .to_string();

        let host = self.host.clone();
        let homedir = self.homedir.clone();
        let native_llm = self.native_llm.clone();
        let permission = self.permission.clone();
        let parent_prompt = self.system_prompt.clone();
        let max_steps = self.max_steps_per_turn;
        let child_depth = self.depth + 1;
        let hooks = self.hooks.clone();
        // A12: resolve the sub-agent model preference — a custom agent file
        // (by type name) may declare `model_preference: secondary`, which
        // selects the configured secondary model when present; otherwise the
        // child inherits the parent model. The secondary-model config is
        // resolved from `[secondary_model]` / `KIMI_SECONDARY_MODEL` behind
        // the experimental gate (see `config/native_llm.rs`); when absent the
        // preference resolves to inheritance.
        let parent_model = self
            .native_llm
            .as_ref()
            .map(|c| c.model.clone())
            .unwrap_or_else(|| "default".to_string());
        let preference = {
            let registry = self.profile_registry.lock().unwrap_or_else(|e| e.into_inner());
            registry
                .catalog()
                .into_iter()
                .find(|def| def.name == subagent_type)
                .and_then(|def| def.model_preference)
                .map(|p| match p {
                    crate::profile::agent_file::ModelPreference::Primary => {
                        crate::agent::types::SubagentModelPreference::Primary
                    }
                    crate::profile::agent_file::ModelPreference::Secondary => {
                        crate::agent::types::SubagentModelPreference::Secondary
                    }
                })
                .unwrap_or(crate::agent::types::SubagentModelPreference::Primary)
        };
        let secondary_model = self
            .secondary_native_llm
            .as_ref()
            .map(|c| c.model.clone());
        let model_override = crate::agent::subagent::resolve_subagent_model(
            &parent_model,
            preference,
            secondary_model.as_deref(),
        );

        // Track the subagent as a detached task (TS `AgentBackgroundTask`
        // parity: kind `agent`, prefix `agent`, output appended on success).
        // The session-wide service is optional — a bare agent without one
        // simply skips tracking.
        let task_service = self.task_service.clone();
        let task_id = task_service.as_ref().and_then(|ts| {
            ts.lock()
                .unwrap_or_else(|e| e.into_inner())
                .track(crate::task::AgentTaskTrackOptions {
                    id_prefix: "agent".to_string(),
                    description: prompt.trim().chars().take(80).collect(),
                    kind: "agent".to_string(),
                    detached: true,
                    timeout_ms: None,
                    detach_timeout_ms: None,
                    agent_id: None,
                })
                .ok()
                .map(|entry| entry.task_id)
        });

        Box::pin(async move {
            match run_child_agent_with_model(
                host,
                homedir,
                native_llm,
                permission,
                &parent_prompt,
                max_steps,
                child_depth,
                &subagent_type,
                &prompt,
                hooks,
                model_override,
            )
            .await
            {
                Ok(text) => {
                    settle_task(&task_service, &task_id, false, None);
                    if let (Some(ts), Some(id)) = (&task_service, &task_id) {
                        let _ = ts
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .append_output(id, &text);
                    }
                    Ok(ToolExecuteResponse {
                        content: text,
                        is_error: false,
                        is_prediction: false,
                        stop_turn: false,
                        media: Vec::new(),
                    })
                }
                Err(e) => {
                    settle_task(&task_service, &task_id, true, Some(e.clone()));
                    Ok(ToolExecuteResponse {
                        content: e,
                        is_error: true,
                        is_prediction: false,
                        stop_turn: false,
                        media: Vec::new(),
                    })
                }
            }
        })
    }
    fn emit_event(&self, e: serde_json::Value) { self.inner.emit_event(e); }
    fn prepare_tool_execution(&self, r: crate::rpc::types::PrepareToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::PrepareToolResponse>, String>> { self.inner.prepare_tool_execution(r) }
    fn authorize_tool_execution(&self, r: crate::rpc::types::AuthorizeToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::AuthorizeToolResponse>, String>> { self.inner.authorize_tool_execution(r) }
    fn finalize_tool_result(&self, r: crate::rpc::types::FinalizeToolRequest) -> BoxFuture<'static, Result<crate::rpc::types::FinalizeToolResponse, String>> { self.inner.finalize_tool_result(r) }
}

/// Settle a tracked Task-tool task (no-op when tracking was skipped).
fn settle_task(
    task_service: &Option<std::sync::Arc<std::sync::Mutex<crate::task::TaskService>>>,
    task_id: &Option<String>,
    failed: bool,
    stop_reason: Option<String>,
) {
    if let (Some(ts), Some(id)) = (task_service, task_id) {
        ts.lock()
            .unwrap_or_else(|e| e.into_inner())
            .settle(
                id,
                crate::task::TaskSettlement {
                    status: if failed {
                        crate::task::TaskSettlementStatus::Failed
                    } else {
                        crate::task::TaskSettlementStatus::Completed
                    },
                    stop_reason,
                },
            );
    }
}

/// Concatenate the text of the last `assistant` message in an agent's context.
pub(crate) fn final_assistant_text(agent: &Agent) -> String {
    use crate::context::types::ContentPart;
    for message in agent.context.messages().iter().rev() {
        if message.role != "assistant" {
            continue;
        }
        let mut out = String::new();
        for part in &message.content {
            if let ContentPart::Text { text } = part {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(text);
            }
        }
        if !out.trim().is_empty() {
            return out.trim().to_string();
        }
    }
    String::new()
}

/// Snapshot of non-conversation state at a user-prompt turn boundary.
///
/// Taken before each real user turn runs, restored by `/undo` together
/// with the conversation history cut (upstream agent-core-v2 #2055).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct UndoCheckpoint {
    /// Plan-mode state at the boundary.
    pub plan_active: bool,
    pub plan_id: Option<String>,
    /// Task notification keys (scheduled, delivered) at the boundary.
    pub task_scheduled_notification_keys: Vec<String>,
    pub task_delivered_notification_keys: Vec<String>,
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
    /// Context memory (message history).
    pub context: ContextMemory,
    /// Non-conversation state snapshots taken at each real user-prompt turn
    /// boundary, restored on `/undo` (upstream #2055 participant rewind:
    /// todo / plan mode / task notifications rewind with the undone turns).
    pub undo_checkpoints: Vec<UndoCheckpoint>,
    /// Host callbacks (JS bridge).
    pub callbacks: Arc<dyn HostCallbacks>,
    /// Agent hooks (permission, injection, etc.).
    pub hooks: AgentHooks,
    /// Optional turn runner override.
    pub run_turn_override: Option<Arc<dyn AgentTurnOverride + Send + Sync>>,
    /// Cancellation flag for the current turn.
    pub cancellation: Arc<AtomicBool>,
    /// Steer queue: content parts pushed by `session/steer` (via a shared
    /// handle, so a push can land while a prompt is running). Drained at the
    /// start of each turn and injected as a user message, so steering redirects
    /// the next turn — including the next goal-continuation turn.
    pub steer_queue: Arc<std::sync::Mutex<Vec<crate::context::types::ContentPart>>>,
    /// Maximum steps per turn.
    pub max_steps_per_turn: u32,
    /// Maximum retries per step.
    pub max_retries_per_step: u32,
    /// Host-provided tool definitions, presented to the model alongside the
    /// engine's own tools; calls settle at the host via `execute_tool`.
    pub host_tools: Vec<loop_types::ToolInfo>,
    /// Session-scoped tool registry: user tools registered via
    /// `session/register_tool` (with per-tool disclosure) plus MCP tools.
    /// Projected into the model-visible list through `tool_defs_for`
    /// (upstream #2119 / #2196).
    pub tool_manager: std::sync::Arc<std::sync::Mutex<crate::tools::manager::ToolManager>>,
    /// Agent-profile registry (upstream #2366): aggregates agent-file roots
    /// (user/plugin/...) and projects the merged custom-agent catalog used
    /// for sub-agent model preferences and custom agent types.
    pub profile_registry: std::sync::Arc<std::sync::Mutex<crate::profile::registry::AgentProfileRegistry>>,
    /// Whether goal mode is enabled.
    pub goal_enabled: bool,
    /// Goal mode state machine (active goal lifecycle).
    pub goal: Option<GoalMode>,
    /// Reasoning effort applied from the next turn (`set_thinking`).
    /// Independent of the native-LLM transport: host-proxy sessions carry it
    /// too, and `session_status` reports it.
    pub thinking_effort: Option<String>,
    pub native_llm: Option<crate::rpc::types::NativeLlmConfig>,
    /// Secondary-model config for subagent spawns (A12). When a subagent's
    /// model preference resolves to `Secondary`, the child binds this model.
    pub secondary_native_llm: Option<crate::rpc::types::NativeLlmConfig>,
    pub mcp: std::sync::Arc<tokio::sync::Mutex<crate::mcp::runtime::McpRuntime>>,
    /// Total wall-clock milliseconds spent connecting MCP servers during
    /// `session/create` — the engine side of SDK `getMcpStartupMetrics`.
    pub mcp_startup_ms: u64,
    pub compaction: crate::compaction::FullCompaction,
    pub injector: crate::injection::InjectionManager,
    pub skill_manager: crate::skill::SkillManager,
    /// Native plan-mode state machine (id + plan-file tracking). Driven by
    /// `set_plan_mode`; read by `get_plan`, mutated by `clear_plan`.
    pub plan: crate::plan::PlanMode,
    pub knowledge: std::sync::Arc<crate::knowledge::KnowledgeService>,
    /// Native background-task manager: the standalone agent owns its whole
    /// process lifecycle (spawn/output/settle), no JS host involved.
    pub background: std::sync::Arc<std::sync::Mutex<crate::background::manager::BackgroundManager>>,
    /// File downloader for `kimi://file/<id>` media. Defaults to the noop
    /// placeholder; the standalone binary swaps in an HTTP downloader
    /// (`KIMI_FILE_BASE_URL`) so media materialises without a host round-trip.
    pub file_downloader: Arc<dyn crate::media::kimi_file_url::FileDownloader>,
    /// Native permission gate (mode from `KIMI_PERMISSION_MODE`). Lets the
    /// engine approve/deny tool calls locally; interactive `Ask` still defers
    /// to the host.
    pub permission: crate::permission::gate::PermissionGate,
    /// Nesting depth for subagents spawned via the native `Task` tool. The
    /// root agent is 0; each child increments it, and a hard cap stops
    /// runaway recursion.
    pub subagent_depth: u32,
    /// User-configured external lifecycle hooks (config.toml `[[hooks]]` +
    /// plugin contributions, host-resolved). Executed natively: PreToolUse /
    /// PostToolUse via the tool interceptor chain, UserPromptSubmit / Stop at
    /// the prompt boundary in `run_prompt`.
    pub external_hooks: Arc<crate::hooks::external::HookManager>,
    /// Swarm mode state machine (`session/set_swarm_mode`): tracks the mode
    /// and applies the enter/exit reminders to the context. One-shot triggers
    /// (`task`/`tool`) auto-exit after the turn in `run_prompt`.
    pub swarm: crate::swarm::SwarmMode,
    /// Cumulative token usage per model (`session/get_status`). Fed at the
    /// end of every turn from the loop's usage tally.
    pub usage: crate::usage::UsageRecorder,
    /// Additional directories the session is allowed to access (beyond cwd).
    /// Populated via `session/add_additional_dir`; applied to the toolset
    /// sandbox at each turn.
    pub additional_dirs: Vec<String>,
    /// Session-wide task service: tracks detached/background agent tasks with
    /// persistence and terminal notifications. Session-wide when injected via
    /// `AgentOptions.task`, else agent-owned.
    pub task: std::sync::Arc<std::sync::Mutex<crate::task::TaskService>>,
    /// Pending-approval store: deferred tool approvals register here so web
    /// hosts can list and resolve them (`session/approval_list` /
    /// `session/approval_resolve`).
    pub approval: crate::approval::SharedApprovalStore,
    /// Host-owned custom metadata (shallow-merged via `session/update_metadata`).
    /// Persisted as part of agent_state on save.
    pub metadata: serde_json::Value,
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
        // Stamp every host-bound request (llm_chat / execute_tool / lifecycle
        // hooks) with this agent's session id so multi-session thin clients
        // can route callbacks back to the right session.
        let callbacks = SessionStampingCallbacks::new(callbacks, options.session_id.clone());
        let task_event_callbacks = callbacks.clone();
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
            context: ContextMemory::new(),
            callbacks,
            hooks: AgentHooks::default(),
            run_turn_override: options.run_turn_override,
            cancellation: Arc::new(AtomicBool::new(false)),
            steer_queue: Arc::new(std::sync::Mutex::new(Vec::new())),
            max_steps_per_turn: options.max_steps_per_turn,
            max_retries_per_step: options.max_retries_per_step,
            host_tools: options.host_tools.clone(),
            tool_manager: std::sync::Arc::new(std::sync::Mutex::new(
                crate::tools::manager::ToolManager::new(),
            )),
            profile_registry: std::sync::Arc::new(std::sync::Mutex::new(
                crate::profile::registry::AgentProfileRegistry::new(),
            )),
            goal_enabled: options.goal_enabled,
            goal: if options.goal_enabled { Some(GoalMode::new()) } else { None },
            thinking_effort: options
                .native_llm
                .as_ref()
                .and_then(|c| c.reasoning_effort.clone()),
            native_llm: options.native_llm.clone(),
            secondary_native_llm: options.secondary_native_llm.clone(),
            mcp: std::sync::Arc::new(tokio::sync::Mutex::new(
                crate::mcp::runtime::McpRuntime::new(false, options.homedir.clone(), None)
            )),
            mcp_startup_ms: 0,
            compaction: crate::compaction::FullCompaction::new(
                crate::compaction::CompactionConfig::default(), Default::default()
            ),
            injector: crate::injection::InjectionManager::new(true),
            skill_manager: crate::skill::SkillManager::new(crate::skill::SkillRegistry::new()),
            plan: {
                let mut pm = crate::plan::PlanMode::new(Box::new(crate::plan::FsKaos));
                if let Some(ref home) = options.homedir {
                    pm.set_config(crate::plan::PlanConfig {
                        plan_dir: format!("{home}/plan"),
                    });
                }
                pm
            },
            knowledge: std::sync::Arc::new(crate::knowledge::KnowledgeService::new()),
            background: std::sync::Arc::new(std::sync::Mutex::new(
                crate::background::manager::BackgroundManager::new(None),
            )),
            file_downloader: match crate::media::http_downloader::from_env() {
                Some(http) => Arc::new(http),
                None => Arc::new(crate::media::kimi_file_url::NoopFileDownloader),
            },
            permission: options.permission.clone()
                .unwrap_or_else(crate::permission::gate::PermissionGate::from_env),
            subagent_depth: 0,
            external_hooks: Arc::new(crate::hooks::external::HookManager::new(
                options.external_hooks,
            )),
            swarm: crate::swarm::SwarmMode::new(),
            usage: crate::usage::UsageRecorder::new(),
            additional_dirs: Vec::new(),
            task: {
                let service = options.task.clone().unwrap_or_else(|| {
                    std::sync::Arc::new(std::sync::Mutex::new(crate::task::TaskService::new(
                        crate::task::TaskServiceConfig::default(),
                    )))
                });
                // Forward task lifecycle onto the host event channel so thin
                // clients (web) can render task cards without polling.
                service
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .set_delegate(Box::new(TaskEventDelegate {
                        callbacks: task_event_callbacks.clone(),
                        session_id: options.session_id.clone(),
                    }));
                service
            },
            approval: options.approval.clone().unwrap_or_default(),
            metadata: serde_json::json!({}),
            undo_checkpoints: Vec::new(),
            turn_id_counter: 0,
            has_active_turn: false,
        }
    }

    /// Switch the model used from the next turn onward. Updates the config
    /// alias and, in native-LLM mode, the transport's `model` field (which is
    /// rebuilt from `self.native_llm` each turn, so the change takes effect on
    /// the next `run_turn`/`run_prompt`). No effect on an in-flight turn.
    pub fn set_model(&mut self, model: String) {
        self.config.model_alias = Some(model.clone());
        self.config.has_model = true;
        if let Some(ref mut cfg) = self.native_llm {
            cfg.model = model;
        }
    }

    /// Run a user-initiated `!` shell command natively (silent — no model
    /// involvement), returning the combined stdout/stderr and an error flag.
    /// Executes in the session's workspace via the native `BashRunner`; `None`
    /// when no shell is available (the host owns the `!` command then).
    pub async fn run_shell(&self, command: &str, timeout_s: Option<u64>) -> Option<(String, bool)> {
        let runner = crate::tools::bash::BashRunner::detect()?;
        let cwd = std::path::Path::new(&self.config.cwd);
        let result = runner.run(command, cwd, timeout_s).await;
        Some((result.content, result.is_error))
    }

    /// `/init` parity (SDK `Session.init` → `generateAgentsMd`): spawn a
    /// `coder` subagent with the default init prompt to explore the project
    /// and write `AGENTS.md`, then inject the completion reminder into the
    /// context (variant `init`). The subagent's native Read/Write tools do the
    /// exploration and file write; the parent's context is updated so the next
    /// turn sees the fresh AGENTS.md content.
    pub async fn init_agents_md(&mut self) -> Result<(), String> {
        let hooks = if self.external_hooks.is_empty() {
            None
        } else {
            Some(self.external_hooks.clone())
        };
        let text = run_child_agent(
            self.callbacks.clone(),
            self.homedir.clone(),
            self.native_llm.clone(),
            self.permission.clone(),
            &self.config.system_prompt,
            self.max_steps_per_turn,
            self.subagent_depth + 1,
            "coder",
            DEFAULT_INIT_PROMPT,
            hooks,
        )
        .await?;
        // Best-effort read of the produced file (the child wrote it in cwd).
        let agents_md =
            std::fs::read_to_string(std::path::Path::new(&self.config.cwd).join("AGENTS.md"))
                .unwrap_or_default();
        let latest = if agents_md.trim().is_empty() {
            "No AGENTS.md content was found after `/init` completed.".to_string()
        } else {
            agents_md
        };
        let reminder = format!(
            "The user just ran `/init` slash command.\n\
             The system has analyzed the codebase and generated an `AGENTS.md` file.\n\n\
             Latest AGENTS.md file content:\n{latest}"
        );
        let _ = text;
        self.context.append_system_reminder(
            &reminder,
            crate::context::types::MessageOrigin::Injection {
                variant: "init".into(),
            },
        );
        Ok(())
    }

    /// Fire a session-level lifecycle hook (SessionStart / Interrupt etc.)
    /// with the given input payload. No-op when no hook of that event is
    /// registered. Non-blocking by design — callers never branch on it.
    pub async fn fire_lifecycle_hook(
        &self,
        event: crate::hooks::external::HookEventType,
        input: serde_json::Value,
    ) {
        if self.external_hooks.is_empty() || !self.external_hooks.has_hooks_for(event) {
            return;
        }
        self.external_hooks.run_all(event, None, &input).await;
    }

    /// Set the reasoning effort (`"low"|"medium"|"high"`, or `None` to clear)
    /// from the next turn onward. All three native-LLM protocols map this:
    /// - OpenAI: `reasoning_effort` field directly.
    /// - Anthropic: `thinking.budget_tokens` (low=1024, medium=4096, high=32k).
    /// - Google: `generationConfig.thinkingConfig.thinkingBudget` (low=1024,
    ///   medium=4096, high=16k).
    pub fn set_thinking(&mut self, effort: Option<String>) {
        if let Some(ref mut cfg) = self.native_llm {
            cfg.reasoning_effort = effort.clone();
        }
        self.thinking_effort = effort;
    }

    /// Add an additional directory to the session's workspace allowlist.
    /// The directory is applied to the toolset sandbox from the next turn.
    /// Returns `false` if the path is not a valid directory.
    pub fn add_additional_dir(&mut self, dir: String) -> bool {
        // Validate early: canonicalize to confirm it exists and is a dir.
        let canonical = match std::fs::canonicalize(&dir) {
            Ok(p) if p.is_dir() => p.to_string_lossy().to_string(),
            _ => return false,
        };
        if !self.additional_dirs.contains(&canonical) {
            self.additional_dirs.push(canonical);
        }
        true
    }

    /// Remove a previously added additional directory. Returns `false` if it
    /// was not in the list.
    pub fn remove_additional_dir(&mut self, dir: &str) -> bool {
        let canonical = match std::fs::canonicalize(dir) {
            Ok(p) => p.to_string_lossy().to_string(),
            Err(_) => return false,
        };
        let before = self.additional_dirs.len();
        self.additional_dirs.retain(|d| *d != canonical);
        self.additional_dirs.len() < before
    }

    /// The current list of additional directories.
    pub fn additional_dirs(&self) -> &[String] {
        &self.additional_dirs
    }

    /// Shallow-merge a JSON object into the session's custom metadata.
    /// Panics if `patch` is not a JSON object (the RPC layer validates this).
    pub fn update_metadata(&mut self, patch: serde_json::Value) {
        if let (Some(base), Some(patch_obj)) = (self.metadata.as_object_mut(), patch.as_object()) {
            for (k, v) in patch_obj {
                base.insert(k.clone(), v.clone());
            }
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
        let is_user_origin = matches!(&origin, crate::context::types::MessageOrigin::User);
        self.context.append_user_message(&input, origin);

        // Record a state checkpoint at real user-prompt boundaries so `/undo`
        // can rewind plan mode and task notifications along with the history
        // (upstream #2055). Goal continuations and other system-triggered
        // turns use non-User origins and are transparent to undo.
        if is_user_origin {
            let (plan_active, plan_id) = self.plan.snapshot();
            let task = self.task.clone();
            let (scheduled, delivered) = {
                let guard = task.lock().unwrap_or_else(|e| e.into_inner());
                guard.notifications_snapshot()
            };
            self.undo_checkpoints.push(UndoCheckpoint {
                plan_active,
                plan_id,
                task_scheduled_notification_keys: scheduled,
                task_delivered_notification_keys: delivered,
            });
        }

        // Drain any steer input queued via `session/steer` (possibly while a
        // previous turn was still running) and append it as a real user
        // message, so steering redirects this turn. Empty → no-op.
        let steered: Vec<crate::context::types::ContentPart> = {
            let mut q = self.steer_queue.lock().unwrap_or_else(|e| e.into_inner());
            std::mem::take(&mut *q)
        };
        if !steered.is_empty() {
            self.context.append_user_message(&steered, crate::context::types::MessageOrigin::User);
        }

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
            .map(|mut ts| {
                // Apply session-level additional directories to the sandbox.
                for dir in &self.additional_dirs {
                    ts.add_additional_dir(dir);
                }
                ts.with_shell()
            });
        let mut callbacks: Arc<dyn HostCallbacks> = if let Some(ref ts) = toolset {
            Arc::new(NativeToolCallbacks {
                inner: self.callbacks.clone(),
                toolset: Arc::new(ts.clone()),
                background: Some(self.background.clone()),
                permission: Some(self.permission.clone()),
                hooks: if self.external_hooks.is_empty() {
                    None
                } else {
                    Some(self.external_hooks.clone())
                },
                approval: Some(self.approval.clone()),
            })
        } else {
            self.callbacks.clone()
        };
        // Knowledge interceptor (SearchKnowledge).
        let k = self.knowledge.clone();
        callbacks = Arc::new(KnowledgeInterceptor { inner: callbacks, knowledge: k });
        // MCP interceptor (mcp__* tools).
        let m = self.mcp.clone();
        callbacks = Arc::new(McpToolInterceptor { inner: callbacks, mcp: m });
        // Skill interceptor (native `Skill` activation) — only when the session
        // registered skills; otherwise the host keeps its Skill tool.
        if !self.skill_manager.registry.is_empty() {
            callbacks = Arc::new(SkillToolInterceptor {
                inner: callbacks,
                registry: self.skill_manager.registry.clone(),
            });
        }
        // Subagent interceptor (native `Task`): spawns a child Agent on the
        // host base callbacks, depth-limited. Below the depth cap only.
        if self.subagent_depth < MAX_SUBAGENT_DEPTH {
            callbacks = Arc::new(SubagentInterceptor {
                inner: callbacks,
                host: self.callbacks.clone(),
                homedir: self.homedir.clone(),
                native_llm: self.native_llm.clone(),
                secondary_native_llm: self.secondary_native_llm.clone(),
                permission: self.permission.clone(),
                system_prompt: self.config.system_prompt.clone(),
                max_steps_per_turn: self.max_steps_per_turn,
                depth: self.subagent_depth,
                swarm: Arc::new(std::sync::Mutex::new(self.swarm.clone())),
                hooks: if self.external_hooks.is_empty() {
                    None
                } else {
                    Some(self.external_hooks.clone())
                },
                profile_registry: self.profile_registry.clone(),
                task_service: Some(self.task.clone()),
            });
        }
        // AgentSwarm interceptor (native parallel subagent dispatch): spawns
        // one child per item concurrently and renders the `<agent_swarm_result>`
        // summary. Enters swarm mode on tool use (one-shot `tool` trigger).
        if self.subagent_depth < MAX_SUBAGENT_DEPTH {
            callbacks = Arc::new(crate::agent::swarm_tool::SwarmToolInterceptor {
                inner: callbacks,
                host: self.callbacks.clone(),
                homedir: self.homedir.clone(),
                native_llm: self.native_llm.clone(),
                secondary_native_llm: self.secondary_native_llm.clone(),
                profile_registry: self.profile_registry.clone(),
                permission: self.permission.clone(),
                system_prompt: self.config.system_prompt.clone(),
                max_steps_per_turn: self.max_steps_per_turn,
                depth: self.subagent_depth,
                swarm: Arc::new(std::sync::Mutex::new(self.swarm.clone())),
                hooks: if self.external_hooks.is_empty() {
                    None
                } else {
                    Some(self.external_hooks.clone())
                },
            });
        }
        // SwarmDiscussion interceptor (native roundtable/debate): drives the
        // discussion coordinators with per-turn child agents and renders the
        // `<discussion_result>` / `<debate_result>` summary.
        if self.subagent_depth < MAX_SUBAGENT_DEPTH {
            callbacks = Arc::new(crate::agent::discussion_tool::DiscussionToolInterceptor {
                inner: callbacks,
                host: self.callbacks.clone(),
                homedir: self.homedir.clone(),
                native_llm: self.native_llm.clone(),
                permission: self.permission.clone(),
                system_prompt: self.config.system_prompt.clone(),
                max_steps_per_turn: self.max_steps_per_turn,
                depth: self.subagent_depth,
                swarm: Arc::new(std::sync::Mutex::new(self.swarm.clone())),
                hooks: if self.external_hooks.is_empty() {
                    None
                } else {
                    Some(self.external_hooks.clone())
                },
            });
        }
        // Memory interceptor (native `Memory` tool): persistent memory
        // search/read/write/list/delete over the home-dir markdown store.
        {
            let homedir = self.homedir.clone().unwrap_or_default();
            let session_id = self.session_id.clone();
            callbacks = Arc::new(crate::memory::tool::MemoryToolInterceptor {
                inner: callbacks,
                store: crate::memory::store::MemoryStore::new(
                    if homedir.is_empty() { "." } else { &homedir },
                ),
                session_id,
            });
        }
        // Intercept goal tools locally.
        let goal_interceptor = Arc::new(GoalToolInterceptor::new(callbacks));
        let goal_temp = self.goal.take();
        goal_interceptor.bind_goal(goal_temp);
        callbacks = goal_interceptor.clone();
        // External lifecycle hooks (PreToolUse veto / PostToolUse notify):
        // wraps the whole execution chain so every tool — native, MCP, goal,
        // host — passes the user's hooks. Inside ToolEventInterceptor so a
        // vetoed call still renders as a failed tool card.
        if !self.external_hooks.is_empty() {
            callbacks = Arc::new(crate::hooks::interceptor::ExternalHooksInterceptor {
                inner: callbacks,
                manager: self.external_hooks.clone(),
                session_id: self.session_id.clone().unwrap_or_default(),
                cwd: self.config.cwd.clone(),
            });
        }
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
        // Session-registered user tools (upstream #2119/#2196): inline tools
        // carry their full schema; deferred tools are withheld from the main
        // list — the model has no dynamic-loading capability on this path
        // (the experiment is off, matching the #2449 default), so they are
        // hidden rather than announce-only. MCP tools stay on the separate
        // `self.mcp` assembly below.
        if let Ok(tm) = self.tool_manager.lock() {
            tool_defs.extend(tm.tool_defs_for(false));
        }
        // Native `Task` (subagent) — advertised only below the depth cap so
        // leaf subagents cannot spawn further children.
        if self.subagent_depth < MAX_SUBAGENT_DEPTH {
            tool_defs.push(loop_types::ToolInfo {
                name: "Task".into(),
                description: "Delegate a self-contained task to a subagent and get its final answer.".into(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "subagent_type": { "type": "string" },
                        "prompt": { "type": "string" }
                    },
                    "required": ["prompt"]
                }),
            });
            // Native `AgentSwarm` (parallel subagent dispatch). Always
            // advertised; its veto rules (one swarm per batch, no `Agent`
            // while swarm mode is active) are enforced at execution.
            tool_defs.push(loop_types::ToolInfo {
                name: crate::swarm::AGENT_SWARM_TOOL_NAME.into(),
                description: "Dispatch multiple subagents in parallel to work on distinct items of one topic, then summarize the combined result.".into(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "description": { "type": "string", "description": "Short description for the whole swarm." },
                        "subagent_type": { "type": "string", "description": "Subagent type for every spawned subagent; defaults to coder." },
                        "prompt_template": { "type": "string", "description": "Prompt template for each subagent; the {{item}} placeholder is replaced with each item value." },
                        "items": { "type": "array", "items": { "type": "string" }, "description": "Values filling {{item}}; each launches one subagent. At least 2 items." }
                    },
                    "required": ["description", "prompt_template", "items"]
                }),
            });
            // Native `SwarmDiscussion` (roundtable / structured debate).
            tool_defs.push(loop_types::ToolInfo {
                name: "SwarmDiscussion".into(),
                description: "Orchestrate a multi-agent roundtable discussion or structured debate on a topic, then return the transcript and consensus.".into(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "mode": { "type": "string", "enum": ["discussion", "debate"], "description": "\"discussion\" for open roundtable, \"debate\" for structured debate." },
                        "topic": { "type": "string", "description": "The topic or question to discuss/debate." },
                        "participants": {
                            "type": "array",
                            "minItems": 2,
                            "maxItems": 10,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "profileName": { "type": "string", "description": "Agent profile name, e.g. coder or explore." },
                                    "roleDescription": { "type": "string", "description": "Role description for this participant." },
                                    "assignedStance": { "type": "string", "description": "Optional assigned stance (debate)." }
                                },
                                "required": ["roleDescription"]
                            }
                        },
                        "maxRounds": { "type": "integer", "description": "Max discussion rounds / free-debate rounds." },
                        "summaryPrompt": { "type": "string", "description": "Optional prompt for a final summary or consensus." },
                        "enableVoting": { "type": "boolean", "description": "Debate only: include a voting phase." }
                    },
                    "required": ["topic", "participants"]
                }),
            });
        }
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
        // Persistent memory tool (search/read/write/list/delete across scopes).
        tool_defs.push(loop_types::ToolInfo {
            name: "Memory".into(),
            description: "Persistent memory: search, read, write, list, and delete memory entries that persist across sessions (scopes: global, project, session).".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["search", "read", "write", "list", "delete"], "description": "The memory operation to perform." },
                    "query": { "type": "string", "description": "Search query (for search)." },
                    "path": { "type": "string", "description": "Memory file path or filename (for read/write/delete)." },
                    "scope": { "type": "string", "enum": ["global", "project", "session"], "description": "Memory scope (for write, list). Defaults to project." },
                    "content": { "type": "string", "description": "Markdown content (for write)." }
                }
            }),
        });
        // Host-registered tools (session surface): presented to the model,
        // executed at the host. Engine-side names win on collision.
        for host_tool in &self.host_tools {
            if !tool_defs.iter().any(|td| td.name == host_tool.name) {
                tool_defs.push(host_tool.clone());
            }
        }

        // ── Compaction ──
        // Auto-compact at the turn boundary when pressure warrants it. Uses
        // the real tokenizer tally (not a message-count guess) and, unlike the
        // old inline call, applies the summary back to the context. A missing
        // summarizer (host-proxy mode, no native LLM) or a delegate error is
        // non-fatal — the turn proceeds on the uncompacted history.
        if self.compaction.should_compact(self.context.token_count_with_pending()) {
            let _ = self.run_compaction(crate::compaction::CompactionSource::Auto, None).await;
        }
        // ── Turn-boundary injection (system reminders) ──
        // InjectionManager appends its reminders into the context directly;
        // snapshot the messages only afterwards so the loop input includes
        // both the injected reminders and any compaction rewrite above.
        let _ = self.injector.inject_with_tracking(&mut self.context);
        let messages = self.context.messages();

        // Materialise `kimi://file/<id>` media before projection: providers
        // cannot resolve the custom scheme, so download each referenced file
        // once and inline it as base64. Failures leave the URL untouched (the
        // provider surfaces the error) rather than silently dropping content.
        let materialized_media = self.materialize_kimi_media(&messages).await;

        let loop_hooks = self.build_loop_hooks();

        let run_turn_input = loop_types::RunTurnInput {
            turn_id: turn_id.to_string(),
            llm: &*llm,
            messages: messages_to_loop_messages(&messages, &materialized_media),
            tools: &[],
            // The assembled table (native + goal + MCP + knowledge + host):
            // this is what the model actually sees. It was previously
            // dropped (`vec![]`), leaving the model blind to every tool.
            tool_defs,
            hooks: loop_hooks.as_ref(),
            max_steps: self.max_steps_per_turn,
            goal: None,
            cancellation: Some(self.cancellation.clone()),
            // Step-boundary steer: mid-turn steers redirect the next step.
            steer_queue: Some(self.steer_queue.clone()),
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

        // Persist the assistant side of the turn: the loop reports the messages
        // it appended this turn (assistant replies, tool results, tool-media
        // follow-ups) in `new_messages`; write them back so multi-turn history,
        // persistence, and compaction all see the assistant side — not just the
        // user input. The RUN_TURN override path returns none (the TS host owns
        // that transcript), so this is a no-op there.
        for message in &result.new_messages {
            if let Some(ctx_message) = loop_message_to_context_message(message) {
                let _ = self.context.append_message(ctx_message);
            }
        }

        // Restore goal from interceptor and update bookkeeping.
        self.goal = goal_interceptor.take_goal();
        if let Some(ref mut goal) = self.goal {
            goal.increment_turn();
            goal.record_token_usage(result.usage.total_tokens.max(0) as u64);
        }

        // Accumulate session usage under the active model alias so
        // `session/get_status` reports real cumulative numbers.
        let usage_model = self
            .config
            .model_alias
            .clone()
            .or_else(|| self.native_llm.as_ref().map(|c| c.model.clone()))
            .unwrap_or_else(|| "unknown".to_string());
        self.usage
            .record(&usage_model, &result.usage, crate::usage::UsageRecordScope::Session);

        self.callbacks.emit_event(serde_json::json!({
            "type": "session.usage.updated",
            "session_id": self.session_id,
            "turn_id": turn_id,
            "input_tokens": result.usage.input_tokens,
            "output_tokens": result.usage.output_tokens,
            "total_tokens": result.usage.total_tokens,
        }));

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
            hit_step_cap: result.hit_step_cap,
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
        // UserPromptSubmit hooks: a block stops the prompt before any turn
        // runs; non-blocking hook output has already been appended to the
        // context as extra user input (TS parity).
        if let Some(block_text) = self.run_user_prompt_submit_hooks(&input).await {
            // Record the prompt and the block verdict so the transcript
            // explains why nothing ran.
            self.context
                .append_user_message(&input, crate::context::types::MessageOrigin::User);
            self.context.append_message(crate::context::types::ContextMessage {
                role: "assistant".to_string(),
                content: vec![crate::context::types::ContentPart::Text { text: block_text.clone() }],
                tool_calls: vec![],
                origin: Some(crate::context::types::MessageOrigin::HookResult {
                    event: "UserPromptSubmit".to_string(),
                    blocked: Some(true),
                }),
                ..Default::default()
            });
            self.callbacks.emit_event(serde_json::json!({
                "type": "session.hook.result",
                "session_id": self.session_id,
                "hook_event": "UserPromptSubmit",
                "content": block_text,
                "blocked": true,
            }));
            return Ok(TurnResult {
                stop_reason: crate::turn_loop::types::LoopTurnStopReason::EndTurn,
                steps: 0,
                usage: crate::rpc::types::TokenUsage::default(),
                hit_step_cap: false,
            });
        }

        let mut result = match self.run_turn(input).await {
            Ok(result) => result,
            Err(error) => {
                self.pause_goal("A runtime error interrupted the goal");
                return Err(error);
            }
        };
        // One stop-hook continuation per prompt (TS: once per turn).
        let mut stop_hook_continuation_used = false;
        loop {
            if matches!(result.stop_reason, crate::turn_loop::types::LoopTurnStopReason::Aborted) {
                self.pause_goal("Paused after an interruption");
                self.maybe_auto_exit_swarm();
                // A22 (upstream #2400): remind the model that the previous
                // turn was deliberately interrupted by the user, appended at
                // most once (dedup on the `interruption` injection variant).
                self.append_interruption_reminder_once();
                return Ok(result);
            }
            // Only a still-active goal continues; complete clears the record,
            // blocked/paused/budgetLimited stop autonomous pursuit.
            let Some(snapshot) = self.goal.as_ref().and_then(|g| g.get_active_goal()) else {
                // Stop hooks fire on the normal completion boundary: a block
                // injects its reason as input and drives one more turn.
                if !stop_hook_continuation_used {
                    if let Some(reason) = self.run_stop_hooks().await {
                        stop_hook_continuation_used = true;
                        result = match self
                            .run_turn_with_origin(
                                vec![crate::context::types::ContentPart::Text { text: reason }],
                                crate::context::types::MessageOrigin::SystemTrigger {
                                    name: "stop_hook".to_string(),
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
                        continue;
                    }
                }
                self.emit_goal_status();
                self.maybe_auto_exit_swarm();
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
                self.maybe_auto_exit_swarm();
                return Ok(result);
            }
            // A cancel that lands between turns pauses instead of silently
            // starting another continuation. (The per-turn reset in
            // `run_turn_with_origin` makes this boundary check load-bearing.)
            if self.cancellation.load(Ordering::Relaxed) {
                self.pause_goal("Paused after an interruption");
                self.maybe_auto_exit_swarm();
                return Ok(result);
            }
            // Continuation input, rendered from the canonical `continuation.md`
            // steering template (GOAL.md: Codex-derived, carrying the tuned
            // completion audit and the 3-turn blocked audit) — a system-
            // triggered input, not a lighter per-status reminder. When the
            // previous turn ended at the per-turn step limit (#2210), the
            // step-capped variant explains the split and asks for smaller
            // slices instead of treating the cap as a goal failure.
            let prompt = if result.hit_step_cap {
                crate::goal::steering::render_step_capped_continuation(
                    &snapshot.objective,
                    snapshot.tokens_used,
                    snapshot.budget.token_budget,
                )
            } else {
                crate::goal::steering::render_continuation(
                    &snapshot.objective,
                    snapshot.tokens_used,
                    snapshot.budget.token_budget,
                )
            };
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

    // ── Goal lifecycle (host control surface, `session/goal_*` RPCs) ──────
    // Deterministic user/host operations; terminal statuses stay model-owned
    // (UpdateGoal tool / goal driver), exactly like the SDK `Session` surface.

    /// Create (or with `replace` swap) the session goal as the user.
    pub fn goal_create(
        &mut self,
        input: crate::goal::CreateGoalInput,
    ) -> Result<crate::goal::GoalSnapshot, String> {
        let goal = self.goal.as_mut().ok_or("goal mode is disabled")?;
        let snapshot = goal.create_goal(input, GoalActor::User)?;
        self.emit_goal_status();
        Ok(snapshot)
    }

    /// The current goal record (may be a terminal snapshot), `None` when
    /// nothing was ever created or a completion cleared it.
    pub fn goal_get(&self) -> crate::goal::GoalToolResult {
        match self.goal.as_ref() {
            Some(goal) => goal.get_goal(),
            None => crate::goal::GoalToolResult { goal: None },
        }
    }

    /// Pause the active goal as the user.
    pub fn goal_pause(
        &mut self,
        reason: Option<String>,
    ) -> Result<crate::goal::GoalSnapshot, String> {
        let goal = self.goal.as_mut().ok_or("goal mode is disabled")?;
        let snapshot = goal.pause_goal(reason, GoalActor::User)?;
        self.emit_goal_status();
        Ok(snapshot)
    }

    /// Resume a paused goal as the user.
    pub fn goal_resume(
        &mut self,
        reason: Option<String>,
    ) -> Result<crate::goal::GoalSnapshot, String> {
        let goal = self.goal.as_mut().ok_or("goal mode is disabled")?;
        let snapshot = goal.resume_goal(reason, GoalActor::User)?;
        self.emit_goal_status();
        Ok(snapshot)
    }

    /// Cancel the goal as the user.
    pub fn goal_cancel(&mut self) -> Result<crate::goal::GoalSnapshot, String> {
        let goal = self.goal.as_mut().ok_or("goal mode is disabled")?;
        let snapshot = goal.cancel_goal(GoalActor::User)?;
        self.emit_goal_status();
        Ok(snapshot)
    }

    /// Enable or disable swarm mode (`session/set_swarm_mode`). Entering
    /// appends the enter reminder to the context (except the silent `tool`
    /// trigger); exiting pops a still-trailing enter reminder or appends the
    /// exit reminder. Returns whether the mode is active afterwards.
    pub fn set_swarm_mode(
        &mut self,
        enabled: bool,
        trigger: crate::swarm::SwarmModeTrigger,
    ) -> bool {
        if enabled {
            let _ = self.swarm.enter_with_context(trigger, &mut self.context);
        } else {
            let _ = self.swarm.exit_with_context(&mut self.context);
        }
        self.swarm.is_active()
    }

    /// One-shot swarm triggers (`task`/`tool`) exit after the prompt's turn
    /// completes; the persistent `manual` toggle stays on.
    fn maybe_auto_exit_swarm(&mut self) {
        if self.swarm.should_auto_exit() {
            let _ = self.swarm.exit_with_context(&mut self.context);
        }
    }

    /// Enable or disable plan mode (`session/set_plan_mode`). Plan mode is
    /// tracked by the permission gate's context type (`"plan_mode"`), which
    /// activates the plan-guard policies; entering also appends the plan-mode
    /// reminder to the context, exiting appends the exit reminder. Returns the
    /// plan-mode state afterwards. Re-entering an already-active plan mode is
    /// an error, matching the TS `PlanModeService.enter` contract (the TUI's
    /// resume path relies on this guard).
    pub fn set_plan_mode(&mut self, enabled: bool) -> Result<bool, String> {
        let active =
            self.permission.manager().context_type().as_deref() == Some("plan_mode");
        if enabled {
            if active {
                return Err("Already in plan mode".to_string());
            }
            self.permission.set_context_type(Some("plan_mode".to_string()));
            // Drive the plan-file state machine alongside the permission gate,
            // creating the plan file so `get_plan` has real content to return.
            if !self.plan.is_active() {
                let _ = self.plan.enter(None, true);
            }
            self.context.append_system_reminder(
                &crate::injection::build_plan_mode_reminder(None),
                crate::context::types::MessageOrigin::Injection {
                    variant: "plan_mode".to_string(),
                },
            );
            Ok(true)
        } else {
            if !active {
                return Ok(false);
            }
            self.permission.set_context_type(None);
            self.plan.cancel();
            self.context.append_system_reminder(
                &crate::injection::build_plan_exit_reminder(),
                crate::context::types::MessageOrigin::Injection {
                    variant: "plan_mode_exit".to_string(),
                },
            );
            Ok(false)
        }
    }

    /// The active plan (id + file path + current file content), or `None` when
    /// plan mode is not active — the engine side of SDK `getPlan`.
    pub fn get_plan(&self) -> Result<Option<crate::plan::PlanData>, String> {
        self.plan.data()
    }

    /// Append the user-interruption reminder to the context, at most once.
    ///
    /// Upstream #2400: when a turn is cancelled with Esc, preserve the
    /// assistant's partial output and tell the model the previous turn was
    /// deliberately interrupted. The reminder is deduplicated on the
    /// `interruption` injection variant so repeated cancels never stack.
    const INTERRUPTION_REMINDER_VARIANT: &'static str = "interruption";
    fn append_interruption_reminder_once(&mut self) {
        use crate::context::types::MessageOrigin;
        // Check the raw history, not the projected view — projection strips
        // message metadata (including origin), which would defeat dedup.
        let already = self.context.history().iter().any(|m| {
            matches!(&m.origin, Some(MessageOrigin::Injection { variant }) if variant == Self::INTERRUPTION_REMINDER_VARIANT)
        });
        if already {
            return;
        }
        let text = "The previous turn was interrupted by the user before completion; \
any partial output shown above is incomplete. The user's next message continues the conversation.";
        self.context.append_system_reminder(
            text,
            MessageOrigin::Injection {
                variant: Self::INTERRUPTION_REMINDER_VARIANT.to_string(),
            },
        );
    }

    /// Clear the active plan's file content (writes empty) — the engine side of
    /// SDK `clearPlan`. A no-op when no plan is active.
    pub fn clear_plan(&mut self) -> Result<(), String> {
        self.plan.clear()
    }

    /// Undo the last `count` real user turns (SDK `undoHistory` parity).
    ///
    /// Rewinds the conversation history AND the non-conversation state
    /// captured at each user-prompt boundary — plan mode and task
    /// notifications rewind together with the undone turns (upstream
    /// agent-core-v2 #2055 participant rewind). All-or-nothing: when the
    /// requested count is not fully available (or would cross a compaction
    /// boundary), returns the reason and leaves everything untouched.
    pub fn undo_history(
        &mut self,
        count: usize,
    ) -> Result<crate::context::context_ops::UndoCut, String> {
        if let Some(reason) = self.context.undo_unavailable_message(count) {
            return Err(reason);
        }
        let cut = self.context.undo(count);
        let removed = cut.removed_count;

        // Pop the checkpoints of the undone turns; the checkpoint left on top
        // (or the empty default when none remain) is the state to restore.
        let keep = self.undo_checkpoints.len().saturating_sub(removed);
        let restore = if keep > 0 {
            self.undo_checkpoints
                .get(keep - 1)
                .cloned()
                .unwrap_or_default()
        } else {
            UndoCheckpoint::default()
        };
        self.undo_checkpoints.truncate(keep);

        self.plan.restore(restore.plan_active, restore.plan_id);
        {
            let mut guard = self.task.lock().unwrap_or_else(|e| e.into_inner());
            guard.restore_notification_keys(
                &restore.task_scheduled_notification_keys,
                &restore.task_delivered_notification_keys,
            );
        }

        Ok(cut)
    }

    /// Activate a skill (`session/activate_skill`). Renders the skill prompt,
    /// seeds it into the context tagged with a `skill_activation` origin, emits
    /// the `skill.activated` event, then drives the goal-aware turn loop over it
    /// — mirroring the TS slash-command activation path (which starts a turn
    /// rather than passively injecting). Returns the turn result.
    pub async fn activate_skill(
        &mut self,
        name: String,
        args: Option<String>,
    ) -> Result<TurnResult, Box<dyn std::error::Error + Send + Sync>> {
        let (origin, rendered) = self
            .skill_manager
            .activate(crate::skill::ActivateSkillPayload { name, args })
            .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;
        // Clients observe activation via `skill.activated` + the ensuing turn.*
        // events (TS parity).
        self.callbacks.emit_event(self.skill_manager.record_activation(&origin));
        self.context.append_user_message(
            &[crate::context::types::ContentPart::Text { text: rendered }],
            crate::context::types::MessageOrigin::SkillActivation {
                activation_id: origin.activation_id,
                skill_name: origin.skill_name,
                skill_args: origin.skill_args,
                trigger: origin.trigger,
            },
        );
        // Empty input: the skill message is already seeded, so the loop runs a
        // turn over the current context (and any goal continuations), exactly
        // like a normal prompt turn.
        self.run_prompt(vec![]).await
    }

    /// Ensure the compaction state machine has a delegate that can actually
    /// summarize. In the standalone engine that means the native-LLM provider;
    /// without one there is no summarizer, so compaction stays a no-op. Returns
    /// whether a delegate is now available.
    fn ensure_compaction_delegate(&mut self, tokens_before: u64) -> bool {
        let Some(cfg) = self.native_llm.clone() else {
            return false;
        };
        self.compaction.set_delegate(Box::new(
            crate::compaction::NativeLlmCompactionDelegate::new(cfg, tokens_before),
        ));
        true
    }

    /// Run one compaction round and apply its result to the live context. The
    /// state machine (`compaction_round`) decides whether/how much to compact;
    /// on a produced result the head messages are rewritten into a summary via
    /// `ContextMemory::apply_compaction` (this is the write-back the old inline
    /// call dropped). Returns the applied result, or `None` when nothing was
    /// compacted.
    async fn run_compaction(
        &mut self,
        source: crate::compaction::CompactionSource,
        instruction: Option<String>,
    ) -> Result<Option<crate::context::compaction_handoff::ContextCompactionShape>, crate::compaction::CompactionError>
    {
        let used_tokens = self.context.token_count_with_pending();
        self.callbacks.emit_event(serde_json::json!({
            "type": "session.compaction.started",
            "session_id": self.session_id,
            "source": format!("{source:?}").to_lowercase(),
            "tokens_before": used_tokens,
        }));
        // PreCompact hooks: fire-and-forget with the pressure context (TS:
        // hook input carries the token tally). Non-fatal — a slow hook never
        // blocks compaction.
        if self
            .external_hooks
            .has_hooks_for(crate::hooks::external::HookEventType::PreCompact)
        {
            let input = serde_json::json!({
                "session_id": self.session_id,
                "source": format!("{source:?}").to_lowercase(),
                "tokens_before": used_tokens,
            });
            self.external_hooks
                .run_all(crate::hooks::external::HookEventType::PreCompact, None, &input)
                .await;
        }
        if !self.ensure_compaction_delegate(used_tokens) {
            return Err(crate::compaction::CompactionError::NoDelegate);
        }
        let messages = self.context.messages();
        let result = self.compaction.compaction_round(&messages, used_tokens, source, instruction)?;
        let Some(result) = result else {
            return Ok(None);
        };
        // Write-back: rewrite the head into a summary message (the step the old
        // inline call dropped). The mapping is a pure helper so it stays
        // unit-testable without an LLM.
        let input = crate::compaction::native_delegate::compaction_result_to_shape_input(&result);
        let shape = self.context.apply_compaction(&input);
        // PostCompact hooks: fire-and-forget with the outcome.
        if self
            .external_hooks
            .has_hooks_for(crate::hooks::external::HookEventType::PostCompact)
        {
            let outcome = serde_json::json!({
                "session_id": self.session_id,
                "tokens_before": used_tokens,
                "tokens_after": self.context.token_count_with_pending(),
                "summary": shape.summary,
            });
            self.external_hooks
                .run_all(crate::hooks::external::HookEventType::PostCompact, None, &outcome)
                .await;
        }
        Ok(Some(shape))
    }

    /// Manually compact the session context (`session/compact`). Requires a
    /// native-LLM provider (the summarizer). Returns a JSON report with the
    /// summary and token counts, or an error string the RPC layer surfaces.
    pub async fn compact(&mut self, instruction: Option<String>) -> Result<serde_json::Value, String> {
        match self.run_compaction(crate::compaction::CompactionSource::Manual, instruction).await {
            Ok(Some(shape)) => Ok(serde_json::json!({
                "compacted": true,
                "summary": shape.summary,
                "compacted_count": shape.compacted_count,
                "tokens_before": shape.tokens_before,
                "tokens_after": shape.tokens_after,
            })),
            Ok(None) => Ok(serde_json::json!({ "compacted": false })),
            Err(e) => Err(e.to_string()),
        }
    }

    /// A live status snapshot for `session/get_status`, shaped like the SDK
    /// `SessionStatus` (wire form is snake_case). Every field comes from a
    /// real engine source: model/effort from the LLM config, permission from
    /// the shared gate, plan from the gate's context type, context tokens
    /// from the tokenizer tally, the ceiling from the compaction strategy.
    pub fn session_status(&self) -> serde_json::Value {
        let model = self
            .config
            .model_alias
            .clone()
            .or_else(|| self.native_llm.as_ref().map(|c| c.model.clone()));
        let thinking_effort = self
            .thinking_effort
            .clone()
            .or_else(|| {
                self.native_llm
                    .as_ref()
                    .and_then(|c| c.reasoning_effort.clone())
            })
            .unwrap_or_default();
        let permission = serde_json::to_value(self.permission.mode())
            .unwrap_or_else(|_| "manual".into());
        let plan_mode =
            self.permission.manager().context_type().as_deref() == Some("plan_mode");
        let context_tokens = self.context.token_count_with_pending();
        let max_context_tokens = self.compaction.strategy().max_size();
        let context_usage = if max_context_tokens == 0 {
            0.0
        } else {
            context_tokens as f64 / max_context_tokens as f64
        };
        serde_json::json!({
            "model": model,
            "thinking_effort": thinking_effort,
            "permission": permission,
            "plan_mode": plan_mode,
            "swarm_mode": self.swarm.is_active(),
            "goal_enabled": self.goal_enabled,
            "context_tokens": context_tokens,
            "max_context_tokens": max_context_tokens,
            "context_usage": context_usage,
            "usage": self.usage.status(),
        })
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
            "undo_checkpoints": self.undo_checkpoints,
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
        if let Some(checkpoints) = state.get("undo_checkpoints").and_then(|v| v.as_array()) {
            for value in checkpoints {
                if let Ok(cp) = serde_json::from_value::<UndoCheckpoint>(value.clone()) {
                    self.undo_checkpoints.push(cp);
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

    /// Download every distinct `kimi://file/<id>` image URL referenced in the
    /// history once, returning a `url -> (mime, base64)` map. Failed
    /// downloads are simply absent from the map, so projection falls back to
    /// emitting the original URL. When no downloader is configured (noop) the
    /// downloads all fail and the map is empty — a zero-cost no-op.
    async fn materialize_kimi_media(
        &self,
        messages: &[crate::context::types::ContextMessage],
    ) -> std::collections::HashMap<String, (String, String)> {
        use crate::context::types::ContentPart;
        use base64::Engine;

        // Collect distinct kimi:// image URLs first (dedup repeated refs).
        let mut urls: Vec<String> = Vec::new();
        for message in messages {
            for part in &message.content {
                if let ContentPart::ImageUrl { image_url } = part {
                    let url = &image_url.url;
                    if crate::media::kimi_file_url::is_kimi_file_url(url)
                        && !urls.iter().any(|u| u == url)
                    {
                        urls.push(url.clone());
                    }
                }
            }
        }

        let mut out = std::collections::HashMap::new();
        for url in urls {
            let bytes = match crate::media::kimi_file_url::parse_and_download(
                &url,
                self.file_downloader.as_ref(),
            )
            .await
            {
                Ok(b) => b,
                // Leave the URL unmaterialised; projection emits it verbatim
                // and the provider surfaces the failure.
                Err(_) => continue,
            };
            let mime = crate::media::file_type::sniff_from_magic(&bytes)
                .map(|m| m.mime.to_string())
                .unwrap_or_else(|| "image/png".to_string());
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            out.insert(url, (mime, b64));
        }
        out
    }

    /// Build LoopHooks from the agent's hook system: each configured
    /// `AgentHooks` closure is cloned (they are `Arc`) and adapted onto the
    /// loop's context/result types. `None` when no hooks are configured, so
    /// the loop skips hook dispatch entirely.
    fn build_loop_hooks(&self) -> Option<loop_types::LoopHooks> {
        if self.hooks.before_step.is_none()
            && self.hooks.after_step.is_none()
            && self.hooks.should_continue_after_stop.is_none()
        {
            return None;
        }
        let mut hooks = loop_types::LoopHooks::default();
        if let Some(f) = self.hooks.before_step.clone() {
            hooks.before_step = Some(Box::new(move |ctx: &loop_types::StepContext| {
                let agent_ctx = crate::agent::types::HookContext {
                    turn_id: ctx.turn_id.clone(),
                    step_number: ctx.step,
                };
                Ok(Some(match f(&agent_ctx)? {
                    crate::agent::types::HookResult::Continue => {
                        loop_types::BeforeStepResult::Continue
                    }
                    crate::agent::types::HookResult::StopTurn(reason) => {
                        loop_types::BeforeStepResult::StopTurn(reason)
                    }
                }))
            }));
        }
        if let Some(f) = self.hooks.after_step.clone() {
            hooks.after_step = Some(Box::new(move |ctx: &loop_types::AfterStepContext| {
                let agent_ctx = crate::agent::types::HookContext {
                    turn_id: ctx.turn_id.clone(),
                    step_number: ctx.step,
                };
                Ok(Some(match f(&agent_ctx)? {
                    crate::agent::types::HookResult::Continue => {
                        loop_types::AfterStepResult::Continue
                    }
                    crate::agent::types::HookResult::StopTurn(reason) => {
                        loop_types::AfterStepResult::StopTurn(reason)
                    }
                }))
            }));
        }
        if let Some(f) = self.hooks.should_continue_after_stop.clone() {
            hooks.should_continue_after_stop =
                Some(Box::new(move |ctx: &loop_types::LoopStoppedStepContext| {
                    let agent_ctx = crate::agent::types::HookContext {
                        turn_id: ctx.turn_id.clone(),
                        step_number: ctx.step_number,
                    };
                    Ok(Some(loop_types::ShouldContinueAfterStopResult {
                        continue_turn: f(&agent_ctx)?,
                    }))
                }));
        }
        Some(hooks)
    }

    /// Render a hook result for the transcript (TS `renderHookResult`).
    fn render_hook_result(event: &str, message: &str) -> String {
        format!("<hook_result hook_event=\"{event}\">\n{message}\n</hook_result>")
    }

    /// Run `UserPromptSubmit` hooks for a user prompt. Returns `Some(text)`
    /// when a hook blocks (the prompt must not run — `text` is the rendered
    /// block verdict). Non-blocking hook output (message or stdout of clean
    /// exits) is appended to the context as a user message, exactly like the
    /// TS `runPromptSubmitHook` path.
    async fn run_user_prompt_submit_hooks(
        &mut self,
        input: &[crate::context::types::ContentPart],
    ) -> Option<String> {
        use crate::hooks::external::{HookAction, HookEventType};
        if !self.external_hooks.has_hooks_for(HookEventType::UserPromptSubmit) {
            return None;
        }
        let prompt_text: String = input
            .iter()
            .filter_map(|p| match p {
                crate::context::types::ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(" ");
        let payload = serde_json::json!({
            "hook_event_name": "UserPromptSubmit",
            "session_id": self.session_id.clone().unwrap_or_default(),
            "cwd": self.config.cwd,
            "prompt": serde_json::to_value(input).unwrap_or(serde_json::Value::Null),
            "is_steer": false,
        });
        let results = self
            .external_hooks
            .run_all(HookEventType::UserPromptSubmit, Some(&prompt_text), &payload)
            .await;

        // A block wins: message → reason → generic text (TS
        // `renderUserPromptHookBlockResult`).
        if let Some(block) = results.iter().find(|r| matches!(r.action, HookAction::Block)) {
            let message = block
                .message
                .as_deref()
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .or_else(|| block.reason.as_deref().map(str::trim).filter(|r| !r.is_empty()))
                .unwrap_or("Blocked by UserPromptSubmit hook");
            return Some(Self::render_hook_result("UserPromptSubmit", message));
        }

        // Non-blocking output of clean exits joins the context as user input
        // (TS `renderUserPromptHookResult`).
        let messages: Vec<String> = results
            .iter()
            .filter(|r| !r.timed_out && r.exit_code == Some(0))
            .filter_map(|r| {
                let text = r
                    .message
                    .as_deref()
                    .map(str::trim)
                    .filter(|m| !m.is_empty())
                    .or_else(|| r.stdout.as_deref().map(str::trim).filter(|s| !s.is_empty()))?;
                Some(Self::render_hook_result("UserPromptSubmit", text))
            })
            .collect();
        if !messages.is_empty() {
            self.context.append_user_message(
                &[crate::context::types::ContentPart::Text { text: messages.join("\n") }],
                crate::context::types::MessageOrigin::HookResult {
                    event: "UserPromptSubmit".to_string(),
                    blocked: None,
                },
            );
        }
        None
    }

    /// Run `Stop` hooks at the normal turn-completion boundary. Returns the
    /// block reason when a hook demands continuation, `None` otherwise.
    async fn run_stop_hooks(&self) -> Option<String> {
        use crate::hooks::external::HookEventType;
        if !self.external_hooks.has_hooks_for(HookEventType::Stop) {
            return None;
        }
        let payload = serde_json::json!({
            "hook_event_name": "Stop",
            "session_id": self.session_id.clone().unwrap_or_default(),
            "cwd": self.config.cwd,
            "stop_hook_active": false,
        });
        let block = self
            .external_hooks
            .run_matching(HookEventType::Stop, None, &payload)
            .await?;
        let reason = block.reason.as_deref().map(str::trim).filter(|r| !r.is_empty());
        Some(reason.unwrap_or("Blocked by Stop hook").to_string())
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

/// Reverse of [`messages_to_loop_messages`] for a single loop message: turn a
/// message the loop appended (assistant reply, tool result, or tool-media
/// follow-up) back into a `ContextMessage` so the session-owned driver can
/// persist the assistant side of the turn. Text becomes a single text part;
/// image blocks become `image_url` parts (data URLs, already inlined); tool
/// calls carry through with `type: "function"`. Returns `None` for a message
/// with nothing worth persisting (empty content, no blocks, no tool calls) —
/// e.g. the host-proxy path where the host owns the transcript.
fn loop_message_to_context_message(
    message: &loop_types::LLMMessage,
) -> Option<crate::context::types::ContextMessage> {
    use crate::context::types::{ContentPart, MediaContainer};
    use crate::rpc::types::ContentBlock;

    let mut content: Vec<ContentPart> = Vec::new();
    // Prefer structured blocks (they preserve image parts); fall back to the
    // flat `content` string when there are none.
    if message.blocks.is_empty() {
        if !message.content.is_empty() {
            content.push(ContentPart::Text { text: message.content.clone() });
        }
    } else {
        for block in &message.blocks {
            match block {
                ContentBlock::Text { text } => content.push(ContentPart::Text { text: text.clone() }),
                ContentBlock::Image { media_type, data } => content.push(ContentPart::ImageUrl {
                    image_url: MediaContainer {
                        url: format!("data:{media_type};base64,{data}"),
                        id: None,
                    },
                }),
                ContentBlock::ImageUrl { url } => content.push(ContentPart::ImageUrl {
                    image_url: MediaContainer { url: url.clone(), id: None },
                }),
            }
        }
    }

    let tool_calls: Vec<crate::context::types::ToolCall> = message
        .tool_calls
        .iter()
        .map(|tc| crate::context::types::ToolCall {
            r#type: "function".to_string(),
            id: tc.id.clone(),
            name: tc.name.clone(),
            arguments: tc.arguments.clone(),
            extras: None,
        })
        .collect();

    // Nothing worth persisting → skip (keeps empty host-proxy assistant
    // messages out of the history).
    if content.is_empty() && tool_calls.is_empty() && message.tool_call_id.is_none() {
        return None;
    }

    Some(crate::context::types::ContextMessage {
        role: message.role.clone(),
        content,
        tool_calls,
        tool_call_id: message.tool_call_id.clone(),
        ..Default::default()
    })
}

/// Project context messages onto the loop wire. Text parts concatenate into
/// `content`; image parts become blocks (text blocks ride along so mixed
/// messages keep their reading order); think parts are model-internal and
/// never resent; tool calls and tool-result linkage carry through
/// structurally so multi-step tool turns project faithfully.
fn messages_to_loop_messages(
    messages: &[crate::context::types::ContextMessage],
    materialized_media: &std::collections::HashMap<String, (String, String)>,
) -> Vec<loop_types::LLMMessage> {
    use crate::context::types::ContentPart;
    messages
        .iter()
        .map(|message| {
            let mut content = String::new();
            let mut blocks: Vec<crate::rpc::types::ContentBlock> = Vec::new();
            let mut has_media = false;
            let push_text = |content: &mut String, text: &str| {
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
                        // Prefer materialised bytes for `kimi://file/<id>`
                        // refs (the provider can't resolve the scheme); fall
                        // back to the raw URL for https/data URLs and for
                        // downloads that failed.
                        match materialized_media.get(&image_url.url) {
                            Some((media_type, data)) => {
                                blocks.push(crate::rpc::types::ContentBlock::Image {
                                    media_type: media_type.clone(),
                                    data: data.clone(),
                                });
                            }
                            None => {
                                blocks.push(crate::rpc::types::ContentBlock::ImageUrl {
                                    url: image_url.url.clone(),
                                });
                            }
                        }
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

    #[test]
    fn mcp_image_result_becomes_a_media_block_not_a_text_placeholder() {
        use crate::mcp::types::{MCPContentBlock, MCPToolCallResult};
        let result = MCPToolCallResult {
            content: vec![
                MCPContentBlock::Text { text: "here is the chart".into() },
                MCPContentBlock::Image { data: "QUJD".into(), mime_type: "image/png".into() },
            ],
            is_error: None,
            meta: None,
        };
        let resp = mcp_result_to_tool_response(&result);
        // Text stays in content; the image is a real media part (not `[Image: …]`).
        assert_eq!(resp.content, "here is the chart");
        assert!(!resp.content.contains("[Image"), "image must not be flattened to text: {}", resp.content);
        assert_eq!(resp.media.len(), 1);
        match &resp.media[0] {
            crate::rpc::types::ContentBlock::Image { media_type, data } => {
                assert_eq!(media_type, "image/png");
                assert_eq!(data, "QUJD");
            }
            other => panic!("expected an Image media block, got {other:?}"),
        }
        assert!(!resp.is_error);
    }

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
                session_id: None,
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
                "task" => Some(callbacks.execute_tool(call(
                    "Task",
                    serde_json::json!({ "prompt": "do the thing" }),
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
                    new_messages: Vec::new(),
                    hit_step_cap: false,
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
    async fn interruption_reminder_appended_once_on_abort() {
        use crate::turn_loop::types::LoopTurnStopReason;
        // A driver that aborts the turn (simulating a user Esc cancel).
        struct AbortDriver;
        impl AgentTurnOverride for AbortDriver {
            fn run_turn(
                &self,
                _input: crate::turn_loop::types::RunTurnInput,
                _callbacks: &dyn HostCallbacks,
            ) -> crate::rpc::types::BoxFuture<
                'static,
                Result<crate::turn_loop::types::TurnResult, Box<dyn std::error::Error + Send + Sync>>,
            > {
                Box::pin(async move {
                    Ok(crate::turn_loop::types::TurnResult {
                        stop_reason: LoopTurnStopReason::Aborted,
                        steps: 0,
                        usage: crate::rpc::types::TokenUsage::default(),
                        new_messages: Vec::new(),
                        hit_step_cap: false,
                    })
                })
            }
        }
        let agent = Agent::new(
            Arc::new(NoopHost),
            AgentOptions {
                run_turn_override: Some(Arc::new(AbortDriver)),
                ..AgentOptions::default()
            },
        );
        let mut agent = agent;
        let result = agent.run_prompt(text_input("do the thing")).await.expect("prompt");
        assert!(matches!(
            result.stop_reason,
            crate::turn_loop::types::LoopTurnStopReason::Aborted
        ));

        // Check the raw history — projection strips origin metadata.
        let reminders: Vec<&crate::context::types::ContextMessage> = agent
            .context
            .history()
            .iter()
            .filter(|m| {
                matches!(
                    &m.origin,
                    Some(crate::context::types::MessageOrigin::Injection { variant })
                        if variant == Agent::INTERRUPTION_REMINDER_VARIANT
                )
            })
            .collect();
        assert_eq!(reminders.len(), 1, "one interruption reminder on cancel");
        let text = reminders[0]
            .content
            .iter()
            .filter_map(|p| match p {
                crate::context::types::ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("");
        assert!(
            text.contains("interrupted by the user"),
            "reminder text must explain the deliberate interruption: {text}"
        );

        // A second abort does not stack another reminder.
        agent.run_prompt(text_input("again")).await.expect("prompt");
        let count = agent
            .context
            .history()
            .iter()
            .filter(|m| {
                matches!(
                    &m.origin,
                    Some(crate::context::types::MessageOrigin::Injection { variant })
                        if variant == Agent::INTERRUPTION_REMINDER_VARIANT
                )
            })
            .count();
        assert_eq!(count, 1, "reminder must be deduplicated");
    }

    #[tokio::test]
    async fn undo_history_rewinds_plan_mode_with_the_turn() {
        let (mut agent, _) = driver_agent(vec![]);

        // Turn 1: a real user-prompt boundary is recorded with plan mode off.
        agent.run_prompt(text_input("first prompt")).await.expect("prompt");
        assert_eq!(agent.undo_checkpoints.len(), 1);
        assert!(!agent.plan.is_active());

        // The model's work enters plan mode after turn 1.
        agent.set_plan_mode(true).expect("enter plan mode");
        assert!(agent.plan.is_active());

        // Turn 2: a second boundary, now with plan mode active.
        agent.run_prompt(text_input("second prompt")).await.expect("prompt");
        assert_eq!(agent.undo_checkpoints.len(), 2);

        // Undo the last turn: plan mode rewinds to the previous boundary's
        // state (inactive) together with the conversation history.
        let cut = agent.undo_history(1).expect("undo");
        assert_eq!(cut.removed_count, 1);
        assert!(
            !agent.plan.is_active(),
            "plan mode must rewind with the undone turn"
        );
        assert_eq!(agent.undo_checkpoints.len(), 1);
        assert!(
            !context_contains(&agent, "second prompt"),
            "undone turn must leave the history"
        );
        assert!(context_contains(&agent, "first prompt"));
    }

    #[tokio::test]
    async fn task_tool_tracks_and_settles_a_detached_task() {
        let (mut agent, _) = driver_agent(vec!["task"]);
        agent.run_prompt(text_input("run the task")).await.expect("prompt");

        let guard = agent.task.lock().unwrap_or_else(|e| e.into_inner());
        let tasks = guard.list(false, None);
        // The child agent runs against the NoopHost; whether it settles
        // completed or failed depends on the LLM stub — the track + settle
        // wiring is what we assert.
        assert_eq!(tasks.len(), 1, "Task tool must register a tracked task");
        let task = tasks.first().expect("one task");
        assert_eq!(task.kind, "agent");
        assert!(task.status.is_terminal(), "task must settle after the child ends");
        // A settled detached task schedules a terminal notification key.
        assert!(
            !guard.notifications_snapshot().0.is_empty(),
            "settling a detached task must schedule a notification key"
        );
    }

    #[tokio::test]
    async fn undo_history_rewinds_task_notifications() {
        let (mut agent, _) = driver_agent(vec![]);
        agent.run_prompt(text_input("first prompt")).await.expect("prompt");

        // Register + settle a task so a notification key is recorded.
        let task = agent.task.clone();
        {
            let mut guard = task.lock().unwrap_or_else(|e| e.into_inner());
            let entry = guard
                .track(crate::task::AgentTaskTrackOptions {
                    id_prefix: "t".to_string(),
                    description: "a task".to_string(),
                    kind: "agent".to_string(),
                    detached: true,
                    timeout_ms: None,
                    detach_timeout_ms: None,
                    agent_id: Some("main".to_string()),
                })
                .expect("track");
            guard.settle(
                &entry.task_id,
                crate::task::TaskSettlement {
                    status: crate::task::TaskSettlementStatus::Completed,
                    stop_reason: Some("done".to_string()),
                },
            );
        }
        assert!(
            !task
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .notifications_snapshot()
                .0
                .is_empty(),
            "settling a detached task must schedule a notification key"
        );

        // A second user prompt captures the notification bookkeeping.
        agent.run_prompt(text_input("second prompt")).await.expect("prompt");
        assert_eq!(agent.undo_checkpoints.len(), 2);

        // Undo: the delivered-notification key set must rewind to the first
        // boundary's (empty) state.
        agent.undo_history(1).expect("undo");
        let (scheduled, delivered) =
            task.lock().unwrap_or_else(|e| e.into_inner()).notifications_snapshot();
        assert!(scheduled.is_empty());
        assert!(delivered.is_empty(), "notifications must rewind with the turn");
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

    // ── kimi://file media materialisation (Phase 6.4) ─────────────────────────

    fn image_message(url: &str) -> crate::context::types::ContextMessage {
        use crate::context::types::{ContentPart, ContextMessage, MediaContainer};
        ContextMessage {
            role: "user".into(),
            content: vec![ContentPart::ImageUrl {
                image_url: MediaContainer { url: url.into(), id: None },
            }],
            ..Default::default()
        }
    }

    #[test]
    fn projection_materialises_kimi_urls_and_passes_through_others() {
        let messages = vec![
            image_message("kimi://file/abc"),
            image_message("https://cdn.example.com/x.png"),
        ];
        let mut media = std::collections::HashMap::new();
        media.insert(
            "kimi://file/abc".to_string(),
            ("image/png".to_string(), "QUJD".to_string()),
        );

        let wire = messages_to_loop_messages(&messages, &media);
        assert_eq!(wire.len(), 2);
        // kimi:// ref becomes an inline base64 Image block.
        match &wire[0].blocks[0] {
            crate::rpc::types::ContentBlock::Image { media_type, data } => {
                assert_eq!(media_type, "image/png");
                assert_eq!(data, "QUJD");
            }
            other => panic!("expected inline Image, got {other:?}"),
        }
        // https URL passes through verbatim as an ImageUrl block.
        match &wire[1].blocks[0] {
            crate::rpc::types::ContentBlock::ImageUrl { url } => {
                assert_eq!(url, "https://cdn.example.com/x.png");
            }
            other => panic!("expected ImageUrl, got {other:?}"),
        }
    }

    #[test]
    fn projection_falls_back_to_url_when_download_missing() {
        // A kimi:// ref with no materialised entry (download failed) keeps the
        // URL so the provider surfaces the error rather than silently dropping.
        let messages = vec![image_message("kimi://file/failed")];
        let media = std::collections::HashMap::new();
        let wire = messages_to_loop_messages(&messages, &media);
        match &wire[0].blocks[0] {
            crate::rpc::types::ContentBlock::ImageUrl { url } => {
                assert_eq!(url, "kimi://file/failed");
            }
            other => panic!("expected ImageUrl fallback, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn materialize_kimi_media_is_empty_without_a_downloader() {
        // The default agent uses NoopFileDownloader; every download errors, so
        // the map is empty and projection falls back to URLs (no-op).
        let (agent, _driver) = driver_agent(vec![]);
        let messages = vec![image_message("kimi://file/abc")];
        let media = agent.materialize_kimi_media(&messages).await;
        assert!(media.is_empty());
    }
}
