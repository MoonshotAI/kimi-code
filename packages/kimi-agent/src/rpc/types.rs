/// JSON-RPC 2.0 protocol types for kimi-agent stdio communication.
///
/// The agent process speaks JSON-RPC 2.0 over stdio:
/// - Reads JSON-RPC requests from stdin
/// - Writes JSON-RPC responses (and notifications) to stdout
/// - Uses stderr for logging/diagnostics

use serde::{Deserialize, Serialize};
use std::pin::Pin;
use std::future::Future;

/// A boxed future type alias for async handlers.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

// ── JSON-RPC 2.0 base types ────────────────────────────────────────────────

/// Unique identifier for a JSON-RPC request.
pub type RequestId = serde_json::Value;

/// A JSON-RPC 2.0 request.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    #[serde(default)]
    pub id: serde_json::Value,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// A JSON-RPC 2.0 response (success).
#[derive(Debug, Serialize)]
#[allow(dead_code)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: RequestId,
    pub result: serde_json::Value,
}

/// A JSON-RPC 2.0 error response.
#[derive(Debug, Serialize)]
#[allow(dead_code)]
pub struct JsonRpcErrorResponse {
    pub jsonrpc: String,
    pub id: RequestId,
    pub error: JsonRpcError,
}

/// A JSON-RPC 2.0 error object.
#[derive(Debug, Serialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl std::fmt::Display for JsonRpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for JsonRpcError {}

/// A JSON-RPC 2.0 notification (no response expected).
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

// ── Agent RPC method names ─────────────────────────────────────────────────

/// RPC method names for the kimi-agent protocol.
#[allow(dead_code)]
pub mod methods {
    /// Run a single turn. Corresponds to `runTurn()` in the JS loop.
    pub const RUN_TURN: &str = "agent/run_turn";

    /// Cancel a running turn.
    pub const CANCEL_TURN: &str = "agent/cancel_turn";

    /// Health check.
    pub const HEALTH: &str = "agent/health";

    /// Shutdown the agent process.
    pub const SHUTDOWN: &str = "agent/shutdown";

    /// LLM chat request (Rust → JS host proxy).
    pub const HOST_LLM_CHAT: &str = "host/llm_chat";

    /// Execute a tool call (Rust → JS host proxy).
    pub const HOST_EXECUTE_TOOL: &str = "host/execute_tool";

    /// Fire-and-forget event notification (Rust → JS host).
    /// Used by the native LLM / native tool paths to report step
    /// boundaries, streaming deltas, and natively-executed tool results
    /// so the host can record them in the transcript.
    pub const HOST_EVENT: &str = "host/event";

    // ── Tool hook methods (tool_call.rs lifecycle) ─────────────────────────────────
    /// Prepare a tool call for execution (Rust → JS host proxy).
    /// Analogous to TS `prepareToolExecution` hook.
    pub const HOST_PREPARE_TOOL: &str = "host/prepare_tool_execution";

    /// Authorize a tool call (Rust → JS host proxy).
    /// Analogous to TS `authorizeToolExecution` hook.
    pub const HOST_AUTHORIZE_TOOL: &str = "host/authorize_tool_execution";

    /// Finalize a tool result (Rust → JS host proxy).
    /// Analogous to TS `finalizeToolResult` hook.
    pub const HOST_FINALIZE_TOOL: &str = "host/finalize_tool_result";

    // ── Cron methods ────────────────────────────────────────────────────────────
    /// Create a new cron task.
    pub const CRON_CREATE: &str = "cron/create";
    /// Delete cron tasks by id.
    pub const CRON_DELETE: &str = "cron/delete";
    /// List all cron tasks.
    pub const CRON_LIST: &str = "cron/list";
    /// Get next fire time for a task.
    pub const CRON_GET_NEXT_FIRE: &str = "cron/get_next_fire";
    /// Rust → JS: a cron job fired.
    pub const CRON_FIRED: &str = "cron/fired";

