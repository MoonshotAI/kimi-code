// apps/kimi-web/src/composables/useKimiWebClient.ts
// Vue state composable — the only place that imports both src/api/* and src/types.ts.
// Components consume computed view props and call actions; they never touch the API or reducer.

import { computed, reactive, ref, watch } from 'vue';
import { i18n } from '../i18n';
import { getKimiWebApi } from '../api';
import type {
  AppApprovalRequest,
  AppMessage,
  AppModel,
  AppProvider,
  AppQuestionRequest,
  AppWorkspace,
  ApprovalDecision,
  ApprovalResponse,
  FsEntry,
  KimiEventConnection,
  QuestionResponse,
  ThinkingLevel,
} from '../api/types';
import { createInitialState, reduceAppEvent } from '../api/daemon/eventReducer';
import type { KimiClientState } from '../api/daemon/eventReducer';
import { toAppEvent } from '../api/daemon/mappers';
import { parseDiff } from '../lib/parseDiff';
import { messagesToTurns } from './messagesToTurns';
import type {
  ActivityState,
  ApprovalBlock,
  ChatTurn,
  ConnectionState,
  ConversationStatus,
  DiffLine,
  DiffViewLine,
  PermissionMode,
  Session,
  TaskItem,
  TaskState,
  UIQuestion,
  Workspace,
  WorkspaceGroup,
  WorkspaceScope,
  WorkspaceView,
} from '../types';

// ---------------------------------------------------------------------------
// Internal reactive state (plain object wrapped in reactive())
// ---------------------------------------------------------------------------

const PERMISSION_STORAGE_KEY = 'kimi-web.permission';
const ACTIVE_WORKSPACE_KEY = 'kimi-active-workspace';
const THINKING_STORAGE_KEY = 'kimi-web.thinking';
const PLAN_MODE_STORAGE_KEY = 'kimi-web.plan-mode';
const THEME_STORAGE_KEY = 'kimi-web.theme';
const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

/** UI theme: 'terminal' = today's default line look, 'modern' = bubbles everywhere. */
export type Theme = 'terminal' | 'modern';

function loadPermissionFromStorage(): PermissionMode {
  try {
    const v = localStorage.getItem(PERMISSION_STORAGE_KEY);
    if (v === 'auto' || v === 'yolo' || v === 'manual') return v;
  } catch {
    // localStorage not available (e.g. jsdom without config)
  }
  return 'manual';
}

