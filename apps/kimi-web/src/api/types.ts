// apps/kimi-web/src/api/types.ts
// App-facing camelCase model + KimiWebApi interface.
// No daemon wire details here — Vue components consume only these types.

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface Page<T> {
  items: T[];
  hasMore: boolean;
}

export interface PageRequest {
  beforeId?: string;
  afterId?: string;
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type AppSessionStatus =
  | 'idle'
  | 'running'
  | 'awaitingApproval'
  | 'awaitingQuestion'
  | 'aborted';

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
  status: AppSessionStatus;
  currentPromptId?: string;
  cwd: string;
  model: string;
  usage: AppSessionUsage;
  messageCount: number;
  lastSeq: number;
  /**
   * The workspace this session belongs to. Present once the daemon ships the
   * workspace registry (returns `workspace_id` on Session). Until then it is
   * undefined and the composable maps sessions to workspaces by cwd === root.
   */
  workspaceId?: string;
}

// ---------------------------------------------------------------------------
// Workspace — a real folder the client organizes sessions by.
// 1 Workspace : N Sessions. A session inherits the workspace's root as its cwd.
// ---------------------------------------------------------------------------

export interface AppWorkspace {
  /** Stable id. In fallback mode (derived from session cwds) this IS the root. */
  id: string;
  /** Absolute path to the project root. */
  root: string;
  /** Display name — defaults to basename(root), may be renamed on the daemon. */
  name: string;
  /** Whether root is inside a git repository. */
  isGitRepo: boolean;
  /** Current branch, when known. */
  branch?: string;
  /** ISO timestamp of when this workspace was last opened. */
  lastOpenedAt?: string;
  /** Number of sessions belonging to this workspace. */
  sessionCount: number;
}

/** One directory entry from the daemon folder browser (fs:browse). */
export interface FsBrowseEntry {
  name: string;
  path: string;
  isDir: boolean;
  isGitRepo: boolean;
  branch?: string;
}

export interface FsBrowseResult {
  path: string;
  parent: string | null;
  entries: FsBrowseEntry[];
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export type AppMessageRole = 'user' | 'assistant' | 'tool' | 'system';

export type AppMessageContent =
  | { type: 'text'; text: string }
  | { type: 'toolUse'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'toolResult'; toolCallId: string; output: unknown; isError?: boolean }
  | { type: 'image'; source: ImageSource }
  | { type: 'file'; fileId: string; name: string; mediaType: string; size: number }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'unknown'; raw: unknown };

export type ImageSource =
  | { kind: 'url'; url: string }
  | { kind: 'base64'; mediaType: string; data: string }
  | { kind: 'file'; fileId: string };