    // ── Background task methods ──────────────────────────────────────────────────
    /// Register a new background task.
    pub const BG_REGISTER: &str = "bg/register";
    /// List all background tasks.
    pub const BG_LIST: &str = "bg/list";
    /// Get a specific background task.
    pub const BG_GET: &str = "bg/get";
    /// Stop a background task.
    pub const BG_STOP: &str = "bg/stop";
    /// Get output snapshot for a task.
    pub const BG_OUTPUT: &str = "bg/output";
    /// Append output to a task.
    pub const BG_APPEND_OUTPUT: &str = "bg/append_output";
    /// Settle a task (mark terminal).
    pub const BG_SETTLE: &str = "bg/settle";
    /// Rust → JS: background task event.
    pub const BG_EVENT: &str = "bg/event";
}

// ── Message content blocks (multimodal) ─────────────────────────────────

/// A single content block within a message. Text-only messages keep using
/// the plain `content` string; multimodal messages carry ordered blocks in
/// addition (blocks win over `content` when non-empty).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    /// Plain text.
    Text { text: String },
    /// Base64-encoded image data with a MIME media type (e.g. `image/png`).
    Image { media_type: String, data: String },
    /// Image referenced by URL (https or data URL).
    ImageUrl { url: String },
}

// ── Native LLM configuration (Rust-side HTTP transport) ───────────────────

/// Configuration for the native HTTP LLM transport. When present on
/// `RunTurnParams`, the Rust engine calls the provider directly over
/// HTTP with SSE streaming instead of proxying `llm_chat` to the JS host.
#[derive(Debug, Clone, Deserialize)]
pub struct NativeLlmConfig {
    /// Wire protocol: `"openai"` (Chat Completions) or `"anthropic"` (Messages).
    pub protocol: String,
    /// API base URL including the version segment (e.g. `https://api.example.com/v1`).
    pub base_url: String,
    /// Bearer token (OpenAI) or x-api-key (Anthropic).
    pub api_key: String,
    /// Model name sent to the provider.
    pub model: String,
    /// `max_tokens` for the Anthropic Messages API (required there).
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// Extra headers sent with every request.
    #[serde(default)]
    pub custom_headers: std::collections::HashMap<String, String>,
}

// ── RunTurn request/response types ─────────────────────────────────────────

/// Input for a run_turn RPC call.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct RunTurnParams {
    pub turn_id: String,
    pub system_prompt: String,
    pub model_name: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDef>,
    pub max_steps: Option<u32>,
    /// Multiple LLM providers for concurrent execution (MultiLLM).
    /// When present, overrides `system_prompt` + `model_name`.
    #[serde(default)]
    pub providers: Vec<LlmProviderDef>,
    /// Optional goal context for budget-aware execution.
    /// When present, the loop checks budgets before each step and
    /// injects steering text into the system prompt.
    #[serde(default)]
    pub goal: Option<crate::turn_loop::types::GoalContext>,
    /// Native HTTP LLM transport. When present, the Rust engine calls the
    /// provider directly (streaming) instead of proxying through the host.
    #[serde(default)]
    pub native_llm: Option<NativeLlmConfig>,
    /// Workspace root used to sandbox native tool execution.
    #[serde(default)]
    pub workspace_root: Option<String>,
    /// When true (and `workspace_root` is set), read-only tools
    /// (Read/Grep/Glob/ListDirectory) execute inside the Rust process,
    /// bypassing the host round-trip.
    #[serde(default)]
    pub native_tools: bool,
}

/// LLM provider definition for MultiLLM.
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct LlmProviderDef {
    pub name: String,
    pub model: String,
    pub system_prompt: String,
}

/// Input for a cancel_turn RPC call.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct CancelTurnParams {
    pub turn_id: String,
}

/// A message in the conversation history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
    /// Optional multimodal content blocks. When non-empty, providers
    /// project these instead of the plain `content` string.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<ContentBlock>,
    /// Tool calls issued by an `assistant` message (empty otherwise).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<LlmToolCall>,
    /// For a `tool` message: the id of the tool call this result answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// Tool definition passed from the JS side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub input_schema: serde_json::Value,
}

