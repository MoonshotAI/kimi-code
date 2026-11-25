
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

export interface WireSessionsPage {
  items: WireSession[];
  total: number;
  has_more: boolean;
  next_page_token?: string | null;
  unavailable_hosts?: string[];
}

export interface WireSessionIdsPage {
  items: { id: string; archived: boolean; host_id?: string }[];
  total: number;
  has_more: boolean;
  next_page_token?: string | null;
  unavailable_hosts?: string[];
}

export interface WireSessionGroup {
  workspace_id: string;
  sessions: WireSession[];
  total: number;
  host_id?: string;
}

export interface WireSessionGroupsPage {
  groups: WireSessionGroup[];
  total: number;
  has_more: boolean;
  next_page_token?: string | null;
  unavailable_hosts?: string[];
}

export interface WireBatchSessionResponse {
  results: { id: string; ok: boolean; error?: { code: number; message: string } }[];
  succeeded: number;
  failed: number;
}

export type WireSessionStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_question'
  | 'aborted';

export interface WireSessionPullRequest {
  number: number;
  state: 'open' | 'closed' | 'merged';
  url: string;
}

export interface WireSessionGit {
  branch?: string;
  pull_request?: WireSessionPullRequest;
}

export interface WireSession {
  id: string;
  cwd: string;
  title: string;
  created_at: string;
  updated_at: string;
  activity: 'idle' | 'turn' | 'background';
  pending_interaction?: 'none' | 'approval' | 'question';
  last_turn_outcome?: 'completed' | 'interrupted' | 'failed';
  archived: boolean;
  archived_at?: string;
  last_prompt?: string;
  workspace_id?: string;
  host_id?: string;
  metadata?: Record<string, unknown>;
  git?: WireSessionGit;
}

export interface WireSessionRatingResult {
  appearance: { id: string; survey: 'session' | 'long_context' } | null;
}

export type WireSessionRatingReport =
  | { op: 'shown' | 'abandon'; appearance_id: string }
  | { op: 'respond'; appearance_id: string; response: 'bad' | 'fine' | 'good' | 'dismissed' };

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