export interface AppMessage {
  id: string;
  sessionId: string;
  role: AppMessageRole;
  content: AppMessageContent[];
  createdAt: string;
  promptId?: string;
  parentMessageId?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface PromptSubmission {
  content: AppMessageContent[];
  metadata?: Record<string, unknown>;
  /** The daemon requires these on every prompt (per-prompt, not session-level). */
  model?: string;
  thinking?: ThinkingLevel;
  permissionMode?: 'manual' | 'auto' | 'yolo';
  planMode?: boolean;
}

export interface PromptSubmitResult {
  promptId: string;
  userMessageId: string;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';

export interface ApprovalResponse {
  decision: ApprovalDecision;
  scope?: 'session';
  feedback?: string;
  selectedLabel?: string;
}

export interface AppApprovalRequest {
  approvalId: string;
  sessionId: string;
  turnId?: number;
  toolCallId: string;
  toolName: string;
  action: string;
  display: unknown; // ToolInputDisplay — Web renders what it knows, falls back to generic
  expiresAt: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Question
// ---------------------------------------------------------------------------

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
  turnId?: number;
  toolCallId?: string;
  questions: QuestionItem[];
  expiresAt: string;
  createdAt: string;
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

// ---------------------------------------------------------------------------
// Background Task
// ---------------------------------------------------------------------------

export type AppTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface AppTask {
  id: string;
  sessionId: string;
  kind: 'subagent' | 'bash' | 'tool';
  description: string;
  status: AppTaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  outputPreview?: string;
  outputBytes?: number;
  outputLines?: string[]; // accumulated by eventReducer from task.progress chunks
}

// ---------------------------------------------------------------------------
// File System
// ---------------------------------------------------------------------------

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
  isSymlinkTo?: string;
  gitStatus?: string;
  childCount?: number;
}

// ---------------------------------------------------------------------------
// Events (app-facing, camelCase)
// ---------------------------------------------------------------------------

export type AppEvent =
  | { type: 'sessionCreated'; session: AppSession }
  | { type: 'sessionUpdated'; session: AppSession; changedFields: string[] }
  | { type: 'sessionDeleted'; sessionId: string }
  | { type: 'sessionStatusChanged'; sessionId: string; status: AppSessionStatus; previousStatus: AppSessionStatus; currentPromptId?: string }
  | { type: 'sessionMetaUpdated'; sessionId: string; title: string }
  | { type: 'sessionUsageUpdated'; sessionId: string; usage: AppSessionUsage; model?: string }
  | { type: 'historyCompacted'; sessionId: string; beforeSeq: number; reason: string; summaryMessageId?: string }
  | { type: 'messageCreated'; message: AppMessage }
  | { type: 'messageUpdated'; sessionId: string; messageId: string; content: AppMessageContent[]; status: 'pending' | 'completed' | 'error' }
  | { type: 'assistantDelta'; sessionId: string; messageId: string; contentIndex: number; delta: { text?: string; thinking?: string } }
  | { type: 'approvalRequested'; sessionId: string; approval: AppApprovalRequest }
  | { type: 'approvalResolved'; sessionId: string; approvalId: string; decision: ApprovalDecision; resolvedAt: string }
  | { type: 'approvalExpired'; sessionId: string; approvalId: string }
  | { type: 'questionRequested'; sessionId: string; question: AppQuestionRequest }
  | { type: 'questionAnswered'; sessionId: string; questionId: string; resolvedAt: string }
  | { type: 'questionDismissed'; sessionId: string; questionId: string; dismissedAt: string }
  | { type: 'questionExpired'; sessionId: string; questionId: string }
  | { type: 'taskCreated'; sessionId: string; task: AppTask }
  | { type: 'taskProgress'; sessionId: string; taskId: string; outputChunk: string; stream: 'stdout' | 'stderr' }
  | { type: 'taskCompleted'; sessionId: string; taskId: string; status: AppTaskStatus; outputPreview?: string; outputBytes?: number }
  | { type: 'unknown'; raw: unknown };

// ---------------------------------------------------------------------------
// WebSocket connection helpers
// ---------------------------------------------------------------------------

export interface KimiEventHandlers {
  onEvent(event: AppEvent, meta: { sessionId: string; seq: number }): void;
  onResync(sessionId: string, currentSeq: number): void;
  onError(code: number, msg: string, fatal: boolean): void;
  onConnectionChange(connected: boolean): void;
}

export interface KimiEventConnection {
  subscribe(sessionId: string, lastSeq?: number): void;
  unsubscribe(sessionId: string): void;
  /**
   * Bind the real daemon prompt_id to the next turn for a session, so the
   * client-side projector stops synthesizing a random promptId on turn.started.
   * Call right after submitPrompt() returns.
   */
  bindNextPromptId(sessionId: string, promptId: string): void;
  abort(sessionId: string, promptId: string): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Model + Provider (app-facing, camelCase)
// PRESUMED — not in current daemon docs; isolated in adapter, swap when backend defines them.
// ---------------------------------------------------------------------------

export interface AppModel {
  /** Unique identifier for this model (the string passed to PATCH session agent_config.model) */
  id: string;
  /** Provider id this model belongs to */
  provider: string;
  /** Raw model name (e.g. "moonshot-v1-128k") */
  model: string;
  /** Optional human-readable display name */
  displayName?: string;
  /** Maximum context size in tokens */
  maxContextSize: number;
  /** Optional capability tags (e.g. ["vision", "thinking"]) */
  capabilities?: string[];
}

export interface AppProvider {
  /** Provider id */
  id: string;
  /** Provider type (e.g. "moonshot", "anthropic", "openai", "custom") */
  type: string;
  /** Optional custom base URL */
  baseUrl?: string;
  /** Optional default model alias */
  defaultModel?: string;
  /** Whether an API key is stored for this provider */
  hasApiKey: boolean;
  /** Provider connectivity status */
  status: 'connected' | 'error' | 'unconfigured';
  /** Model ids available from this provider */
  models?: string[];
}

// ---------------------------------------------------------------------------
// KimiWebApi — the app-facing interface
// ---------------------------------------------------------------------------

export interface KimiWebApi {
  getHealth(): Promise<{ status: 'ok'; uptimeSec: number }>;
  getMeta(): Promise<{ daemonVersion: string; serverId: string; startedAt: string; capabilities: Record<string, boolean> }>;
  listSessions(input?: PageRequest & { status?: AppSessionStatus; workspaceId?: string }): Promise<Page<AppSession>>;
  createSession(input: { title?: string; cwd?: string; model?: string; workspaceId?: string }): Promise<AppSession>;
  updateSession(sessionId: string, input: { title?: string; cwd?: string; model?: string }): Promise<AppSession>;
  deleteSession(sessionId: string): Promise<{ deleted: true }>;
  listMessages(sessionId: string, input?: PageRequest & { role?: AppMessageRole }): Promise<Page<AppMessage>>;
  submitPrompt(sessionId: string, input: PromptSubmission): Promise<PromptSubmitResult>;
  abortPrompt(sessionId: string, promptId: string): Promise<{ aborted: boolean; atSeq?: number }>;
  respondApproval(sessionId: string, approvalId: string, response: ApprovalResponse): Promise<{ resolved: true; resolvedAt: string }>;
  respondQuestion(sessionId: string, questionId: string, response: QuestionResponse): Promise<{ resolved: true; resolvedAt: string }>;
  dismissQuestion(sessionId: string, questionId: string): Promise<{ dismissed: true; dismissedAt: string }>;
  listTasks(sessionId: string, status?: AppTaskStatus): Promise<AppTask[]>;
  getTask(sessionId: string, taskId: string, input?: { withOutput?: boolean; outputBytes?: number }): Promise<AppTask>;
  cancelTask(sessionId: string, taskId: string): Promise<{ cancelled: true }>;
  listDirectory(sessionId: string, input: { path?: string; depth?: number; includeGitStatus?: boolean }): Promise<{ items: FsEntry[]; childrenByPath?: Record<string, FsEntry[]>; truncated: boolean }>;
  readFile(sessionId: string, input: { path: string; offset?: number; length?: number }): Promise<{ path: string; content: string; encoding: 'utf-8' | 'base64'; size: number; truncated: boolean; etag: string; mime: string; languageId?: string; lineCount?: number; isBinary: boolean }>;
  searchFiles(sessionId: string, input: { query: string; limit?: number }): Promise<{ items: Array<{ path: string; name: string; kind: FsKind; score: number; matchPositions: number[] }>; truncated: boolean }>;
  grepFiles(sessionId: string, input: { pattern: string; regex?: boolean; caseSensitive?: boolean }): Promise<{ files: Array<{ path: string; matches: Array<{ line: number; col: number; text: string; before: string[]; after: string[] }> }>; filesScanned: number; truncated: boolean; elapsedMs: number }>;
  getGitStatus(sessionId: string, paths?: string[]): Promise<{ branch: string; ahead: number; behind: number; entries: Record<string, string> }>;
  getFileDiff(sessionId: string, path?: string): Promise<{ path: string; diff: string }>;
  connectEvents(handlers: KimiEventHandlers): KimiEventConnection;

