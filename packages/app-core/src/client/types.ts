// packages/app-core/src/client/types.ts

import type { AppTask, SessionPlan } from '../api/types';

/** File content loaded for preview (text or base64-encoded binary). */
export interface FileData {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mime: string;
  languageId?: string;
  isBinary: boolean;
  size: number;
  lineCount?: number;
}

/** A file entry shown in the composer's @-mention menu. */
export interface FileItem {
  path: string;
  name: string;
  /** The daemon's entry kind, when the search pipeline preserved it (drives
   *  the folder icon/pill; older callers may omit it). */
  kind?: 'file' | 'directory' | 'symlink';
  /** Matched-character positions into the FULL path (fs:search/fs:suggest
   *  `match_positions`), when the pipeline preserved them — drives the
   *  match highlighting in the menu row. */
  matchPositions?: number[];
}

export interface Session {
  id: string;
  title: string;
  time: string;
  /** True while the session shows a "working" indicator — the unified
      condition shared by the sidebar spinner, the chat working indicator, and the Stop
      button: a prompt submitted but not yet terminated, or a main turn in
      flight. Background tasks and subagent turns do NOT set it. */
  busy: boolean;
  /** List-level fallback for action-required badges on unopened sessions. */
  pendingInteraction?: 'none' | 'approval' | 'question';
  /** Main agent's latest turn outcome — drives the "aborted" tag when the
      session is quiet and the last turn was cancelled/failed. */
  lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  /** ISO timestamp for recency-based filtering (e.g. default visible sessions). */
  updatedAt?: string;
  /** Text of the most recent user prompt, used by sidebar search. */
  lastPrompt?: string;
  /** Workspace id this session belongs to (resolved from cwd / daemon). */
  workspaceId?: string;
  /** Workspace display name, joined from workspacesView. */
  workspaceName?: string;
  /** True when the session is pinned to the top pinned section. */
  pinned?: boolean;
  /** True when the session is archived ("done" in the status view). Only
      projected on lists that can contain done sessions (the status view's
      已完成 tab, the workspace home's recent list). */
  archived?: boolean;
  /** Session working directory — projected on the `sessions` list so the
      workspace-delete cleanup can match by root (App.vue confirmDeleteWorkspace).
      Flat-style rows render `cwdLabel` instead. */
  cwd?: string;
  /** Flat-style second line text: the cwd's final directory name, '-' when the
      session has no cwd. Projected by the facade for the flat list and the
      pinned section; absent in grouped rows, which stay single-line. */
  cwdLabel?: string;
  /** PR association (from the v2 sessions git domain) — the flat-style second
      line shows it as a chip on the right. null/undefined = nothing to show. */
  pullRequest?: { number: number; state: 'open' | 'closed' | 'merged'; url: string } | null;
}

export interface Workspace {
  name: string;
  branch: string;
}

/**
 * Sidebar-facing workspace entry. The active workspace header + the switcher
 * dropdown both render these.
 */
export interface WorkspaceView {
  id: string;
  /** Display name (defaults to basename of root). */
  name: string;
  /** Absolute path to the project root. */
  root: string;
  /** Home-shortened path for dim display, e.g. `~/code/kimi-code-app`. */
  shortPath: string;
  /** Number of sessions in this workspace. */
  sessionCount: number;
}

/**
 * One workspace group for the "all workspaces" sidebar view: the workspace
 * header plus its sessions.
 */
export interface WorkspaceGroup {
  workspace: WorkspaceView;
  sessions: Session[];
  /** True when the server has more sessions in this workspace than are loaded. */
  hasMore: boolean;
  /** True while the next page of sessions is being fetched for this workspace. */
  loadingMore: boolean;
  /** First-page capacity for the in-group show-less collapse target: the number
   *  of sessions loaded on first paint, floored at one full page so a workspace
   *  that was empty or sparse does not hide sessions created later. */
  initialCount: number;
  /** How many of this workspace's sessions are pinned (they render in the
   *  pinned section, not in this group) — the group shows a pinned-count note
   *  instead of the plain empty state when every session it has is pinned. */
  pinnedCount: number;
}

