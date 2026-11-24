
import type { ToolMedia } from '../client/types';
import type { ConversationFrame, ConversationTurnsPage } from '../conversation/types';
import type { RcDeviceList } from '../lib/rcDevicesApi';

export interface AgentRef {
  readonly agentId: string;
  readonly role?: 'child' | 'member';
}

export interface Page<T> {
  items: T[];
  hasMore: boolean;
}

export interface PageRequest {
  beforeId?: string;
  afterId?: string;
  pageSize?: number;
}

export type AppNoticeSeverity = 'info' | 'success' | 'warning' | 'error';

export type AppNoticePosition = 'top-center' | 'top-right' | 'bottom-center' | 'bottom-right';

export interface AppNoticeDetail {
  label: string;
  value: string;
}

export interface AppNoticeCopyLink {
  label: string;
  copiedLabel: string;
  url: string;
}

export interface AppNotice {
  severity: AppNoticeSeverity;
  title: string;
  message?: string;
  details?: AppNoticeDetail[];
  copyLink?: AppNoticeCopyLink;
  position?: AppNoticePosition;
}

export type AppWarning = string | AppNotice;

export interface AppTurnError {
  code?: string;
  message?: string;
  name?: string;
  retryable?: boolean;
  statusCode?: number;
  requestId?: string;
  endReason?: string;
}

export interface AppTurnRetry {
  failedAttempt: number;
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  errorName?: string;
  statusCode?: number;
}

export interface AppSessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  contextTokens: number;
  contextLimit: number;
  turnCount: number;
}

export interface AppSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  busy: boolean;
  mainTurnActive?: boolean;
  pendingInteraction?: 'none' | 'approval' | 'question';
  lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  archived: boolean;
  archivedAt?: string;
  lastPrompt?: string;
  cwd: string;
  model: string;
  usage: AppSessionUsage;
  messageCount: number;
  workspaceId?: string;
  parentSessionId?: string;
  pullRequest?: { number: number; state: 'open' | 'closed' | 'merged'; url: string } | null;
  hostId?: string;
}

export type SessionActivity = 'idle' | 'turn' | 'background';

export type SessionsSort = 'updated_at_desc' | 'updated_at_asc' | 'created_at_desc';

export interface GitStatusEntry {
  branch: string;
  ahead: number;
  behind: number;
  entries: Record<string, string>;
  additions: number;
  deletions: number;
  pullRequest: { number: number; state: string; url: string } | null;
}

export interface GitStatusQuery {
  root?: string;
  paths?: string[];
  includePullRequest?: boolean;
}

export interface GitBatchError {
  code: number;
  msg: string;
}

export interface GitStatusBatchResult {
  results: Record<string, GitStatusEntry>;
  errors: Record<string, GitBatchError>;
}

export interface PullRequestBatchResult {
  results: Record<string, GitStatusEntry['pullRequest']>;
  errors: Record<string, GitBatchError>;
}

export interface ListSessionsInput extends PageRequest {
  workspaceId?: string;
  workspaceIds?: string[];
  busy?: boolean;
  activities?: SessionActivity[];
  updatedAfter?: string;
  updatedBefore?: string;
  archived?: boolean | 'all';
  hasPrompt?: boolean;
  query?: string;
  localOnly?: boolean;
  sort?: SessionsSort;
  include?: 'git';
  pageToken?: string;
  page?: number;
}

export interface SessionsPage extends Page<AppSession> {
  nextPageToken: string | null;
  total: number;
  unavailableHosts?: string[];
}

export interface SessionGroup {
  workspaceId: string;
  sessions: AppSession[];
  total: number;
}

export interface SessionGroupsPage {
  groups: SessionGroup[];
  hasMore: boolean;
  nextPageToken: string | null;
  total: number;
  unavailableHosts?: string[];
}

export interface ListSessionGroupsInput {
  groupPageSize?: number;
  hasPrompt?: boolean;
  workspaceIds?: string[];
  busy?: boolean;
  activities?: SessionActivity[];
  archived?: boolean | 'all';
  sort?: SessionsSort;
  include?: 'git';
  pageSize?: number;
  pageToken?: string;
  page?: number;
}

export interface SessionIdProjection {
  id: string;
  archived: boolean;
  host_id?: string;
}

export interface ListSessionIdsInput {
  workspaceIds?: string[];
  busy?: boolean;
  activities?: SessionActivity[];
  updatedAfter?: string;
  updatedBefore?: string;
  archived?: boolean | 'all';
  hasPrompt?: boolean;
  sort?: SessionsSort;
  pageSize?: number;
  pageToken?: string;
  page?: number;
}

export interface SessionIdsPage {
  items: SessionIdProjection[];
  hasMore: boolean;
  nextPageToken: string | null;
  total: number;
  unavailableHosts?: string[];
}

export interface BatchSessionResult {
  id: string;
  ok: boolean;
  error?: { code: number; message: string };
}

export interface BatchSessionResponse {
  results: BatchSessionResult[];
  succeeded: number;
  failed: number;
}

export interface AppWorkspace {
  id: string;
  root: string;
  hostId?: string;
  name: string;
  kind: 'managed' | 'implicit';
  additionalDirs: string[];
  lastOpenedAt?: string;
  sessionCount: number;
}

export interface FsBrowseEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FsBrowseResult {
  path: string;
  parent: string | null;
  entries: FsBrowseEntry[];
}

export type AppMessageRole = 'user' | 'assistant' | 'tool' | 'system';

