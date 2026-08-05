// apps/kimi-web/src/api/types.ts
// App-facing camelCase model + KimiWebApi interface.
// No daemon wire details here — Vue components consume only these types.

import type {
  AgentDescriptor,
  AgentRef,
  AgentTranscriptSnapshot,
  TranscriptOperation,
} from '@moonshot-ai/transcript';

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
// Notices
// ---------------------------------------------------------------------------

export type AppNoticeSeverity = 'info' | 'success' | 'warning' | 'error';

export interface AppNoticeDetail {
  label: string;
  value: string;
}

export interface AppNotice {
  severity: AppNoticeSeverity;
  title: string;
  message?: string;
  details?: AppNoticeDetail[];
}

export type AppWarning = string | AppNotice;

/**
 * The latest main-turn terminal error of a session (e.g. a provider 429 after
 * step retries are exhausted). Recorded from the agent's session-scoped `error`
 * event so the conversation can render a persistent failed-turn card; cleared
 * when the next main turn starts. Not persisted — after a reload the card
 * falls back to the generic copy driven by `lastTurnReason` alone.
 */
export interface AppTurnError {
  code?: string;
  message?: string;
  name?: string;
  retryable?: boolean;
  /** HTTP status from the provider (details.statusCode), when present. */
  statusCode?: number;
  /** Provider request id (details.requestId), when present. */
  requestId?: string;
}

/** Live retry state of the main turn's current step (the loop's stepRetry
 *  backoff). Mirrors the wire `agent.status.updated` phase 'retrying'. */
export interface AppTurnRetry {
  failedAttempt: number;
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  errorName?: string;
  statusCode?: number;
  /** The turn this backoff belongs to — snapshot rebuilds keep the slice
   *  only while the in-flight turn still matches it. */
  turnId?: number;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

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
  /** Any agent in the session holds an active turn or background lease.
   *  Awaiting states ride the approval/question channels; turn outcomes ride
   *  turn.ended. */
  busy: boolean;
  /** Whether the main agent has an active turn. Unlike busy, this excludes
   *  background tasks and sub-agent work. */
  mainTurnActive?: boolean;
  /** List-level fallback for the action-required badge. */
  pendingInteraction?: 'none' | 'approval' | 'question';
  /** Outcome of the main agent's most recent turn (when the server reports
   *  one). Presentation rule for the "aborted" tag:
   *  `!busy && (cancelled | failed)`. */
  lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  archived: boolean;
  currentPromptId?: string;
  /** Text of the most recent user prompt, for search/preview. */
  lastPrompt?: string;
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
  /**
   * Set on a child ("side chat") session — the id of the parent it was forked
   * from. Used to keep child sessions out of the main session list.
   */
  parentSessionId?: string;
}

/**
 * Live runtime state from GET /sessions/{id}/status — the source of truth for
 * the current model + context usage (Session.agent_config.model can be "").
 */