function savePermissionToStorage(mode: PermissionMode): void {
  try {
    localStorage.setItem(PERMISSION_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

function loadThinkingFromStorage(): ThinkingLevel {
  try {
    const v = localStorage.getItem(THINKING_STORAGE_KEY);
    if (v && (THINKING_LEVELS as readonly string[]).includes(v)) return v as ThinkingLevel;
  } catch {
    // ignore
  }
  return 'high';
}

function saveThinkingToStorage(v: ThinkingLevel): void {
  try {
    localStorage.setItem(THINKING_STORAGE_KEY, v);
  } catch {
    // ignore
  }
}

function loadPlanModeFromStorage(): boolean {
  try {
    return localStorage.getItem(PLAN_MODE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function savePlanModeToStorage(v: boolean): void {
  try {
    localStorage.setItem(PLAN_MODE_STORAGE_KEY, v ? 'true' : 'false');
  } catch {
    // ignore
  }
}

function loadThemeFromStorage(): Theme {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'terminal' || v === 'modern') return v;
  } catch {
    // ignore
  }
  return 'terminal';
}

function saveThemeToStorage(v: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, v);
  } catch {
    // ignore
  }
}

function loadActiveWorkspaceFromStorage(): string | null {
  try {
    return localStorage.getItem(ACTIVE_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

function saveActiveWorkspaceToStorage(id: string): void {
  try {
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
  } catch {
    // ignore
  }
}

/** basename of an absolute path (last non-empty segment), defaulting to the path. */
function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : path;
}

/** Shorten a $HOME-prefixed absolute path to `~/…` for dim display. */
function shortenHome(path: string, home: string | null): string {
  if (home && path.startsWith(home)) {
    const rest = path.slice(home.length);
    return rest ? `~${rest}` : '~';
  }
  // Heuristic when we don't know $HOME: collapse /Users/<x> or /home/<x>.
  const m = path.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  if (m) return `~${m[1] ?? ''}`;
  return path;
}

interface GitStatusEntry {
  branch: string;
  ahead: number;
  behind: number;
  entries: Record<string, string>;
}

interface ExtendedState extends KimiClientState {
  connected: boolean;
  daemonVersion: string;
  workspaceName: string;
  connection: ConnectionState;
  permission: PermissionMode;
  thinking: ThinkingLevel;
  planMode: boolean;
  loading: boolean;
  queuedBySession: Record<string, string[]>;
  gitStatusBySession: Record<string, GitStatusEntry>;
  // Real daemon prompt_id of the last submitted prompt, per session. This is the
  // AUTHORITATIVE id for :abort — the event projector synthesizes a `pr_…` id
  // when turn.started races ahead of binding, which the daemon rejects.
  promptIdBySession: Record<string, string>;
  // Auth state (real daemon)
  authReady: boolean;
  defaultModel: string | null;
  managedProviderStatus: string | null;
  // Workspace state
  workspaces: AppWorkspace[];
  activeWorkspaceId: string | null;
  workspaceScope: WorkspaceScope;
  fsHome: string | null;
  recentRoots: string[];
}

const rawState: ExtendedState = reactive({
  ...createInitialState(),
  connected: false,
  daemonVersion: '',
  workspaceName: 'kimi-web',
  connection: 'disconnected' as ConnectionState,
  permission: loadPermissionFromStorage(),
  thinking: loadThinkingFromStorage(),
  planMode: loadPlanModeFromStorage(),
  loading: false,
  queuedBySession: {},
  gitStatusBySession: {},
  promptIdBySession: {},
  authReady: false,
  defaultModel: null,
  managedProviderStatus: null,
  workspaces: [],
  activeWorkspaceId: loadActiveWorkspaceFromStorage(),
  workspaceScope: 'current',
  fsHome: null,
  recentRoots: [],
});

// Models + Providers reactive state (lazy-loaded, cached)
const models = ref<AppModel[]>([]);
const providers = ref<AppProvider[]>([]);

// ~/diff line-by-line view: the file the user tapped + its parsed unified diff.
// Loaded on demand via loadFileDiff(); cleared when the file list is shown.
const selectedDiffPath = ref<string | null>(null);
const fileDiffLines = ref<DiffViewLine[]>([]);
const fileDiffLoading = ref(false);

// ---------------------------------------------------------------------------
// Theme (Terminal default vs Modern bubbles). Persisted to localStorage and
// mirrored onto <html data-theme> so fixed/teleported dialogs + sheets inherit.
// ---------------------------------------------------------------------------
const theme = ref<Theme>(loadThemeFromStorage());

/** Reflect the active theme onto <html data-theme>. jsdom-safe. */
function applyThemeToDocument(t: Theme): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.dataset.theme = t;
}

// Sync on every change AND immediately (so the very first paint is themed).
watch(theme, applyThemeToDocument, { immediate: true });

/** Set the active theme and persist it. */
function setTheme(t: Theme): void {
  if (t !== 'terminal' && t !== 'modern') return;
  theme.value = t;
  saveThemeToStorage(t);
}

/** Flip Terminal ↔ Modern. */
function toggleTheme(): void {
  setTheme(theme.value === 'modern' ? 'terminal' : 'modern');
}

// Singleton WS connection
let eventConn: KimiEventConnection | null = null;

// Per-session "a prompt is in flight" flag. Flipped SYNCHRONOUSLY the moment we
// decide to submit (before any await), and cleared when the session returns to
// idle. This gates concurrent prompts: `activity` only turns 'running' after the
// WS turn.started round-trips, so a fast second sendPrompt would otherwise race
// past the queue check and clobber promptIdBySession (breaking abort).
const inFlightPromptSessions = new Set<string>();

// Helper: mutate rawState by applying a reducer on a snapshot then re-assigning fields
function applyEvent(event: ReturnType<typeof toAppEvent>, sessionId: string, seq: number): void {
  const snapshot: KimiClientState = {
    sessions: rawState.sessions,
    activeSessionId: rawState.activeSessionId,
    messagesBySession: rawState.messagesBySession,
    approvalsBySession: rawState.approvalsBySession,
    questionsBySession: rawState.questionsBySession,
    tasksBySession: rawState.tasksBySession,
    lastSeqBySession: rawState.lastSeqBySession,
    warnings: rawState.warnings,
  };
  const next = reduceAppEvent(snapshot, event, { sessionId, seq });
  // Assign back to the reactive proxy
  rawState.sessions = next.sessions;
  rawState.activeSessionId = next.activeSessionId;
  rawState.messagesBySession = next.messagesBySession;
  rawState.approvalsBySession = next.approvalsBySession;
  rawState.questionsBySession = next.questionsBySession;
  rawState.tasksBySession = next.tasksBySession;
  rawState.lastSeqBySession = next.lastSeqBySession;
  rawState.warnings = next.warnings;
}

// ---------------------------------------------------------------------------
// WS subscription (lazy, only when a session is selected)
// ---------------------------------------------------------------------------

function connectEventsIfNeeded(): void {
  if (eventConn !== null) return;
  // Guard: jsdom and some environments have no WebSocket
  if (typeof WebSocket === 'undefined') return;

  rawState.connection = 'connecting';

  const api = getKimiWebApi();

  eventConn = api.connectEvents({
    onEvent(appEvent, meta) {
      // meta carries wire-level seq/sessionId so the reducer can advance
      // lastSeqBySession[sessionId] = seq. historyCompacted reload is owned
      // by onResync (the client routes it there); here we only let the reducer
      // run so lastSeqBySession stays current.
      applyEvent(appEvent, meta.sessionId, meta.seq);

      // Permission auto-approve: CLIENT-SIDE POLICY until the daemon exposes a
      // permission endpoint. When permission is 'auto' or 'yolo' and an approval
      // request arrives, immediately respond with 'approved'.
      if (appEvent.type === 'approvalRequested') {
        const perm = rawState.permission;
        if (perm === 'auto' || perm === 'yolo') {
          void respondApproval(appEvent.approval.approvalId, {
            decision: 'approved',
            scope: perm === 'yolo' ? 'session' : undefined,
          });
        }
      }
    },

    onResync(sessionId: string, currentSeq: number) {
      void reloadAndResubscribe(sessionId, currentSeq);
    },

    onError(_code: number, msg: string, _fatal: boolean) {
      rawState.warnings = [...rawState.warnings, `WS error: ${msg}`];
    },

    onConnectionChange(connected: boolean) {
      rawState.connected = connected;
      rawState.connection = connected ? 'connected' : 'disconnected';
    },
  });
}

/**
 * The daemon's GET /messages returns messages NEWEST-FIRST (confirmed: the
 * assistant reply comes before its user prompt). For display we need
 * chronological order (oldest first), otherwise a reloaded session renders
 * upside down. Reverse (handles the common newest-first case + equal
 * timestamps), then stable-sort by createdAt as a safety net.
 */
function orderMessages(
  items: import('../api/types').AppMessage[],
): import('../api/types').AppMessage[] {
  return [...items]
    .reverse()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

async function loadMessagesForSession(sessionId: string): Promise<void> {
  try {
    const api = getKimiWebApi();
    const page = await api.listMessages(sessionId, { pageSize: 100 });
    rawState.messagesBySession = {
      ...rawState.messagesBySession,
      [sessionId]: orderMessages(page.items),
    };
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `Failed to load messages: ${String(err)}`];
  }
}

async function reloadAndResubscribe(sessionId: string, currentSeq: number): Promise<void> {
  await loadMessagesForSession(sessionId);
  rawState.lastSeqBySession = { ...rawState.lastSeqBySession, [sessionId]: currentSeq };
  if (eventConn) {
    eventConn.subscribe(sessionId, currentSeq);
  }
}

// ---------------------------------------------------------------------------
// View-model mappers
// ---------------------------------------------------------------------------

/** Map AppSession status to UI SessionStatus */
function toUiSessionStatus(status: string): 'running' | 'idle' {
  if (status === 'running' || status === 'awaitingApproval' || status === 'awaitingQuestion') {
    return 'running';
  }
  return 'idle';
}

/** Format createdAt/updatedAt into a short display string */
function formatTime(iso: string, status: string): string {
  if (status === 'running' || status === 'awaitingApproval' || status === 'awaitingQuestion') {
    return `just now · ${i18n.global.t('status.runningShort')}`;
  }
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffH = diffMs / 3600000;
    if (diffH < 1) return `${Math.round(diffMs / 60000)}m ago`;
    if (diffH < 24) return `${Math.round(diffH)}h ago`;
    return d.toLocaleDateString(i18n.global.locale.value, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Build DiffLine[] from old_text/new_text strings */
function buildDiffLines(oldText: string, newText: string): DiffLine[] {
  const removed = oldText.split('\n');
  const added = newText.split('\n');
  const lines: DiffLine[] = [];
  removed.forEach((text, i) => {
    lines.push({ kind: 'rem', gutter: String(i + 1), text: `- ${text}` });
  });
  added.forEach((text, i) => {
    lines.push({ kind: 'add', gutter: String(i + 1), text: `+ ${text}` });
  });
  return lines;
}

/** Build ApprovalBlock from AppApprovalRequest (discriminated union) */
function buildApprovalBlock(a: AppApprovalRequest): ApprovalBlock {
  // Cast display to a loose dict for defensive reading
  const d = (a.display ?? {}) as Record<string, unknown>;
  const kind = typeof d.kind === 'string' ? d.kind : '';

  // diff
  if (kind === 'diff') {
    const path = typeof d.path === 'string' ? d.path : '';
    if (Array.isArray(d.diff)) {
      return { kind: 'diff', path, diff: d.diff as DiffLine[] };
    }
    if (typeof d.old_text === 'string' && typeof d.new_text === 'string') {
      return { kind: 'diff', path, diff: buildDiffLines(d.old_text, d.new_text) };
    }
    return { kind: 'diff', path, diff: [] };
  }

  // shell / command
  if (kind === 'shell' || kind === 'command') {
    const command = typeof d.command === 'string' ? d.command : a.action;
    const cwd = typeof d.cwd === 'string' ? d.cwd : undefined;
    const danger = typeof d.danger === 'string' ? d.danger : undefined;
    return { kind: 'shell', command, cwd, danger };
  }

  // file_content / file
  if (kind === 'file_content' || kind === 'file') {
    const path = typeof d.path === 'string' ? d.path : '';
    const content = typeof d.content === 'string' ? d.content : '';
    const language = typeof d.language === 'string' ? d.language : undefined;
    return { kind: 'file', path, content, language };
  }

  // file_op / fileop
  if (kind === 'file_op' || kind === 'fileop') {
    const op = typeof d.operation === 'string' ? d.operation : (typeof d.op === 'string' ? d.op : kind);
    const path = typeof d.path === 'string' ? d.path : '';
    const detail = typeof d.detail === 'string' ? d.detail : undefined;
    return { kind: 'fileop', op, path, detail };
  }

  // url_fetch / url
  if (kind === 'url_fetch' || kind === 'url') {
    const url = typeof d.url === 'string' ? d.url : a.action;
    const method = typeof d.method === 'string' ? d.method : undefined;
    return { kind: 'url', method, url };
  }

  // search
  if (kind === 'search') {
    const query = typeof d.query === 'string' ? d.query : a.action;
    const scope = typeof d.scope === 'string' ? d.scope : undefined;
    return { kind: 'search', query, scope };
  }

  // invocation / agent_call / skill_call
  if (kind === 'invocation' || kind === 'agent_call' || kind === 'skill_call') {
    const kind2 = typeof d.kind === 'string' ? d.kind : kind;
    const name = typeof d.name === 'string' ? d.name : a.toolName;
    const description = typeof d.description === 'string' ? d.description : undefined;
    return { kind: 'invocation', kind2, name, description };
  }

  // todo / todo_list
  if (kind === 'todo' || kind === 'todo_list') {
    const rawItems = Array.isArray(d.items) ? d.items : [];
    const items = rawItems.map((item: unknown) => {
      const it = (item ?? {}) as Record<string, unknown>;
      return {
        title: typeof it.title === 'string' ? it.title : String(it.title ?? ''),
        status: typeof it.status === 'string' ? it.status : 'pending',
      };
    });
    return { kind: 'todo', items };
  }

  // Unknown daemon display.kind → 'generic' with summary = action
  return { kind: 'generic', summary: a.action };
}

/** Map AppQuestionRequest to UIQuestion */
function toUiQuestion(q: AppQuestionRequest): UIQuestion {
  return {
    questionId: q.questionId,
    sessionId: q.sessionId,
    questions: q.questions.map((qi) => ({
      id: qi.id,
      question: qi.question,
      header: qi.header,
      body: qi.body,
      options: qi.options.map((o) => ({
        id: o.id,
        label: o.label,
        description: o.description,
      })),
      multiSelect: qi.multiSelect,
      allowOther: qi.allowOther,
      otherLabel: qi.otherLabel,
    })),
  };
}

// messagesToTurns is imported from ./messagesToTurns (extracted module that
// groups consecutive assistant messages by promptId into a single turn).

/** Map AppTask to UI TaskItem */
function toUiTask(task: {
  id: string;
  description: string;
  kind: string;
  status: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  outputLines?: string[];
  outputPreview?: string;
}): TaskItem {
  let state: TaskState;
  if (task.status === 'running') {
    state = 'run';
  } else if (task.status === 'completed') {
    state = 'done';
  } else {
    state = 'fail';
  }

  // Compute timing string
  let timing = '';
  if (task.status === 'running' && task.startedAt) {
    const elapsed = Math.round((Date.now() - new Date(task.startedAt).getTime()) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    timing = i18n.global.t('tasks.timingRunning', { time: `${m}:${String(s).padStart(2, '0')}` });
  } else if (task.completedAt && task.startedAt) {
    const elapsed = Math.round((new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime()) / 1000);
    timing = i18n.global.t('tasks.timingDone', { sec: elapsed });
  } else {
    timing = task.status;
  }

  const output: string[] | undefined =
    task.outputLines && task.outputLines.length > 0
      ? task.outputLines
      : task.outputPreview
        ? [task.outputPreview]
        : undefined;

  return {
    id: task.id,
    name: task.description,
    kind: task.kind,
    state,
    timing,
    output,
  };
}

// ---------------------------------------------------------------------------
// Computed view props
// ---------------------------------------------------------------------------

const workspace = computed<Workspace>(() => {
  const activeSession = rawState.sessions.find((s) => s.id === rawState.activeSessionId);
  const branch = activeSession ? activeSession.cwd.split('/').pop() ?? activeSession.cwd : 'main';
  return {
    name: rawState.workspaceName,
    branch,
  };
});

const sessions = computed<Session[]>(() =>
  rawState.sessions.map((s) => ({
    id: s.id,
    title: s.title,
    time: formatTime(s.updatedAt, s.status),
    status: toUiSessionStatus(s.status),
  })),
);

const activeSessionId = computed<string>(() => rawState.activeSessionId ?? '');

const turns = computed<ChatTurn[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const messages = rawState.messagesBySession[sid] ?? [];
  const approvals = rawState.approvalsBySession[sid] ?? [];
  return messagesToTurns(messages, approvals);
});

const tasks = computed<TaskItem[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return (rawState.tasksBySession[sid] ?? []).map(toUiTask);
});

const connection = computed<ConnectionState>(() => rawState.connection);

const loading = computed<boolean>(() => rawState.loading);

const permission = computed<PermissionMode>(() => rawState.permission);
const thinking = computed<ThinkingLevel>(() => rawState.thinking);
const planMode = computed<boolean>(() => rawState.planMode);

/** Queued messages for the active session */
const queued = computed<string[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return rawState.queuedBySession[sid] ?? [];
});

/** Pending warnings list */
const warnings = computed<string[]>(() => rawState.warnings);

/** Active session's pending questions mapped to UIQuestion[] */
const questions = computed<UIQuestion[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return (rawState.questionsBySession[sid] ?? []).map(toUiQuestion);
});

/**
 * Pending approvals for the active session, rendered as standalone interrupt
 * cards at the end of the transcript (they do NOT need to match a loaded
 * tool_use). This is how the TUI / old web surface approvals.
 */
const pendingApprovals = computed<
  { approvalId: string; block: ApprovalBlock; agentName?: string }[]
>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return (rawState.approvalsBySession[sid] ?? []).map((a) => ({
    approvalId: a.approvalId,
    block: buildApprovalBlock(a),
    agentName: (a as { agentName?: string }).agentName,
  }));
});

