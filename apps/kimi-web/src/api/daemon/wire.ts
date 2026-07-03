// apps/kimi-web/src/api/daemon/wire.ts
// Daemon wire DTOs — ALL fields stay snake_case as they appear on the wire.
// No camelCase conversions here; that is mappers.ts's job.

// ---------------------------------------------------------------------------
// Envelope & Page
// ---------------------------------------------------------------------------

export interface WireEnvelope<T> {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
}

export interface WirePage<T> {
  items: T[];
  has_more: boolean;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type WireSessionStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_question'
  | 'aborted';

export interface WireSessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  context_tokens: number;
  context_limit: number;
  turn_count: number;
}

export interface WireSessionUsageDelta {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
}

export interface WirePermissionRule {
  id: string;
  tool_name: string;
  matcher?: {
    kind: 'command_prefix' | 'path_glob' | 'exact_input' | 'always';
    value?: string;
  };
  decision: 'approved';
  created_at: string;
  created_by: 'user' | 'agent';
}

export interface WireSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  status: WireSessionStatus;
  archived: boolean;
  current_prompt_id?: string;
  /** Text of the most recent user prompt, for search/preview. */
  last_prompt?: string;
  // PRESUMED — daemon adds this once it ships the workspace registry; until then
  // it is absent and the client maps sessions by metadata.cwd === workspace.root.
  workspace_id?: string;
  metadata: {
    cwd: string;
    [key: string]: unknown;
  };
  agent_config: {
    model: string;
    system_prompt?: string;
    tools?: string[];
    mcp_servers?: string[];
    // Runtime controls — optional on read (the daemon may not backfill them;
    // live values come from GET /sessions/{id}/status).
    thinking?: string;
    permission_mode?: string;
    plan_mode?: boolean;
    swarm_mode?: boolean;
    goal_objective?: string;
    goal_control?: 'pause' | 'resume' | 'cancel';
  };
  usage: WireSessionUsage;
  permission_rules: WirePermissionRule[];
  message_count: number;
  last_seq: number;
}

// GET /sessions/{id}/status — live runtime state, aligned with TUI /status.
export interface WireSessionRuntimeStatus {
  model?: string;
  thinking_level: string;
  permission: string;
  plan_mode: boolean;
  swarm_mode: boolean;
  context_tokens: number;
  max_context_tokens: number;
  context_usage: number;
}

// GET /sessions/{id}/warnings — session-level warnings (e.g. oversized AGENTS.md).
export interface WireSessionWarning {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

export interface WireSessionWarningsResponse {
  warnings: WireSessionWarning[];
}

// ---------------------------------------------------------------------------
// Workspace + daemon folder browser wire DTOs
// PRESUMED — not in the live daemon yet; isolated here, swap when backend ships.
// ---------------------------------------------------------------------------

export interface WireWorkspace {
  id: string;
  root: string;
  name: string;
  is_git_repo: boolean;
  branch: string | null;
  last_opened_at?: string;
  session_count: number;
}

export interface WireFsBrowseEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_git_repo: boolean;
  branch?: string;
}

export interface WireFsBrowseResult {
  path: string;
  parent: string | null;
  entries: WireFsBrowseEntry[];
}

export interface WireFsHomeResult {
  home: string;
  recent_roots: string[];
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export type WireMessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool_call_id: string; tool_name: string; input: unknown }
  | { type: 'tool_result'; tool_call_id: string; output: unknown; is_error?: boolean }
  | { type: 'image'; source: WireImageSource }
  | { type: 'video'; source: WireImageSource }
  | { type: 'file'; file_id: string; name: string; media_type: string; size: number }
  | { type: 'thinking'; thinking: string; signature?: string };

export type WireImageSource =
  | { kind: 'url'; url: string }
  | { kind: 'base64'; media_type: string; data: string }
  | { kind: 'file'; file_id: string };

export interface WireMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: WireMessageContent[];
  created_at: string;
  prompt_id?: string;
  parent_message_id?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export interface WirePromptSubmission {
  content: WireMessageContent[];
  metadata?: Record<string, unknown>;
  agent_id?: string;
  model?: string;
  thinking?: string;
  permission_mode?: string;
  plan_mode?: boolean;
  swarm_mode?: boolean;
  goal_objective?: string;
  goal_control?: 'pause' | 'resume' | 'cancel';
}