export type AppMessageContent =
  | { type: 'text'; text: string; final?: boolean }
  | {
      type: 'toolUse';
      toolCallId: string;
      toolName: string;
      input: unknown;
      outputLines?: string[];
      agentRefs?: readonly AgentRef[];
    }
  | {
      type: 'toolResult';
      toolCallId: string;
      output: unknown;
      isError?: boolean;
      interrupted?: boolean;
      media?: ToolMedia;
    }
  | { type: 'image'; source: ImageSource; name?: string }
  | { type: 'video'; source: ImageSource; name?: string }
  | { type: 'file'; fileId: string; name: string; mediaType: string; size: number }
  | {
      type: 'thinking';
      thinking: string;
      signature?: string;
      startedAt?: string;
      durationMs?: number;
    }
  | { type: 'unknown'; raw: unknown };

export type ImageSource =
  | { kind: 'url'; url: string }
  | { kind: 'base64'; mediaType: string; data: string }
  | { kind: 'file'; fileId: string }
  | { kind: 'sessionMedia'; fileId: string };

export type AppSkillAttachment = Extract<AppMessageContent, { type: 'text' | 'image' | 'video' | 'file' }>;

export interface AppSkillActivationOptions {
  metadata?: Record<string, unknown>;
  skillPath?: string;
  promptId?: string;
}

export interface AppMessage {
  id: string;
  sessionId: string;
  role: AppMessageRole;
  content: AppMessageContent[];
  createdAt: string;
  promptId?: string;
  daemonTurnId?: number;
  daemonTurnState?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  userMessageId?: string;
  parentMessageId?: string;
  durationMs?: number;
  endedAt?: string;
  metadata?: Record<string, unknown>;
}

export type ThinkingLevel = 'off' | 'on' | (string & {});

export interface PromptSubmission {
  promptId?: string;
  content: AppMessageContent[];
  metadata?: Record<string, unknown>;
  agentId?: string;
  model?: string;
  thinking?: ThinkingLevel;
  permissionMode?: 'manual' | 'auto' | 'yolo';
  planMode?: boolean;
  swarmMode?: boolean;
  goalObjective?: string;
  goalControl?: 'pause' | 'resume' | 'cancel' | 'edit';
  skills?: { name: string; path?: string; args?: string }[];
}

export interface PromptSubmitResult {
  promptId: string;
  userMessageId: string;
  origin?: unknown;
  status?: 'running' | 'queued' | 'failed';
}

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';

export type InteractionOutcome = ApprovalDecision | 'answered' | 'dismissed';

export interface InteractionRespondResult {
  outcome: InteractionOutcome;
  endedAt: string;
}

export interface ApprovalResponse {
  decision: ApprovalDecision;
  scope?: 'session';
  feedback?: string;
  selectedLabel?: string;
}

export interface AppApprovalRequest {
  approvalId: string;
  sessionId: string;
  agentId?: string;
  turnId?: number;
  toolCallId: string;
  toolName: string;
  action: string;
  display: unknown;
}

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface QuestionItem {
  id: string;
  question: string;
  header?: string;
  body?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  allowOther?: boolean;
  otherLabel?: string;
  otherDescription?: string;
}

export interface AppQuestionRequest {
  questionId: string;
  sessionId: string;
  agentId?: string;
  turnId?: number;
  toolCallId?: string;
  questions: QuestionItem[];
}

export type QuestionAnswer =
  | { kind: 'single'; optionId: string }
  | { kind: 'multi'; optionIds: string[] }
  | { kind: 'other'; text: string }
  | { kind: 'multiWithOther'; optionIds: string[]; otherText: string }
  | { kind: 'skipped' };

export interface QuestionResponse {
  answers: Record<string, QuestionAnswer>;
  method?: 'enter' | 'space' | 'number_key' | 'click';
  note?: string;
}

export type AppTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type AppSubagentPhase = 'queued' | 'working' | 'suspended' | 'completed' | 'failed' | 'cancelled';

export interface AppTask {
  id: string;
  agentId?: string;
  sessionId: string;
  kind: 'subagent' | 'bash' | 'tool';
  description: string;
  status: AppTaskStatus;
  command?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  outputLines?: string[];
  text?: string;
  subagentPhase?: AppSubagentPhase;
  subagentType?: string;
  model?: string;
  thinkingEffort?: string;
  parentToolCallId?: string;
  suspendedReason?: string;
  swarmIndex?: number;
  runInBackground?: boolean;
}

export interface SessionTask {
  readonly taskId: string;
  readonly kind: 'shell' | 'subagent' | 'other';
  readonly state: 'running' | 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
  readonly phase?: 'working' | 'suspended';
  readonly detached: boolean;
  readonly description?: string;
  readonly agentId?: string;
  readonly parentToolCallId?: string;
  readonly swarmIndex?: number;
  readonly command?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly resultSummary?: string;
  readonly stateReason?: string;
  readonly model?: string;
  readonly thinkingEffort?: string;
}

export type AppSessionRatingSurvey = 'session' | 'long_context';

export type AppSessionRatingResponse = 'bad' | 'fine' | 'good';

export interface AppSessionRatingOffer {
  appearanceId: string;
  survey: AppSessionRatingSurvey;
}

export type AppSessionRatingView =
  | { phase: 'closed' }
  | (AppSessionRatingOffer & { phase: 'open' })
  | (AppSessionRatingOffer & { phase: 'pending' | 'thanks'; response: AppSessionRatingResponse });

export type AppSessionRatingReport =
  | { op: 'shown' | 'abandon'; appearanceId: string }
  | { op: 'respond'; appearanceId: string; response: AppSessionRatingResponse | 'dismissed' };

export interface AppAgentState {
  status: 'idle' | 'running' | 'ended';
  compacting: boolean;
  model?: string;
  thinking?: string;
  permissionMode?: 'manual' | 'yolo' | 'auto';
  planMode: boolean;
  swarmMode: boolean;
  towerMode: boolean;
  planModeAvailable?: boolean;
  swarmModeAvailable?: boolean;
  towerModeAvailable?: boolean;
  goalModeAvailable?: boolean;
}

