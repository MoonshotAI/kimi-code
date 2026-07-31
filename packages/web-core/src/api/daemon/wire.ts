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
  busy: boolean;
  main_turn_active?: boolean;
  pending_interaction?: 'none' | 'approval' | 'question';
  last_turn_reason?: 'completed' | 'cancelled' | 'failed';
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

// GET /sessions/{id}/goal — camelCase, same shape as the `goal.updated` event
// payload. The endpoint returns null when no goal is active.
export interface WireGoalSnapshot {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: 'active' | 'paused' | 'blocked' | 'complete';
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  terminalReason?: string;
  budget: {
    tokenBudget: number | null;
    turnBudget: number | null;
    wallClockBudgetMs: number | null;
    remainingTokens: number | null;
    remainingTurns: number | null;
    remainingWallClockMs: number | null;
    tokenBudgetReached: boolean;
    turnBudgetReached: boolean;
    wallClockBudgetReached: boolean;
    overBudget: boolean;
  };
}

export interface WireSessionPlanReview {
  state: 'pending' | 'approved' | 'rejected' | 'cancelled';
  selected_option?: string;
  feedback?: string;
}

export interface WireSessionPlan {
  tool_call_id: string;
  turn_id: string;
  source: 'interaction' | 'display' | 'output';
  plan: string;
  path?: string;
  options?: Array<{ label: string; description?: string }>;
  review?: WireSessionPlanReview;
}