/**
 * Activity state for the active session.
 * Priority: awaiting-approval > awaiting-question > running > idle
 */
const activity = computed<ActivityState>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return 'idle';

  const approvals = rawState.approvalsBySession[sid] ?? [];
  if (approvals.length > 0) return 'awaiting-approval';

  const questionList = rawState.questionsBySession[sid] ?? [];
  if (questionList.length > 0) return 'awaiting-question';

  const activeSession = rawState.sessions.find((s) => s.id === sid);
  if (activeSession && (activeSession.status === 'running' || activeSession.status === 'awaitingApproval' || activeSession.status === 'awaitingQuestion')) {
    return 'running';
  }

  return 'idle';
});

/** Git info for the active session from the daemon's fs:git_status response */
const gitInfo = computed<{ branch: string; ahead: number; behind: number } | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  const gs = rawState.gitStatusBySession[sid];
  if (!gs) return null;
  return { branch: gs.branch, ahead: gs.ahead, behind: gs.behind };
});

/** Changed files for the active session, sorted by path */
const changes = computed<{ path: string; status: string }[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const gs = rawState.gitStatusBySession[sid];
  if (!gs) return [];
  return Object.entries(gs.entries)
    .map(([path, status]) => ({ path, status }))
    .sort((a, b) => a.path.localeCompare(b.path));
});