/// Result of a run_turn RPC call.
#[derive(Debug, Serialize, Deserialize)]
pub struct RunTurnResult {
    pub stop_reason: String,
    pub steps: u32,
    pub usage: TokenUsage,
}

// ── LLM proxy types (Rust → JS host) ───────────────────────────────────────

/// Parameters for the host/llm_chat RPC call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmChatRequest {
    pub system_prompt: String,
    pub model_name: String,
    pub messages: Vec<LlmChatMessage>,
    pub tools: Vec<ToolDef>,
}

/// A message in the LLM chat request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmChatMessage {
    pub role: String,
    pub content: String,
    /// Optional multimodal content blocks (see [`ContentBlock`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<ContentBlock>,
}

/// Response from the host/llm_chat RPC call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmChatResponse {
    /// Assistant text content. The host proxy path may leave this empty
    /// (the host owns the transcript there); the native HTTP path fills it.
    #[serde(default)]
    pub content: String,
    pub tool_calls: Vec<LlmToolCall>,
    pub finish_reason: Option<String>,
    pub usage: TokenUsage,
}

/// A tool call from the LLM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

// ── Tool execution proxy types (Rust → JS host) ────────────────────────────

/// Parameters for the host/execute_tool RPC call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolExecuteRequest {
    pub turn_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
    /// When true, JS side should skip workspace index predictions and
    /// execute the tool precisely. Used by background prediction replacement.
    #[serde(default)]
    pub force_precise: bool,
}

/// Response from the host/execute_tool RPC call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct ToolExecuteResponse {
    pub content: String,
    pub is_error: bool,
    /// When true, the result is a fast prediction from the workspace index
    /// rather than the precise execution output. The caller should use this
    /// immediately and spawn background precise execution to replace it later.
    #[serde(default)]
    pub is_prediction: bool,
}

/// Token usage tracking.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    #[serde(default)]
    pub input_tokens: u32,
    #[serde(default)]
    pub output_tokens: u32,
    #[serde(default)]
    pub total_tokens: u32,
}

// ── Tool hook request/response types (tool_call.rs lifecycle) ─────────────

/// Request for the prepare_tool_execution hook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrepareToolRequest {
    pub turn_id: String,
    pub step_number: u32,
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
    #[serde(default)]
    pub all_tool_calls: Vec<serde_json::Value>,
    pub trace_id: Option<String>,
}

/// Response from the prepare_tool_execution hook.
/// `None` = allow unchanged; `Some` = decision.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrepareToolResponse {
    /// When true, the tool call is blocked.
    #[serde(default)]
    pub block: bool,
    /// Reason for blocking (when block is true).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Synthetic result to use instead of executing (when block is false).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synthetic_result: Option<ExecutableToolResultData>,
    /// Updated arguments for the tool call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_args: Option<serde_json::Value>,
    /// Execution metadata (opaque, passed through to tool execution).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_metadata: Option<serde_json::Value>,
    /// When true, this is a resolved decision (not a pass-through).
    #[serde(default)]
    pub resolved: bool,
}

/// Request for the authorize_tool_execution hook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorizeToolRequest {
    pub turn_id: String,
    pub step_number: u32,
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
    #[serde(default)]
    pub all_tool_calls: Vec<serde_json::Value>,
    pub trace_id: Option<String>,
    pub approval_rule: String,
}

/// Response from the authorize_tool_execution hook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorizeToolResponse {
    /// When true, the tool call is blocked.
    #[serde(default)]
    pub block: bool,
    /// Reason for blocking (when block is true).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Synthetic result to use instead of executing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synthetic_result: Option<ExecutableToolResultData>,
    /// Execution metadata (opaque, passed through to tool execution).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_metadata: Option<serde_json::Value>,
    /// When true, this is a resolved decision (not a pass-through).
    #[serde(default)]
    pub resolved: bool,
}

