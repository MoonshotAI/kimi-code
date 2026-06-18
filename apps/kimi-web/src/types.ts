// apps/kimi-web/src/types.ts
import type { AppSessionStatus } from './api/types';

/** Real session lifecycle status (5 states), surfaced verbatim to the UI so the
    list can distinguish awaiting / aborted instead of collapsing to running|idle. */
export type SessionStatus = AppSessionStatus;

export interface Session {
  id: string;
  title: string;
  time: string;
  status: SessionStatus;
  /** True only when the session should show a "working" spinner: it is
      `running` AND has a real task in flight. Awaiting-input and aborted are
      NOT busy, so the spinner no longer spins while the session waits on the
      user. (Distinct from `status`, which is the lifecycle label.) */
  busy: boolean;
  /** ISO timestamp for recency-based filtering (e.g. default visible sessions). */
  updatedAt?: string;
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
  /** Home-shortened path for dim display, e.g. `~/code/kimi-code-web`. */
  shortPath: string;
  /** Current branch, when known. */
  branch?: string;
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
}

/** Sidebar session-list scope: only the active workspace, or all workspaces. */
export type WorkspaceScope = 'current' | 'all';

export type ToolStatus = 'ok' | 'running' | 'error';

export interface ToolCall {
  id: string;
  name: string; // e.g. 'read' | 'bash'
  arg: string; // e.g. '· src/api/client.ts'
  status: ToolStatus;
  timing?: string; // e.g. '12ms'
  output?: string[]; // shown line by line when expanded
  media?: ToolMedia;
  defaultExpanded?: boolean;
}

export interface ToolMedia {
  kind: 'image' | 'video' | 'audio';
  url: string;
  path?: string;
  mimeType?: string;
  bytes?: number;
  dimensions?: string;
}

export type AgentPhase = 'queued' | 'working' | 'suspended' | 'completed' | 'failed';

export interface AgentMember {
  id: string;
  toolCallId?: string;
  name: string;
  subagentType?: string;
  phase: AgentPhase;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  /** The prompt/task the subagent was given (from the Agent tool input). */
  prompt?: string;
  summary?: string;
  outputLines?: string[];
  suspendedReason?: string;
  swarmIndex?: number;
}

export type DiffKind = 'ctx' | 'add' | 'rem';

export interface DiffLine {
  kind: DiffKind;
  gutter: string; // gutter (line-number) column text, e.g. '23' or '   13' or '7   7'
  text: string;
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
 *
 * Phase 3 will render each kind differently; for now ApprovalCard.vue handles
 * 'diff' (the original shape) and falls back to 'generic' for everything else.
 */
export type ApprovalBlock =
  | { kind: 'diff'; path: string; diff: DiffLine[] }
  | { kind: 'shell'; command: string; cwd?: string; danger?: string }
  | { kind: 'file'; path: string; content: string; language?: string }
  | { kind: 'fileop'; op: string; path: string; detail?: string }
  | { kind: 'url'; method?: string; url: string }
  | { kind: 'search'; query: string; scope?: string }
  | { kind: 'invocation'; kind2: string; name: string; description?: string }
  | { kind: 'todo'; items: { title: string; status: string }[] }
  | { kind: 'generic'; summary: string };

export type TurnRole = 'user' | 'assistant' | 'compaction';

export interface FilePreviewRequest {
  path: string;
  line?: number;
}

/** One ordered piece of an assistant turn: a thinking segment, a text segment
 * OR a tool card. Built in call order so every piece renders inline where it
 * happened (a turn can think → act → think again — nothing is hoisted). */
export type TurnBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; thinking: string }
  | { kind: 'tool'; tool: ToolCall }
  | { kind: 'agent'; member: AgentMember }
  | { kind: 'agentGroup'; members: AgentMember[] };

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
  /** Image attachments sent by the user (rendered above the text bubble). */
  images?: { url: string; alt?: string; kind: 'image' | 'video' }[];
  /** Compaction divider data (role 'compaction'): the transcript keeps all
      prior turns and renders this as a separator line; `text` holds the
      LLM-generated summary, opened in the right-side panel on click. */
  compaction?: { trigger?: 'manual' | 'auto'; tokensBefore?: number; tokensAfter?: number };
  /** ISO timestamp when the message was created (used for the user bubble timestamp). */
  createdAt?: string;
  /** Client-side measured duration from turn.started to turn.ended (ms). */
  durationMs?: number;
  /** Skill activation metadata: when a user turn was triggered by a slash
      command (/skill), this holds the skill name and args for display. */
  skillActivation?: { name: string; args?: string };
}

/**
 * One item of the model-maintained todo list (the TodoList tool). Each write
 * replaces the whole list, so the latest tool call IS the current state.
 */
export interface TodoView {
  title: string;
  status: 'pending' | 'in_progress' | 'done';
}

export type TaskState = 'run' | 'done' | 'fail';

export interface TaskItem {
  id: string;
  name: string;
  kind: string; // 'subagent' | 'task'
  state: TaskState;
  timing: string;
  meta?: string;
  output?: string[];
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
export type DetailTarget = 'file' | 'diff' | 'thinking' | 'compaction' | 'agent' | 'btw';

export interface ActivationBadges {
  plan: boolean;
  goal: { status: string; turnsUsed: number; elapsedMs: number } | null;
  swarm: { done: number; total: number } | null;
}

/** A queued prompt as shown in the composer's queue strip. */
export interface QueuedPromptView {
  text: string;
  /** Number of image attachments waiting with this prompt. */
  attachmentCount: number;
}

/** Horizontal alignment of the conversation reading column within the pane. */

/**
 * UI-facing question type, mapped from AppQuestionRequest in the composable.
 */
export interface UIQuestion {
  questionId: string;
  sessionId: string;
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