export interface WirePromptSubmitResult {
  prompt_id: string;
  user_message_id: string;
  /** 'running' = started immediately; 'queued' = parked behind the active prompt. */
  status?: 'running' | 'queued';
}

export interface WirePromptSteerResult {
  steered: boolean;
  prompt_ids: string[];
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export interface WireApprovalRequest {
  approval_id: string;
  session_id: string;
  turn_id?: number;
  tool_call_id: string;
  tool_name: string;
  action: string;
  /** ToolInputDisplay — 12 discriminated kinds; client falls back to generic.
      The daemon protocol field is `tool_input_display` (protocol/approval.ts);
      `display` is the stub daemon's older shape, kept for compatibility. */
  tool_input_display?: unknown;
  display?: unknown;
  expires_at: string;
  created_at: string;
}

export interface WireApprovalResponse {
  decision: 'approved' | 'rejected' | 'cancelled';
  scope?: 'session';
  feedback?: string;
  selected_label?: string;
}

// ---------------------------------------------------------------------------
// Question
// ---------------------------------------------------------------------------

export interface WireQuestionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  is_recommended?: boolean;
}

export interface WireQuestionItem {
  id: string;
  question: string;
  header?: string;
  body?: string;
  options: WireQuestionOption[];
  multi_select?: boolean;
  allow_other?: boolean;
  other_label?: string;
  other_description?: string;
}

export interface WireQuestionRequest {
  question_id: string;
  session_id: string;
  turn_id?: number;
  tool_call_id?: string;
  questions: WireQuestionItem[];
  created_at: string;
}

export type WireQuestionAnswer =
  | { kind: 'single'; option_id: string }
  | { kind: 'multi'; option_ids: string[] }
  | { kind: 'other'; text: string }
  | { kind: 'multi_with_other'; option_ids: string[]; other_text: string }
  | { kind: 'skipped' };

export interface WireQuestionResponse {
  answers: Record<string, WireQuestionAnswer>;
  method?: 'enter' | 'space' | 'number_key' | 'click';
  note?: string;
}

// ---------------------------------------------------------------------------
// Background Task
// ---------------------------------------------------------------------------

export type WireTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface WireBackgroundTask {
  id: string;
  session_id: string;
  kind: 'subagent' | 'bash' | 'tool';
  description: string;
  status: WireTaskStatus;
  command?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  output_preview?: string;
  output_bytes?: number;
  subagent_phase?: 'queued' | 'working' | 'suspended' | 'completed' | 'failed';
  subagent_type?: string;
  parent_tool_call_id?: string;
  suspended_reason?: string;
  swarm_index?: number;
}

// ---------------------------------------------------------------------------
// File System
// ---------------------------------------------------------------------------

export type WireFsKind = 'file' | 'directory' | 'symlink';

export interface WireFsEntry {
  path: string;
  name: string;
  kind: WireFsKind;
  size?: number;
  modified_at: string;
  etag?: string;
  mime?: string;
  language_id?: string;
  is_binary?: boolean;
  is_symlink_to?: string;
  git_status?: string;
  child_count?: number;
}

// ---------------------------------------------------------------------------
// Model + Provider wire DTOs
// PRESUMED — not in current daemon docs; isolated here, swap when backend defines them.
// ---------------------------------------------------------------------------

export interface WireModel {
  provider: string;
  model: string;
  display_name?: string;
  max_context_size: number;
  capabilities?: string[];
}

export interface WireProvider {
  id: string;
  type: string;
  base_url?: string;
  default_model?: string;
  has_api_key: boolean;
  status: 'connected' | 'error' | 'unconfigured';
  models?: string[];
}

export interface WireProviderRefreshResult {
  changed: Array<{
    provider_id: string;
    provider_name: string;
    added: number;
    removed: number;
  }>;
  unchanged: string[];
  failed: Array<{ provider: string; reason: string }>;
}

export interface WireConfigProvider {
  type: string;
  base_url?: string;
  default_model?: string;
  has_api_key: boolean;
}