export interface WireSessionWarning {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

export interface WireSessionWarningsResponse {
  warnings: WireSessionWarning[];
}

export interface WireWorkspace {
  id: string;
  root: string;
  name: string;
  kind: 'managed' | 'implicit';
  additional_dirs: string[];
  last_opened_at?: string;
  session_count: number;
  host_id?: string;
}

export interface WireFsBrowseEntry {
  name: string;
  path: string;
  is_dir: boolean;
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

export interface WireFsMkdirResult {
  path: string;
}

export type WireMessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool_call_id: string; tool_name: string; input: unknown }
  | { type: 'tool_result'; tool_call_id: string; output: unknown; is_error?: boolean }
  | { type: 'image'; source: WireImageSource; name?: string }
  | { type: 'video'; source: WireImageSource; name?: string }
  | { type: 'file'; file_id: string; name: string; media_type: string; size: number }
  | { type: 'thinking'; thinking: string; signature?: string };

export type WireImageSource =
  | { kind: 'url'; url: string }
  | { kind: 'base64'; media_type: string; data: string }
  | { kind: 'file'; file_id: string }
  | { kind: 'session_media'; file_id: string };

export interface WirePromptSubmission {
  prompt_id?: string;
  content: WireMessageContent[];
  metadata?: Record<string, unknown>;
  agent_id?: string;
  model?: string;
  thinking?: string;
  permission_mode?: string;
  plan_mode?: boolean;
  swarm_mode?: boolean;
  tower_mode?: boolean;
  goal_objective?: string;
  goal_control?: 'pause' | 'resume' | 'cancel' | 'edit';
  skills?: { name: string; args?: string }[];
}

export interface WirePromptSubmitResult {
  prompt_id: string;
  user_message_id: string;
  origin?: unknown;
  status?: 'running' | 'queued' | 'failed';
}

export interface WirePromptSteerResult {
  steered: boolean;
  prompt_ids: string[];
}

export interface WireApprovalResponse {
  decision: 'approved' | 'rejected' | 'cancelled';
  scope?: 'session';
  feedback?: string;
  selected_label?: string;
}

export interface WireQuestionOption {
  id: string;
  label: string;
  description?: string;
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

interface WireInteractionBase<K extends string, Req, Res> {
  type: 'interaction';
  session_id: string;
  agent_id: string;
  event_created_at: string;
  interaction_id: string;
  kind: K;
  status: 'pending' | 'ended';
  outcome?: 'approved' | 'rejected' | 'cancelled' | 'answered' | 'dismissed';
  ended_at?: string;
  tool_call_id?: string;
  request: Req;
  response?: Res;
}

export type WireInteraction =
  | WireInteractionBase<
      'approval',
      { tool_name: string; action: string; tool_input_display?: unknown; expires_at: string },
      WireApprovalResponse
    >
  | WireInteractionBase<
      'question',
      { questions: WireQuestionItem[] },
      { answers: Record<string, string | true>; method?: WireQuestionResponse['method'] }
    >;

export interface WireTaskState {
  task_id: string;
  kind: 'shell' | 'subagent' | 'other';
  status: 'running' | 'ended';
  outcome?: 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
  phase?: 'working' | 'suspended';
  detached: boolean;
  description?: string;
  child_agent_id?: string;
  parent_tool_call_id?: string;
  swarm_index?: number;
  command?: string;
  started_at?: string;
  ended_at?: string;
  result_summary?: string;
  error?: string;
  state_reason?: string;
  model?: string;
  thinking?: string;
}

export interface WireTaskEvent extends WireTaskState {
  type: 'task';
  session_id: string;
  agent_id: string;
  event_created_at: string;
}

export interface WireTaskList {
  type: 'task.list';
  session_id: string;
  agent_id: string;
  tasks: WireTaskState[];
}

interface WireAgentFrameBase {
  session_id: string;
  agent_id: string;
  event_created_at: string;
}

export interface WireAgentStateFrame extends WireAgentFrameBase {
  type: 'agent';
  status: 'idle' | 'running' | 'ended';
  compacting: boolean;
  model?: string;
  thinking?: string;
  permission_mode?: 'manual' | 'yolo' | 'auto';
  plan_mode: boolean;
  swarm_mode: boolean;
  tower_mode: boolean;
  plan_mode_available: boolean;
  swarm_mode_available: boolean;
  tower_mode_available: boolean;
  goal_mode_available: boolean;
}

export interface WireContextFrame extends WireAgentFrameBase {
  type: 'context';
  context_tokens: number;
  max_context_tokens?: number;
}

export interface WireGoalState {
  objective: string;
  status: 'active' | 'paused' | 'blocked' | 'complete';
  completion_criterion?: string;
  turns_used: number;
  tokens_used: number;
  wall_clock_ms: number;
}

export interface WireGoalFrame extends WireAgentFrameBase {
  type: 'goal';
  goal?: WireGoalState;
}

export interface WireTodoFrame extends WireAgentFrameBase {
  type: 'todo';
  items: { title: string; status: 'pending' | 'in_progress' | 'done' }[];
}

export type WireAgentFeedFrame = WireAgentStateFrame | WireContextFrame | WireGoalFrame | WireTodoFrame;

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
  is_directory?: boolean;
  is_symlink_to?: string;
  git_status?: string;
  child_count?: number;
}

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

export interface WireUpdateProviderRequest {
  new_id?: string;
  type: string;
  api_key?: string;
  base_url?: string;
  default_model?: string;
  models: WireCreateProviderModel[];
}

export interface WireUpdateProviderResult {
  provider: WireProvider;
}

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
  wire_type: string | null;
  base_url: string | null;
  guessed: boolean;
  needs_base_url: boolean;
  rejected: boolean;
  reject_reason: string | null;
  env_key: string | null;
  models: WireCatalogModel[];
}

export interface WireImportCatalogProviderRequest {
  catalog_id: string;
  api_key?: string;
  base_url?: string;
  id?: string;
}

export interface WireImportCatalogProviderResult {
  provider: WireProvider;
  models_imported: number;
}

export interface WireImportCustomRegistryRequest {
  url: string;
  api_key?: string;
}

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
  secondary_model?: unknown;
  tools?: { enabled?: string[]; disabled?: string[] };
  models?: Record<string, unknown>;
  thinking?: unknown;
  plan_mode?: boolean;
  yolo?: boolean;
  default_permission_mode?: string;
  default_plan_mode?: boolean;
  auto_session_title?: boolean;
  permission?: unknown;
  hooks?: unknown[];
  services?: unknown;
  merge_all_available_skills?: boolean;
  extra_skill_dirs?: string[];
  loop_control?: unknown;
  background?: unknown;
  experimental?: Record<string, boolean>;
  telemetry?: boolean;
  disable_feedback_survey?: boolean;
  raw?: Record<string, unknown>;
}

export interface WireHostDefinition {
  host: string;
  identity_file?: string;
  remote_bin?: string;
  name?: string;
  enabled?: boolean;
}

export interface WireHost extends WireHostDefinition {
  id: string;
  status: 'pending' | 'connecting' | 'ready' | 'disconnected';
  remote_version?: string;
  connect_error?: string;
  connect_failure?: string;
}

export interface WireHostTestResult {
  connected: boolean;
  remote_version?: string;
  connect_error?: string;
  connect_failure?: string;
}

export interface WireSshConfigHosts {
  config_path: string;
  exists: boolean;
  hosts: Array<{ alias: string; host_name?: string; user?: string; port?: number }>;
}

export interface WireManagedProvider {
  status: string;
  [key: string]: unknown;
}

export interface WireAuthResult {
  models_ready: boolean;
  providers_count: number;
  managed_provider: WireManagedProvider | null;
}

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
  status: 'pending' | 'authenticated' | 'denied' | 'expired' | 'cancelled';
  resolved_at?: string;
  error_message?: string;
}