export interface AppAgentUsage {
  contextTokens: number;
  contextLimit?: number;
}

export interface AppTodoItem {
  title: string;
  status: 'pending' | 'in_progress' | 'done';
}

export type AppGoalStatus = 'active' | 'paused' | 'blocked' | 'complete';

export const GOAL_OBJECTIVE_MAX_LENGTH = 4000;

export interface AppGoal {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: AppGoalStatus;
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  terminalReason?: string;
  budget: {
    tokenBudget: number | null;
    remainingTokens: number | null;
    turnBudget: number | null;
    remainingTurns: number | null;
    wallClockBudgetMs: number | null;
    remainingWallClockMs: number | null;
    overBudget: boolean;
  };
}

export type SessionPlanReviewState = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface SessionPlanReview {
  state: SessionPlanReviewState;
  selectedOption?: string;
  feedback?: string;
}

export interface SessionPlan {
  toolCallId: string;
  plan: string;
  path?: string;
  review: SessionPlanReview;
}

export interface TurnFileHistoryChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  binary?: boolean;
  oversize?: boolean;
}

export interface TurnFileHistoryContent {
  version: number;
  content?: string;
  binary?: boolean;
}

export type FsKind = 'file' | 'directory' | 'symlink';

export interface FsEntry {
  path: string;
  name: string;
  kind: FsKind;
  size?: number;
  modifiedAt: string;
  etag?: string;
  mime?: string;
  languageId?: string;
  isBinary?: boolean;
  isDirectory?: boolean;
  isSymlinkTo?: string;
  gitStatus?: string;
  childCount?: number;
}

export type AppEvent =
  | { type: 'sessionCreated'; session: AppSession }
  | { type: 'workspaceCreated'; workspace: AppWorkspace }
  | { type: 'workspaceUpdated'; workspace: AppWorkspace }
  | { type: 'workspaceDeleted'; workspaceId: string; root: string }
  | { type: 'sessionDeleted'; sessionId: string }
  | { type: 'sessionArchived'; sessionId: string; workspaceId?: string }
  | { type: 'sessionRestored'; sessionId: string }
  | {
      type: 'sessionWorkChanged';
      sessionId: string;
      busy: boolean;
      mainTurnActive?: boolean;
      pendingInteraction?: 'none' | 'approval' | 'question';
      lastTurnReason?: 'completed' | 'cancelled' | 'failed';
      session?: AppSession;
    }
  | { type: 'sessionMetaUpdated'; sessionId: string; title?: string; lastPrompt?: string }
  | { type: 'approvalRequested'; sessionId: string; approval: AppApprovalRequest }
  | { type: 'questionRequested'; sessionId: string; question: AppQuestionRequest }
  | { type: 'interactionEnded'; sessionId: string; interactionId: string; kind: 'approval' | 'question'; outcome: InteractionOutcome; feedback?: string; selectedLabel?: string }
  | { type: 'interactionsReset'; sessionId: string }
  | { type: 'configChanged'; changedFields: string[]; config: AppConfig; warnings?: readonly { domain?: string; message: string }[] }
  | { type: 'pluginsChanged' }
  | { type: 'capabilityChanged'; capabilityId: string; install: AppCapabilityInstallProgress }
  | { type: 'hostsChanged'; hosts: AppHost[] }
  | {
      type: 'modelCatalogChanged';
      changed: { providerId: string; providerName: string; added: number; removed: number }[];
      unchanged: string[];
      failed: { provider: string; reason: string }[];
    }
  | { type: 'unknown'; raw: unknown };

export interface AgentTurnsQuery {
  beforeOrdinal?: number;
  pageSize?: number;
}

export interface KimiEventHandlers {
  onEvent(event: AppEvent, meta: KimiEventMeta): void;
  onError(code: number, msg: string, fatal: boolean): void;
  onConnectionChange(connected: boolean): void;
  onConversation?(sessionId: string, agentId: string, frame: ConversationFrame): void;
  onConversationFailed?(sessionId: string, code: number, msg: string): void;
  onTaskList?(sessionId: string, agentId: string, tasks: readonly SessionTask[]): void;
  onTask?(sessionId: string, agentId: string, task: SessionTask): void;
  onAgentState?(sessionId: string, agentId: string, state: AppAgentState): void;
  onAgentUsage?(sessionId: string, agentId: string, usage: AppAgentUsage): void;
  onAgentGoal?(sessionId: string, agentId: string, goal: AppGoal | null): void;
  onAgentTodos?(sessionId: string, agentId: string, todos: readonly AppTodoItem[]): void;
  onTaskOutput?(sessionId: string, agentId: string, taskId: string, offset: number, text: string): void;
  onTaskOutputFailed?(sessionId: string, agentId: string, taskId: string): void;
}

export interface KimiEventMeta {
  sessionId: string;
  hostId?: string;
}

export interface TaskCommandResult {
  code: number;
  msg?: string;
}

export interface KimiEventConnection {
  subscribeConversation(sessionId: string, agentId: string): void;
  unsubscribeConversation(sessionId: string, agentIds?: string[]): void;
  watchTaskOutput(sessionId: string, agentId: string, taskId: string): void;
  unwatchTaskOutput(sessionId: string, agentId: string, taskId: string): void;
  stopTask(sessionId: string, agentId: string, taskId: string): Promise<TaskCommandResult>;
  backgroundTask(sessionId: string, agentId: string, taskId: string): Promise<TaskCommandResult>;
  health(): { connected: boolean; open: boolean; stale: boolean };
  reconnect(): void;
  close(): void;
}

export interface AppModel {
  id: string;
  provider: string;
  model: string;
  displayName?: string;
  maxContextSize: number;
  capabilities?: string[];
  supportEfforts?: readonly string[];
  defaultEffort?: string;
}