/// Request for the finalize_tool_result hook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinalizeToolRequest {
    pub turn_id: String,
    pub step_number: u32,
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
    pub result: ExecutableToolResultData,
    pub trace_id: Option<String>,
}

/// Response from the finalize_tool_result hook.
/// When `None`, the original result is used unchanged.
pub type FinalizeToolResponse = Option<ExecutableToolResultData>;

/// Serializable tool result data for RPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutableToolResultData {
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default)]
    pub is_prediction: bool,
    #[serde(default)]
    pub stop_turn: bool,
}

/// Health check response.
#[derive(Debug, Serialize)]
pub struct HealthStatus {
    pub status: String,
    pub version: String,
}

// ── Helper functions ───────────────────────────────────────────────────────

impl JsonRpcResponse {
    pub fn ok(id: RequestId, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result,
        }
    }
}

impl JsonRpcErrorResponse {
    pub fn new(id: RequestId, code: i32, message: String) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            error: JsonRpcError {
                code,
                message,
                data: None,
            },
        }
    }
}

impl JsonRpcError {
    #[allow(dead_code)]
    pub fn parse_error() -> Self {
        Self {
            code: -32700,
            message: "Parse error".into(),
            data: None,
        }
    }
    #[allow(dead_code)]
    pub fn invalid_request() -> Self {
        Self {
            code: -32600,
            message: "Invalid Request".into(),
            data: None,
        }
    }
    #[allow(dead_code)]
    pub fn method_not_found(method: &str) -> Self {
        Self {
            code: -32601,
            message: format!("Method not found: {method}"),
            data: None,
        }
    }
    pub fn internal_error(msg: String) -> Self {
        Self {
            code: -32603,
            message: msg,
            data: None,
        }
    }
}

// ── Cron RPC types ────────────────────────────────────────────────────────────

/// Parameters for cron/create.
#[derive(Debug, Deserialize)]
pub struct CronCreateParams {
    pub cron: String,
    pub prompt: String,
    #[serde(default)]
    pub recurring: Option<bool>,
}

/// Result of cron/create.
#[derive(Debug, Serialize)]
pub struct CronCreateResult {
    pub id: String,
    pub cron: String,
    pub prompt: String,
    pub created_at: u64,
    pub recurring: bool,
}

/// Parameters for cron/delete.
#[derive(Debug, Deserialize)]
pub struct CronDeleteParams {
    pub ids: Vec<String>,
}

/// Result of cron/delete.
#[derive(Debug, Serialize)]
pub struct CronDeleteResult {
    pub removed: Vec<String>,
}

/// A cron task snapshot returned by cron/list.
#[derive(Debug, Serialize)]
pub struct CronTaskSnapshotRpc {
    pub id: String,
    pub cron: String,
    pub recurring: bool,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_fired_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_fire_at: Option<u64>,
}

/// Result of cron/list.
#[derive(Debug, Serialize)]
pub struct CronListResult {
    pub tasks: Vec<CronTaskSnapshotRpc>,
}

/// Parameters for cron/get_next_fire.
#[derive(Debug, Deserialize)]
pub struct CronGetNextFireParams {
    #[serde(default)]
    pub task_id: Option<String>,
}

/// Result of cron/get_next_fire.
#[derive(Debug, Serialize)]
pub struct CronGetNextFireResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_fire_at: Option<u64>,
}

/// Cron fire event payload (Rust → JS via host/event).
#[derive(Debug, Serialize)]
pub struct CronFireEventPayload {
    pub r#type: String,
    pub job_id: String,
    pub cron: String,
    pub recurring: bool,
    pub coalesced_count: u32,
    pub stale: bool,
    pub prompt: String,
}

// ── Background RPC types ───────────────────────────────────────────────────────