export interface AppSessionRuntimeStatus {
  /** Current model alias, or null if the daemon couldn't resolve it. */
  model: string | null;
  thinkingEffort: string;
  permission: string;
  planMode: boolean;
  swarmMode: boolean;
  contextTokens: number;
  maxContextTokens: number;
  contextUsage: number;
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
  | {
      type: 'toolUse';
      toolCallId: string;
      toolName: string;
      input: unknown;
      outputLines?: string[];
      agentRefs?: readonly AgentRef[];
    }
  | { type: 'toolResult'; toolCallId: string; output: unknown; isError?: boolean }
  | { type: 'image'; source: ImageSource }
  | { type: 'video'; source: ImageSource }
  | { type: 'file'; fileId: string; name: string; mediaType: string; size: number }
  | {
      type: 'thinking';
      thinking: string;
      signature?: string;
      /** Renderer-measured timing (client-side only, never persisted): when this
          thinking part opened (ISO) and how long it streamed (ms). Absent on
          history-loaded or snapshot-restored parts. */
      startedAt?: string;
      durationMs?: number;
    }
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
  /** Authoritative daemon id for a user message whose client-side optimistic
      id is intentionally kept as `id` to avoid remounting the visible turn. */
  userMessageId?: string;
  parentMessageId?: string;
  /** Client-side measured duration from turn.started to turn.ended (ms). */
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Metadata key of the client-side compaction marker message appended on
 * compactionCompleted. The transcript keeps all prior messages (TUI parity);
 * this marker renders as a "context compacted" divider. Snapshot-loaded
 * summary messages (origin kind 'compaction_summary') render the same way
 * but carry no token stats.
 */
export const COMPACTION_MARKER_METADATA_KEY = 'kimiWeb.compaction';

export interface CompactionMarkerMetadata {
  trigger: 'manual' | 'auto';
  tokensBefore?: number;
  tokensAfter?: number;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Runtime thinking level. 'off' disables extended thinking; 'on' is the
 * enable signal for legacy boolean models (those without `support_efforts`);
 * any other string is a model-declared effort level (e.g. 'low'/'high'/'max').
 *
 * `support_efforts` is the single source of truth for which concrete levels a
 * model accepts; providers silently drop unknown efforts rather than erroring.
 * Collapses to `string` at runtime — this is a semantic marker, not a closed
 * enum. Mirrors kosong's `ThinkingEffort`.
 */
export type ThinkingLevel = 'off' | 'on' | (string & {});

export interface PromptSubmission {
  content: AppMessageContent[];
  metadata?: Record<string, unknown>;
  /** Optional non-main agent id, used by BTW side-channel prompts. */
  agentId?: string;
  /** The daemon requires these on every prompt (per-prompt, not session-level). */
  model?: string;
  /** Omit to leave the session profile's thinking untouched — the daemon then
   *  resolves the config/model default (same as an unset [thinking] in the TUI). */
  thinking?: ThinkingLevel;
  permissionMode?: 'manual' | 'auto' | 'yolo';
  planMode?: boolean;
  swarmMode?: boolean;
  goalObjective?: string;
  goalControl?: 'pause' | 'resume' | 'cancel';
}

export interface PromptSubmitResult {
  promptId: string;
  userMessageId: string;
  /** 'running' when the prompt started a turn immediately; 'queued' when
      another prompt is active and the daemon parked it (steerable). */
  status?: 'running' | 'queued';
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
  recommended?: boolean;
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
export type AppSubagentPhase = 'queued' | 'working' | 'suspended' | 'completed' | 'failed';

export interface AppTask {
  id: string;
  /** Stable child-agent id for Transcript reads/subscriptions. Background-task
   *  REST rows omit this because their `id` belongs to the task store. */
  agentId?: string;
  sessionId: string;
  kind: 'subagent' | 'bash' | 'tool';
  description: string;
  status: AppTaskStatus;
  command?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  outputPreview?: string;
  outputBytes?: number;
  outputLines?: string[]; // accumulated by eventReducer from task.progress chunks
  /** The subagent's concatenated live output (assistant.delta), accumulated by
   *  the event reducer from `taskProgress` chunks of kind `text`. Grows in the
   *  right-side detail panel like a thinking block. */
  text?: string;
  subagentPhase?: AppSubagentPhase;
  subagentType?: string;
  parentToolCallId?: string;
  suspendedReason?: string;
  swarmIndex?: number;
  /** True only for subagents detached into the background task store. Drives
   *  the dock: the dock lists background subagents, while foreground subagents
   *  render inline in the message flow as the `Agent` tool card. */
  runInBackground?: boolean;
  /** The id this same subagent has in the server's background-task store
   *  (REST `/tasks`), learned from the `task.started` registration event. The
   *  WS event stream keys the agent by agent id while REST keys it by task id;
   *  this links the two so the REST copy can be folded into this row and so
   *  cancel can target the id REST actually knows. */
  backgroundTaskId?: string;
}

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

export type AppGoalStatus = 'active' | 'paused' | 'blocked' | 'complete';

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

// ---------------------------------------------------------------------------
// Plan history
// ---------------------------------------------------------------------------

export type SessionPlanReviewState = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface SessionPlanReview {
  state: SessionPlanReviewState;
  selectedOption?: string;
  feedback?: string;
}

export interface SessionPlanOption {
  label: string;
  description?: string;
}

/** Persisted ExitPlanMode payload and its eventual review outcome. */
export interface SessionPlan {
  agentId: string;
  toolCallId: string;
  turnId: string;
  source: 'interaction' | 'display' | 'output';
  plan: string;
  path?: string;
  options?: SessionPlanOption[];
  review?: SessionPlanReview;
}

export interface SessionPlanQuery {
  agentId: string;
  toolCallId?: string;
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

export type AppTerminalStatus = 'running' | 'exited';

export interface AppTerminal {
  id: string;
  sessionId: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  status: AppTerminalStatus;
  createdAt: string;
  exitedAt?: string;
  exitCode?: number | null;
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
  | { type: 'workspaceCreated'; workspace: AppWorkspace }
  | { type: 'workspaceUpdated'; workspace: AppWorkspace }
  | { type: 'workspaceDeleted'; workspaceId: string; root: string }
  | { type: 'sessionUpdated'; session: AppSession; changedFields: string[] }
  | { type: 'sessionDeleted'; sessionId: string }
  | {
      type: 'sessionWorkChanged';
      sessionId: string;
      busy: boolean;
      mainTurnActive?: boolean;
      pendingInteraction?: 'none' | 'approval' | 'question';
      lastTurnReason?: 'completed' | 'cancelled' | 'failed';
    }
  | { type: 'sessionMetaUpdated'; sessionId: string; title?: string; lastPrompt?: string }
  | { type: 'sessionUsageUpdated'; sessionId: string; usage: AppSessionUsage; model?: string; swarmMode?: boolean; planMode?: boolean; thinking?: string }
  | { type: 'historyCompacted'; sessionId: string; beforeSeq: number; reason: string; summaryMessageId?: string }
  | { type: 'compactionStarted'; sessionId: string; trigger: 'manual' | 'auto'; instruction?: string }
  | { type: 'compactionCompleted'; sessionId: string; tokensBefore?: number; tokensAfter?: number; summary?: string }
  | { type: 'compactionCancelled'; sessionId: string }
  | {
      type: 'messageCreated';
      message: AppMessage;
      /** Present for raw prompt.submitted frames so non-main prompts can be
          routed to their agent-scoped transcript before touching main state. */
      agentId?: string;
    }
  | { type: 'messageUpdated'; sessionId: string; messageId: string; content: AppMessageContent[]; status: 'pending' | 'completed' | 'error'; durationMs?: number }
  | { type: 'assistantDelta'; sessionId: string; messageId: string; contentIndex: number; delta: { text?: string; thinking?: string } }
  // Side-channel / non-main-agent streaming: carries text/thinking deltas for a
  // specific agent (e.g. a BTW side chat) without folding them into the parent
  // transcript. The web layer routes these to the side-chat panel.
  | { type: 'agentDelta'; sessionId: string; agentId: string; delta: { text?: string; thinking?: string } }
  | { type: 'agentTurnEnded'; sessionId: string; agentId: string; reason?: string }
  | { type: 'toolOutput'; sessionId: string; toolCallId: string; outputChunk: string; stream: 'stdout' | 'stderr' }
  | { type: 'approvalRequested'; sessionId: string; approval: AppApprovalRequest }
  | { type: 'approvalResolved'; sessionId: string; approvalId: string; decision: ApprovalDecision; resolvedAt: string }
  | { type: 'approvalExpired'; sessionId: string; approvalId: string }
  | { type: 'questionRequested'; sessionId: string; question: AppQuestionRequest }
  | { type: 'questionAnswered'; sessionId: string; questionId: string; resolvedAt: string }
  | { type: 'questionDismissed'; sessionId: string; questionId: string; dismissedAt: string }
  | { type: 'taskCreated'; sessionId: string; task: AppTask }
  | {
      type: 'taskProgress';
      sessionId: string;
      taskId: string;
      outputChunk: string;
      stream: 'stdout' | 'stderr';
      /**
       * `line` (default) appends a new progress line (tool-call / tool-progress).
       * `text` concatenates onto the subagent's growing streamed output
       * (`AppTask.text`), shown live in the detail panel like a thinking block.
       */
      kind?: 'line' | 'text';
    }
  | { type: 'taskCompleted'; sessionId: string; taskId: string; status: AppTaskStatus; outputPreview?: string; outputBytes?: number }
  // Prompt-level lifecycle (distinct from turn-level): a prompt that never
  // produced a turn — blocked by a pre-submit hook, or aborted while queued —
  // gets no turn.ended and no session status flip, so these are the web layer's
  // only signal to clear the per-session in-flight state. A normal turn's
  // prompt.completed is a no-op for state (the status_changed ahead of it
  // already finished the prompt).
  | { type: 'promptCompleted'; sessionId: string; promptId: string; reason: string }
  | { type: 'promptAborted'; sessionId: string; promptId: string }
  // The MAIN agent's turn boundary — the single source of truth for "the main
  // conversation has a turn in flight" (half of the working moon, and the
  // streaming reveal). Deliberately NOT derived from session status: a
  // background subagent or BTW side chat keeps the session busy but must not
  // light up the main conversation's moon. `reason` rides on deactivation.
  | {
      type: 'turnActiveChanged';
      sessionId: string;
      active: boolean;
      reason?: string;
      /** Present on deactivation: the prompt this turn served. Lets the
       *  reducer tell an active-turn abort (prompt.aborted for a prompt whose
       *  turn already ended — not a second recency moment) from a queued abort
       *  (no turn ever started — the recency moment turn.ended never gave). */
      promptId?: string;
    }
  | { type: 'goalUpdated'; sessionId: string; goal: AppGoal | null }
  /** The main turn's current step is backing off before a retry (provider
   *  429/5xx, connection, timeout). `retry` present = retrying phase entered;
   *  undefined = left (next attempt started / step completed / turn ended).
   *  Drives the working indicator's retry label. */
  | { type: 'turnRetry'; sessionId: string; retry?: AppTurnRetry }
  | { type: 'configChanged'; changedFields: string[]; config: AppConfig }
  | {
      type: 'modelCatalogChanged';
      changed: { providerId: string; providerName: string; added: number; removed: number }[];
      unchanged: string[];
      failed: { provider: string; reason: string }[];
    }
  | { type: 'unknown'; raw: unknown };

// ---------------------------------------------------------------------------
// WebSocket connection helpers
// ---------------------------------------------------------------------------

/** Per-session sync cursor (v2): durable seq + journal epoch. */
export interface AppSessionCursor {
  seq: number;
  epoch?: string;
}

/** In-flight (mid-turn) state recovered from the session snapshot. */
export interface AppInFlightToolCall {
  toolCallId: string;
  name: string;
  args?: unknown;
  description?: string;
  lastProgress?: { kind: string; text?: string; percent?: number };
}

export interface AppInFlightTurn {
  turnId: number;
  assistantText: string;
  thinkingText: string;
  runningTools: AppInFlightToolCall[];
  /** Authoritative daemon prompt_id for the active prompt, if known. */
  promptId?: string;
}

/**
 * IM-style initial sync result: everything needed to rebuild a session's UI
 * state, consistent at `asOfSeq`. The standard flow is
 * `getSessionSnapshot()` → `subscribe(sessionId, {seq: asOfSeq, epoch})`.
 */
export interface AppSessionSnapshot {
  asOfSeq: number;
  epoch: string;
  session: AppSession;
  /** Most recent messages, chronological ascending. */
  messages: AppMessage[];
  hasMoreMessages: boolean;
  inFlightTurn: AppInFlightTurn | null;
  /** Live subagent roster at the watermark — rebuilds swarm cards on refresh. */
  subagents: AppTask[];
  pendingApprovals: AppApprovalRequest[];
  pendingQuestions: AppQuestionRequest[];
}

export interface SessionTranscriptPage extends AgentTranscriptSnapshot {
  agentId: string;
  agents: AgentDescriptor[];
  pendingInteractions: string[];
  seq?: number;
}

export interface SessionTranscriptQuery {
  agentId: string;
  beforeTurn?: string;
  afterTurn?: string;
  pageSize?: number;
}

export interface KimiEventHandlers {
  onEvent(event: AppEvent, meta: KimiEventMeta): void;
  onResync(sessionId: string, currentSeq: number, epoch?: string): void;
  onError(code: number, msg: string, fatal: boolean): void;
  onConnectionChange(connected: boolean): void;
  /** Fires after reconnect replay is complete and client_hello is acknowledged. */
  onReplayComplete?(): void;
  onTerminalOutput?(sessionId: string, terminalId: string, data: string, seq: number): void;
  onTerminalExit?(sessionId: string, terminalId: string, exitCode: number | null): void;
  onTranscriptReset?(
    sessionId: string,
    agentId: string,
    snapshot: AgentTranscriptSnapshot,
    seq?: number,
  ): void;
  onTranscriptOps?(
    sessionId: string,
    agentId: string,
    ops: readonly TranscriptOperation[],
    seq?: number,
  ): boolean;
}

/** Raw stream coordinates are present only for kap-server assistant/thinking
    deltas. They let the render queue merge chunks without guessing continuity. */
export interface KimiEventMeta {
  sessionId: string;
  seq: number;
  stream?: {
    turnId: number;
    offset: number;
    kind: 'text' | 'thinking';
  };
}

export interface KimiEventConnection {
  subscribe(sessionId: string, cursor?: AppSessionCursor): void;
  unsubscribe(sessionId: string): void;
  /** Replace this session's Transcript subscription with one agent. */
  subscribeTranscript(sessionId: string, agentId: string, sinceSeq?: number): void;
  /** Remove selected agents, or the whole Transcript stream when omitted. */
  unsubscribeTranscript(sessionId: string, agentIds?: string[]): void;
  /**
   * Bind the real daemon prompt_id to the next turn for a session, so the
   * client-side projector stops synthesizing a random promptId on turn.started.
   * Call right after submitPrompt() returns.
   */
  bindNextPromptId(sessionId: string, promptId: string): void;
  /**
   * Seed the client-side projector with a snapshot's in-flight turn so a
   * reconnecting client renders mid-turn state immediately; emits the
   * corresponding AppEvents through `onEvent`. Resets per-session projector
   * state first — call BEFORE subscribe(), with the snapshot's cursor.
   */
  seedSnapshot(sessionId: string, snapshot: AppSessionSnapshot): void;
  abort(sessionId: string, promptId: string): void;
  terminalAttach(sessionId: string, terminalId: string, sinceSeq?: number): void;
  terminalInput(sessionId: string, terminalId: string, data: string): void;
  terminalResize(sessionId: string, terminalId: string, cols: number, rows: number): void;
  terminalDetach(sessionId: string, terminalId: string): void;
  terminalClose(sessionId: string, terminalId: string): void;
  /**
   * Mark an agent as a side-channel (e.g. BTW side chat). The client-side
   * projector will then emit its text/thinking deltas as agent-scoped events
   * instead of dropping them like background subagents, and main-only raw
   * subscriptions will keep that agent in the parent session's filter.
   */
  markSideChannelAgent(sessionId: string, agentId: string): void;
  /**
   * Report the underlying socket's health. Used to detect a silent-half-open
   * connection after the tab was frozen in the background: the browser still
   * reports OPEN (so no auto-reconnect) yet no frames have arrived for a while.
   */
  health(): { connected: boolean; open: boolean; stale: boolean };
  /**
   * Force a clean reconnect of the underlying socket. Used to recover from a
   * silent-half-open (background-tab freeze) where onclose never fires. The
   * reconnect handshake re-subscribes at the last durable cursor. No-op after
   * close().
   */
  reconnect(): void;
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
  /** Effort levels this model supports for extended thinking (e.g. ["low", "high", "max"]).
      Sourced from the model catalog (managed) or config [models.<id>.overrides]. */
  supportEfforts?: readonly string[];
  /** Catalog-declared default effort for extended thinking. */
  defaultEffort?: string;
}

export interface AppProvider {
  /** Provider id */
  id: string;
  /** Provider wire protocol (one of PROVIDER_TYPES: kimi / openai /
      openai_responses / anthropic / google-genai / vertexai) */
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

/** Single-provider GET result: the only response that reveals the stored key. */
export interface AppProviderDetail extends AppProvider {
  /** Stored API key in plaintext (absent when none is set) */
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

/** One model entry of a manually added provider (POST /providers, design §4.1). */
export interface AddProviderModelInput {
  /** Model id; written as the `<id>/<model>` alias */
  model: string;
  /** Maximum context size in tokens */
  maxContextSize: number;
  /** Optional human-readable display name */
  displayName?: string;
  /** Optional capability tags (e.g. ["vision"]) */
  capabilities?: string[];
  /** Optional max output tokens */
  maxOutputSize?: number;
  /** Optional thinking efforts the model supports (e.g. ["low","high","max"]) */
  supportEfforts?: string[];
  /** Optional adaptive-thinking override (Anthropic wire; undefined = infer) */
  adaptiveThinking?: boolean;
}

/** Manual add-provider request (POST /providers, design §4.1).
 *  `id` and `models` are required by the server (400 otherwise); they are
 *  optional in the type only so the not-yet-synced apps/web copy, which still
 *  calls this with the legacy { type, apiKey? } shape, keeps type-checking. */
export interface AddProviderInput {
  /** Provider id: Unicode letters/digits plus "-", "_" and spaces (409 on conflict) */
  id?: string;
  /** Wire protocol: kimi / openai / openai_responses / anthropic / google-genai / vertexai */
  type: string;
  /** Optional — providers that read credentials from the env may omit it */
  apiKey?: string;
  /** Optional; protocol default endpoint applies when omitted */
  baseUrl?: string;
  /** Optional; must be one of `models` when set */
  defaultModel?: string;
  /** At least one model */
  models?: AddProviderModelInput[];
}

/** Delete-provider outcome (DELETE /providers/{id} — always a bare 204; the
 *  global default pointers are never modified server-side). */
export interface DeleteProviderResult {
  deleted: string;
}

/** Update-provider request (PUT /providers/{id}) — replace semantics: the body
 *  is the provider's new config. `newId` renames the provider (providers key,
 *  model aliases and default pointers migrate server-side). `apiKey` is
 *  three-state: undefined = keep the stored key, '' = clear it, non-empty =
 *  set a new one. */
export interface UpdateProviderInput {
  /** Optional rename target; must pass the server id pattern and be free */
  newId?: string;
  /** Wire protocol: kimi / openai / openai_responses / anthropic / google-genai / vertexai */
  type: string;
  /** Three-state: keep / clear / set (see above) */
  apiKey?: string;
  /** Optional; omitted unsets under replace semantics */
  baseUrl?: string;
  /** Optional; must be one of `models` when set */
  defaultModel?: string;
  /** At least one model */
  models: AddProviderModelInput[];
}

/** Update-provider outcome (PUT /providers/{id} 200 body). */
export interface UpdateProviderResult {
  provider: AppProvider;
}

/** One model in the browsable models.dev directory (design §4.3). */
export interface AppCatalogModel {
  id: string;
  name?: string;
  maxContextSize: number;
  capabilities?: string[];
  reasoning: boolean;
}

/** A browsable models.dev directory entry with server-resolved import eligibility. */
export interface AppCatalogProvider {
  /** Catalog entry id (the default local provider id on import) */
  id: string;
  name: string;
  /** Resolved wire protocol; null when the entry is rejected */
  wireType: string | null;
  /** True when the wire came from the OpenAI-compatible fallback */
  guessed: boolean;
  /** True when the import form must collect a base URL */
  needsBaseUrl: boolean;
  /** True when this server version cannot import the entry at all */
  rejected: boolean;
  rejectReason: string | null;
  /** Credential env var the vendor conventionally uses (hint only) */
  envKey: string | null;
  models: AppCatalogModel[];
}

/** Catalog-import request (POST /providers:import_catalog, design §4.4).
 *  Re-importing an existing id is a refresh; the global default pointers are
 *  never modified server-side. */
export interface ImportCatalogProviderInput {
  catalogId: string;
  apiKey?: string;
  baseUrl?: string;
  /** Optional local provider id override (defaults to the catalog id) */
  id?: string;
}

/** Catalog-import outcome (POST /providers:import_catalog 201 body). */
export interface ImportCatalogProviderResult {
  provider: AppProvider;
  modelsImported: number;
}

/** Custom-registry import request (POST /providers:import_registry, design
 *  §4.5): a models.dev-shaped api.json URL plus its optional Bearer key.
 *  Re-importing the same URL is a refresh — providers that disappeared
 *  upstream are removed; the global default pointers are never modified. */
export interface ImportCustomRegistryInput {
  url: string;
  apiKey?: string;
}

/** Custom-registry import outcome (201 body): one item per imported provider. */
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

export interface AppConfig {
  providers: Record<string, AppConfigProvider>;
  defaultProvider?: string;
  defaultModel?: string;
  /** Secondary model recipe: the model subagents (Agent/AgentSwarm tools) bind
      by default when the server's `secondary-model` experimental flag is on.
      Read/write via GET/POST /config (`secondary_model` wire field). */
  secondaryModel?: { model?: string; defaultEffort?: string };
  models?: Record<string, unknown>;
  thinking?: { enabled?: boolean; effort?: string };
  planMode?: boolean;
  yolo?: boolean;
  defaultPermissionMode?: string;
  defaultPlanMode?: boolean;
  permission?: unknown;
  hooks?: unknown[];
  services?: unknown;
  mergeAllAvailableSkills?: boolean;
  extraSkillDirs?: string[];
  loopControl?: unknown;
  background?: unknown;
  experimental?: Record<string, boolean>;
  telemetry?: boolean;
  raw?: Record<string, unknown>;
}

/** A session-scoped skill the user can invoke from the slash menu. */
export interface AppSkill {
  name: string;
  description: string;
  /** Skill source (e.g. 'builtin' | 'project' | 'plugin') for grouping/labels. */
  source: string;
}

// ---------------------------------------------------------------------------
// KimiWebApi — the app-facing interface
// ---------------------------------------------------------------------------

export interface AppSessionWarning {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

export interface KimiWebApi {
  getHealth(): Promise<{ status: 'ok'; uptimeSec: number }>;
  getMeta(): Promise<{ serverVersion: string; serverId: string; startedAt: string; capabilities: Record<string, boolean>; openInApps: string[]; dangerousBypassAuth: boolean; experimentalFlags: Record<string, boolean>; backend: 'v1' | 'v2' }>;
  listSessions(input?: PageRequest & { busy?: boolean; workspaceId?: string; includeArchive?: boolean; archivedOnly?: boolean; excludeEmpty?: boolean }): Promise<Page<AppSession>>;
  createSession(input: { title?: string; cwd?: string; model?: string; workspaceId?: string }): Promise<AppSession>;
  /** Fetch one session by id (deep links beyond the first listSessions page). */
  getSession(sessionId: string): Promise<AppSession>;
  updateSession(sessionId: string, input: { title?: string; cwd?: string; model?: string; permissionMode?: string; planMode?: boolean; swarmMode?: boolean; goalObjective?: string; goalControl?: 'pause' | 'resume' | 'cancel'; thinking?: string }): Promise<AppSession>;
  getSessionStatus(sessionId: string): Promise<AppSessionRuntimeStatus>;
  /** Current goal snapshot, or null when the session has no active goal. */
  getSessionGoal(sessionId: string): Promise<AppGoal | null>;
  /** Persisted ExitPlanMode payloads, including final review state. */
  getSessionPlans(sessionId: string, input: SessionPlanQuery): Promise<SessionPlan[]>;
  getSessionWarnings(sessionId: string): Promise<AppSessionWarning[]>;
  archiveSession(sessionId: string): Promise<{ archived: true }>;
  restoreSession(sessionId: string): Promise<AppSession>;
  listMessages(sessionId: string, input?: PageRequest & { role?: AppMessageRole }): Promise<Page<AppMessage>>;
  /** v2 initial sync: atomic session state + `asOfSeq` watermark + epoch. */
  getSessionSnapshot(sessionId: string): Promise<AppSessionSnapshot>;
  getSessionTranscript(
    sessionId: string,
    input: SessionTranscriptQuery,
  ): Promise<SessionTranscriptPage>;
  /** Export the session archive, optionally including the bounded Web JSONL
   *  log. `options.desktop` asks the server to bundle the on-disk desktop app
   *  log (desktop hosts only; older servers are retried without the flag). */
  exportSession(
    sessionId: string,
    webLog?: string,
    options?: { desktop?: boolean },
  ): Promise<{ blob: Blob; fileName: string }>;
  submitPrompt(sessionId: string, input: PromptSubmission): Promise<PromptSubmitResult>;
  /** Steer daemon-queued prompts into the active turn (TUI ctrl+s). */
  steerPrompts(sessionId: string, promptIds: string[]): Promise<{ steered: boolean; promptIds: string[] }>;
  abortPrompt(sessionId: string, promptId: string): Promise<{ aborted: boolean; atSeq?: number }>;
  /** Cancel whatever is running in the session, including skill activations. */
  abortSession(sessionId: string): Promise<{ aborted: boolean }>;
  compactSession(sessionId: string, instruction?: string): Promise<void>;
  undoSession(sessionId: string, count?: number): Promise<void>;
  forkSession(sessionId: string, input?: { title?: string }): Promise<AppSession>;
  /** Create a child session under a parent — POST /sessions/{id}/children. */
  createChildSession(sessionId: string, input?: { title?: string }): Promise<AppSession>;
  /** List a session's child sessions — GET /sessions/{id}/children. */
  listChildSessions(sessionId: string): Promise<AppSession[]>;
  /** Start a BTW side-channel agent under the session — POST /sessions/{id}:btw. */
  startBtw(sessionId: string): Promise<{ agentId: string }>;
  respondApproval(sessionId: string, approvalId: string, response: ApprovalResponse): Promise<{ resolved: true; resolvedAt: string }>;
  respondQuestion(sessionId: string, questionId: string, response: QuestionResponse): Promise<{ resolved: true; resolvedAt: string }>;
  dismissQuestion(sessionId: string, questionId: string): Promise<{ dismissed: true; dismissedAt: string }>;
  listSkills(sessionId: string): Promise<AppSkill[]>;
  /** List skills for a workspace (no session required) — GET /workspaces/{id}/skills. */
  listSkillsForWorkspace(workspaceId: string): Promise<AppSkill[]>;
  activateSkill(sessionId: string, skillName: string, args?: string): Promise<{ activated: true; skillName: string }>;
  listTasks(sessionId: string, status?: AppTaskStatus): Promise<AppTask[]>;
  getTask(sessionId: string, taskId: string, input?: { withOutput?: boolean; outputBytes?: number }): Promise<AppTask>;
  cancelTask(sessionId: string, taskId: string): Promise<{ cancelled: true }>;
  listTerminals(sessionId: string): Promise<AppTerminal[]>;
  createTerminal(sessionId: string, input?: { cwd?: string; shell?: string; cols?: number; rows?: number }): Promise<AppTerminal>;
  getTerminal(sessionId: string, terminalId: string): Promise<AppTerminal>;
  closeTerminal(sessionId: string, terminalId: string): Promise<{ closed: true }>;
  listDirectory(sessionId: string, input: { path?: string; depth?: number; includeGitStatus?: boolean }): Promise<{ items: FsEntry[]; childrenByPath?: Record<string, FsEntry[]>; truncated: boolean }>;
  readFile(sessionId: string, input: { path: string; offset?: number; length?: number }): Promise<{ path: string; content: string; encoding: 'utf-8' | 'base64'; size: number; truncated: boolean; etag: string; mime: string; languageId?: string; lineCount?: number; isBinary: boolean }>;
  /** Search files in a workspace (no session required) — POST /workspace/fs:search. `workspace` accepts a registered workspace id or an absolute root. */
  searchFiles(workspace: string, input: { query: string; limit?: number }): Promise<{ items: Array<{ path: string; name: string; kind: FsKind; score: number; matchPositions: number[] }>; truncated: boolean }>;
  grepFiles(sessionId: string, input: { pattern: string; regex?: boolean; caseSensitive?: boolean }): Promise<{ files: Array<{ path: string; matches: Array<{ line: number; col: number; text: string; before: string[]; after: string[] }> }>; filesScanned: number; truncated: boolean; elapsedMs: number }>;
  getGitStatus(sessionId: string, paths?: string[]): Promise<{ branch: string; ahead: number; behind: number; entries: Record<string, string>; additions: number; deletions: number; pullRequest: { number: number; state: string; url: string } | null }>;
  getFileDiff(sessionId: string, path: string): Promise<{ path: string; diff: string; truncated: boolean }>;
  getFileDownloadUrl(sessionId: string, path: string): string;
  openFile(sessionId: string, input: { path: string; line?: number }): Promise<{ opened: true }>;
  revealFile(sessionId: string, input: { path: string }): Promise<{ revealed: true }>;
  /** Open the session working directory (or a session-relative path) in an external application. */
  openInApp(sessionId: string, appId: string, path: string, line?: number): Promise<void>;
  connectEvents(handlers: KimiEventHandlers): KimiEventConnection;