export interface AppProvider {
  id: string;
  type: string;
  baseUrl?: string;
  defaultModel?: string;
  hasApiKey: boolean;
  status: 'connected' | 'error' | 'unconfigured';
  models?: string[];
}

export interface AppProviderDetail extends AppProvider {
  apiKey?: string;
}

export interface ProviderRefreshResult {
  changed: Array<{
    providerId: string;
    providerName: string;
    added: number;
    removed: number;
  }>;
  unchanged: string[];
  failed: Array<{ provider: string; reason: string }>;
}

export interface AddProviderModelInput {
  model: string;
  maxContextSize: number;
  displayName?: string;
  capabilities?: string[];
  maxOutputSize?: number;
  supportEfforts?: string[];
  adaptiveThinking?: boolean;
}

export interface AddProviderInput {
  id?: string;
  type: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  models?: AddProviderModelInput[];
}

export interface DeleteProviderResult {
  deleted: string;
}

export interface UpdateProviderInput {
  newId?: string;
  type: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  models: AddProviderModelInput[];
}

export interface UpdateProviderResult {
  provider: AppProvider;
}

export interface AppCatalogModel {
  id: string;
  name?: string;
  maxContextSize: number;
  capabilities?: string[];
  reasoning: boolean;
}

export interface AppCatalogProvider {
  id: string;
  name: string;
  wireType: string | null;
  baseUrl: string | null;
  guessed: boolean;
  needsBaseUrl: boolean;
  rejected: boolean;
  rejectReason: string | null;
  envKey: string | null;
  models: AppCatalogModel[];
}

export interface ImportCatalogProviderInput {
  catalogId: string;
  apiKey?: string;
  baseUrl?: string;
  id?: string;
}

export interface ImportCatalogProviderResult {
  provider: AppProvider;
  modelsImported: number;
}

export interface ImportCustomRegistryInput {
  url: string;
  apiKey?: string;
}

export interface ImportCustomRegistryResult {
  providers: AppProvider[];
  modelsImported: number;
}

export interface AppConfigProvider {
  type: string;
  baseUrl?: string;
  defaultModel?: string;
  hasApiKey: boolean;
}

export interface AppToolsConfig {
  enabled?: string[];
  disabled?: string[];
}

export interface AppHostDefinition {
  host: string;
  identityFile?: string;
  remoteBin?: string;
  name?: string;
  enabled?: boolean;
}

export type AppHostConnectFailure =
  | 'host_not_found'
  | 'connection_refused'
  | 'host_unreachable'
  | 'connect_timeout'
  | 'authentication_failed'
  | 'host_key_changed'
  | 'executor_not_found'
  | 'executor_outdated'
  | 'remote_busy'
  | 'remote_start_failed'
  | 'unknown';

export interface AppHost extends AppHostDefinition {
  id: string;
  status: 'pending' | 'connecting' | 'ready' | 'disconnected';
  remoteVersion?: string;
  connectError?: string;
  connectFailure?: AppHostConnectFailure;
}

export interface AppHostTestResult {
  connected: boolean;
  remoteVersion?: string;
  connectError?: string;
  connectFailure?: AppHostConnectFailure;
}

export interface AppSshConfigHost {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
}

export interface AppSshConfigHosts {
  configPath: string;
  exists: boolean;
  hosts: AppSshConfigHost[];
}

export interface AppProviderCopyResult {
  providers: string[];
}

export interface AppConfig {
  providers: Record<string, AppConfigProvider>;
  defaultProvider?: string;
  defaultModel?: string;
  secondaryModel?: {
    model?: string;
    defaultModel?: string;
    models?: Record<string, string>;
    force?: boolean;
    defaultEffort?: string;
  } | null;
  tools?: AppToolsConfig;
  models?: Record<string, unknown>;
  thinking?: { enabled?: boolean; effort?: string };
  planMode?: boolean;
  yolo?: boolean;
  defaultPermissionMode?: string;
  defaultPlanMode?: boolean;
  autoSessionTitle?: boolean;
  permission?: unknown;
  hooks?: unknown[];
  services?: unknown;
  mergeAllAvailableSkills?: boolean;
  extraSkillDirs?: string[];
  loopControl?: unknown;
  background?: unknown;
  experimental?: Record<string, boolean>;
  telemetry?: boolean;
  disableFeedbackSurvey?: boolean;
  raw?: Record<string, unknown>;
}

export interface AppToolCatalogEntry {
  name: string;
  source: 'builtin' | 'skill' | 'mcp';
}

export interface EditableTextFile {
  path: string;
  content: string;
  revision: string | null;
}

export interface AppSkill {
  name: string;
  description: string;
  path: string;
  source: string;
  workspaceDir?: string;
}

export type AppCapabilityId = 'kimi-cu' | 'kimi-webbridge';

export type AppCapabilityReadiness = 'not_installed' | 'partial' | 'ready' | 'unsupported';

export interface AppCapabilityStep {
  id: string;
  state: 'ok' | 'missing' | 'failed';
  detail?: string;
  optional?: boolean;
}

export interface AppCapabilityInstallProgress {
  running: boolean;
  step?: string;
  percent?: number;
  error?: string;
  note?: string;
  confirmationRequired?: 'stop-processes';
}

export interface AppCapabilityInstallOptions {
  stopRunningProcesses?: boolean;
}

export interface AppCapabilityStatus {
  id: string;
  pluginId?: string;
  displayName: string;
  description: string;
  supported: boolean;
  state: AppCapabilityReadiness;
  version?: string;
  steps: AppCapabilityStep[];
  install: AppCapabilityInstallProgress;
}

export type AppPluginSource = 'local-path' | 'zip-url' | 'github';

export type AppPluginOrigin = 'marketplace' | 'custom' | 'unknown';

