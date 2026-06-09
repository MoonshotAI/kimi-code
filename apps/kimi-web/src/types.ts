// apps/kimi-web/src/types.ts
export type SessionStatus = 'running' | 'idle';

export interface Session {
  id: string;
  title: string;
  time: string;
  status: SessionStatus;
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
  defaultExpanded?: boolean;
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

export type TurnRole = 'user' | 'assistant';

export interface ChatTurn {
  id: string;
  role: TurnRole;
  no: number; // terminal line number
  text: string;
  thinking?: string; // extended-thinking content; rendered as ThinkingBlock in Phase 2
  tools?: ToolCall[];
  approval?: ApprovalBlock;
  approvalId?: string; // daemon approval id — present when approval needs a decision
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
  model: string;
  ctxUsed: number;
  ctxMax: number;
  permission: 'manual' | 'auto' | 'yolo';
  branch: string;
  /** Working directory of the active session */
  cwd: string;
  /** True when the active session's cwd is inside a real git repository */
  isGitRepo: boolean;
}

export type PaneKey = 'chat' | 'diff' | 'tasks' | 'files';

/** Horizontal alignment of the conversation reading column within the pane. */
export type ContentAlign = 'left' | 'center';

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
    options: { id: string; label: string; description?: string }[];
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