  // Workspaces + daemon folder browser. /workspaces now ships and includes
  // derived workspaces (cwds with sessions that were never explicitly registered).
  listWorkspaces(): Promise<AppWorkspace[]>;
  addWorkspace(input: { root: string; name?: string }): Promise<AppWorkspace>;
  updateWorkspace(id: string, input: { name: string }): Promise<AppWorkspace>;
  deleteWorkspace(id: string): Promise<void>;
  browseFs(path?: string): Promise<FsBrowseResult>;
  getFsHome(): Promise<{ home: string; recentRoots: string[] }>;

  // Models + providers — list/refresh are REAL endpoints; add/update/delete
  // follow design §4.1/§4.2 (POST /providers, PUT/DELETE /providers/{id}).
  listModels(): Promise<AppModel[]>;
  listProviders(): Promise<AppProvider[]>;
  /** REAL endpoint: GET /v1/providers/{id} — the only response carrying the
      plaintext api_key (the list stays redacted). */
  getProvider(id: string): Promise<AppProviderDetail>;
  addProvider(input: AddProviderInput): Promise<AppProvider>;
  updateProvider(id: string, input: UpdateProviderInput): Promise<UpdateProviderResult>;
  deleteProvider(id: string): Promise<DeleteProviderResult>;
  refreshProvider(id: string): Promise<ProviderRefreshResult>;
  refreshAllProviders(): Promise<ProviderRefreshResult>;
  refreshOAuthProviderModels(): Promise<ProviderRefreshResult>;
  // models.dev directory (design §4.3/§4.4) — server-proxied browse + import.
  listCatalogProviders(): Promise<AppCatalogProvider[]>;
  getCatalogProvider(catalogId: string): Promise<AppCatalogProvider>;
  importCatalogProvider(input: ImportCatalogProviderInput): Promise<ImportCatalogProviderResult>;
  // Custom registry (design §4.5) — models.dev-shaped api.json import.
  importCustomRegistry(input: ImportCustomRegistryInput): Promise<ImportCustomRegistryResult>;