export interface WireSessionPlansResponse {
  agent_id: string;
  plans: WireSessionPlan[];
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
// Task
// ---------------------------------------------------------------------------

export type WireTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface WireTask {
  id: string;
  agent_id?: string;
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
  run_in_background?: boolean;
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
// GET /models, GET /providers and the :refresh endpoints are REAL (kap-server
// routes/modelCatalog.ts); create/delete follow design §4.1/§4.2.
// ---------------------------------------------------------------------------

export interface WireModel {
  provider: string;
  model: string;
  display_name?: string;
  max_context_size: number;
  capabilities?: string[];
  support_efforts?: string[];
  default_effort?: string;
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

/** GET /providers/{id} only: the single GET reveals the stored key. */
export interface WireProviderDetail extends WireProvider {
  api_key?: string;
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

// POST /api/v1/providers request body (design §4.1) — snake_case, aligned with
// the server zod schema. `models` writes one `<id>/<model>` alias per entry.
export interface WireCreateProviderModel {
  model: string;
  max_context_size: number;
  display_name?: string;
  capabilities?: string[];
  max_output_size?: number;
  support_efforts?: string[];
  adaptive_thinking?: boolean;
}

export interface WireCreateProviderRequest {
  id: string;
  type: string;
  api_key?: string;
  base_url?: string;
  default_model?: string;
  models: WireCreateProviderModel[];
}

// PUT /api/v1/providers/{id} request body — replace semantics (the body is the
// provider's new config), except api_key which is three-state so the edit form
// can leave the stored key untouched: absent = keep, "" = clear, non-empty = set.
export interface WireUpdateProviderRequest {
  new_id?: string;
  type: string;
  api_key?: string;
  base_url?: string;
  default_model?: string;
  models: WireCreateProviderModel[];
}

// PUT /api/v1/providers/{id} 200 body.
export interface WireUpdateProviderResult {
  provider: WireProvider;
}

// GET /api/v1/catalog/providers item (design §4.3) — a pruned models.dev
// entry with import eligibility pre-resolved server-side.
export interface WireCatalogModel {
  id: string;
  name?: string;
  max_context_size: number;
  capabilities?: string[];
  reasoning: boolean;
}

export interface WireCatalogProvider {
  id: string;
  name: string;
  /** Resolved wire protocol; null when the entry is rejected. */
  wire_type: string | null;
  /** True when the wire came from the OpenAI-compatible fallback. */
  guessed: boolean;
  /** True when the import form must collect a base URL. */
  needs_base_url: boolean;
  /** True when this server version cannot import the entry at all. */
  rejected: boolean;
  reject_reason: string | null;
  /** Credential env var the vendor conventionally uses (hint only). */
  env_key: string | null;
  models: WireCatalogModel[];
}

// POST /api/v1/providers:import_catalog request body (design §4.4).
export interface WireImportCatalogProviderRequest {
  catalog_id: string;
  api_key?: string;
  base_url?: string;
  id?: string;
}

// POST /api/v1/providers:import_catalog 201 body.
export interface WireImportCatalogProviderResult {
  provider: WireProvider;
  models_imported: number;
}

// POST /api/v1/providers:import_registry request body (design §4.5).
export interface WireImportCustomRegistryRequest {
  url: string;
  api_key?: string;
}

// POST /api/v1/providers:import_registry 201 body — one item per provider the
// registry document lists.
export interface WireImportCustomRegistryResult {
  providers: WireProvider[];
  models_imported: number;
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
  /** Passthrough (z.unknown() server-side); inner keys arrive camelCase
      ({ model, defaultEffort }) since only top-level keys are snake_cased. */
  secondary_model?: unknown;
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

// `POST /oauth/login` returns one of two shapes, discriminated by `status`:
//   - `pending`: a real device-code flow was started; all device fields are
//     populated so the client can render the device-code step and poll.
//   - `authenticated`: the toolkit already had a usable token and short-
//     circuited via its `ensureFresh` fast path, so no device code was
//     issued; the client can skip the device-code step and treat the login
//     as already complete.
interface WireOAuthLoginStartPending {
  flow_id: string;
  provider: string;
  status: 'pending';
  verification_uri: string;
  verification_uri_complete: string;
  user_code: string;
  expires_in: number;
  interval: number;
  expires_at: string;
}

interface WireOAuthLoginStartAuthenticated {
  flow_id: string;
  provider: string;
  status: 'authenticated';
}

export type WireOAuthLoginStartResult =
  | WireOAuthLoginStartPending
  | WireOAuthLoginStartAuthenticated;

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

// `GET /oauth/usage` — managed-account plan usage, discriminated by `kind`:
// the server mirrors the toolkit result so the client can render inline
// states (not signed in / endpoint unavailable / fetch failed) without a hard
// HTTP failure. Rows are structured (window + absolute reset timestamp); the
// client localizes labels and reset hints itself.
export interface WireUsageWindow {
  duration: number;
  unit: 'minute' | 'hour' | 'day' | 'week';
}

export interface WireUsageRow {
  name?: string;
  window?: WireUsageWindow;
  used: number;
  limit: number;
  reset_at?: string;
}

export interface WireBoosterWallet {
  balance_cents: number;
  total_cents: number;
  monthly_charge_limit_enabled: boolean;
  monthly_charge_limit_cents: number;
  monthly_used_cents: number;
  currency: string;
}

export interface WireUsageOk {
  kind: 'ok';
  summary: WireUsageRow | null;
  limits: WireUsageRow[];
  extra_usage: WireBoosterWallet | null;
}

export interface WireUsageError {
  kind: 'error';
  message: string;
  status?: number;
}

export type WireUsageResult = WireUsageOk | WireUsageError;

// GET /oauth/userinfo needs no wire DTOs: the oauth payload is already
// camelCase, identical to ManagedUserInfoResult in ../types — the client
// returns it unmapped.

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
    /** Advisory only — kap-server omits this since it sends no heartbeat. */
    heartbeat_ms?: number;
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
  /** Live subagent roster at the watermark (absent on older servers). */
  subagents?: WireTask[];
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
type WireEventSessionWorkChanged = WireEventBase<'event.session.work_changed', {
  busy: boolean;
  main_turn_active?: boolean;
  pending_interaction?: 'none' | 'approval' | 'question';
  last_turn_reason?: 'completed' | 'cancelled' | 'failed';
}>;
/** @deprecated Old journals may still carry this; mapped onto busy for replay. */
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
// Tasks
type WireEventTaskCreated = WireEventBase<'event.task.created', { task: WireTask }>;
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
  | WireEventSessionWorkChanged
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
  // Tasks
  | WireEventTaskCreated
  | WireEventTaskProgress
  | WireEventTaskCompleted
  // Config
  | WireEventConfigChanged
  | WireEventModelCatalogChanged
  // Unknown / future events
  | WireEventUnknown;