/** Sidebar session-list scope: only the active workspace, or all workspaces. */
export type WorkspaceScope = 'current' | 'all';

export type ToolStatus = 'ok' | 'running' | 'error';

export interface ToolCall {
  id: string;
  name: string; // e.g. 'read' | 'bash'
  arg: string; // e.g. '· src/api/client.ts'
  status: ToolStatus;
  /** Stable child agent id used to open or resume its transcript. */
  agentId?: string;
  timing?: string; // e.g. '12ms'
  output?: string[]; // shown line by line when expanded
  media?: ToolMedia;
  defaultExpanded?: boolean;
  /** Absolute path of the plan file (ExitPlanMode only) — rendered as a
   *  clickable link that opens the plan in the file preview. */
  planPath?: string;
  /** Persisted ExitPlanMode content and final review state. */
  plan?: SessionPlan;
}

export interface ToolMedia {
  kind: 'image' | 'video' | 'audio';
  url: string;
  path?: string;
  mimeType?: string;
  bytes?: number;
  dimensions?: string;
  /** File-store id when the media is an uploaded file. The preview fetches its
   *  bytes with the Bearer credential (a bare getFileUrl src 401s in <img>). */
  fileId?: string;
  /** Set only when `fileId` addresses the session media store (a daemon media
   *  reference): the preview fetches via the session-scoped media route. */
  sessionId?: string;
}

/** Payload of the `openMedia` event chain (tool cards → App): opens the
 *  floating MediaLightbox preview. */
export interface OpenMediaRequest {
  media: ToolMedia;
  /** The clicked thumbnail <img> — the image preview's zoom origin (and byte
   *  source) for PhotoSwipe; null for videos or when no thumbnail resolved. */
  originImg?: HTMLImageElement | null;
}

export type AgentPhase = 'queued' | 'working' | 'suspended' | 'completed' | 'failed' | 'cancelled';

export interface AgentMember {
  id: string;
  toolCallId?: string;
  name: string;
  /** The task-store discriminator (`AppTask.kind`) — unlike the optional
   *  `subagentType`, it always tells a subagent from a bash/tool task. Drives
   *  the detail panel's fallback font: a subagent's conclusion is prose (UI
   *  font), a bash task's command + terminal output stays mono. */
  kind?: AppTask['kind'];
  subagentType?: string;
  /** The bound model alias (display-mapped at render). */
  model?: string;
  /** The effective thinking effort (concrete levels shown; on/off hidden). */
  thinkingEffort?: string;
  phase: AgentPhase;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  /** The prompt/task the subagent was given (from the Agent tool input). */
  prompt?: string;
  summary?: string;
  outputLines?: string[];
  /** The subagent's concatenated live output (assistant deltas) — grows in the
   *  detail panel like a thinking block. */
  text?: string;
  suspendedReason?: string;
  swarmIndex?: number;
}

/**
 * One row of a parsed UNIFIED diff (from the daemon's `fs:diff` action),
 * rendered line-by-line in the ~/diff tab.
 *
 *   - `add`     — an added line (`+...`); has `newNo`.
 *   - `del`     — a removed line (`-...`); has `oldNo`.
 *   - `context` — an unchanged line; has both `oldNo` + `newNo`.
 *   - `hunk`    — a `@@ -a,b +c,d @@` hunk header (no line numbers).
 *
 * `text` is the line content WITHOUT the leading +/-/space marker.
 */
export interface DiffViewLine {
  type: 'add' | 'del' | 'context' | 'hunk';
  text: string;
  oldNo?: number;
  newNo?: number;
}

/**
 * Discriminated ApprovalBlock union.
 */