export interface WireOAuthCancelResult {
  cancelled: boolean;
  status: string;
}

export interface WireLogoutResult {
  logged_out: boolean;
}

export interface WireOAuthRegionResult {
  region: 'mainland-cn' | 'global';
}

export interface WireFileMeta {
  id: string;
  name: string;
  media_type: string;
  size: number;
  created_at: string;
  expires_at?: string;
}

export type WireServerFrame =
  | WirePing
  | WireEvent;

export interface WirePing {
  type: 'ping';
}

export interface WireCapabilityInstallProgress {
  running: boolean;
  step?: string;
  percent?: number;
  error?: string;
  note?: string;
  confirmation_required?: 'stop-processes';
}

export interface WireCapabilityStatus {
  id: string;
  plugin_id?: string;
  display_name: string;
  description: string;
  supported: boolean;
  state: 'not_installed' | 'partial' | 'ready' | 'unsupported';
  version?: string;
  steps: { id: string; state: 'ok' | 'missing' | 'failed'; detail?: string; optional?: boolean }[];
  install: WireCapabilityInstallProgress;
}

export interface WirePluginSummary {
  id: string;
  display_name: string;
  description?: string;
  short_description?: string;
  long_description?: string;
  version?: string;
  enabled: boolean;
  state: 'ok' | 'error';
  skill_count: number;
  mcp_server_count: number;
  enabled_mcp_server_count: number;
  hook_count: number;
  command_count: number;
  has_errors: boolean;
  source: 'local-path' | 'zip-url' | 'github';
  original_source?: string;
  origin: 'marketplace' | 'custom' | 'unknown';
  installed_at: string;
  catalog_id?: string;
}

export interface WirePluginSkillInfo {
  name: string;
  display_name?: string;
  description?: string;
}

export interface WirePluginMcpServerInfo {
  name: string;
  display_name?: string;
  description?: string;
  icon_url?: string;
  runtime_name: string;
  enabled: boolean;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env_keys?: string[];
  header_keys?: string[];
}

export interface WirePluginCapabilities {
  skills: WirePluginSkillInfo[];
  mcp_servers: WirePluginMcpServerInfo[];
}

export interface WirePluginMarketplaceEntry {
  id: string;
  tier: 'official' | 'curated' | 'third-party';
  display_name: string;
  description?: string;
  short_description?: string;
  long_description?: string;
  cli_description?: string;
  homepage?: string;
  keywords?: string[];
  version?: string;
  sha256sum?: string;
  source: string;
  capability_id?: string;
  installed?: { version?: string; enabled: boolean };
  update_available?: boolean;
  icon_url?: string;
  default_locale?: string;
  locale?: Record<string, unknown>;
  platforms?: string[];
  distribution?: {
    category?: string;
    region?: string;
    default_install?: boolean;
    weight?: number;
    user_level?: unknown;
  };
  billing?: string;
}

export interface WireMcpAuthStatus {
  name: string;
  auth_status:
    | 'not-applicable'
    | 'bearer-token'
    | 'oauth-required'
    | 'oauth-authorized'
    | 'oauth-expired'
    | 'unavailable';
}

export interface WireMcpServerAuthInspection {
  runtime_name: string;
  auth_status: WireMcpAuthStatus['auth_status'];
}

export type WireMcpServerLocator =
  | { source: 'global'; name: string }
  | { source: 'plugin'; plugin_id: string; server_name: string };

export type WireMcpAuthBeginResult =
  | { status: 'authorization-required'; flow_id: string; authorization_url: string }
  | { status: 'already-authorized' };

export interface WireSessionCancelResult {
  cancelled: boolean;
}

interface WireEventBase<T extends string> {
  type: T;
  event_created_at: string;
}

type WireSessionEvent = WireEventBase<'session'> & {
  change: 'created' | 'updated' | 'archived' | 'restored' | 'deleted';
  session: WireSession;
};

type WireWorkspaceEvent = WireEventBase<'workspace'> & {
  change: 'created' | 'updated' | 'deleted';
  workspace: WireWorkspace;
};

type WireConfigEvent = WireEventBase<'config'> & {
  config: WireConfig;
  warnings?: readonly { domain?: string; message: string }[];
};

type WireInvalidatedEvent = WireEventBase<'invalidated'> & {
  kind: 'models' | 'plugins';
};

type WireCapabilityChangedEvent = WireEventBase<'event.capability.changed'> & {
  capability_id: string;
  install: WireCapabilityInstallProgress;
};

type WireHostChangedEvent = WireEventBase<'event.host.changed'> & {
  hosts: WireHost[];
};

type WireEventUnknown = { type: string; event_created_at: string };

export type WireEvent =
  | WireSessionEvent
  | WireWorkspaceEvent
  | WireConfigEvent
  | WireInvalidatedEvent
  | WireCapabilityChangedEvent
  | WireHostChangedEvent
  | WireEventUnknown;