const status = computed<ConversationStatus>(() => {
  const activeSession = rawState.sessions.find((s) => s.id === rawState.activeSessionId);
  // Prefer real git branch from daemon; fall back to cwd basename
  const branch =
    gitInfo.value?.branch ??
    (activeSession ? activeSession.cwd.split('/').pop() ?? activeSession.cwd : 'main');
  // Known backend limitation: Session.agent_config.model is ALWAYS '' in
  // responses, so fall back to the daemon's default_model (from GET /auth) for
  // display when the session model is empty.
  const displayModel =
    (activeSession?.model && activeSession.model.length > 0
      ? activeSession.model
      : rawState.defaultModel) ?? '—';

  return {
    model: displayModel,
    ctxUsed: activeSession?.usage.contextTokens ?? 0,
    ctxMax: activeSession?.usage.contextLimit ?? 0,
    permission: rawState.permission,
    branch,
    cwd: activeSession?.cwd ?? '',
    isGitRepo: gitInfo.value !== null,
  };
});

/** Parsed unified-diff lines for the file selected in the ~/diff tab. */
const fileDiff = computed<DiffViewLine[]>(() => fileDiffLines.value);

/** Cumulative cost (USD) for the active session, from daemon usage. 0 if unknown. */
const sessionCost = computed<number>(() => {
  const activeSession = rawState.sessions.find((s) => s.id === rawState.activeSessionId);
  return activeSession?.usage.totalCostUsd ?? 0;
});

const authReady = computed<boolean>(() => rawState.authReady);
const defaultModel = computed<string | null>(() => rawState.defaultModel);
const managedProviderStatus = computed<string | null>(() => rawState.managedProviderStatus);

/** path → status map for quick badge lookup in the file tree */
const changesByPath = computed<Record<string, string>>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return {};
  const gs = rawState.gitStatusBySession[sid];
  if (!gs) return {};
  return { ...gs.entries };
});

// ---------------------------------------------------------------------------
// Workspace view-model
// ---------------------------------------------------------------------------

/**
 * The workspace id a session belongs to: prefer the daemon-provided
 * session.workspaceId; otherwise map by cwd (in derived/fallback mode the
 * workspace id IS the cwd).
 */
function workspaceIdForSession(s: { workspaceId?: string; cwd: string }): string {
  return s.workspaceId ?? s.cwd;
}

/**
 * Merge real (daemon) workspaces with workspaces DERIVED from the current
 * sessions' cwds. Each distinct cwd with no matching real workspace becomes one
 * derived workspace (id = root = cwd). This makes the switcher + grouping work
 * immediately off existing sessions until /workspaces ships.
 */
const mergedWorkspaces = computed<AppWorkspace[]>(() => {
  const byRoot = new Map<string, AppWorkspace>();
  // Real workspaces win on root.
  for (const w of rawState.workspaces) {
    byRoot.set(w.root, { ...w });
  }
  // Derive from sessions for any cwd without a real workspace.
  for (const s of rawState.sessions) {
    const root = s.cwd;
    if (!root) continue;
    if (!byRoot.has(root)) {
      byRoot.set(root, {
        // Use the session's REAL daemon workspace_id (wd_<slug>_<hash>) so
        // createSession({ workspaceId }) is accepted; fall back to cwd only
        // when the daemon hasn't tagged the session yet.
        id: s.workspaceId ?? root,
        root,
        name: basename(root),
        isGitRepo: false,
        sessionCount: 0,
      });
    }
  }
  // Compute live session counts + a branch hint from the active session's git.
  const counts = new Map<string, number>();
  for (const s of rawState.sessions) {
    const wid = workspaceIdForSession(s);
    counts.set(wid, (counts.get(wid) ?? 0) + 1);
  }
  const activeGit = gitInfo.value;
  const activeRoot = rawState.sessions.find((s) => s.id === rawState.activeSessionId)?.cwd;
  const result: AppWorkspace[] = [];
  for (const w of byRoot.values()) {
    // Match count by either id or root (derived id === root).
    const count = counts.get(w.id) ?? counts.get(w.root) ?? w.sessionCount;
    let branch = w.branch;
    if (!branch && activeGit && activeRoot === w.root) branch = activeGit.branch;
    result.push({ ...w, sessionCount: count, branch });
  }
  return result;
});

/** Sidebar-facing workspace list. */
const workspacesView = computed<WorkspaceView[]>(() =>
  mergedWorkspaces.value.map((w) => ({
    id: w.id,
    name: w.name,
    root: w.root,
    shortPath: shortenHome(w.root, rawState.fsHome),
    branch: w.branch,
    sessionCount: w.sessionCount,
  })),
);

/** The active workspace id, falling back to the first available workspace. */
const activeWorkspaceId = computed<string | null>(() => {
  const id = rawState.activeWorkspaceId;
  const list = mergedWorkspaces.value;
  if (id && list.some((w) => w.id === id)) return id;
  return list[0]?.id ?? null;
});

/** The active workspace as a sidebar view (or null when none). */
const visibleWorkspace = computed<WorkspaceView | null>(() => {
  const id = activeWorkspaceId.value;
  if (!id) return null;
  return workspacesView.value.find((w) => w.id === id) ?? null;
});

const workspaceScope = computed<WorkspaceScope>(() => rawState.workspaceScope);

/**
 * Sessions to show in the sidebar given the current scope.
 * - 'current': only sessions in the active workspace (flat list).
 * - 'all': every session (the sidebar renders workspaceGroups for grouping).
 */
const sessionsForView = computed<Session[]>(() => {
  const mapped = rawState.sessions.map((s) => ({
    id: s.id,
    title: s.title,
    time: formatTime(s.updatedAt, s.status),
    status: toUiSessionStatus(s.status),
  }));
  if (rawState.workspaceScope === 'all') return mapped;
  const wid = activeWorkspaceId.value;
  if (!wid) return mapped;
  const allowed = new Set(
    rawState.sessions
      .filter((s) => workspaceIdForSession(s) === wid)
      .map((s) => s.id),
  );
  return mapped.filter((s) => allowed.has(s.id));
});

/** Per-workspace groups for the 'all workspaces' scope. */
const workspaceGroups = computed<WorkspaceGroup[]>(() => {
  const byId = new Map<string, Session[]>();
  for (const s of rawState.sessions) {
    const wid = workspaceIdForSession(s);
    const view: Session = {
      id: s.id,
      title: s.title,
      time: formatTime(s.updatedAt, s.status),
      status: toUiSessionStatus(s.status),
    };
    const list = byId.get(wid) ?? [];
    list.push(view);
    byId.set(wid, list);
  }
  return workspacesView.value
    .filter((w) => byId.has(w.id))
    .map((w) => ({ workspace: w, sessions: byId.get(w.id) ?? [] }));
});

/**
 * Per-session pending-attention count = pending approvals + pending questions.
 * For the active session this is live (driven by WS events). Other sessions
 * light up once the daemon ships Session.pending_attention; until then their
 * counts are derived from whatever approvals/questions we've already seen.
 */
const attentionBySession = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {};
  for (const [sid, list] of Object.entries(rawState.approvalsBySession)) {
    if (list.length > 0) out[sid] = (out[sid] ?? 0) + list.length;
  }
  for (const [sid, list] of Object.entries(rawState.questionsBySession)) {
    if (list.length > 0) out[sid] = (out[sid] ?? 0) + list.length;
  }
  return out;
});