export interface AppPluginSummary {
  id: string;
  displayName: string;
  description?: string;
  shortDescription?: string;
  longDescription?: string;
  version?: string;
  enabled: boolean;
  state: 'ok' | 'error';
  skillCount: number;
  mcpServerCount: number;
  enabledMcpServerCount: number;
  hookCount: number;
  commandCount: number;
  hasErrors: boolean;
  source: AppPluginSource;
  originalSource?: string;
  origin: AppPluginOrigin;
  installedAt: string;
  catalogId?: string;
}

export interface AppPluginSkillInfo {
  name: string;
  displayName?: string;
  description?: string;
}

export interface AppPluginMcpServerInfo {
  name: string;
  displayName?: string;
  description?: string;
  iconUrl?: string;
  runtimeName: string;
  enabled: boolean;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  envKeys?: string[];
  headerKeys?: string[];
}

export interface AppPluginCapabilities {
  skills: AppPluginSkillInfo[];
  mcpServers: AppPluginMcpServerInfo[];
}

export type AppMcpAuthState =
  | 'not-applicable'
  | 'bearer-token'
  | 'oauth-required'
  | 'oauth-authorized'
  | 'oauth-expired'
  | 'unavailable';

export interface AppMcpAuthStatus {
  name: string;
  authStatus: AppMcpAuthState;
}

export type AppMcpServerLocator =
  | { source: 'global'; name: string }
  | { source: 'plugin'; pluginId: string; serverName: string };

export type AppMcpAuthBeginResult =
  | { status: 'authorization-required'; flowId: string; authorizationUrl: string }
  | { status: 'already-authorized' };

export type AppPluginTier = 'official' | 'curated' | 'third-party';

export interface AppPluginMarketplaceEntry {
  id: string;
  tier: AppPluginTier;
  displayName: string;
  description?: string;
  shortDescription?: string;
  longDescription?: string;
  cliDescription?: string;
  homepage?: string;
  keywords?: string[];
  version?: string;
  sha256sum?: string;
  source: string;
  capabilityId?: string;
  installed?: { version?: string; enabled: boolean };
  updateAvailable?: boolean;
  iconUrl?: string;
  defaultLocale?: string;
  locale?: Record<string, unknown>;
  platforms?: string[];
  distribution?: {
    category?: string;
    region?: string;
    defaultInstall?: boolean;
    weight?: number;
    userLevel?: unknown;
  };
  billing?: string;
}

