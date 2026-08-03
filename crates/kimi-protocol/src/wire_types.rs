//! Session RPC params/results wire types — moved from
//! `packages/kimi-agent/src/rpc/types.rs` (Rust-first migration, stage A).
//! Pure types only; engine-owned types (UsageStatus, TaskInfoBase, ...) stay
//! in kimi-core until stage A3.

use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;

/// A boxed future type alias for async handlers.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

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

/// Configuration for the native HTTP LLM transport. When present on
/// `RunTurnParams`, the Rust engine calls the provider directly over
/// HTTP with SSE streaming instead of proxying `llm_chat` to the JS host.
#[derive(Debug, Clone, Deserialize)]
pub struct NativeLlmConfig {
    /// Wire protocol: `"openai"` (Chat Completions), `"anthropic"` (Messages),
    /// or `"google"` / `"google-genai"` (Gemini streamGenerateContent).
    pub protocol: String,
    /// API base URL including the version segment (e.g. `https://api.example.com/v1`,
    /// or `https://generativelanguage.googleapis.com/v1beta` for Gemini).
    pub base_url: String,
    /// Bearer token (OpenAI), x-api-key (Anthropic), or x-goog-api-key (Gemini).
    pub api_key: String,
    /// Model name sent to the provider.
    pub model: String,
    /// `max_tokens` for the Anthropic Messages API (required there).
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// Extra headers sent with every request.
    #[serde(default)]
    pub custom_headers: std::collections::HashMap<String, String>,
    /// Reasoning effort (`"low"|"medium"|"high"`). Mapped per protocol:
    /// OpenAI → `reasoning_effort`; Anthropic → `thinking.budget_tokens`;
    /// Google → `generationConfig.thinkingConfig.thinkingBudget`.
    /// `None` omits it.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
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

/// Input for session/prompt.
#[derive(Debug, Deserialize)]
pub struct SessionPromptParams {
    pub session_id: String,
    /// Content parts on the context wire shape: `[{"type":"text","text":…}]`.
    pub input: serde_json::Value,
    /// When set to a side-question agent id (`btw-<session_id>`), drives that
    /// child instead of the main agent.
    #[serde(default)]
    pub agent_id: Option<String>,
}

/// Input for session/cancel · session/save · session/load.
#[derive(Debug, Deserialize)]
pub struct SessionIdParams {
    pub session_id: String,
}

/// Input for session/fork.
#[derive(Debug, Deserialize)]
pub struct SessionForkParams {
    /// The source session to fork from.
    pub session_id: String,
    /// The new session's id.
    pub fork_id: String,
    /// Optional title for the fork.
    #[serde(default)]
    pub title: Option<String>,
    /// Optional historical fork point: keep only conversation up to and
    /// including the turn at this 0-based index (each user-originated message
    /// starts a turn). Absent → copy the full conversation. Negative or
    /// out-of-range values are rejected with `request.invalid`.
    #[serde(default)]
    pub turn_index: Option<i64>,
}

/// Input for session/set_model.
#[derive(Debug, Deserialize)]
pub struct SessionSetModelParams {
    pub session_id: String,
    pub model: String,
}

/// Input for session/approval_list. The session id is optional: an empty or
/// absent value lists approvals across all sessions (the run_turn path has no
/// session id).
#[derive(Debug, Deserialize)]
pub struct SessionApprovalListParams {
    #[serde(default)]
    pub session_id: Option<String>,
}

/// Input for session/approval_resolve. The session id is optional: the
/// process-wide store resolves by approval id alone (run_turn path has none).
#[derive(Debug, Deserialize)]
pub struct SessionApprovalResolveParams {
    #[serde(default)]
    pub session_id: Option<String>,
    pub id: String,
    pub decision: String,
    #[serde(default)]
    pub reason: Option<String>,
}

/// Input for session/goal_create.
#[derive(Debug, Deserialize)]
pub struct SessionGoalCreateParams {
    pub session_id: String,
    pub objective: String,
    #[serde(default)]
    pub completion_criterion: Option<String>,
    #[serde(default)]
    pub replace: bool,
}

/// Input for session/goal_get, goal_cancel (session id only).
#[derive(Debug, Deserialize)]
pub struct SessionGoalParams {
    pub session_id: String,
}

/// Input for session/goal_pause and goal_resume (optional reason).
#[derive(Debug, Deserialize)]
pub struct SessionGoalReasonParams {
    pub session_id: String,
    #[serde(default)]
    pub reason: Option<String>,
}

/// Input for session/set_swarm_mode.
#[derive(Debug, Deserialize)]
pub struct SessionSetSwarmModeParams {
    pub session_id: String,
    pub enabled: bool,
    /// `manual` (persistent toggle) | `task` (one-shot prompt) | `tool`
    /// (silent). Defaults to `manual` when omitted; ignored on disable.
    #[serde(default)]
    pub trigger: Option<String>,
}

/// Input for session/set_plan_mode.
#[derive(Debug, Deserialize)]
pub struct SessionSetPlanModeParams {
    pub session_id: String,
    pub enabled: bool,
}

/// Input for session/compact (optional custom summarizer instruction).
#[derive(Debug, Deserialize)]
pub struct SessionCompactParams {
    pub session_id: String,
    #[serde(default)]
    pub instruction: Option<String>,
}

/// Input for session/import_context.
#[derive(Debug, Deserialize)]
pub struct SessionImportContextParams {
    pub session_id: String,
    pub content: String,
    pub source: String,
}

/// Input for session/undo_history (defaults to 1 turn when omitted).
#[derive(Debug, Deserialize)]
pub struct SessionUndoHistoryParams {
    pub session_id: String,
    #[serde(default = "default_undo_count")]
    pub count: usize,
}

fn default_undo_count() -> usize {
    1
}

/// Input for session/activate_skill.
#[derive(Debug, Deserialize)]
pub struct SessionActivateSkillParams {
    pub session_id: String,
    pub name: String,
    #[serde(default)]
    pub args: Option<String>,
}

/// Input for session/reconnect_mcp_server.
#[derive(Debug, Deserialize)]
pub struct SessionReconnectMcpParams {
    pub session_id: String,
    pub name: String,
}

/// Input for plugin/get.
#[derive(Debug, Deserialize)]
pub struct PluginGetParams {
    pub id: String,
}

/// Input for session/export (stage 2c: kap-server Rust migration).
#[derive(Debug, Deserialize)]
pub struct SessionExportParams {    /// Session id to export.
    pub session_id: String,
    /// Session files directory to bundle (defaults to the process cwd when
    /// absent — the engine's session workdir convention).
    #[serde(default)]
    pub homedir: Option<String>,
    /// Bounded Web JSONL log supplied by the client (kap-server `/export`
    /// `web_log`); archived as `logs/kimi-web.jsonl` with a manifest entry.
    #[serde(default)]
    pub web_log: Option<String>,
}

/// Input for session/fs (stage 2d: read-class filesystem actions).
#[derive(Debug, Deserialize)]
pub struct SessionFsParams {    /// Session id (identity for the host).
    pub session_id: String,
    /// Action: `read` or `list` (globs are resolved against the workspace
    /// root via the native toolset).
    pub action: String,
    /// Workspace root (session workdir) — sandbox for the native toolset.
    pub homedir: Option<String>,    /// Target path (read) or glob pattern (list).
    pub path: Option<String>,
    /// Read window (line_offset/n_lines for `read`).
    #[serde(default)]
    pub line_offset: Option<i64>,
    #[serde(default)]
    pub n_lines: Option<u32>,
    /// Search query + limit (for `search`).
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// Input for session/list_tools (stage 3d). Unlike session/fs this carries no
/// action — the engine answers with its native toolset + goal tools for the
/// session workspace.
#[derive(Debug, Deserialize)]
pub struct SessionListToolsParams {
    /// Session id (identity for the host).
    pub session_id: String,
    /// Workspace root (session workdir) — sandbox for the native toolset.
    pub homedir: Option<String>,
}

/// Input for config/set (stage 2e: kap-server Rust migration). The patch is
/// a partial camelCase `KimiConfig`; fields absent (or `null`) keep the base
/// value during the merge.
#[derive(Debug, Deserialize)]
pub struct ConfigSetParams {
    pub patch: serde_json::Value,
}

/// Input for session/init (generate AGENTS.md via an init subagent).
#[derive(Debug, Deserialize)]
pub struct SessionInitParams {
    pub session_id: String,
}

/// Input for git/status.
#[derive(Debug, Deserialize)]
pub struct GitStatusParams {
    pub cwd: String,
}

/// Input for git/diff.
#[derive(Debug, Deserialize)]
pub struct GitDiffParams {
    pub cwd: String,
    pub path: String,
}

/// Input for session/run_shell (user-initiated `!` command).
#[derive(Debug, Deserialize)]
pub struct SessionRunShellParams {
    pub session_id: String,
    pub command: String,
    #[serde(default)]
    pub timeout_s: Option<u64>,
    /// When set, the command streams `shell.output` events tagged with this id
    /// and can be cancelled via `session/cancel_shell_command`.
    #[serde(default)]
    pub command_id: Option<String>,
}

/// Input for session/cancel_shell_command.
#[derive(Debug, Deserialize)]
pub struct SessionCancelShellParams {
    pub session_id: String,
    pub command_id: String,
}

/// Input for session/set_thinking. `effort` = "low"|"medium"|"high"; null clears.
#[derive(Debug, Deserialize)]
pub struct SessionSetThinkingParams {
    pub session_id: String,
    #[serde(default)]
    pub effort: Option<String>,
}

/// Input for session/steer. `input` = content parts on the context wire shape.
#[derive(Debug, Deserialize)]
pub struct SessionSteerParams {
    pub session_id: String,
    pub input: serde_json::Value,
}

/// Input for session/add_additional_dir.
#[derive(Debug, Deserialize)]
pub struct SessionAddDirParams {
    pub session_id: String,
    pub path: String,
}

/// Result of session/add_additional_dir.
#[derive(Debug, Serialize)]
pub struct SessionAddDirResult {
    pub success: bool,
    pub additional_dirs: Vec<String>,
}

/// Input for session/remove_additional_dir.
#[derive(Debug, Deserialize)]
pub struct SessionRemoveDirParams {
    pub session_id: String,
    pub path: String,
}

/// Result of session/remove_additional_dir.
#[derive(Debug, Serialize)]
pub struct SessionRemoveDirResult {
    pub success: bool,
    pub additional_dirs: Vec<String>,
}

/// Input for session/update_metadata. `metadata` is shallow-merged into the
/// session's persisted custom metadata (must be a JSON object).
#[derive(Debug, Deserialize)]
pub struct SessionUpdateMetadataParams {
    pub session_id: String,
    pub metadata: serde_json::Value,
}

/// Input for session/list.
#[derive(Debug, Default, Deserialize)]
pub struct SessionListParams {
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
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

/// Parameters for the host/llm_chat RPC call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmChatRequest {
    /// Owning session (multi-session thin clients route host callbacks by
    /// this). Stamped by the engine; absent on legacy callers.
    #[serde(default)]
    pub session_id: Option<String>,
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

/// Parameters for the host/execute_tool RPC call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolExecuteRequest {
    /// Owning session (see [`LlmChatRequest::session_id`]).
    #[serde(default)]
    pub session_id: Option<String>,
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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct ToolExecuteResponse {
    pub content: String,
    pub is_error: bool,
    /// When true, the result is a fast prediction from the workspace index
    /// rather than the precise execution output. The caller should use this
    /// immediately and spawn background precise execution to replace it later.
    #[serde(default)]
    pub is_prediction: bool,
    /// When true, executing this tool should stop the turn immediately.
    #[serde(default)]
    pub stop_turn: bool,
    /// Image parts produced by the tool (native ReadMediaFile / MCP images).
    /// Absent on the host wire (host-returned tools stay text); the loop
    /// delivers these as a follow-up `user` image message.
    #[serde(default)]
    pub media: Vec<ContentBlock>,
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

/// Request for the prepare_tool_execution hook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrepareToolRequest {
    /// Owning session (see [`LlmChatRequest::session_id`]).
    #[serde(default)]
    pub session_id: Option<String>,
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
    /// Owning session (see [`LlmChatRequest::session_id`]).
    #[serde(default)]
    pub session_id: Option<String>,
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
    /// Owning session (see [`LlmChatRequest::session_id`]).
    #[serde(default)]
    pub session_id: Option<String>,
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

/// A single MCP server view returned by `session/list_mcp_servers` and
/// `session/reconnect_mcp_server`. `transport` / `status` stay as strings:
/// the engine's typed enums serialize with non-snake_case values
/// (`pending-approval`, `needs-auth`) that would not survive a rename.
#[derive(Debug, Serialize)]
pub struct McpServerInfoRpc {
    pub name: String,
    pub transport: String,
    pub status: String,
    pub tool_count: usize,
    pub error: Option<String>,
}

/// Result of `session/list_mcp_servers`.
#[derive(Debug, Serialize)]
pub struct McpServerListResult {
    pub servers: Vec<McpServerInfoRpc>,
}

/// A registered skill view returned by `session/list_skills`. Deliberately a
/// dedicated wire shape (not `SkillMetadata`): the metadata struct carries a
/// `content` field that would serialize as `null` and change the wire.
#[derive(Debug, Serialize)]
pub struct SkillSummaryRpc {
    pub name: String,
    pub description: String,
    pub skill_type: String,
    pub source: Option<String>,
    pub path: Option<String>,
    pub dir: Option<String>,
}

/// Result of `session/list_skills`.
#[derive(Debug, Serialize)]
pub struct SkillListResult {
    pub skills: Vec<SkillSummaryRpc>,
}

/// One session warning returned by `session/get_warnings`.
#[derive(Debug, Serialize)]
pub struct SessionWarning {
    pub code: String,
    pub message: String,
    pub severity: String,
}

/// Result of `session/get_warnings`.
#[derive(Debug, Serialize)]
pub struct WarningsResult {
    pub warnings: Vec<SessionWarning>,
}

/// Result of `session/get_mcp_startup_metrics`.
#[derive(Debug, Serialize)]
pub struct McpStartupMetricsResult {
    pub duration_ms: u64,
}

/// Result of `session/list_tools` — native tool definitions (reuses `ToolDef`).
#[derive(Debug, Serialize)]
pub struct ListToolsResult {
    pub tools: Vec<ToolDef>,
}

/// A persisted-session summary returned by `session/list`. `title` /
/// `work_dir` are always present as strings (the record's own fields).
#[derive(Debug, Serialize)]
pub struct SessionSummaryRpc {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub title: String,
    pub work_dir: String,
}

/// Result of `session/list`.
#[derive(Debug, Serialize)]
pub struct SessionListResult {
    pub sessions: Vec<SessionSummaryRpc>,
}

/// A plugin summary returned by `plugin/list` (and embedded in `plugin/get`).
#[derive(Debug, Serialize)]
pub struct PluginSummaryRpc {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub enabled: bool,
    pub state: String,
    pub skill_count: usize,
    pub mcp_server_count: usize,
    pub enabled_mcp_server_count: usize,
    pub hook_count: usize,
    pub command_count: usize,
    pub has_errors: bool,
    pub source: String,
}

/// Result of `plugin/list`.
#[derive(Debug, Serialize)]
pub struct PluginListResult {
    pub plugins: Vec<PluginSummaryRpc>,
}

/// One MCP server contributed by a plugin (`plugin/get` detail).
#[derive(Debug, Serialize)]
pub struct PluginMcpServerInfoRpc {
    pub name: String,
    pub runtime_name: String,
    pub enabled: bool,
    pub transport: String,
    pub command: Option<String>,
    pub url: Option<String>,
}

/// A plugin detail returned by `plugin/get` (summary fields + detail extras).
#[derive(Debug, Serialize)]
pub struct PluginInfoRpc {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub enabled: bool,
    pub state: String,
    pub skill_count: usize,
    pub mcp_server_count: usize,
    pub enabled_mcp_server_count: usize,
    pub hook_count: usize,
    pub command_count: usize,
    pub has_errors: bool,
    pub source: String,
    pub root: String,
    pub installed_at: String,
    pub mcp_servers: Vec<PluginMcpServerInfoRpc>,
    pub diagnostics: Vec<serde_json::Value>,
}

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