/// Parameters for bg/register.
#[derive(Debug, Deserialize)]
pub struct BgRegisterParams {
    pub prefix: String,
    pub kind: String,
    pub description: String,
    #[serde(default)]
    pub detached: Option<bool>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// Result of bg/register.
#[derive(Debug, Serialize)]
pub struct BgRegisterResult {
    pub task_id: Option<String>,
    pub error: Option<String>,
}

/// Parameters for bg/get.
#[derive(Debug, Deserialize)]
pub struct BgGetParams {
    pub task_id: String,
}

/// Parameters for bg/stop.
#[derive(Debug, Deserialize)]
pub struct BgStopParams {
    pub task_id: String,
    #[serde(default)]
    pub reason: Option<String>,
}

/// Parameters for bg/output.
#[derive(Debug, Deserialize)]
pub struct BgOutputParams {
    pub task_id: String,
}

/// Result of bg/output.
#[derive(Debug, Serialize)]
pub struct BgOutputResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    pub output_size_bytes: u64,
    pub preview_bytes: u64,
    pub truncated: bool,
    pub full_output_available: bool,
    pub preview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Parameters for bg/append_output.
#[derive(Debug, Deserialize)]
pub struct BgAppendOutputParams {
    pub task_id: String,
    pub chunk: String,
}

/// Parameters for bg/settle.
#[derive(Debug, Deserialize)]
pub struct BgSettleParams {
    pub task_id: String,
    pub status: String,
    #[serde(default)]
    pub stop_reason: Option<String>,
}

/// Background task event payload (Rust → JS via host/event).
#[derive(Debug, Serialize)]
pub struct BgEventPayload {
    pub r#type: String,
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_run_turn_params_serialization() {
        let json = serde_json::json!({
            "turn_id": "turn-1",
            "system_prompt": "You are a helpful assistant.",
            "model_name": "gpt-4",
            "messages": [
                {"role": "user", "content": "Hello"}
            ],
            "tools": [
                {"name": "read", "description": "Read a file", "input_schema": {"type": "object"}}
            ],
            "max_steps": 10
        });
        let params: RunTurnParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.turn_id, "turn-1");
        assert_eq!(params.model_name, "gpt-4");
        assert_eq!(params.messages.len(), 1);
        assert_eq!(params.tools.len(), 1);
        assert_eq!(params.max_steps, Some(10));
        assert!(params.providers.is_empty());
    }