  // File upload / download
  uploadFile(input: { file: Blob; name?: string }): Promise<{ id: string; name: string; mediaType: string; size: number }>;
  getFileUrl(fileId: string): string;
  /** Fetch a file's bytes with auth — feed the resulting Blob to a blob URL for <video>/<img> src. */
  getFileBlob(fileId: string): Promise<Blob>;

  /** Read any host file by ABSOLUTE path via the daemon's global fs:content.
   *  No workspace prefix gate (unlike session fs:read); a missing file surfaces
   *  the daemon's real not-found. Text decodes utf-8, binary returns base64.
   *  Throws FileTooLargeError when the file exceeds the client-side read cap. */
  readHostFileContent(path: string): Promise<{ path: string; content: string; encoding: 'utf-8' | 'base64'; mime: string; isBinary: boolean; size: number }>;

  // Config — REAL endpoints
  getConfig(): Promise<AppConfig>;
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;

  // Auth — REAL endpoints
  getAuth(): Promise<{
    ready: boolean;
    providersCount: number;
    defaultModel: string | null;
    managedProvider: { status: string } | null;
  }>;
  startOAuthLogin(): Promise<OAuthLoginStartResult>;
  pollOAuthLogin(): Promise<{
    flowId: string;
    status: 'pending' | 'authenticated' | 'expired' | 'cancelled';
    resolvedAt?: string;
  } | null>;
  cancelOAuthLogin(): Promise<{ cancelled: boolean; status: string }>;
  logout(): Promise<{ loggedOut: boolean }>;
  getUsage(): Promise<ManagedUsageResult>;
  getUserInfo(): Promise<ManagedUserInfoResult>;
}

/** Result of `startOAuthLogin()`, mirroring the wire discriminated union. */
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

// ---------------------------------------------------------------------------
// Managed-account plan usage (GET /api/v1/oauth/usage)
// ---------------------------------------------------------------------------

export interface UsageWindow {
  duration: number;
  unit: 'minute' | 'hour' | 'day' | 'week';
}

export interface UsageRow {
  /** Server-supplied custom name, passed through verbatim. */
  name?: string;
  window?: UsageWindow;
  used: number;
  limit: number;
  /** Absolute ISO timestamp of the next reset. */
  resetAt?: string;
}

export interface BoosterWallet {
  balanceCents: number;
  totalCents: number;
  monthlyChargeLimitEnabled: boolean;
  monthlyChargeLimitCents: number;
  monthlyUsedCents: number;
  currency: string;
}

/** Discriminated by `kind` so the settings UI can render inline states
    (not signed in / endpoint unavailable / fetch failed) without a throw. */
export type ManagedUsageResult =
  | { kind: 'ok'; summary: UsageRow | null; limits: UsageRow[]; extraUsage: BoosterWallet | null }
  | { kind: 'error'; message: string; status?: number };

// ---------------------------------------------------------------------------
// Managed-account profile (GET /api/v1/oauth/userinfo)
// ---------------------------------------------------------------------------

export interface ManagedUserInfo {
  userId: string;
  nickname: string;
  status: string;
  region: string;
  userLevel: number;
  userLevelName: string;
  domain: number;
  domainName: string;
  globalId?: string;
  bio?: string;
  avatar?: string;
  username?: string;
  email?: string;
  phone?: { countryCode: string; number: string };
  createdTime?: string;
  lastLoginTime?: string;
}

/** Same `kind` discrimination as ManagedUsageResult — an older daemon without
    the endpoint surfaces as the `error` shape, not a throw. */
export type ManagedUserInfoResult =
  | { kind: 'ok'; userInfo: ManagedUserInfo }
  | { kind: 'error'; message: string; status?: number };