export interface AppSessionWarning {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

export interface MediaBlobOptions {
  prefixBytes?: number;
  signal?: AbortSignal;
  cache?: RequestCache;
}

export interface ReadRequestOptions {
  background?: boolean;
  signal?: AbortSignal;
}

export type CreateFeedbackInput =
  | {
    kind: 'global';
    source: 'sidebar' | 'command';
    category: 'bug' | 'suggestion' | 'other';
    content: string;
    session_id?: string;
    client?: 'desktop' | 'web';
    upload_session?: boolean;
    upload_logs?: boolean;
  }
  | { kind: 'turn'; session_id: string; turn_id: string; reply_id: string; rating: 'up' | 'down'; client?: 'desktop' | 'web' };

export type UpdateFeedbackInput =
  | { kind: 'details'; reasons: string[]; content?: string; upload_session?: boolean }
  | { kind: 'cancel' };

export interface FeedbackAttachmentInput {
  kind: 'media' | 'diagnostics';
  file: Blob;
  fileName: string;
}

export interface RemoteControlStatus {
  enabled: boolean;
  state: 'off' | 'starting' | 'on' | 'stopping';
  url?: string;
  device_id?: string;
  device_name?: string;
  error?: string;
  conflict?: {
    pid: number;
    local_origin: string;
    device_id: string;
    url: string;
    started_at: number;
  };
}

export type PromptPredictionCancelReason =
  | 'input'
  | 'escape'
  | 'new_turn'
  | 'session'
  | 'dialog'
  | 'queue'
  | 'submit'
  | 'visibility'
  | 'shutdown';

export interface KimiWebApi {
  dispose(): void;
  getHealth(): Promise<{ status: 'ok'; uptimeSec: number }>;
  getMeta(): Promise<{ protocolVersion: string; serverVersion: string; serverId: string; startedAt: string; homeDir: string; capabilities: Record<string, boolean>; openInApps: string[]; dangerousBypassAuth: boolean; experimentalFlags: Record<string, boolean>; backend: 'v1' | 'v2'; webTitle: string }>;
  getRemoteControlStatus(): Promise<RemoteControlStatus>;
  setRemoteControlEnabled(enabled: boolean): Promise<RemoteControlStatus>;
  listRemoteControlDevices(): Promise<RcDeviceList>;
  renameRemoteControlDevice(deviceId: string, alias: string): Promise<void>;
  deactivateRemoteControlDevice(deviceId: string): Promise<void>;
  deleteRemoteControlDevice(deviceId: string): Promise<void>;
  listSessions(input?: ListSessionsInput, options?: ReadRequestOptions): Promise<SessionsPage>;
  listSessionIds(input?: ListSessionIdsInput): Promise<SessionIdsPage>;
  listSessionGroups(input?: ListSessionGroupsInput, options?: ReadRequestOptions): Promise<SessionGroupsPage>;
  createSession(input: { title?: string; cwd?: string; model?: string; workspaceId?: string; planMode?: boolean }): Promise<AppSession>;
  getSession(sessionId: string, options?: ReadRequestOptions): Promise<AppSession>;
  updateSession(sessionId: string, input: { title?: string; cwd?: string; model?: string; permissionMode?: string; planMode?: boolean; swarmMode?: boolean; towerMode?: boolean; towerBase?: string; goalObjective?: string; goalControl?: 'pause' | 'resume' | 'cancel' | 'edit'; thinking?: string }): Promise<AppSession>;
  evaluateSessionRating(sessionId: string, turnId: string): Promise<AppSessionRatingOffer | null>;
  reportSessionRating(sessionId: string, report: AppSessionRatingReport): Promise<void>;
  createFeedback(input: CreateFeedbackInput): Promise<{ feedback_id: number }>;
  updateFeedback(feedbackId: number, input: UpdateFeedbackInput, sessionId?: string): Promise<{ feedback_id: number }>;
  uploadFeedbackAttachment(feedbackId: number, input: FeedbackAttachmentInput, signal?: AbortSignal): Promise<{ upload_id: number }>;
  uploadFeedbackSession(feedbackId: number, sessionId: string, signal?: AbortSignal, globalFeedback?: { hostId?: string }): Promise<{ upload_id: number }>;
  getTurnFileChanges(
    sessionId: string,
    turnNumber: number,
    options?: ReadRequestOptions,
  ): Promise<TurnFileHistoryChange[] | 'unrecorded'>;
  getTurnFileContent(
    sessionId: string,
    turnNumber: number,
    path: string,
    phase?: 'start' | 'end',
  ): Promise<TurnFileHistoryContent | null>;
  getSessionWarnings(sessionId: string, options?: ReadRequestOptions): Promise<AppSessionWarning[]>;
  archiveSession(sessionId: string): Promise<{ archived: true }>;
  restoreSession(sessionId: string): Promise<AppSession>;
  reloadSession(sessionId: string): Promise<AppSession>;
  takeoverSessionLock(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<{ deleted: true }>;
  archiveSessions(ids: string[]): Promise<BatchSessionResponse>;
  restoreSessions(ids: string[]): Promise<BatchSessionResponse>;
  getAgentTurns(
    sessionId: string,
    agentId: string,
    input?: AgentTurnsQuery,
    options?: ReadRequestOptions,
  ): Promise<ConversationTurnsPage>;
  exportSession(
    sessionId: string,
    webLog?: string,
    options?: { desktop?: boolean },
  ): Promise<{ blob: Blob; fileName: string }>;
  submitPrompt(sessionId: string, input: PromptSubmission): Promise<PromptSubmitResult>;
  steerPrompt(sessionId: string, input: PromptSubmission): Promise<PromptSubmitResult>;
  steerPrompts(sessionId: string, promptIds: string[]): Promise<{ steered: boolean; promptIds: string[] }>;
  abortPrompt(sessionId: string, promptId: string): Promise<{ aborted: boolean }>;
  cancelSession(sessionId: string, options?: { agentId?: string; includeBackground?: boolean }): Promise<{ cancelled: boolean }>;
  continueSession(sessionId: string): Promise<{ continued: true }>;
  compactSession(sessionId: string, instruction?: string): Promise<void>;
  undoSession(sessionId: string, turnId: string, agentId?: string): Promise<readonly string[]>;
  generateSessionTitle(
    sessionId: string,
    input?: { force?: boolean; source?: 'user_prompts' | 'first_turn' | 'digest' },
  ): Promise<string | null>;
  forkSession(sessionId: string, input?: { title?: string; turnIndex?: number }): Promise<AppSession>;
  startBtw(sessionId: string): Promise<{ agentId: string }>;
  closeAgent(sessionId: string, agentId: string): Promise<{ closed: true }>;
  predictNextPrompt(sessionId: string, input: { predictionId: string; expectedTurnId: number }): Promise<string | null>;
  cancelPromptPrediction(sessionId: string, predictionId: string, reason?: PromptPredictionCancelReason): Promise<boolean>;
  respondApproval(sessionId: string, approvalId: string, response: ApprovalResponse): Promise<InteractionRespondResult>;
  respondQuestion(sessionId: string, questionId: string, response: QuestionResponse): Promise<InteractionRespondResult>;
  dismissQuestion(sessionId: string, questionId: string): Promise<InteractionRespondResult>;
  listToolCatalog(): Promise<AppToolCatalogEntry[]>;
  listSkills(sessionId: string, options?: ReadRequestOptions): Promise<AppSkill[]>;
  listSkillsForWorkspace(workspaceId: string, options?: ReadRequestOptions): Promise<AppSkill[]>;
  activateSkill(sessionId: string, skillName: string, args?: string, attachments?: AppSkillAttachment[], options?: AppSkillActivationOptions): Promise<{ activated: true; skillName: string }>;
  listCapabilities(): Promise<AppCapabilityStatus[]>;
  getCapability(capabilityId: string): Promise<AppCapabilityStatus>;
  installCapability(capabilityId: string, options?: AppCapabilityInstallOptions): Promise<AppCapabilityStatus>;
  listPlugins(): Promise<AppPluginSummary[]>;
  getPluginInfo(pluginId: string, locale?: string): Promise<AppPluginCapabilities>;
  previewPlugin(input: { marketplaceId: string; expectedVersion?: string; expectedSha256?: string; locale?: string }): Promise<AppPluginCapabilities>;
  listPluginMarketplace(): Promise<AppPluginMarketplaceEntry[]>;
  installPlugin(input: string | { marketplaceId: string; expectedVersion?: string; expectedSha256?: string }): Promise<AppPluginSummary>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<{ ok: true }>;
  removePlugin(pluginId: string): Promise<{ ok: true }>;
  getMcpAuthStatuses(options?: { cwd?: string }): Promise<AppMcpAuthStatus[]>;
  inspectMcpAuthStatuses(locators: AppMcpServerLocator[], options?: { cwd?: string }): Promise<AppMcpAuthStatus[]>;
  beginMcpAuth(locator: AppMcpServerLocator, options?: { cwd?: string }): Promise<AppMcpAuthBeginResult>;
  completeMcpAuth(input: { flowId: string; timeoutMs?: number; signal?: AbortSignal }): Promise<null>;
  cancelMcpAuth(flowId: string): Promise<null>;
  resetMcpAuth(locator: AppMcpServerLocator, options?: { cwd?: string }): Promise<null>;
  listDirectory(sessionId: string, input: { path?: string; depth?: number; includeGitStatus?: boolean; showHidden?: boolean; allowIgnoredGlobs?: string[]; allowExternalSymlinks?: boolean }): Promise<{ items: FsEntry[]; childrenByPath?: Record<string, FsEntry[]>; truncated: boolean }>;
  listWorkspaceDirectory(workspace: string, input: { path?: string; depth?: number; showHidden?: boolean; allowIgnoredGlobs?: string[]; allowExternalSymlinks?: boolean }): Promise<{ items: FsEntry[]; childrenByPath?: Record<string, FsEntry[]>; truncated: boolean }>;
  readFile(sessionId: string, input: { path: string; offset?: number; length?: number; allowExternalSymlinks?: boolean }): Promise<{ path: string; content: string; encoding: 'utf-8' | 'base64'; size: number; truncated: boolean; etag: string; mime: string; languageId?: string; lineCount?: number; isBinary: boolean }>;
  searchFiles(workspace: string, input: { query: string; limit?: number }, opts?: { signal?: AbortSignal }): Promise<{ items: Array<{ path: string; name: string; kind: FsKind; score: number; matchPositions: number[] }>; truncated: boolean }>;
  suggestFiles(workspace: string, input: { query: string; limit?: number; showHidden?: boolean }, opts?: { signal?: AbortSignal }): Promise<{ items: Array<{ path: string; name: string; kind: FsKind; score: number; matchPositions: number[] }>; truncated: boolean }>;
  suggestFilesAtRoots(roots: readonly string[], input: { query: string; limit?: number; showHidden?: boolean }, opts?: { signal?: AbortSignal }): Promise<{ items: Array<{ path: string; name: string; kind: FsKind; score: number; matchPositions: number[] }>; truncated: boolean }>;
  grepFiles(sessionId: string, input: { pattern: string; regex?: boolean; caseSensitive?: boolean }): Promise<{ files: Array<{ path: string; matches: Array<{ line: number; col: number; text: string; before: string[]; after: string[] }> }>; filesScanned: number; truncated: boolean; elapsedMs: number }>;
  getGitStatus(sessionId: string, input?: GitStatusQuery, options?: ReadRequestOptions): Promise<GitStatusEntry>;
  getPullRequest(sessionId: string, input?: { root?: string }, options?: ReadRequestOptions): Promise<GitStatusEntry['pullRequest']>;
  getGitStatusBatch(sessionId: string, input: { roots: string[]; includePullRequest?: boolean }, options?: ReadRequestOptions): Promise<GitStatusBatchResult>;
  getPullRequestBatch(sessionId: string, input: { roots: string[] }, options?: ReadRequestOptions): Promise<PullRequestBatchResult>;
  getFileDiff(sessionId: string, path: string, input?: { root?: string }, options?: ReadRequestOptions): Promise<{ path: string; diff: string; truncated: boolean }>;
  getFileDownloadUrl(sessionId: string, path: string, opts?: { allowExternalSymlinks?: boolean }): string;
  downloadSessionFile(sessionId: string, path: string, opts?: { prefixBytes?: number; allowExternalSymlinks?: boolean }): Promise<Blob>;
  openFile(sessionId: string, input: { path: string; line?: number }): Promise<{ opened: true }>;
  revealFile(sessionId: string, input: { path: string }): Promise<{ revealed: true }>;
  openInApp(sessionId: string, appId: string, path: string, line?: number): Promise<void>;
  connectEvents(handlers: KimiEventHandlers): KimiEventConnection;

  listWorkspaces(): Promise<AppWorkspace[]>;
  addWorkspace(input: { root: string; name?: string; additionalDirs?: string[]; idempotencyKey: string; hostId?: string }): Promise<AppWorkspace>;
  updateWorkspace(id: string, input: { name?: string; additionalDirs?: string[] }): Promise<AppWorkspace>;
  setWorkspacePrimary(id: string, path: string): Promise<AppWorkspace>;
  getWorkspaceProjectConfigDirs(root: string): Promise<string[]>;
  deleteWorkspace(id: string): Promise<void>;
  getWorkspaceTrust(workspaceId: string, options?: ReadRequestOptions): Promise<{ trusted: boolean }>;
  trustWorkspace(workspaceId: string): Promise<{ trusted: boolean }>;
  browseFs(path: string | undefined, signal?: AbortSignal): Promise<FsBrowseResult>;
  listHosts(): Promise<AppHost[]>;
  putHost(id: string, definition: AppHostDefinition): Promise<void>;
  deleteHost(id: string): Promise<void>;
  connectHost(id: string): Promise<AppHost>;
  testHost(definition: AppHostDefinition, opts?: { signal?: AbortSignal }): Promise<AppHostTestResult>;
  listHostSshConfig(): Promise<AppSshConfigHosts>;
  copyProvidersToHost(id: string): Promise<AppProviderCopyResult>;
  getFsHome(): Promise<{ home: string; recentRoots: string[] }>;
  mkdirFs(path: string): Promise<{ path: string }>;

  listModels(): Promise<AppModel[]>;
  listProviders(): Promise<AppProvider[]>;
  getProvider(id: string): Promise<AppProviderDetail>;
  addProvider(input: AddProviderInput): Promise<AppProvider>;
  updateProvider(id: string, input: UpdateProviderInput): Promise<UpdateProviderResult>;
  deleteProvider(id: string): Promise<DeleteProviderResult>;
  refreshProvider(id: string): Promise<ProviderRefreshResult>;
  refreshAllProviders(): Promise<ProviderRefreshResult>;
  refreshOAuthProviderModels(): Promise<ProviderRefreshResult>;
  listCatalogProviders(): Promise<AppCatalogProvider[]>;
  getCatalogProvider(catalogId: string): Promise<AppCatalogProvider>;
  importCatalogProvider(input: ImportCatalogProviderInput): Promise<ImportCatalogProviderResult>;
  importCustomRegistry(input: ImportCustomRegistryInput): Promise<ImportCustomRegistryResult>;

  uploadFile(input: { file: Blob; name?: string; hostId?: string; onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal }): Promise<{ id: string; name: string; mediaType: string; size: number }>;
  getFileUrl(fileId: string): string;
  getFileBlob(fileId: string, options?: MediaBlobOptions): Promise<Blob>;
  getSessionMediaUrl(sessionId: string, fileId: string): string;
  getSessionMediaBlob(sessionId: string, fileId: string, options?: MediaBlobOptions): Promise<Blob>;

  readHostFileContent(path: string): Promise<{ path: string; content: string; encoding: 'utf-8' | 'base64'; mime: string; isBinary: boolean; size: number }>;
  downloadHostFile(path: string, opts?: { prefixBytes?: number }): Promise<Blob>;

  getConfig(): Promise<AppConfig>;
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  readHostTextFile(path: string): Promise<EditableTextFile>;
  writeHostTextFile(path: string, content: string, revision: string | null): Promise<{ revision: string }>;

  getAuth(): Promise<AuthResult>;
  startOAuthLogin(region?: OAuthRegion): Promise<OAuthLoginStartResult>;
  pollOAuthLogin(): Promise<{
    flowId: string;
    status: 'pending' | 'authenticated' | 'denied' | 'expired' | 'cancelled';
    resolvedAt?: string;
    errorMessage?: string;
  } | null>;
  cancelOAuthLogin(): Promise<{ cancelled: boolean; status: string }>;
  logout(): Promise<{ loggedOut: boolean }>;
  getUsage(): Promise<ManagedQuotaResult>;
  getUserInfo(): Promise<ManagedUserInfoResult>;
  getOAuthRegion(): Promise<OAuthRegion | null>;
  getClientConfig(name: string, options?: ReadRequestOptions): Promise<unknown>;
  getSessionContextSummary(sessionId: string, agentId?: string, options?: ReadRequestOptions): Promise<SessionContextSummary>;
  getSessionContextItems(
    sessionId: string,
    query?: { agentId?: string; role?: string; roles?: readonly string[]; offset?: number; limit?: number },
    options?: ReadRequestOptions,
  ): Promise<SessionContextItemsResponse>;
  getSessionContextItem(
    sessionId: string,
    itemId: string,
    agentId?: string,
  ): Promise<SessionContextItemDetail>;
}

export type OAuthRegion = 'mainland-cn' | 'global';

export type OAuthLoginStartResult =
  | {
      flowId: string;
      provider: string;
      status: 'pending';
      verificationUri: string;
      verificationUriComplete: string;
      userCode: string;
      expiresIn: number;
      interval: number;
      expiresAt: string;
    }
  | {
      flowId: string;
      provider: string;
      status: 'authenticated';
    };

export interface QuotaEntry {
  usedRatio: number;
  resetAt?: string;
}

export interface ManagedQuota {
  usages: {
    limit5h?: QuotaEntry;
    limit7d?: QuotaEntry;
    monthTotal?: QuotaEntry;
    monthCode?: QuotaEntry;
  };
  extraUsage: BoosterWallet | null;
}

export interface BoosterWallet {
  balanceCents: number;
  totalCents: number;
  monthlyChargeLimitEnabled: boolean;
  monthlyChargeLimitCents: number;
  monthlyUsedCents: number;
  currency: string;
}

export type ManagedQuotaResult =
  | { kind: 'ok'; quota: ManagedQuota }
  | { kind: 'error'; message: string; status?: number };

export interface ManagedUserInfo {
  userId: string;
  nickname: string;
  status: string;
  region: string;
  userLevel: number;
  userLevelName: string;
  domain: number;
  domainName: string;
  goodsVersion?: number;
  globalId?: string;
  bio?: string;
  avatar?: string;
  username?: string;
  email?: string;
  phone?: { countryCode: string; number: string };
  createdTime?: string;
  lastLoginTime?: string;
}

export type ManagedUserInfoResult =
  | { kind: 'ok'; userInfo: ManagedUserInfo }
  | { kind: 'error'; message: string; status?: number };

export const MANAGED_KIMI_CODE_PROVIDER_ID = 'managed:kimi-code';

export interface SessionContextGroup {
  role: string;
  count: number;
  tokens: number;
}

export interface SessionContextSummary {
  session_id: string;
  agent_id: string;
  captured_at: number;
  model?: string;
  tokens: {
    used: number;
    max?: number;
  };
  groups: SessionContextGroup[];
}

export type SessionContextItemSegment = 'thinking' | 'reply' | 'tool_call';

export interface SessionContextItemSummary {
  id: string;
  role: string;
  segment?: SessionContextItemSegment;
  name?: string;
  sequence?: number;
  preview: string;
  tokens: number;
  has_media: boolean;
}

export interface SessionContextItemsResponse {
  summary: SessionContextSummary;
  tools: SessionContextItemSummary[];
  items: SessionContextItemSummary[];
  total: number;
  has_more: boolean;
}

export interface SessionContextItemPart {
  kind: 'text' | 'think' | 'definition' | 'function' | 'media';
  text?: string;
  name?: string;
  tokens?: number;
  data?: unknown;
}

export interface SessionContextItemDetail {
  id: string;
  role: string;
  segment?: SessionContextItemSegment;
  name?: string;
  sequence?: number;
  tokens: number;
  has_media: boolean;
  parts: SessionContextItemPart[];
  raw: unknown;
}

export interface AuthResult {
  modelsReady: boolean;
  providersCount: number;
  managedProvider: { status: string } | null;
}