/**
 * Per-workspace pending-attention count = sum of attentionBySession over the
 * sessions belonging to each workspace. Drives the rail's attention badge.
 */
const attentionByWorkspace = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {};
  const perSession = attentionBySession.value;
  for (const s of rawState.sessions) {
    const count = perSession[s.id] ?? 0;
    if (count <= 0) continue;
    const wid = workspaceIdForSession(s);
    out[wid] = (out[wid] ?? 0) + count;
  }
  return out;
});

/** Recently-used roots for the add-workspace quick-pick (from /fs:home). */
const recentRoots = computed<string[]>(() => rawState.recentRoots);

/** Distinct cwd values from loaded sessions, most-recent first, deduped, max 8 */
const recentCwds = computed<string[]>(() => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const s of rawState.sessions) {
    const cwd = s.cwd;
    if (cwd && !seen.has(cwd)) {
      seen.add(cwd);
      result.push(cwd);
      if (result.length >= 8) break;
    }
  }
  return result;
});

// ---------------------------------------------------------------------------
// Queue auto-flush watcher
// When activity returns to 'idle' and there are queued messages, flush one.
// Also refresh git status when the agent finishes (activity → idle).
// ---------------------------------------------------------------------------

watch(activity, (act) => {
  if (act !== 'idle') return;
  const sid = rawState.activeSessionId;
  if (!sid) return;

  // The turn finished — this session no longer has a prompt in flight.
  inFlightPromptSessions.delete(sid);

  // Refresh git status so edits the agent just made are reflected
  void loadGitStatus(sid);

  const queue = rawState.queuedBySession[sid] ?? [];
  if (queue.length === 0) return;

  const [next, ...rest] = queue;
  rawState.queuedBySession = { ...rawState.queuedBySession, [sid]: rest };
  // Flush the first queued message
  if (next !== undefined) {
    void submitPromptInternal(sid, next);
  }
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Load + parse the unified diff for one changed file in the active session,
 * storing the result for the ~/diff line-by-line view. Defensive: on error
 * (or no active session) it leaves the diff empty but still records the path
 * so the panel opens with an empty state instead of silently doing nothing.
 */
async function loadFileDiff(path: string): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  selectedDiffPath.value = path;
  fileDiffLines.value = [];
  fileDiffLoading.value = true;
  try {
    const api = getKimiWebApi();
    const result = await api.getFileDiff(sid, path);
    // Guard against a stale response when the user tapped another file.
    if (selectedDiffPath.value !== path) return;
    fileDiffLines.value = parseDiff(result.diff);
  } catch (err) {
    if (selectedDiffPath.value === path) fileDiffLines.value = [];
    rawState.warnings = [...rawState.warnings, `loadFileDiff failed: ${String(err)}`];
  } finally {
    if (selectedDiffPath.value === path) fileDiffLoading.value = false;
  }
}

/** Close the ~/diff line-by-line view and return to the changed-file list. */
function clearFileDiff(): void {
  selectedDiffPath.value = null;
  fileDiffLines.value = [];
  fileDiffLoading.value = false;
}

/** Load git status for a session — defensive, never throws */
async function loadGitStatus(sessionId: string): Promise<void> {
  try {
    const api = getKimiWebApi();
    const result = await api.getGitStatus(sessionId);
    rawState.gitStatusBySession = {
      ...rawState.gitStatusBySession,
      [sessionId]: result,
    };
  } catch {
    // Stale/old sessions may 404 — leave undefined, no crash
  }
}

/** Fetch auth readiness from GET /api/v1/auth. Defensive — never throws. */
async function checkAuth(): Promise<void> {
  try {
    const api = getKimiWebApi();
    const result = await api.getAuth();
    rawState.authReady = result.ready;
    rawState.defaultModel = result.defaultModel;
    rawState.managedProviderStatus = result.managedProvider?.status ?? null;
  } catch {
    // Daemon may not have this endpoint yet; leave defaults (authReady: false)
  }
}

async function load(): Promise<void> {
  rawState.loading = true;
  try {
    const api = getKimiWebApi();
    // Parallel: health + meta + sessions
    const [, , sessionsPage] = await Promise.all([
      api.getHealth().catch(() => null),
      api.getMeta().then((m) => { rawState.daemonVersion = m.daemonVersion; }).catch(() => null),
      api.listSessions({ pageSize: 20 }).catch(() => ({ items: [], hasMore: false })),
    ]);

    // Check auth readiness (separate call — defensive)
    await checkAuth();

    rawState.sessions = sessionsPage.items;

    // Load workspaces (real if available, else derived from session cwds).
    await loadWorkspaces();

    // First load: pick the workspace of the most-recent session, unless the
    // user already has a persisted active workspace that still exists.
    const mostRecent = sessionsPage.items[0];
    const persisted = rawState.activeWorkspaceId;
    const persistedStillExists =
      persisted !== null && mergedWorkspaces.value.some((w) => w.id === persisted);
    if (!persistedStillExists && mostRecent) {
      selectWorkspace(workspaceIdForSession(mostRecent));
    }

    // Auto-select first session if none selected
    if (!rawState.activeSessionId && sessionsPage.items.length > 0) {
      await selectSession(sessionsPage.items[0]!.id);
    }
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `load() failed: ${String(err)}`];
    // Do not re-throw — app stays mounted with empty sessions
  } finally {
    rawState.loading = false;
  }
}

/** Load workspaces from the daemon (falls back to derived in mergedWorkspaces). */
async function loadWorkspaces(): Promise<void> {
  try {
    const api = getKimiWebApi();
    const [list, home] = await Promise.all([
      api.listWorkspaces().catch(() => [] as AppWorkspace[]),
      api.getFsHome().catch(() => ({ home: '', recentRoots: [] })),
    ]);
    rawState.workspaces = list;
    rawState.fsHome = home.home || null;
    rawState.recentRoots = home.recentRoots;
  } catch {
    // Defensive — derived workspaces still work off the loaded sessions.
  }
}

/** Set the active workspace and persist it. */
function selectWorkspace(id: string): void {
  rawState.activeWorkspaceId = id;
  saveActiveWorkspaceToStorage(id);
}

/** Switch the sidebar session-list scope. */
function setWorkspaceScope(scope: WorkspaceScope): void {
  rawState.workspaceScope = scope;
}

/**
 * Create a session in a workspace — the one-click path (no cwd typing).
 * Resolves the workspace root → createSession({ workspaceId, cwd: root }).
 */
async function createSessionInWorkspace(workspaceId: string): Promise<void> {
  const ws = mergedWorkspaces.value.find((w) => w.id === workspaceId);
  if (!ws) return;
  try {
    const api = getKimiWebApi();
    // A DERIVED workspace (id auto-assigned to a session by cwd) isn't in the
    // daemon's workspace registry, and createSession validates the id against
    // that registry ("workspace not found"). Register it first (idempotent),
    // then use the registry's real id.
    let workspaceIdForCreate = ws.id;
    if (!rawState.workspaces.some((w) => w.id === ws.id)) {
      try {
        const registered = await api.addWorkspace({ root: ws.root });
        workspaceIdForCreate = registered.id;
        rawState.workspaces = [
          registered,
          ...rawState.workspaces.filter((w) => w.root !== registered.root),
        ];
      } catch {
        // Registration failed — fall through with the derived id.
      }
    }
    const session = await api.createSession({ workspaceId: workspaceIdForCreate, cwd: ws.root });
    rawState.sessions = [session, ...rawState.sessions];
    selectWorkspace(workspaceIdForCreate);
    await selectSession(session.id);
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `createSessionInWorkspace failed: ${String(err)}`];
  }
}