export interface WireConfig {
  providers: Record<string, WireConfigProvider>;
  default_provider?: string;
  default_model?: string;
  models?: Record<string, unknown>;
  thinking?: unknown;
  plan_mode?: boolean;
  yolo?: boolean;
  default_permission_mode?: string;
  default_plan_mode?: boolean;
  permission?: unknown;
  hooks?: unknown[];
  services?: unknown;
  merge_all_available_skills?: boolean;
  extra_skill_dirs?: string[];
  loop_control?: unknown;
  background?: unknown;
  experimental?: Record<string, boolean>;
  telemetry?: boolean;
  raw?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Auth wire DTOs — REAL endpoints (GET /api/v1/auth, POST/GET/DELETE /api/v1/oauth/login, POST /api/v1/oauth/logout)
// ---------------------------------------------------------------------------

export interface WireManagedProvider {
  status: string;
  [key: string]: unknown;
}

export interface WireAuthResult {
  ready: boolean;
  providers_count: number;
  default_model: string | null;
  managed_provider: WireManagedProvider | null;
}

export interface WireOAuthLoginStartResult {
  flow_id: string;
  provider: string;
  verification_uri: string;
  verification_uri_complete: string;
  user_code: string;
  expires_in: number;
  interval: number;
  status: 'pending';
  expires_at: string;
}

export interface WireOAuthLoginPollResult {
  flow_id: string;
  status: 'pending' | 'authenticated' | 'expired' | 'cancelled';
  resolved_at?: string;
}

export interface WireOAuthCancelResult {
  cancelled: boolean;
  status: string;
}

export interface WireLogoutResult {
  logged_out: boolean;
}

// ---------------------------------------------------------------------------
// File upload wire DTOs
// ---------------------------------------------------------------------------

export interface WireFileMeta {
  id: string;
  name: string;
  media_type: string;
  size: number;
  created_at: string;
  expires_at?: string;
}

// ---------------------------------------------------------------------------
// WS Server frames (S→C)
// ---------------------------------------------------------------------------

/** All typed server-to-client WS frames */
export type WireServerFrame =
  | WireServerHello
  | WireAck
  | WirePing
  | WireResyncRequired
  | WireErrorFrame
  | WireEvent;

export interface WireServerHello {
  type: 'server_hello';
  timestamp: string;
  payload: {
    server_id: string;
    heartbeat_ms: number;
    max_event_buffer_size: number;
    capabilities: {
      event_batching: boolean;
      compression: boolean;
    };
  };
}

export interface WireAck {
  type: 'ack';
  id: string;
  code: number;
  msg: string;
  payload: unknown;
}

export interface WirePing {
  type: 'ping';
  timestamp: string;
  payload: { nonce: string };
}

export interface WireResyncRequired {
  type: 'resync_required';
  timestamp: string;
  payload: {
    session_id: string;
    reason: 'buffer_overflow' | 'session_recreated' | 'epoch_changed';
    current_seq: number;
    /** Current journal epoch — adopt it after resyncing (v2 sync protocol). */
    epoch?: string;
  };
}

// ---------------------------------------------------------------------------
// v2 sync protocol: cursors + session snapshot
// ---------------------------------------------------------------------------

/** Per-session sync cursor: durable seq + journal epoch. */
export interface WireSessionCursor {
  seq: number;
  epoch?: string;
}

export interface WireInFlightToolCall {
  tool_call_id: string;
  name: string;
  args?: unknown;
  description?: string;
  display?: unknown;
  last_progress?: {
    kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
    text?: string;
    percent?: number;
  };
}

export interface WireInFlightTurn {
  turn_id: number;
  assistant_text: string;
  thinking_text: string;
  running_tools: WireInFlightToolCall[];
  current_prompt_id?: string;
}

/** `GET /sessions/{sid}/snapshot` — atomic rebuild state at a watermark. */
export interface WireSessionSnapshot {
  as_of_seq: number;
  epoch: string;
  session: WireSession;
  messages: { items: WireMessage[]; has_more: boolean };
  in_flight_turn: WireInFlightTurn | null;
  pending_approvals: WireApprovalRequest[];
  pending_questions: WireQuestionRequest[];
}

export interface WireSessionAbortResult {
  aborted: boolean;
}

export interface WireErrorFrame {
  type: 'error';
  timestamp: string;
  payload: {
    code: number;
    msg: string;
    fatal: boolean;
    request_id?: string;
    details?: unknown;
  };
}

// ---------------------------------------------------------------------------
// WS Client control messages (C→S)
// ---------------------------------------------------------------------------

export type WireClientControl =
  | WireClientHello
  | WireSubscribe
  | WireUnsubscribe
  | WireAbort
  | WirePong;

export interface WireClientHello {
  type: 'client_hello';
  id: string;
  payload: {
    client_id: string;
    subscriptions: string[];
    cursors?: Record<string, WireSessionCursor>;
  };
}

export interface WireSubscribe {
  type: 'subscribe';
  id: string;
  payload: {
    session_ids: string[];
    cursors?: Record<string, WireSessionCursor>;
  };
}

export interface WireUnsubscribe {
  type: 'unsubscribe';
  id: string;
  payload: { session_ids: string[] };
}

export interface WireAbort {
  type: 'abort';
  id: string;
  payload: {
    session_id: string;
    prompt_id: string;
  };
}

export interface WirePong {
  type: 'pong';
  payload: { nonce: string };
}

// ---------------------------------------------------------------------------
// WS Events (S→C) — all type: "event.*"
// ---------------------------------------------------------------------------

/** Base shape for all WS event frames */
interface WireEventBase<T extends string, P> {
  type: T;
  seq: number;
  session_id: string;
  timestamp: string;
  payload: P;
}

// Session lifecycle
type WireEventSessionCreated = WireEventBase<'event.session.created', { session: WireSession }>;
type WireEventSessionUpdated = WireEventBase<'event.session.updated', { session: WireSession; changed_fields: string[] }>;
type WireEventSessionDeleted = WireEventBase<'event.session.deleted', { session_id: string }>;
type WireEventSessionStatusChanged = WireEventBase<'event.session.status_changed', {
  status: WireSessionStatus;
  previous_status: WireSessionStatus;
  current_prompt_id?: string;
}>;
type WireEventSessionUsageUpdated = WireEventBase<'event.session.usage_updated', {
  usage: WireSessionUsage;
  delta: WireSessionUsageDelta;
}>;
type WireEventSessionHistoryCompacted = WireEventBase<'event.session.history_compacted', {
  before_seq: number;
  reason: 'auto_compact' | 'manual_compact' | 'history_rewrite';
  summary_message_id?: string;
}>;

// Workspace lifecycle (global — not session-scoped)
type WireEventWorkspaceCreated = WireEventBase<'event.workspace.created', { workspace: WireWorkspace }>;
type WireEventWorkspaceUpdated = WireEventBase<'event.workspace.updated', { workspace: WireWorkspace }>;
type WireEventWorkspaceDeleted = WireEventBase<'event.workspace.deleted', { workspace_id: string; root: string }>;

// Message lifecycle
type WireEventMessageCreated = WireEventBase<'event.message.created', { message: WireMessage }>;
type WireEventMessageUpdated = WireEventBase<'event.message.updated', {
  message_id: string;
  content: WireMessageContent[];
  status: 'pending' | 'completed' | 'error';
}>;

// Assistant streaming
type WireEventAssistantDelta = WireEventBase<'event.assistant.delta', {
  message_id: string;
  content_index: number;
  delta: { text?: string; thinking?: string };
}>;
// No-op-but-known streaming events (advance lastSeq, no UI change)
type WireEventAssistantToolUseStarted = WireEventBase<'event.assistant.tool_use_started', {
  message_id: string;
  tool_call_id: string;
  tool_name: string;
  content_index: number;
}>;
type WireEventAssistantToolUseDelta = WireEventBase<'event.assistant.tool_use_delta', {
  message_id: string;
  tool_call_id: string;
  input_delta: string;
}>;
type WireEventAssistantToolUseCompleted = WireEventBase<'event.assistant.tool_use_completed', {
  message_id: string;
  tool_call_id: string;
  input: unknown;
}>;
type WireEventAssistantCompleted = WireEventBase<'event.assistant.completed', {
  message_id: string;
  finish_reason: 'stop' | 'tool_use' | 'length' | 'cancelled' | 'error';
}>;

// Tool execution (no-op-but-known)
type WireEventToolStarted = WireEventBase<'event.tool.started', {
  tool_call_id: string;
  tool_name: string;
  input: unknown;
  parent_message_id: string;
}>;
type WireEventToolOutput = WireEventBase<'event.tool.output', {
  tool_call_id: string;
  chunk: string;
  stream: 'stdout' | 'stderr';
}>;
type WireEventToolProgress = WireEventBase<'event.tool.progress', {
  tool_call_id: string;
  progress: number;
  message?: string;
}>;
type WireEventToolCompleted = WireEventBase<'event.tool.completed', {
  tool_call_id: string;
  output: unknown;
  is_error: boolean;
  duration_ms: number;
}>;

// Approval
type WireEventApprovalRequested = WireEventBase<'event.approval.requested', WireApprovalRequest>;
type WireEventApprovalResolved = WireEventBase<'event.approval.resolved', {
  approval_id: string;
  decision: 'approved' | 'rejected' | 'cancelled';
  scope?: 'session';
  feedback?: string;
  selected_label?: string;
  resolved_by: string;
  resolved_at: string;
}>;
type WireEventApprovalExpired = WireEventBase<'event.approval.expired', { approval_id: string }>;

// Question
type WireEventQuestionRequested = WireEventBase<'event.question.requested', WireQuestionRequest>;
type WireEventQuestionAnswered = WireEventBase<'event.question.answered', {
  question_id: string;
  answers: Record<string, WireQuestionAnswer>;
  method?: string;
  note?: string;
  resolved_by: string;
  resolved_at: string;
}>;
type WireEventQuestionDismissed = WireEventBase<'event.question.dismissed', {
  question_id: string;
  dismissed_by: string;
  dismissed_at: string;
}>;
// Background tasks
type WireEventTaskCreated = WireEventBase<'event.task.created', { task: WireBackgroundTask }>;
type WireEventTaskProgress = WireEventBase<'event.task.progress', {
  task_id: string;
  output_chunk: string;
  stream: 'stdout' | 'stderr';
}>;
type WireEventTaskCompleted = WireEventBase<'event.task.completed', {
  task_id: string;
  status: WireTaskStatus;
  output_preview?: string;
  output_bytes?: number;
}>;

type WireEventConfigChanged = WireEventBase<'event.config.changed', {
  changed_fields: string[];
  config: WireConfig;
}>;

type WireEventModelCatalogChanged = WireEventBase<'event.model_catalog.changed', {
  changed: Array<{
    provider_id: string;
    provider_name: string;
    added: number;
    removed: number;
  }>;
  unchanged: string[];
  failed: Array<{ provider: string; reason: string }>;
}>;

/** Catch-all for unrecognised event frames — keeps lastSeq advancing without warnings */
type WireEventUnknown = { type: string; seq: number; session_id: string; timestamp: string; payload: unknown };

/**
 * Union of all WS event frames the client will process.
 * Visible events (UI updates) + no-op-but-known events (lastSeq only).
 * The catch-all at the end handles future server events gracefully.
 */
export type WireEvent =
  // Session lifecycle
  | WireEventSessionCreated
  | WireEventSessionUpdated
  | WireEventSessionDeleted
  | WireEventSessionStatusChanged
  | WireEventSessionUsageUpdated
  | WireEventSessionHistoryCompacted
  // Workspace lifecycle
  | WireEventWorkspaceCreated
  | WireEventWorkspaceUpdated
  | WireEventWorkspaceDeleted
  // Message lifecycle
  | WireEventMessageCreated
  | WireEventMessageUpdated
  // Assistant streaming
  | WireEventAssistantDelta
  | WireEventAssistantToolUseStarted
  | WireEventAssistantToolUseDelta
  | WireEventAssistantToolUseCompleted
  | WireEventAssistantCompleted
  // Tool execution
  | WireEventToolStarted
  | WireEventToolOutput
  | WireEventToolProgress
  | WireEventToolCompleted
  // Approval
  | WireEventApprovalRequested
  | WireEventApprovalResolved
  | WireEventApprovalExpired
  // Question
  | WireEventQuestionRequested
  | WireEventQuestionAnswered
  | WireEventQuestionDismissed
  // Background tasks
  | WireEventTaskCreated
  | WireEventTaskProgress
  | WireEventTaskCompleted
  // Config
  | WireEventConfigChanged
  | WireEventModelCatalogChanged
  // Unknown / future events
  | WireEventUnknown;