export type ApprovalBlock =
  | { kind: 'diff'; path: string; diff: DiffViewLine[] }
  | { kind: 'shell'; command: string; cwd?: string; danger?: string }
  | { kind: 'file'; path: string; content: string; language?: string }
  | { kind: 'fileop'; op: string; path: string; detail?: string }
  | { kind: 'url'; method?: string; url: string }
  | { kind: 'search'; query: string; scope?: string }
  | { kind: 'invocation'; kind2: string; name: string; description?: string }
  | { kind: 'todo'; items: { title: string; status: string }[] }
  | {
      kind: 'plan_review';
      plan: string;
      path?: string;
      options?: { label: string; description?: string }[];
    }
  | { kind: 'generic'; summary: string };

export type TurnRole = 'user' | 'assistant' | 'compaction' | 'cron';

export interface FilePreviewRequest {
  path: string;
  line?: number;
  /** Inline content: when present the preview renders it directly without a
   *  daemon read — used for files the daemon can't serve (e.g. plan files
   *  living outside the workspace root). */
  content?: string;
}

/** Metadata carried by a cron fire — shared by a standalone cron turn and by a
 *  cron notice embedded inside an assistant turn's blocks. Mirrors the TUI's
 *  CronTranscriptData. `missedCount` present means a missed-fire catch-up. */
export interface CronTurnData {
  jobId?: string;
  cron?: string;
  recurring?: boolean;
  coalescedCount?: number;
  stale?: boolean;
  missedCount?: number;
}

/** A parsed `<notification>` block from a hidden task-notification user
    message (origin kind 'task_notification'), rendered as a notification card
    inside the assistant turn it landed in. See lib/notificationXml.ts. */
export interface TaskNotification {
  id: string;
  category: string;
  /** Raw type, e.g. 'task.completed'. */
  type: string;
  /** 'background_task' | 'subagent' | … (drives the card's kind label). */
  sourceKind: string;
  sourceId: string;
  agentId?: string;
  title: string;
  severity: string;
  body: string;
  outputFile?: { path: string; bytes?: number };
  /** `<output-preview>` child: buffered task output shown when no persisted
      full output file exists. `text` is the unescaped preview (the block's
      leading explanation line is dropped); `bytes` is the preview length,
      `totalBytes` the full output length, `truncated` whether the preview is
      only the tail of the output. */
  outputPreview?: { text: string; bytes?: number; totalBytes?: number; truncated?: boolean };
  /** The verbatim XML block, shown in the raw-payload disclosure. */
  raw: string;
  /** Server `created_at` of the carrying message. */
  createdAt?: string;
}

/** One ordered piece of an assistant turn: a thinking segment, a text segment
 * OR a tool card. Built in call order so every piece renders inline where it
 * happened (a turn can think → act → think again — nothing is hoisted).
 *
 * Subagents render as the spawning `Agent` tool card here; their live progress
 * streams in the right-side detail panel, sourced from the task rather than a
 * dedicated block. */
export type TurnBlock =
  | { kind: 'text'; text: string }
  | {
      kind: 'thinking';
      thinking: string;
      /** Renderer-measured timing (live sessions only): when this block opened
          (ISO) and how long it streamed (ms). Absent for history. */
      startedAt?: string;
      durationMs?: number;
    }
  | { kind: 'tool'; tool: ToolCall }
  | { kind: 'notification'; notification: TaskNotification };

/** One attachment on a user turn: an uploaded file, image or video. Images
    and pasted media carry no name; the chip falls back to a generic label.
    `url` is browser-loadable (a data URL, or the authed file URL). */
export interface TurnAttachment {
  kind: 'image' | 'video' | 'file';
  url: string;
  fileId?: string;
  /** Set only when `fileId` addresses the session media store (a daemon
      media reference) rather than the global upload store — the byte fetch
      must go through the session-scoped media route with this session id. */
  sessionId?: string;
  name?: string;
  mediaType?: string;
  size?: number;
  /** The attachment's position in the SUBMIT payload (the persisted
      message's content-part order — kap-server replaces attachment parts in
      place) — the edit&resend refill re-stamps the composer's add-order
      clock from it, so the resent payload keeps the original media/file
      interleave instead of collapsing to media-first. */
  orderHint?: number;
  /** Add-order stamp in the composer's shared clock (see
      interleaveSubmitAttachments in app-client's composerAttachments) —
      round-tripped through the chip draft so a restored attachment keeps
      its payload position across remounts. */
  seq?: number;
}