/**
 * Add a workspace by folder path. Tries the daemon registry; on failure (or in
 * fallback mode) creates a locally-derived workspace from the path and
 * remembers it, then selects it.
 */
async function addWorkspaceByPath(root: string): Promise<void> {
  const trimmed = root.trim();
  if (!trimmed) return;
  const api = getKimiWebApi();
  try {
    const ws = await api.addWorkspace({ root: trimmed });
    // Merge/replace in the real workspace list.
    const others = rawState.workspaces.filter((w) => w.root !== ws.root);
    rawState.workspaces = [ws, ...others];
    selectWorkspace(ws.id);
  } catch {
    // Fallback: remember a derived workspace locally (id = root = path).
    const existing = rawState.workspaces.find((w) => w.root === trimmed);
    if (!existing) {
      rawState.workspaces = [
        {
          id: trimmed,
          root: trimmed,
          name: basename(trimmed),
          isGitRepo: false,
          sessionCount: 0,
        },
        ...rawState.workspaces,
      ];
    }
    selectWorkspace(trimmed);
  }
}

/**
 * Browse subdirectories under `path` (defaults to the daemon $HOME). Used by the
 * add-workspace folder browser. Defensive: returns an empty result on error so
 * the dialog falls back to the paste-path field.
 */
async function browseFs(path?: string): Promise<import('../api/types').FsBrowseResult> {
  try {
    const api = getKimiWebApi();
    return await api.browseFs(path);
  } catch {
    return { path: path ?? '', parent: null, entries: [] };
  }
}

/** Start directory + recently-used roots for the folder browser. */
async function getFsHome(): Promise<{ home: string; recentRoots: string[] }> {
  try {
    const api = getKimiWebApi();
    return await api.getFsHome();
  } catch {
    return { home: '', recentRoots: [] };
  }
}

async function selectSession(sessionId: string): Promise<void> {
  try {
    rawState.activeSessionId = sessionId;
    // A diff belongs to the session it was loaded from — drop it on switch.
    clearFileDiff();

    // NOTE: persisted sessions are directly promptable on the current daemon —
    // selecting one and sending a message just works, no re-activation needed.

    // Keep the active workspace in sync with the selected session.
    const selected = rawState.sessions.find((s) => s.id === sessionId);
    if (selected) {
      const wid = workspaceIdForSession(selected);
      if (rawState.activeWorkspaceId !== wid) selectWorkspace(wid);
    }

    // Load messages, tasks, and git status concurrently
    const api = getKimiWebApi();
    const [messagesPage, taskList] = await Promise.all([
      api.listMessages(sessionId, { pageSize: 100 }).catch(() => ({ items: [], hasMore: false })),
      api.listTasks(sessionId).catch(() => [] as import('../api/types').AppTask[]),
    ]);

    rawState.messagesBySession = {
      ...rawState.messagesBySession,
      [sessionId]: orderMessages(messagesPage.items),
    };
    rawState.tasksBySession = {
      ...rawState.tasksBySession,
      [sessionId]: taskList,
    };

    // Load git status (defensive — catch in loadGitStatus)
    void loadGitStatus(sessionId);

    // Subscribe to WS events for this session (lazy connect)
    connectEventsIfNeeded();
    if (eventConn) {
      const lastSeq = rawState.lastSeqBySession[sessionId] ?? 0;
      eventConn.subscribe(sessionId, lastSeq);
    }
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `selectSession failed: ${String(err)}`];
  }
}

async function createSession(cwd: string, opts?: { title?: string; model?: string }): Promise<void> {
  try {
    const api = getKimiWebApi();
    const session = await api.createSession({ cwd, title: opts?.title, model: opts?.model });
    rawState.sessions = [session, ...rawState.sessions];
    await selectSession(session.id);
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `createSession failed: ${String(err)}`];
  }
}

/** Internal: submit a prompt to a specific session, bypassing the queue check */
async function submitPromptInternal(sid: string, text: string, attachments?: { fileId: string }[]): Promise<void> {
  // Mark this session as having a prompt in flight BEFORE any await, so a racing
  // sendPrompt sees it and enqueues. Cleared when activity returns to idle.
  inFlightPromptSessions.add(sid);
  try {
    const api = getKimiWebApi();
    const content: import('../api/types').AppMessageContent[] = [];
    if (text) content.push({ type: 'text', text });
    for (const att of attachments ?? []) {
      content.push({ type: 'image', source: { kind: 'file', fileId: att.fileId } });
    }
    if (content.length === 0) {
      inFlightPromptSessions.delete(sid);
      return;
    }

    // OPTIMISTICALLY add the user message to local state BEFORE awaiting the
    // submit.  The real daemon does NOT emit a user-message event over WS, so
    // without this the user's own text never appears in the transcript.
    const tempId = `msg_opt_${Date.now().toString(36)}`;
    const optimisticMsg: AppMessage = {
      id: tempId,
      sessionId: sid,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    const existingMessages = rawState.messagesBySession[sid] ?? [];
    rawState.messagesBySession = {
      ...rawState.messagesBySession,
      [sid]: [...existingMessages, optimisticMsg],
    };

    // The daemon now requires `model` + `thinking` on every prompt. Resolve the
    // model from the session (falls back to the daemon's default_model) and the
    // thinking level from the user's setting.
    const promptSession = rawState.sessions.find((s) => s.id === sid);
    const model =
      (promptSession?.model && promptSession.model.length > 0
        ? promptSession.model
        : rawState.defaultModel) ?? undefined;
    const result = await api.submitPrompt(sid, {
      content,
      model,
      thinking: rawState.thinking,
      permissionMode: rawState.permission,
      planMode: rawState.planMode,
    });

    // Authoritative prompt_id for :abort — race-free (the projector binding can
    // lose to a fast turn.started and synthesize a `pr_…` id the daemon rejects).
    rawState.promptIdBySession = { ...rawState.promptIdBySession, [sid]: result.promptId };

    // Reconcile: swap the temp id for the real userMessageId returned by the
    // server.  This prevents a duplicate if the server ever echoes a
    // messageCreated event with that id.
    const msgs = rawState.messagesBySession[sid] ?? [];
    const idx = msgs.findIndex((m) => m.id === tempId);
    if (idx !== -1) {
      const updated = [...msgs];
      updated[idx] = { ...updated[idx]!, id: result.userMessageId, promptId: result.promptId };
      rawState.messagesBySession = { ...rawState.messagesBySession, [sid]: updated };
    }

    // Bind the real daemon prompt_id into the event projector so the upcoming
    // turn.started uses it (instead of synthesizing a random one). This is what
    // makes Stop work on the real daemon: session.currentPromptId then matches
    // the prompt_id the REST :abort endpoint expects.
    eventConn?.bindNextPromptId(sid, result.promptId);

    // NOTE: we no longer set a local auto-title here. The daemon generates a
    // smarter title from the first prompt and announces it via
    // session.meta.updated (projected to sessionMetaUpdated). PATCHing a title
    // locally would mark the session isCustomTitle=true and SUPPRESS the
    // daemon's auto-title, so we let the daemon own it.
  } catch (err) {
    // Submit failed — clear the in-flight flag so the next prompt isn't stuck
    // queued forever (turn.ended will never arrive).
    inFlightPromptSessions.delete(sid);
    rawState.warnings = [...rawState.warnings, `sendPrompt failed: ${String(err)}`];
  }
}

async function sendPrompt(text: string, attachments?: { fileId: string }[]): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;

  // If the session is not idle OR a prompt is already in flight (submitted but
  // the WS turn.started hasn't flipped activity to 'running' yet), enqueue
  // instead of submitting directly. Gating on inFlightPromptSessions closes the
  // window where two rapid prompts would both submit and race.
  // Attachments are not queued for simplicity — only the text is enqueued.
  if (activity.value !== 'idle' || inFlightPromptSessions.has(sid)) {
    enqueue(text);
    return;
  }

  await submitPromptInternal(sid, text, attachments);
}