  // Workspaces + daemon folder browser
  // PRESUMED — falls back until the daemon ships /workspaces, /fs:browse, /fs:home.
  listWorkspaces(): Promise<AppWorkspace[]>;
  addWorkspace(input: { root: string; name?: string }): Promise<AppWorkspace>;
  browseFs(path?: string): Promise<FsBrowseResult>;
  getFsHome(): Promise<{ home: string; recentRoots: string[] }>;

  // PRESUMED — not in current daemon docs; isolated in adapter, swap when backend defines them.
  listModels(): Promise<AppModel[]>;
  listProviders(): Promise<AppProvider[]>;
  addProvider(input: { type: string; apiKey?: string; baseUrl?: string; defaultModel?: string }): Promise<AppProvider>;
  deleteProvider(id: string): Promise<{ deleted: true }>;
  refreshProvider(id: string): Promise<AppProvider>;

  // File upload
  uploadFile(input: { file: Blob; name?: string }): Promise<{ id: string; name: string; mediaType: string; size: number }>;

  // Auth — REAL endpoints
  getAuth(): Promise<{
    ready: boolean;
    providersCount: number;
    defaultModel: string | null;
    managedProvider: { status: string } | null;
  }>;
  startOAuthLogin(): Promise<{
    flowId: string;
    provider: string;
    verificationUri: string;
    verificationUriComplete: string;
    userCode: string;
    expiresIn: number;
    interval: number;
    status: 'pending';
    expiresAt: string;
  }>;
  pollOAuthLogin(): Promise<{
    flowId: string;
    status: 'pending' | 'authenticated' | 'expired' | 'cancelled';
    resolvedAt?: string;
  } | null>;
  cancelOAuthLogin(): Promise<{ cancelled: boolean; status: string }>;
  logout(): Promise<{ loggedOut: boolean }>;
}