export interface ChatTurn {
  id: string;
  role: TurnRole;
  no: number; // terminal line number
  text: string;
  /** All thinking segments joined — aggregate convenience field; rendering
      uses the ordered `blocks` (a turn can have MULTIPLE thinking blocks). */
  thinking?: string;
  tools?: ToolCall[];
  /** Thinking + text + tool cards in original call order (assistant turns). */
  blocks?: TurnBlock[];
  approval?: ApprovalBlock;
  approvalId?: string; // daemon approval id — present when approval needs a decision
  /** Attachments sent by the user — files, images and videos, rendered as a
      chip row above the text bubble. */
  attachments?: TurnAttachment[];
  /** File attachments referenced by the bubble text's INLINE attachment pills
      (pill-flow messages only), in the pills' 1..N index order — the
      recovered "Attached file …" notices, which stay out of `attachments` so
      the legacy pill row doesn't double them. The message renderer maps a
      pill's attId (the submit-time 1-based rewrite index) onto this list to
      revive the pill's open target. */
  inlineAttachments?: TurnAttachment[];
  /** Compaction divider data (role 'compaction'): the transcript keeps all
      prior turns and renders this as a separator line; `text` holds the
      LLM-generated summary, opened in the right-side panel on click. */
  compaction?: { trigger?: 'manual' | 'auto'; tokensBefore?: number; tokensAfter?: number };
  /** ISO timestamp when the message was created (user bubble timestamp; for
      assistant turns without `endedAt`, the footer derives the completion
      stamp from createdAt + durationMs). */
  createdAt?: string;
  /** Stamped end of the turn's work span (thinking stamps cover the start;
      this covers the end, immune to renderer throttling): the reducer's live
      settle stamp when the daemon's duration lands, else the server
      `created_at` of the turn's last absorbed message (history). Feeds the
      fold's settle fallback and the assistant footer's message time; absent
      when nothing is stamped. */
  endedAt?: string;
  /** Client-side measured duration from turn.started to turn.ended (ms). */
  durationMs?: number;
  /** Skill activation metadata: when a user turn was triggered by a slash
      command (/skill), this holds the skill name and args for display. */
  skillActivation?: { name: string; args?: string };
  /** Plugin command metadata: when a user turn was triggered by a plugin slash
      command (/plugin:command), this holds the command identity and args. */
  pluginCommand?: { pluginId: string; commandName: string; args?: string };
  /** Cron fire metadata (role 'cron'): set when an agent turn was triggered by a
      scheduled reminder rather than a real user. Mirrors the TUI's
      CronTranscriptData. `missedCount` present means a missed-fire catch-up. */
  cron?: CronTurnData;
  /** True when this assistant turn was opened by a goal continuation (the
      hidden `goal_continuation` trigger message) rather than a user message —
      the transcript shows a small provenance line above the turn. */
  goalContinuation?: boolean;
}

/**
 * One item of the model-maintained todo list (the TodoList tool). Each write
 * replaces the whole list, so the latest tool call IS the current state.
 */
export interface TodoView {
  title: string;
  status: 'pending' | 'in_progress' | 'done';
}

export type TaskState = 'run' | 'done' | 'fail' | 'cancelled';