/**
 * Upload an image file to the daemon's /api/v1/files endpoint.
 * Returns { fileId, name, mediaType } on success, or null on error (warning added to state).
 */
async function uploadImage(file: Blob, name?: string): Promise<{ fileId: string; name: string; mediaType: string } | null> {
  try {
    const api = getKimiWebApi();
    const result = await api.uploadFile({ file, name });
    return { fileId: result.id, name: result.name, mediaType: result.mediaType };
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `uploadImage failed: ${String(err)}`];
    return null;
  }
}

/** Enqueue a message for the active session; flushed when activity returns to idle */
function enqueue(text: string): void {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  const current = rawState.queuedBySession[sid] ?? [];
  rawState.queuedBySession = { ...rawState.queuedBySession, [sid]: [...current, text] };
}

async function abortCurrentPrompt(): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  const session = rawState.sessions.find((s) => s.id === sid);
  // Prefer the authoritative prompt_id captured at submit time; fall back to the
  // projector-derived one only if we never recorded a submit (e.g. resumed turn).
  const promptId = rawState.promptIdBySession[sid] ?? session?.currentPromptId;
  if (!promptId) return;
  try {
    const api = getKimiWebApi();
    await api.abortPrompt(sid, promptId);
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `abortCurrentPrompt failed: ${String(err)}`];
  }
}

async function respondApproval(
  approvalId: string,
  response: { decision: ApprovalDecision; scope?: 'session'; feedback?: string },
): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  try {
    const api = getKimiWebApi();
    const fullResponse: ApprovalResponse = {
      decision: response.decision,
      scope: response.scope,
      feedback: response.feedback,
    };
    await api.respondApproval(sid, approvalId, fullResponse);
    // Remove from local approvals immediately (WS event will confirm)
    const list = rawState.approvalsBySession[sid] ?? [];
    rawState.approvalsBySession = {
      ...rawState.approvalsBySession,
      [sid]: list.filter((a) => a.approvalId !== approvalId),
    };
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `respondApproval failed: ${String(err)}`];
  }
}

async function respondQuestion(
  questionId: string,
  response: QuestionResponse,
): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  try {
    const api = getKimiWebApi();
    await api.respondQuestion(sid, questionId, response);
    const list = rawState.questionsBySession[sid] ?? [];
    rawState.questionsBySession = {
      ...rawState.questionsBySession,
      [sid]: list.filter((q) => q.questionId !== questionId),
    };
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `respondQuestion failed: ${String(err)}`];
  }
}

async function dismissQuestion(questionId: string): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  try {
    const api = getKimiWebApi();
    await api.dismissQuestion(sid, questionId);
    const list = rawState.questionsBySession[sid] ?? [];
    rawState.questionsBySession = {
      ...rawState.questionsBySession,
      [sid]: list.filter((q) => q.questionId !== questionId),
    };
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `dismissQuestion failed: ${String(err)}`];
  }
}

async function cancelTask(taskId: string): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  try {
    const api = getKimiWebApi();
    await api.cancelTask(sid, taskId);
    // Update task status locally
    const list = rawState.tasksBySession[sid] ?? [];
    rawState.tasksBySession = {
      ...rawState.tasksBySession,
      [sid]: list.map((t) =>
        t.id === taskId ? { ...t, status: 'cancelled' as const } : t,
      ),
    };
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `cancelTask failed: ${String(err)}`];
  }
}

/** Persist and apply a new extended-thinking level (sent on every prompt). */
function setThinking(level: ThinkingLevel): void {
  rawState.thinking = level;
  saveThinkingToStorage(level);
}

/** Persist and apply plan mode (sent on every prompt as planMode). */
function setPlanMode(on: boolean): void {
  rawState.planMode = on;
  savePlanModeToStorage(on);
}

/** Flip plan mode on/off. */
function togglePlanMode(): void {
  setPlanMode(!rawState.planMode);
}

/** Persist and apply a new permission mode; auto-approve pending approvals if switching to auto/yolo */
function setPermission(mode: PermissionMode): void {
  rawState.permission = mode;
  savePermissionToStorage(mode);

  // If switching to auto/yolo, auto-approve any currently-pending approvals for the active session
  if (mode === 'auto' || mode === 'yolo') {
    const sid = rawState.activeSessionId;
    if (sid) {
      const approvals = [...(rawState.approvalsBySession[sid] ?? [])];
      for (const a of approvals) {
        void respondApproval(a.approvalId, {
          decision: 'approved',
          scope: mode === 'yolo' ? 'session' : undefined,
        });
      }
    }
  }
}

/** Dismiss a warning by index */
function dismissWarning(index: number): void {
  const list = [...rawState.warnings];
  list.splice(index, 1);
  rawState.warnings = list;
}

/** Rename a session — calls API and updates local state */
async function renameSession(id: string, title: string): Promise<void> {
  try {
    const api = getKimiWebApi();
    await api.updateSession(id, { title });
    rawState.sessions = rawState.sessions.map((s) =>
      s.id === id ? { ...s, title } : s,
    );
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `renameSession failed: ${String(err)}`];
  }
}

/** Delete a session — calls API, removes locally, picks another active session or none */
async function deleteSession(id: string): Promise<void> {
  try {
    const api = getKimiWebApi();
    await api.deleteSession(id);
    rawState.sessions = rawState.sessions.filter((s) => s.id !== id);

    // If deleted session was active, pick another
    if (rawState.activeSessionId === id) {
      const next = rawState.sessions[0];
      if (next) {
        await selectSession(next.id);
      } else {
        rawState.activeSessionId = undefined;
      }
    }
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `deleteSession failed: ${String(err)}`];
  }
}

// ---------------------------------------------------------------------------
// Model + Provider actions
// ---------------------------------------------------------------------------

/** Load models (cached — call again to force refresh) */
async function loadModels(): Promise<void> {
  try {
    const api = getKimiWebApi();
    models.value = await api.listModels();
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `loadModels failed: ${String(err)}`];
  }
}

/** Load providers */
async function loadProviders(): Promise<void> {
  try {
    const api = getKimiWebApi();
    providers.value = await api.listProviders();
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `loadProviders failed: ${String(err)}`];
  }
}

/**
 * Switch model for the active session. Calls PATCH /sessions/{id} but does NOT
 * assume it took effect: the real daemon silently ignores agent_config.model
 * (it always returns model ''), so model switching is a no-op there. We update
 * local state optimistically to `modelId`, falling back to whatever the daemon
 * returns only when it is non-empty. Never crashes.
 */
