/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * TypeScript mirror of the Rust JSON-RPC wire contract
 * (`packages/kimi-agent/src/rpc/types.rs` + referenced crate types).
 * Field names/optionality follow serde exactly (snake_case, `#[serde(default)]`
 * → optional, `Option<T>` → `T | undefined`).
 *
 * Regenerate with: `pnpm gen:wire`
 */

export interface JsonRpcRequest {
  jsonrpc: string;
  id?: unknown;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: string;
  id: unknown;
  error: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: string;
  method: string;
  params?: unknown;
}

export interface NativeLlmConfig {
  /** Wire protocol: `"openai"` (Chat Completions), `"anthropic"` (Messages), or `"google"` / `"google-genai"` (Gemini streamGenerateContent). */
  protocol: string;
  /** API base URL including the version segment (e.g. `https://api.example.com/v1`, or `https://generativelanguage.googleapis.com/v1beta` for Gemini). */
  base_url: string;
  /** Bearer token (OpenAI), x-api-key (Anthropic), or x-goog-api-key (Gemini). */
  api_key: string;
  /** Model name sent to the provider. */
  model: string;
  max_tokens?: number | undefined;
  custom_headers?: Record<string, string>;
  reasoning_effort?: string | undefined;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; media_type: string; data: string }
  | { type: 'image_url'; url: string };

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface Message {
  role: string;
  content: string;
  blocks?: Array<ContentBlock>;
  tool_calls?: Array<LlmToolCall>;
  tool_call_id?: string | undefined;
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema?: unknown;
}

export interface LlmProviderDef {
  name: string;
  model: string;
  system_prompt: string;
}

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'budgetLimited' | 'usageLimited';

export interface GoalContext {
  goal_id: string;
  objective: string;
  status: GoalStatus;
  /** Optional token budget (total tokens allowed). */
  token_budget?: number | undefined;
  /** Optional turn budget (max turns). */
  turn_budget?: number | undefined;
  /** Cumulative tokens consumed so far (before this turn). */
  tokens_used: number;
  /** Cumulative turns run so far (before this turn). */
  turns_used: number;
}

export interface RunTurnParams {
  turn_id: string;
  system_prompt: string;
  model_name: string;
  messages: Array<Message>;
  tools: Array<ToolDef>;
  max_steps?: number | undefined;
  providers?: Array<LlmProviderDef>;
  goal?: GoalContext | undefined;
  native_llm?: NativeLlmConfig | undefined;
  workspace_root?: string | undefined;
  native_tools?: boolean;
}

export interface CancelTurnParams {
  turn_id: string;
}

export interface McpServerSpecInput {
  name: string;
  transport?: string | undefined;
  enabled?: boolean | undefined;
  command?: string | undefined;
  args?: Array<string>;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  url?: string | undefined;
  enabled_tools?: Array<string> | undefined;
  disabled_tools?: Array<string> | undefined;
  bearer_token?: string | undefined;
  bearer_token_env_var?: string | undefined;
  startup_timeout_ms?: number | undefined;
  tool_timeout_ms?: number | undefined;
  has_headers?: boolean | undefined;
  project_root?: boolean | undefined;
}

export interface SkillMetadataInput {
  name: string;
  description?: string;
  skill_type?: string;
  source?: string | undefined;
  path?: string | undefined;
  dir?: string | undefined;
  content?: string | undefined;
}

export type HookEventType = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PermissionRequest' | 'PermissionResult' | 'UserPromptSubmit' | 'Stop' | 'StopFailure' | 'Interrupt' | 'SessionStart' | 'SessionEnd' | 'SubagentStart' | 'SubagentStop' | 'PreCompact' | 'PostCompact' | 'Notification';

export interface HookDef {
  /** The event that triggers this hook. */
  event: HookEventType;
  matcher?: string | undefined;
  /** The shell command to execute. */
  command: string;
  timeout?: number | undefined;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
}

export interface SessionCreateParams {
  session_id?: string | undefined;
  homedir?: string | undefined;
  system_prompt?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  goal_enabled?: boolean | undefined;
  native_llm?: NativeLlmConfig | undefined;
  tools?: Array<ToolDef>;
  mcp_servers?: Array<McpServerSpecInput>;
  skills?: Array<SkillMetadataInput>;
  hooks?: Array<HookDef>;
  native_tools?: boolean;
}

export interface SessionPromptParams {
  session_id: string;
  /** Content parts on the context wire shape: `[{"type":"text","text":…}]`. */
  input: unknown;
  agent_id?: string | undefined;
}

export interface SessionIdParams {
  session_id: string;
}

export interface SessionSetModelParams {
  session_id: string;
  model: string;
}

export interface SessionApprovalListParams {
  session_id?: string | undefined;
}

export interface SessionApprovalResolveParams {
  session_id?: string | undefined;
  id: string;
  decision: string;
  reason?: string | undefined;
}

export interface SessionGoalCreateParams {
  session_id: string;
  objective: string;
  completion_criterion?: string | undefined;
  replace?: boolean;
}

export interface SessionGoalParams {
  session_id: string;
}

export interface SessionGoalReasonParams {
  session_id: string;
  reason?: string | undefined;
}

export interface SessionSetSwarmModeParams {
  session_id: string;
  enabled: boolean;
  trigger?: string | undefined;
}

export interface SessionSetPlanModeParams {
  session_id: string;
  enabled: boolean;
}

export interface SessionCompactParams {
  session_id: string;
  instruction?: string | undefined;
}

export interface SessionImportContextParams {
  session_id: string;
  content: string;
  source: string;
}

export interface SessionUndoHistoryParams {
  session_id: string;
  count?: number;
}

export interface SessionActivateSkillParams {
  session_id: string;
  name: string;
  args?: string | undefined;
}