export interface TaskItem {
  id: string;
  /** Stable child-agent id. Unlike `id`, this is never a REST background-task id. */
  agentId?: string;
  /** The REST background-task id this row folded from — lets the card
      numbering carry a shown serial across the rekey to `agentId`. */
  backgroundTaskId?: string;
  name: string;
  kind: string; // 'subagent' | 'task'
  state: TaskState;
  timing: string;
  /** Elapsed run time in ms (start→now while running, start→end once finished). */
  durationMs?: number;
  meta?: string;
  output?: string[];
  /** Background subagents only — the dock lists these; foreground subagents
   *  render inline as the `Agent` tool card instead. */
  runInBackground?: boolean;
  /** The spawning `Agent` tool-call id — used to resolve a subagent task back
   *  to its inline tool card, so the card's "Open detail" button can be hidden
   *  when the task is no longer available. */
  parentToolCallId?: string;
  /** The server's stable per-swarm index — drives the card grid's numbering so
   *  an agent keeps its number across filter changes. */
  swarmIndex?: number;
  /** ISO completion stamp — the "recently finished" filter sorts by it. */
  completedAt?: string;
  /** ISO creation stamp — the recency sort's fallback when completedAt is
      missing (all-historical sessions on old daemons). */
  createdAt?: string;
  /** Subagent tasks only: the bound model alias (display-mapped at render). */
  model?: string;
  /** Subagent tasks only: the effective thinking effort (concrete levels shown). */
  thinkingEffort?: string;
}

export interface ConversationStatus {
  /** Friendly display name of the live model (for the toolbar pill). */
  model: string;
  /** Raw model id — the value selection lists compare against. */
  modelId: string;
  ctxUsed: number;
  ctxMax: number;
  permission: 'manual' | 'auto' | 'yolo';
  branch: string;
  /** Working directory of the active session */
  cwd: string;
  /** True when the active session's cwd is inside a real git repository */
  isGitRepo: boolean;
}

/** Kind of the global right-side detail layer. Only one detail is visible at a
 *  time; opening a new one closes the previous. */
export type DetailTarget = 'file' | 'diff' | 'turn-diff' | 'compaction' | 'agent' | 'btw';

export interface ActivationBadges {
  plan: boolean;
  goal: { status: string; turnsUsed: number; elapsedMs: number } | null;
  swarm: { done: number; total: number } | null;
}

/** A queued prompt as shown inline at the tail of the transcript. */
export interface QueuedPromptView {
  /** Stable entry id assigned at enqueue — keys per-entry UI state. */
  id: string;
  text: string;
  /** Number of attachments waiting with this prompt. */
  attachmentCount: number;
  /** Attachments waiting with this prompt, with resolved URLs for thumbnails
      (file attachments render an icon chip, no thumbnail). */
  attachments?: TurnAttachment[];
  /** The pre-rewrite draft for edit-reload (selection quote pills revive
      from their link form); falls back to `text` when absent. */
  editText?: string;
}

/** Horizontal alignment of the conversation reading column within the pane. */

/**
 * UI-facing question type, mapped from AppQuestionRequest in the composable.
 */
export interface UIQuestion {
  questionId: string;
  sessionId: string;
  /** The AskUserQuestion tool call this request is waiting on, when known. */
  toolCallId?: string;
  questions: {
    id: string;
    question: string;
    header?: string;
    body?: string;
    options: { id: string; label: string; description?: string; recommended?: boolean }[];
    multiSelect?: boolean;
    allowOther?: boolean;
    otherLabel?: string;
  }[];
}

/** Activity state for the active session. */
export type ActivityState =
  | 'idle'
  | 'running'
  | 'awaiting-approval'
  | 'awaiting-question';

/** Connection state for the WebSocket. */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/** Permission mode (client-side policy). */
export type PermissionMode = 'manual' | 'auto' | 'yolo';

/** One file touched by the turn's Edit/MultiEdit/Write calls, aggregated across
    every call that named it (a file edited three times appears once). */
export interface TurnFileChange {
  path: string;
  added: number;
  removed: number;
  /** At least one Write named the file. */
  hasWrite: boolean;
  /** At least one edit's stats could not be derived from its args
      (replace_all, args beyond the diff budget, unparseable arg) — or it was
      a Write, whose removed lines are unknowable (new file vs overwrite).
      The totals are then a lower bound, not the full count. */
  statsIncomplete: boolean;
  /** The turn's line diff for this file (the same LCS the stats derive from),
      segments joined in call order; null when underivable (Write / incomplete). */
  diff: DiffViewLine[] | null;
}
