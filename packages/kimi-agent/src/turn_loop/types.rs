/// Core type definitions for the stateless turn loop.
///
/// These correspond to the types in `packages/agent-core/src/loop/types.ts`.

use serde::{Deserialize, Serialize};

use crate::rpc::types::TokenUsage;

// ── TurnResult ─────────────────────────────────────────────────────────────

/// The final result of a completed turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnResult {
    /// Why the turn stopped.
    pub stop_reason: LoopTurnStopReason,
    /// Number of steps taken.
    pub steps: u32,
    /// Token usage for the entire turn.
    pub usage: TokenUsage,
}

/// Reasons a turn can stop.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum LoopTurnStopReason {
    EndTurn,
    MaxTokens,
    Filtered,
    Paused,
    Unknown,
    Aborted,
}

// ── LLM interface ──────────────────────────────────────────────────────────

/// The LLM abstraction that the loop calls.
pub trait LLM: Send + Sync {
    /// The system prompt for this LLM.
    fn system_prompt(&self) -> &str;
    /// The model name.
    fn model_name(&self) -> &str;
    /// Whether the given error is retryable.
    fn is_retryable_error(&self, error: &str) -> bool;
    /// Send a chat request and get a response.
    fn chat(&self, params: LLMChatParams) -> Result<LLMChatResponse, Box<dyn std::error::Error>>;
}

/// Parameters for an LLM chat call.
#[derive(Debug, Clone)]
pub struct LLMChatParams {
    pub messages: Vec<LLMMessage>,
    pub tools: Vec<ToolInfo>,
}

/// A message in the LLM conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LLMMessage {
    pub role: String,
    pub content: String,
}

/// Information about an available tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// The LLM's response to a chat call.
#[derive(Debug, Clone)]
pub struct LLMChatResponse {
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
    pub usage: TokenUsage,
}

/// A tool call from the LLM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

// ── ExecutableTool trait ───────────────────────────────────────────────────

/// The result of resolving a tool execution.
pub enum ToolExecution {
    Runnable(RunnableToolExecution),
    Error(ExecutableToolErrorResult),
}

/// A tool that can be executed.
pub struct RunnableToolExecution {
    pub accesses: Option<ToolAccesses>,
    pub approval_rule: String,
    /// The actual execution logic.
    pub execute: Box<dyn FnOnce(ToolExecContext) -> Result<ExecutableToolResult, Box<dyn std::error::Error>> + Send>,
}

/// Context passed to a tool's execute function.
#[derive(Debug, Clone)]
pub struct ToolExecContext {
    pub turn_id: String,
    pub tool_call_id: String,
}

/// The result of a tool execution.
#[derive(Debug, Clone)]
pub struct ExecutableToolResult {
    pub content: String,
    pub is_error: bool,
}

/// Error result from tool resolution.
#[derive(Debug, Clone)]
pub struct ExecutableToolErrorResult {
    pub message: String,
}

/// Tool access tracking.
#[derive(Debug, Clone, Default)]
pub struct ToolAccesses {
    pub read_dirs: Vec<String>,
    pub write_dirs: Vec<String>,
}

/// The trait that all executable tools must implement.
pub trait ExecutableTool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn resolve_execution(
        &self,
        input: serde_json::Value,
    ) -> Result<ToolExecution, Box<dyn std::error::Error>>;
}

// ── LoopHooks ──────────────────────────────────────────────────────────────

/// Possible results from the before_step hook.
#[derive(Debug, Clone)]
pub enum BeforeStepResult {
    /// Stop the turn with this reason.
    StopTurn(LoopTurnStopReason),
    /// Continue normally.
    Continue,
}

/// Possible results from the after_step hook.
#[derive(Debug, Clone)]
pub enum AfterStepResult {
    /// Stop the turn.
    StopTurn(LoopTurnStopReason),
    /// Continue to the next step.
    Continue,
}

/// Context passed to hooks.
#[derive(Debug, Clone)]
pub struct StepContext {
    pub turn_id: String,
    pub step: u32,
}

/// Context passed to after_step hook.
#[derive(Debug, Clone)]
pub struct AfterStepContext {
    pub turn_id: String,
    pub step: u32,
    pub tool_results: Vec<ExecutableToolResult>,
}

/// The hook system for the turn loop.
/// Each hook is optional.
#[derive(Default)]
pub struct LoopHooks {
    pub before_step: Option<Box<dyn Fn(&StepContext) -> Result<Option<BeforeStepResult>, Box<dyn std::error::Error>> + Send + Sync>>,
    pub after_step: Option<Box<dyn Fn(&AfterStepContext) -> Result<Option<AfterStepResult>, Box<dyn std::error::Error>> + Send + Sync>>,
}

// ── RunTurnInput ───────────────────────────────────────────────────────────

/// Input to the `run_turn` function.
pub struct RunTurnInput<'a> {
    pub turn_id: String,
    pub llm: &'a dyn LLM,
    pub messages: Vec<LLMMessage>,
    pub tools: &'a [&'a dyn ExecutableTool],
    /// Tool definitions passed from the JS side. These are sent to the
    /// LLM proxy so the JS host can include them in the actual LLM call.
    pub tool_defs: Vec<ToolInfo>,
    pub hooks: Option<&'a LoopHooks>,
    pub max_steps: u32,
}

// ── Step-level types ───────────────────────────────────────────────────────

/// Result of a single step.
#[derive(Debug, Clone)]
pub struct StepResult {
    pub usage: TokenUsage,
    pub stop_reason: LoopStepStopReason,
}

/// Reasons a single step can stop.
#[derive(Debug, Clone)]
pub enum LoopStepStopReason {
    /// The LLM returned a complete response (no more tool calls).
    Complete,
    /// The LLM made tool calls that need to be executed.
    ToolCalls(Vec<ToolCall>),
    /// The step was aborted.
    Aborted,
    /// An error occurred.
    Error(String),
}