export interface SessionReconnectMcpParams {
  session_id: string;
  name: string;
}

export interface PluginGetParams {
  id: string;
}

export interface SessionInitParams {
  session_id: string;
}

export interface GitStatusParams {
  cwd: string;
}

export interface GitDiffParams {
  cwd: string;
  path: string;
}

export interface SessionRunShellParams {
  session_id: string;
  command: string;
  timeout_s?: number | undefined;
  command_id?: string | undefined;
}

export interface SessionCancelShellParams {
  session_id: string;
  command_id: string;
}

export interface SessionSetThinkingParams {
  session_id: string;
  effort?: string | undefined;
}

export interface SessionSteerParams {
  session_id: string;
  input: unknown;
}

export interface SessionAddDirParams {
  session_id: string;
  path: string;
}

export interface SessionAddDirResult {
  success: boolean;
  additional_dirs: Array<string>;
}

export interface SessionRemoveDirParams {
  session_id: string;
  path: string;
}

export interface SessionRemoveDirResult {
  success: boolean;
  additional_dirs: Array<string>;
}

export interface SessionUpdateMetadataParams {
  session_id: string;
  metadata: unknown;
}

export interface SessionListParams {
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface RunTurnResult {
  stop_reason: string;
  steps: number;
  usage: TokenUsage;
}

export interface LlmChatMessage {
  role: string;
  content: string;
  blocks?: Array<ContentBlock>;
}

export interface LlmChatRequest {
  session_id?: string | undefined;
  system_prompt: string;
  model_name: string;
  messages: Array<LlmChatMessage>;
  tools: Array<ToolDef>;
}

export interface LlmChatResponse {
  content?: string;
  tool_calls: Array<LlmToolCall>;
  finish_reason?: string | undefined;
  usage: TokenUsage;
}

export interface ToolExecuteRequest {
  session_id?: string | undefined;
  turn_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments: unknown;
  force_precise?: boolean;
}

export interface ToolExecuteResponse {
  content: string;
  is_error: boolean;
  is_prediction?: boolean;
  stop_turn?: boolean;
  media?: Array<ContentBlock>;
}

export interface PrepareToolRequest {
  session_id?: string | undefined;
  turn_id: string;
  step_number: number;
  tool_call_id: string;
  tool_name: string;
  arguments: unknown;
  all_tool_calls?: Array<unknown>;
  trace_id?: string | undefined;
}

export interface ExecutableToolResultData {
  content: string;
  is_error?: boolean;
  note?: string | undefined;
  is_prediction?: boolean;
  stop_turn?: boolean;
}

export interface PrepareToolResponse {
  block?: boolean;
  reason?: string | undefined;
  synthetic_result?: ExecutableToolResultData | undefined;
  updated_args?: unknown;
  execution_metadata?: unknown;
  resolved?: boolean;
}

export interface AuthorizeToolRequest {
  session_id?: string | undefined;
  turn_id: string;
  step_number: number;
  tool_call_id: string;
  tool_name: string;
  arguments: unknown;
  all_tool_calls?: Array<unknown>;
  trace_id?: string | undefined;
  approval_rule: string;
}

export interface AuthorizeToolResponse {
  block?: boolean;
  reason?: string | undefined;
  synthetic_result?: ExecutableToolResultData | undefined;
  execution_metadata?: unknown;
  resolved?: boolean;
}

export interface FinalizeToolRequest {
  session_id?: string | undefined;
  turn_id: string;
  step_number: number;
  tool_call_id: string;
  tool_name: string;
  arguments: unknown;
  result: ExecutableToolResultData;
  trace_id?: string | undefined;
}

export interface HealthStatus {
  status: string;
  version: string;
}

export interface CronCreateParams {
  cron: string;
  prompt: string;
  recurring?: boolean | undefined;
}

export interface CronCreateResult {
  id: string;
  cron: string;
  prompt: string;
  created_at: number;
  recurring: boolean;
}

export interface CronDeleteParams {
  ids: Array<string>;
}

export interface CronDeleteResult {
  removed: Array<string>;
}

export interface CronTaskSnapshotRpc {
  id: string;
  cron: string;
  recurring: boolean;
  created_at: number;
  last_fired_at?: number | undefined;
  next_fire_at?: number | undefined;
}

export interface CronListResult {
  tasks: Array<CronTaskSnapshotRpc>;
}

export interface CronGetNextFireParams {
  task_id?: string | undefined;
}

export interface CronGetNextFireResult {
  next_fire_at?: number | undefined;
}

export interface CronFireEventPayload {
  type: string;
  job_id: string;
  cron: string;
  recurring: boolean;
  coalesced_count: number;
  stale: boolean;
  prompt: string;
}

export interface BgRegisterParams {
  prefix: string;
  kind: string;
  description: string;
  detached?: boolean | undefined;
  timeout_ms?: number | undefined;
}

export interface BgRegisterResult {
  task_id?: string | undefined;
  error?: string | undefined;
}

export interface BgGetParams {
  task_id: string;
}

export interface BgStopParams {
  task_id: string;
  reason?: string | undefined;
}

export interface BgOutputParams {
  task_id: string;
}

export interface BgOutputResult {
  output_path?: string | undefined;
  output_size_bytes: number;
  preview_bytes: number;
  truncated: boolean;
  full_output_available: boolean;
  preview: string;
  error?: string | undefined;
}

export interface BgAppendOutputParams {
  task_id: string;
  chunk: string;
}

export interface BgSettleParams {
  task_id: string;
  status: string;
  stop_reason?: string | undefined;
}

export interface BgEventPayload {
  type: string;
  task_id: string;
  status?: string | undefined;
  description?: string | undefined;
}

export type RequestId = unknown;

export type FinalizeToolResponse = ExecutableToolResultData | null;