async function setModel(modelId: string): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  try {
    const api = getKimiWebApi();
    const updated = await api.updateSession(sid, { model: modelId });
    // Daemon returns '' for model (limitation) → keep the user's chosen id for
    // display rather than blanking it out.
    const effectiveModel = updated.model && updated.model.length > 0 ? updated.model : modelId;
    rawState.sessions = rawState.sessions.map((s) =>
      s.id === sid ? { ...s, model: effectiveModel } : s,
    );
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `setModel failed: ${String(err)}`];
  }
}

/** Add a provider, then reload providers + models */
async function addProvider(input: {
  type: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}): Promise<void> {
  try {
    const api = getKimiWebApi();
    await api.addProvider(input);
    await Promise.all([loadProviders(), loadModels()]);
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `addProvider failed: ${String(err)}`];
  }
}

/** Delete a provider, then reload providers + models */
async function deleteProvider(id: string): Promise<void> {
  try {
    const api = getKimiWebApi();
    await api.deleteProvider(id);
    await Promise.all([loadProviders(), loadModels()]);
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `deleteProvider failed: ${String(err)}`];
  }
}

/** Refresh a provider status */
async function refreshProvider(id: string): Promise<void> {
  try {
    const api = getKimiWebApi();
    const updated = await api.refreshProvider(id);
    providers.value = providers.value.map((p) => (p.id === id ? updated : p));
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `refreshProvider failed: ${String(err)}`];
  }
}

/** Start managed Kimi OAuth device flow. Returns flow data or null on error. */
async function startOAuthLogin(): Promise<{
  flowId: string;
  provider: string;
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresIn: number;
  interval: number;
  status: 'pending';
  expiresAt: string;
} | null> {
  try {
    const api = getKimiWebApi();
    return await api.startOAuthLogin();
  } catch {
    return null;
  }
}

/** Poll the singleton OAuth flow. Returns null on error or no active flow. */
async function pollOAuthLogin(): Promise<{
  flowId: string;
  status: 'pending' | 'authenticated' | 'expired' | 'cancelled';
  resolvedAt?: string;
} | null> {
  try {
    const api = getKimiWebApi();
    return await api.pollOAuthLogin();
  } catch {
    return null;
  }
}

/** Cancel the current OAuth flow (best-effort). */
async function cancelOAuthLogin(): Promise<void> {
  try {
    const api = getKimiWebApi();
    await api.cancelOAuthLogin();
  } catch {
    // Best-effort
  }
}

/** Logout from the managed Kimi provider. Re-checks auth and reloads sessions. */
async function logout(): Promise<void> {
  try {
    const api = getKimiWebApi();
    await api.logout();
    await checkAuth();
    await load();
  } catch (err) {
    rawState.warnings = [...rawState.warnings, `logout failed: ${String(err)}`];
  }
}

/**
 * compact() — request history compaction.
 * TODO: wire to a real /compact endpoint once the daemon exposes it.
 * For now, push an info warning so the user knows it's not yet implemented.
 */
function compact(): void {
  rawState.warnings = [...rawState.warnings, i18n.global.t('commands.compactNotImplemented')];
}

/**
 * undo() — revert the last message.
 * The daemon has no undo endpoint yet, so don't silently no-op — surface a
 * warning so the user knows the command isn't connected.
 */
function undo(): void {
  rawState.warnings = [...rawState.warnings, i18n.global.t('commands.undoNotImplemented')];
}

/**
 * Remove a queued message for the active session by index.
 * Defensive: no-op if index out of range or no active session.
 */
function unqueue(index: number): void {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  const current = rawState.queuedBySession[sid] ?? [];
  if (index < 0 || index >= current.length) return;
  const next = [...current];
  next.splice(index, 1);
  rawState.queuedBySession = { ...rawState.queuedBySession, [sid]: next };
}

/**
 * List directory contents for the active session.
 * Returns FsEntry[] — defensive, returns [] on error or no active session.
 */
async function listDir(path: string): Promise<FsEntry[]> {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  try {
    const api = getKimiWebApi();
    const result = await api.listDirectory(sid, { path, includeGitStatus: true });
    return result.items;
  } catch {
    return [];
  }
}

/**
 * Read file content for the active session.
 * Returns the file metadata + content (including path), or null on error or no active session.
 */
async function readFileContent(path: string): Promise<{
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mime: string;
  languageId?: string;
  isBinary: boolean;
  size: number;
  lineCount?: number;
} | null> {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  try {
    const api = getKimiWebApi();
    const result = await api.readFile(sid, { path });
    return {
      path: result.path,
      content: result.content,
      encoding: result.encoding,
      mime: result.mime,
      languageId: result.languageId,
      isBinary: result.isBinary,
      size: result.size,
      lineCount: result.lineCount,
    };
  } catch {
    return null;
  }
}

/**
 * Search files in the active session using the daemon searchFiles endpoint.
 * Returns {path, name}[] — defensive, returns [] on error or no active session.
 */
async function searchFiles(query: string): Promise<Array<{ path: string; name: string }>> {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  try {
    const api = getKimiWebApi();
    const result = await api.searchFiles(sid, { query, limit: 20 });
    return result.items.map((item) => ({ path: item.path, name: item.name }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Composable return
// ---------------------------------------------------------------------------

export function useKimiWebClient() {
  return {
    // Reactive state / computed view props
    workspace,
    sessions,
    activeSessionId,

    // Workspace view props
    workspacesView,
    visibleWorkspace,
    activeWorkspaceId,
    workspaceScope,
    sessionsForView,
    workspaceGroups,
    attentionBySession,
    attentionByWorkspace,
    recentRoots,

    turns,
    tasks,
    status,
    sessionCost,
    fileDiff,
    selectedDiffPath,
    fileDiffLoading,
    changes,
    gitInfo,
    changesByPath,
    pendingApprovals,
    recentCwds,

    // New Phase 1 computed
    connection,
    loading,
    permission,
    thinking,
    planMode,
    queued,
    warnings,
    questions,
    activity,

    // Model + Provider reactive state
    models,
    providers,

    // Theme
    theme,
    setTheme,
    toggleTheme,

    // Actions
    load,
    selectSession,
    createSession,

    // Workspace actions
    loadWorkspaces,
    selectWorkspace,
    setWorkspaceScope,
    createSessionInWorkspace,
    addWorkspaceByPath,
    browseFs,
    getFsHome,

    sendPrompt,
    uploadImage,
    abortCurrentPrompt,
    respondApproval,
    respondQuestion,
    dismissQuestion,
    cancelTask,

    // New Phase 1 actions
    setPermission,
    setThinking,
    setPlanMode,
    togglePlanMode,
    enqueue,
    dismissWarning,
    renameSession,
    deleteSession,
    compact,
    undo,

    // New Phase 4 actions
    unqueue,
    searchFiles,
    loadGitStatus,
    loadFileDiff,
    clearFileDiff,

    // File system actions
    listDir,
    readFileContent,

    // Model + Provider actions
    loadModels,
    loadProviders,
    setModel,
    addProvider,
    deleteProvider,
    refreshProvider,

    // Auth state
    authReady,
    defaultModel,
    managedProviderStatus,

    // Auth actions
    checkAuth,
    startOAuthLogin,
    pollOAuthLogin,
    cancelOAuthLogin,
    logout,
  };
}

// Re-export types used by wired components so they can import from one place
export type { ApprovalDecision, AppModel, AppProvider };