    #[test]
    fn test_run_turn_params_with_providers() {
        let json = serde_json::json!({
            "turn_id": "turn-1",
            "system_prompt": "",
            "model_name": "",
            "messages": [],
            "tools": [],
            "providers": [
                {"name": "fast", "model": "gpt-4o-mini", "system_prompt": "You are fast."},
                {"name": "smart", "model": "claude-opus-4", "system_prompt": "You are smart."}
            ]
        });
        let params: RunTurnParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.providers.len(), 2);
        assert_eq!(params.providers[0].name, "fast");
        assert_eq!(params.providers[0].model, "gpt-4o-mini");
        assert_eq!(params.providers[1].name, "smart");
    }

    #[test]
    fn test_run_turn_result_roundtrip() {
        let result = RunTurnResult {
            stop_reason: "EndTurn".to_string(),
            steps: 3,
            usage: TokenUsage { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["stop_reason"], "EndTurn");
        assert_eq!(json["steps"], 3);
        assert_eq!(json["usage"]["input_tokens"], 100);

        let deserialized: RunTurnResult = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.stop_reason, "EndTurn");
        assert_eq!(deserialized.steps, 3);
    }

    #[test]
    fn test_llm_chat_request_roundtrip() {
        let req = LlmChatRequest {
            system_prompt: "You are helpful.".to_string(),
            model_name: "gpt-4".to_string(),
            messages: vec![
                LlmChatMessage { role: "user".to_string(), content: "Hi".to_string(), blocks: Vec::new() },
            ],
            tools: vec![
                ToolDef {
                    name: "read".to_string(),
                    description: "Read file".to_string(),
                    input_schema: serde_json::json!({"type": "object"}),
                },
            ],
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["system_prompt"], "You are helpful.");
        assert_eq!(json["messages"][0]["role"], "user");

        let deserialized: LlmChatRequest = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.system_prompt, req.system_prompt);
        assert_eq!(deserialized.messages.len(), 1);
        assert_eq!(deserialized.tools.len(), 1);
    }

    #[test]
    fn test_llm_chat_response_roundtrip() {
        let resp = LlmChatResponse {
            content: String::new(),
            tool_calls: vec![
                LlmToolCall {
                    id: "call_1".to_string(),
                    name: "read".to_string(),
                    arguments: serde_json::json!({"path": "/tmp/test.txt"}),
                },
            ],
            finish_reason: Some("stop".to_string()),
            usage: TokenUsage { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["tool_calls"][0]["name"], "read");
        assert_eq!(json["finish_reason"], "stop");

        let deserialized: LlmChatResponse = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.tool_calls.len(), 1);
        assert_eq!(deserialized.tool_calls[0].id, "call_1");
        assert_eq!(deserialized.finish_reason, Some("stop".to_string()));
    }

    #[test]
    fn test_tool_execute_request_roundtrip() {
        let req = ToolExecuteRequest {
            turn_id: "turn-1".to_string(),
            tool_call_id: "call_1".to_string(),
            tool_name: "read".to_string(),
            arguments: serde_json::json!({"path": "/tmp/test.txt", "line_offset": 1}),
            force_precise: false,
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["tool_name"], "read");
        assert_eq!(json["arguments"]["path"], "/tmp/test.txt");

        let deserialized: ToolExecuteRequest = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.turn_id, "turn-1");
        assert_eq!(deserialized.tool_name, "read");
    }

    #[test]
    fn test_tool_execute_request_force_precise_default() {
        // Test that force_precise defaults to false when deserializing
        let json = serde_json::json!({
            "turn_id": "turn-1",
            "tool_call_id": "call_1",
            "tool_name": "read",
            "arguments": {"path": "/tmp/test.txt"}
        });
        let req: ToolExecuteRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.turn_id, "turn-1");
        assert!(!req.force_precise);
    }

    #[test]
    fn test_tool_execute_request_force_precise_true() {
        let req = ToolExecuteRequest {
            turn_id: "turn-1".to_string(),
            tool_call_id: "call_1".to_string(),
            tool_name: "read".to_string(),
            arguments: serde_json::json!({"path": "/tmp/test.txt"}),
            force_precise: true,
        };
        assert!(req.force_precise);
        let json = serde_json::to_value(&req).unwrap();
        assert!(json["force_precise"].as_bool().unwrap());
    }

    #[test]
    fn test_tool_execute_response_roundtrip() {
        let resp = ToolExecuteResponse {
            content: "file content here".to_string(),
            is_error: false,
            is_prediction: false,
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["content"], "file content here");
        assert!(!json["is_error"].as_bool().unwrap());

        let deserialized: ToolExecuteResponse = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.content, "file content here");
        assert!(!deserialized.is_error);
    }

    #[test]
    fn test_tool_execute_response_error() {
        let resp = ToolExecuteResponse {
            content: "File not found".to_string(),
            is_error: true,
            is_prediction: false,
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert!(json["is_error"].as_bool().unwrap());

        let deserialized: ToolExecuteResponse = serde_json::from_value(json).unwrap();
        assert!(deserialized.is_error);
    }

    #[test]
    fn test_health_status() {
        let status = HealthStatus {
            status: "ok".to_string(),
            version: "0.1.0".to_string(),
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["status"], "ok");
        assert_eq!(json["version"], "0.1.0");
    }

    #[test]
    fn test_message_roundtrip() {
        let msg = Message {
            role: "user".to_string(),
            content: "Hello world".to_string(),
            blocks: Vec::new(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["role"], "user");

        let deserialized: Message = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.role, "user");
        assert_eq!(deserialized.content, "Hello world");
    }

    #[test]
    fn test_tool_def_roundtrip() {
        let def = ToolDef {
            name: "grep".to_string(),
            description: "Search text".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"}
                }
            }),
        };
        let json = serde_json::to_value(&def).unwrap();
        let deserialized: ToolDef = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.name, "grep");
        assert!(deserialized.input_schema["properties"]["pattern"]["type"].as_str().is_some());
    }

    #[test]
    fn test_token_usage_default() {
        let usage = TokenUsage::default();
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.output_tokens, 0);
        assert_eq!(usage.total_tokens, 0);
    }

    #[test]
    fn test_token_usage_roundtrip() {
        let usage = TokenUsage { input_tokens: 100, output_tokens: 50, total_tokens: 150 };
        let json = serde_json::to_value(&usage).unwrap();
        assert_eq!(json["input_tokens"], 100);
        assert_eq!(json["output_tokens"], 50);
        assert_eq!(json["total_tokens"], 150);

        let deserialized: TokenUsage = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.input_tokens, 100);
        assert_eq!(deserialized.output_tokens, 50);
    }

    #[test]
    fn test_json_rpc_request_parse() {
        let json = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 42,
            "method": "agent/run_turn",
            "params": {"key": "value"}
        });
        let req: JsonRpcRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.jsonrpc, "2.0");
        assert_eq!(req.id, 42);
        assert_eq!(req.method, "agent/run_turn");
        assert_eq!(req.params["key"], "value");
    }

    #[test]
    fn test_json_rpc_request_notification() {
        // Notification has no id
        let json = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "agent/notify",
            "params": {}
        });
        let req: JsonRpcRequest = serde_json::from_value(json).unwrap();
        assert!(req.id.is_null());
    }

    #[test]
    fn test_json_rpc_response_ok() {
        let resp = JsonRpcResponse::ok(serde_json::json!(1), serde_json::json!({"result": "ok"}));
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["jsonrpc"], "2.0");
        assert_eq!(json["id"], 1);
        assert_eq!(json["result"]["result"], "ok");
    }

    #[test]
    fn test_json_rpc_error_response() {
        let err = JsonRpcErrorResponse::new(serde_json::json!(null), -32700, "Parse error".to_string());
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["error"]["code"], -32700);
        assert_eq!(json["error"]["message"], "Parse error");
        assert!(json["error"].get("data").is_none());
    }

    #[test]
    fn test_json_rpc_error_with_data() {
        let err = JsonRpcError {
            code: -32000,
            message: "Custom error".to_string(),
            data: Some(serde_json::json!({"detail": "something broke"})),
        };
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], -32000);
        assert_eq!(json["data"]["detail"], "something broke");
    }

    #[test]
    fn test_methods_constants() {
        assert_eq!(methods::RUN_TURN, "agent/run_turn");
        assert_eq!(methods::CANCEL_TURN, "agent/cancel_turn");
        assert_eq!(methods::HEALTH, "agent/health");
        assert_eq!(methods::SHUTDOWN, "agent/shutdown");
        assert_eq!(methods::HOST_LLM_CHAT, "host/llm_chat");
        assert_eq!(methods::HOST_EXECUTE_TOOL, "host/execute_tool");
    }

    #[test]
    fn test_llm_provider_def_deserialize() {
        let json = serde_json::json!({
            "name": "fast-llm",
            "model": "gpt-4o-mini",
            "system_prompt": "You are fast."
        });
        let def: LlmProviderDef = serde_json::from_value(json).unwrap();
        assert_eq!(def.name, "fast-llm");
        assert_eq!(def.model, "gpt-4o-mini");
        assert_eq!(def.system_prompt, "You are fast.");
    }

    #[test]
    fn test_notification_parse() {
        let json = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "host/event",
            "params": {"type": "progress"}
        });
        let notif: JsonRpcNotification = serde_json::from_value(json).unwrap();
        assert_eq!(notif.jsonrpc, "2.0");
        assert_eq!(notif.method, "host/event");
        assert_eq!(notif.params["type"], "progress");
    }

    #[test]
    fn test_llm_tool_call_roundtrip() {
        let tc = LlmToolCall {
            id: "call_abc".to_string(),
            name: "read_file".to_string(),
            arguments: serde_json::json!({"path": "/tmp/x.txt"}),
        };
        let json = serde_json::to_value(&tc).unwrap();
        let deserialized: LlmToolCall = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.id, "call_abc");
        assert_eq!(deserialized.name, "read_file");
    }

    #[test]
    fn test_empty_providers_default() {
        let json = serde_json::json!({
            "turn_id": "t1",
            "system_prompt": "hi",
            "model_name": "m",
            "messages": [],
            "tools": []
        });
        let params: RunTurnParams = serde_json::from_value(json).unwrap();
        assert!(params.providers.is_empty());
    }

    #[test]
    fn test_tool_def_empty_schema() {
        let def = ToolDef {
            name: "bash".to_string(),
            description: "Run shell".to_string(),
            input_schema: serde_json::Value::Object(Default::default()),
        };
        let json = serde_json::to_value(&def).unwrap();
        let deserialized: ToolDef = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.name, "bash");
        assert!(deserialized.input_schema.as_object().unwrap().is_empty());
    }

    // ── Cron RPC roundtrip tests ──────────────────────────────────────────────

    #[test]
    fn test_cron_create_params_roundtrip() {
        let json = serde_json::json!({
            "cron": "0 9 * * *",
            "prompt": "morning reminder",
            "recurring": true
        });
        let params: CronCreateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.cron, "0 9 * * *");
        assert_eq!(params.prompt, "morning reminder");
        assert_eq!(params.recurring, Some(true));
    }

    #[test]
    fn test_cron_create_params_defaults() {
        let json = serde_json::json!({
            "cron": "*/5 * * * *",
            "prompt": "every 5"
        });
        let params: CronCreateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.cron, "*/5 * * * *");
        assert_eq!(params.recurring, None); // default
    }

    #[test]
    fn test_cron_delete_params_roundtrip() {
        let json = serde_json::json!({
            "ids": ["abc12345", "def67890"]
        });
        let params: CronDeleteParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.ids.len(), 2);
        assert_eq!(params.ids[0], "abc12345");
    }

    #[test]
    fn test_cron_create_result_roundtrip() {
        let result = CronCreateResult {
            id: "abc12345".into(),
            cron: "0 9 * * *".into(),
            prompt: "test".into(),
            created_at: 1000,
            recurring: true,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["id"], "abc12345");
        assert_eq!(json["recurring"], true);
        assert_eq!(json["created_at"], 1000);
    }

    // ── Background RPC roundtrip tests ─────────────────────────────────────────

    #[test]
    fn test_bg_register_params_roundtrip() {
        let json = serde_json::json!({
            "prefix": "bash",
            "kind": "process",
            "description": "echo hello",
            "detached": true,
            "timeout_ms": 30000
        });
        let params: BgRegisterParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.prefix, "bash");
        assert_eq!(params.kind, "process");
        assert_eq!(params.detached, Some(true));
        assert_eq!(params.timeout_ms, Some(30000));
    }

    #[test]
    fn test_bg_register_params_minimal() {
        let json = serde_json::json!({
            "prefix": "agent",
            "kind": "agent",
            "description": "subagent task"
        });
        let params: BgRegisterParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.prefix, "agent");
        assert!(params.detached.is_none());
        assert!(params.timeout_ms.is_none());
    }

    #[test]
    fn test_bg_settle_params_roundtrip() {
        let json = serde_json::json!({
            "task_id": "bash-abc123",
            "status": "completed",
            "stop_reason": "finished successfully"
        });
        let params: BgSettleParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.task_id, "bash-abc123");
        assert_eq!(params.status, "completed");
        assert_eq!(params.stop_reason.unwrap(), "finished successfully");
    }

    #[test]
    fn test_cron_fire_event_payload() {
        let payload = CronFireEventPayload {
            r#type: "cron.fired".into(),
            job_id: "abc12345".into(),
            cron: "0 9 * * *".into(),
            recurring: true,
            coalesced_count: 1,
            stale: false,
            prompt: "morning reminder".into(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["type"], "cron.fired");
        assert_eq!(json["job_id"], "abc12345");
        assert_eq!(json["coalesced_count"], 1);
    }
}