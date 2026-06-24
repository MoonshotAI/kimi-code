// apps/kimi-web/src/composables/useKimiWebClient.ts
// Vue state composable — the only place that imports both src/api/* and src/types.ts.
// Components consume computed view props and call actions; they never touch the API or reducer.

import { computed, reactive, ref } from 'vue';
import { i18n } from '../i18n';
import { getKimiWebApi } from '../api';
import { isDaemonApiError, isDaemonNetworkError } from '../api/errors';
import { loadUnread, safeGetString, safeRemove, safeSetString, saveUnread, STORAGE_KEYS } from '../lib/storage';
import { useAppearance } from './client/useAppearance';
import { useNotification } from './client/useNotification';
import { useTaskPoller } from './client/useTaskPoller';
import { useModelProviderState } from './client/useModelProviderState';
import { useSideChat } from './client/useSideChat';
import { useWorkspaceState } from './client/useWorkspaceState';

const appearance = useAppearance();
const notification = useNotification();
import type {
  AppApprovalRequest,
  AppConfig,
  AppGoal,
  AppNotice,
  AppNoticeDetail,
  AppMessage,
  AppModel,
  AppProvider,
  AppQuestionRequest,
  AppSession,
  AppSessionRuntimeStatus,
  AppSkill,
  AppTask,
  AppWarning,
  AppWorkspace,
  ApprovalDecision,
  KimiEventConnection,
  ThinkingLevel,
} from '../api/types';
import { createInitialState, reduceAppEvent, type CompactionStatus, type KimiClientState } from '../api/daemon/eventReducer';
import { toAppEvent } from '../api/daemon/mappers';

import { messagesToTurns } from './messagesToTurns';
import { latestTodos } from './latestTodos';
import { buildSwarmGroups, countSwarmMembers } from './swarmGroups';
import type { SwarmGroup } from './swarmGroups';
import type {
  ActivityState,
  ActivationBadges,
  ApprovalBlock,
  ChatTurn,
  ConnectionState,
  ConversationStatus,
  DiffLine,
  DiffViewLine,
  PermissionMode,
  QueuedPromptView,
  Session,
  TaskItem,
  TaskState,
  TodoView,
  UIQuestion,
  Workspace,
  WorkspaceGroup,
  WorkspaceView,
} from '../types';

// ---------------------------------------------------------------------------
// Internal reactive state (plain object wrapped in reactive())
// ---------------------------------------------------------------------------

const PERMISSION_STORAGE_KEY = STORAGE_KEYS.permission;
const ACTIVE_WORKSPACE_KEY = STORAGE_KEYS.activeWorkspace;
const THINKING_STORAGE_KEY = STORAGE_KEYS.thinking;
const PLAN_MODE_STORAGE_KEY = STORAGE_KEYS.planMode;
const SWARM_MODE_STORAGE_KEY = STORAGE_KEYS.swarmMode;
const GOAL_MODE_STORAGE_KEY = STORAGE_KEYS.goalMode;
const SESSION_NOT_FOUND_CODE = 40401;
const ONBOARDED_STORAGE_KEY = STORAGE_KEYS.onboarded;
const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

// Appearance types + logic live in ./client/useAppearance; re-exported here so
// existing `import type { Theme, ColorScheme, Accent } from './useKimiWebClient'`
// callers keep working.
export type { Accent, ColorScheme, Theme } from './client/useAppearance';

// The code-font setting was removed with its UI (b8a9e83). Clear the old
// persisted key so users who once picked a font aren't frozen on it forever.
safeRemove(STORAGE_KEYS.codeFont);

function loadPermissionFromStorage(): PermissionMode {
  try {
    const v = safeGetString(PERMISSION_STORAGE_KEY);
    if (v === 'auto' || v === 'yolo' || v === 'manual') return v;
  } catch {
    // localStorage not available (e.g. jsdom without config)
  }
  return 'manual';
}

function savePermissionToStorage(mode: PermissionMode): void {
  try {
    safeSetString(PERMISSION_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

function loadThinkingFromStorage(): ThinkingLevel {
  try {
    const v = safeGetString(THINKING_STORAGE_KEY);
    if (v && (THINKING_LEVELS as readonly string[]).includes(v)) return v as ThinkingLevel;
  } catch {
    // ignore
  }
  return 'high';
}

function saveThinkingToStorage(v: ThinkingLevel): void {
  try {
    safeSetString(THINKING_STORAGE_KEY, v);
  } catch {
    // ignore
  }
}

function loadPlanModeFromStorage(): boolean {
  try {
    return safeGetString(PLAN_MODE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function savePlanModeToStorage(v: boolean): void {
  try {
    safeSetString(PLAN_MODE_STORAGE_KEY, v ? 'true' : 'false');
  } catch {
    // ignore
  }
}

function loadSwarmModeFromStorage(): boolean {
  try {
    return safeGetString(SWARM_MODE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveSwarmModeToStorage(v: boolean): void {
  try {
    safeSetString(SWARM_MODE_STORAGE_KEY, v ? 'true' : 'false');
  } catch {
    // ignore
  }
}

function loadGoalModeFromStorage(): boolean {
  try {
    return safeGetString(GOAL_MODE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveGoalModeToStorage(v: boolean): void {
  try {
    safeSetString(GOAL_MODE_STORAGE_KEY, v ? 'true' : 'false');
  } catch {
    // ignore
  }
}

function loadActiveWorkspaceFromStorage(): string | null {
  try {
    return safeGetString(ACTIVE_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

// Roots the user removed from the sidebar. "Remove workspace" must hide a
// workspace even when it still has sessions (the daemon DELETE is registry-only
// and mergedWorkspaces would otherwise re-derive it from those sessions' cwds).
// History is untouched — only the sidebar entry is hidden — so this is persisted
// per browser, keyed by root path.
const HIDDEN_WORKSPACES_KEY = STORAGE_KEYS.hiddenWorkspaces;

function loadHiddenWorkspacesFromStorage(): string[] {
  try {
    const v = safeGetString(HIDDEN_WORKSPACES_KEY);
    if (!v) return [];
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveHiddenWorkspacesToStorage(roots: string[]): void {
  try {
    safeSetString(HIDDEN_WORKSPACES_KEY, JSON.stringify(roots));
  } catch {
    // ignore
  }
}

function saveActiveWorkspaceToStorage(id: string): void {
  try {
    safeSetString(ACTIVE_WORKSPACE_KEY, id);
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
  additions: number;
  deletions: number;
  pullRequest: { number: number; state: string; url: string } | null;
}

/** An uploaded attachment to send with a prompt. `kind` drives the content-block
    type (image vs video) so a still and a clip resolve to the right wire shape. */
export type PromptAttachment = { fileId: string; kind: 'image' | 'video' };

/** A prompt waiting for the session to go idle. Keeps the uploaded
    fileIds so attachments survive queueing (not just the text). */
interface QueuedPrompt {
  text: string;
  attachments?: PromptAttachment[];
}

export interface ExtendedState extends KimiClientState {
  connected: boolean;
  serverVersion: string;
  workspaceName: string;
  connection: ConnectionState;
  permission: PermissionMode;
  thinking: ThinkingLevel;
  planMode: boolean;
  swarmMode: boolean;
  goalMode: boolean;
  loading: boolean;
  sessionLoading: boolean;
  queuedBySession: Record<string, QueuedPrompt[]>;
  gitStatusBySession: Record<string, GitStatusEntry>;
  // Real daemon prompt_id of the last submitted prompt, per session. This is the
  // AUTHORITATIVE id for :abort — the event projector synthesizes a `pr_…` id
  // when turn.started races ahead of binding, which the daemon rejects.
  promptIdBySession: Record<string, string>;
  // True while a prompt is in flight but the assistant reply hasn't started yet.
  sendingBySession: Record<string, boolean>;
  // True when a BACKGROUND session finished a turn the user hasn't opened since
  // (drives the unread blue dot in the sidebar). Set on idle for a non-active
  // session, cleared when the session is selected.
  unreadBySession: Record<string, boolean>;
  // Auth state (real daemon)
  authReady: boolean;
  defaultModel: string | null;
  managedProviderStatus: string | null;
  // Workspace state
  workspaces: AppWorkspace[];
  activeWorkspaceId: string | null;
  fsHome: string | null;
  recentRoots: string[];
  // Root paths the user removed from the sidebar (see HIDDEN_WORKSPACES_KEY).
  hiddenWorkspaceRoots: string[];
  /** Installed external apps that can be used with "Open in app". */
  availableOpenInApps: string[];
  /** Global daemon configuration (secrets redacted). */
  config: AppConfig | null;
  /** Transient BTW side-panel transcript, keyed by forked agent id. */
  sideChatMessagesByAgent: Record<string, AppMessage[]>;
  /** Local sending flag for BTW agents; agent ids are not session ids. */
  sideChatSendingByAgent: Record<string, boolean>;
  /** User message ids sent through BTW so they can be hidden from the main transcript. */
  sideChatUserMessageIdsBySession: Record<string, string[]>;
  /** True when older messages are being fetched for a session (scroll-up lazy load). */
  messagesLoadingMoreBySession: Record<string, boolean>;
  /** Whether the server has more older messages than currently loaded per session. */
  messagesHasMoreBySession: Record<string, boolean>;
  /** True when the last older-message fetch failed for a session. */
  messagesLoadMoreErrorBySession: Record<string, boolean>;
}

const rawState: ExtendedState = reactive({
  ...createInitialState(),
  connected: false,
  serverVersion: '',
  workspaceName: 'kimi-web',
  connection: 'disconnected' as ConnectionState,
  permission: loadPermissionFromStorage(),
  thinking: loadThinkingFromStorage(),
  planMode: loadPlanModeFromStorage(),
  swarmMode: loadSwarmModeFromStorage(),
  goalMode: loadGoalModeFromStorage(),
  loading: false,
  sessionLoading: false,
  queuedBySession: {},
  gitStatusBySession: {},
  promptIdBySession: {},
  sendingBySession: {},
  unreadBySession: loadUnread(),
  authReady: false,
  defaultModel: null,
  managedProviderStatus: null,
  workspaces: [],
  activeWorkspaceId: loadActiveWorkspaceFromStorage(),
  fsHome: null,
  recentRoots: [],
  hiddenWorkspaceRoots: loadHiddenWorkspacesFromStorage(),
  availableOpenInApps: [],
  config: null,
  sideChatMessagesByAgent: {},
  sideChatSendingByAgent: {},
  sideChatUserMessageIdsBySession: {},
  messagesLoadingMoreBySession: {},
  messagesHasMoreBySession: {},
  messagesLoadMoreErrorBySession: {},
});

// ---------------------------------------------------------------------------
// rawState.sessions — single mutation funnel.
// Every change to the session list goes through one of these helpers, so
// "where can sessions change?" has exactly one answer per intent. They are
// injected into the workspace/model modules (via deps) so no module assigns
// rawState.sessions directly.
// ---------------------------------------------------------------------------
function setSessions(next: AppSession[]): void {
  rawState.sessions = next;
}
/** Replace one session in place (matched by id); no-op if it isn't loaded. */
function updateSession(id: string, update: (session: AppSession) => AppSession): void {
  rawState.sessions = rawState.sessions.map((s) => (s.id === id ? update(s) : s));
}
/** Add or move a session to the front (recency order), de-duped by id. */
function upsertSessionFront(session: AppSession): void {
  rawState.sessions = [session, ...rawState.sessions.filter((s) => s.id !== session.id)];
}
/** Append a session to the end (e.g. a deep-linked older session). */
function appendSession(session: AppSession): void {
  rawState.sessions = [...rawState.sessions, session];
}
/** Drop a session from the list by id. */
function removeSession(id: string): void {
  rawState.sessions = rawState.sessions.filter((s) => s.id !== id);
}

// Cross-tab sync: when another tab writes the unread key, adopt its value so a
// clear on one tab doesn't get overwritten by this tab's stale in-memory map.
//
// The session this tab is actively viewing is also cleared (only while visible):
// its unread bit may have been set by a tab where it was in the background, and
// we don't want the on-screen session to light up a dot. The same clear runs when
// a hidden tab becomes visible again, so a dot that arrived while hidden is
// dropped once the user is actually looking.
function clearActiveUnread(): void {
  const active = rawState.activeSessionId;
  if (
    active &&
    rawState.unreadBySession[active] &&
    typeof document !== 'undefined' &&
    document.visibilityState === 'visible'
  ) {
    rawState.unreadBySession = { ...rawState.unreadBySession, [active]: false };
    saveUnread({ [active]: false });
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEYS.unread) {
      rawState.unreadBySession = loadUnread();
      clearActiveUnread();
    }
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      clearActiveUnread();
    }
  });
}

// ---------------------------------------------------------------------------
// rawState.activeSessionId — single mutation funnel.
// ---------------------------------------------------------------------------
/** Set the active session (or clear it with undefined). */
function setActiveSessionId(id: string | undefined): void {
  rawState.activeSessionId = id;
}

// ---------------------------------------------------------------------------
// rawState.messagesBySession — single mutation funnel.
// ---------------------------------------------------------------------------
/** Replace the whole messages map (e.g. from the reducer snapshot). */
function setMessagesBySession(next: Record<string, AppMessage[]>): void {
  rawState.messagesBySession = next;
}
/** Set one session's message list. */
function setSessionMessages(sessionId: string, messages: AppMessage[]): void {
  rawState.messagesBySession = { ...rawState.messagesBySession, [sessionId]: messages };
}
/** Update one session's message list via a function of the current list. */
function updateSessionMessages(
  sessionId: string,
  update: (messages: AppMessage[]) => AppMessage[],
): void {
  rawState.messagesBySession = {
    ...rawState.messagesBySession,
    [sessionId]: update(rawState.messagesBySession[sessionId] ?? []),
  };
}
/** Remove one session's message list. */
function removeSessionMessages(sessionId: string): void {
  const { [sessionId]: _removed, ...rest } = rawState.messagesBySession;
  void _removed;
  rawState.messagesBySession = rest;
}

// ---------------------------------------------------------------------------
// Session teardown — single place that wipes a session and all its per-session
// sidecar state. Both removal entry points (not-found + archive) go through
// this, so adding a new per-session map only ever needs one new line here.
// ---------------------------------------------------------------------------
function forgetSession(sessionId: string): void {
  // Stop receiving events for this session BEFORE clearing its state: a late or
  // buffered event for this id would otherwise be reduced and recreate the very
  // per-session maps we are about to delete.
  eventConn?.unsubscribe(sessionId);
  removeSession(sessionId);
  removeSessionMessages(sessionId);
  delete rawState.approvalsBySession[sessionId];
  delete rawState.questionsBySession[sessionId];
  delete rawState.tasksBySession[sessionId];
  delete rawState.goalBySession[sessionId];
  delete rawState.gitStatusBySession[sessionId];
  delete rawState.lastSeqBySession[sessionId];
  delete rawState.compactionBySession[sessionId];
  delete rawState.messagesLoadingMoreBySession[sessionId];
  delete rawState.messagesHasMoreBySession[sessionId];
  delete rawState.messagesLoadMoreErrorBySession[sessionId];
  delete epochBySession[sessionId];
  sessionsKnownEmpty.delete(sessionId);
  // In-flight / queued prompt state: drop these too so a queued follow-up
  // can't be submitted to a session that was just archived when its turn later
  // goes idle (onSessionIdle drains queuedBySession[sid] without re-checking
  // that the session still exists).
  inFlightPromptSessions.delete(sessionId);
  delete rawState.queuedBySession[sessionId];
  delete rawState.promptIdBySession[sessionId];
  delete rawState.sendingBySession[sessionId];
}

// Models + Providers reactive state and helpers live in
// ./client/useModelProviderState. It is instantiated below (after the
// `activity` computed it depends on) as `modelProvider`.

// ~/diff line-by-line view: the file the user tapped + its parsed unified diff.
// Loaded on demand via loadFileDiff(); cleared when the file list is shown.
const selectedDiffPath = ref<string | null>(null);
const fileDiffLines = ref<DiffViewLine[]>([]);
const fileDiffLoading = ref(false);

// False until the very first load() settles (success OR failure). Gates the
// global connecting-splash so a page refresh doesn't flash a half-empty app.
const initialized = ref(false);

/**
 * Fetch GET /sessions/{id}/status and fold the live model + context usage back
 * into the cached session, so the status line and the WS `agent.status.updated`
 * path share ONE source of truth (the session). Never throws — an old daemon
 * without /status just keeps the previously-known values.
 */
async function refreshSessionStatus(sessionId: string): Promise<void> {
  let st: AppSessionRuntimeStatus;
  try {
    st = await getKimiWebApi().getSessionStatus(sessionId);
  } catch {
    return; // status endpoint missing/unreachable — keep what we have.
  }
  updateSession(sessionId, (s) => ({
    ...s,
    model: st.model || s.model,
    usage: {
      ...s.usage,
      contextTokens: st.contextTokens,
      contextLimit: st.maxContextTokens,
    },
  }));
  rawState.swarmMode = st.swarmMode;
  rawState.planMode = st.planMode;
}

/** Persist runtime controls to the active session via POST /profile, then
 *  re-read /status. Fire-and-forget: the UI already updated optimistically. */
function persistSessionProfile(patch: {
  model?: string;
  permissionMode?: string;
  planMode?: boolean;
  swarmMode?: boolean;
  goalObjective?: string;
  goalControl?: 'pause' | 'resume' | 'cancel';
  thinking?: string;
}): void {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  // Promise.resolve wrap: tolerate a sync/undefined return (e.g. test mocks).
  void Promise.resolve(getKimiWebApi().updateSession(sid, patch))
    .then(() => refreshSessionStatus(sid))
    .catch(() => {
      /* ignore — local state already reflects the change */
    });
}

// ---------------------------------------------------------------------------
// Beta: proportional conversation TOC with viewport indicator and hover tooltip.
// Default off; persisted per browser.
// ---------------------------------------------------------------------------
const BETA_TOC_STORAGE_KEY = STORAGE_KEYS.betaToc;
function loadBetaTocFromStorage(): boolean {
  try {
    return safeGetString(BETA_TOC_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}
function saveBetaTocToStorage(v: boolean): void {
  try {
    safeSetString(BETA_TOC_STORAGE_KEY, v ? 'true' : 'false');
  } catch {
    // ignore
  }
}
const betaToc = ref<boolean>(loadBetaTocFromStorage());
function setBetaToc(v: boolean): void {
  betaToc.value = v;
  saveBetaTocToStorage(v);
}

// ---------------------------------------------------------------------------
// Onboarding: a "has the user been onboarded" flag that gates the first-run
// onboarding screen (preferences: language + theme). Persisted; can be reset to
// re-open the screen from the settings popover.
// ---------------------------------------------------------------------------
function loadStringFromStorage(key: string): string {
  try {
    return safeGetString(key) ?? '';
  } catch {
    return '';
  }
}
const onboarded = ref<boolean>(loadStringFromStorage(ONBOARDED_STORAGE_KEY) === '1');
function setOnboarded(done: boolean): void {
  onboarded.value = done;
  try {
    safeSetString(ONBOARDED_STORAGE_KEY, done ? '1' : '0');
  } catch {
    /* ignore */
  }
}

// Singleton WS connection
let eventConn: KimiEventConnection | null = null;

// Monotonic counter for optimistic user-message ids. Date.now() alone collides
// when two prompts are submitted in the same millisecond (e.g. a queued send
// then a steer), which gave both messages the SAME id — breaking Vue keying and
// the prompt_id stamping that dedupes the daemon echo. The counter guarantees a
// unique id per optimistic message.
let optimisticMsgSeq = 0;
function nextOptimisticMsgId(): string {
  optimisticMsgSeq += 1;
  return `msg_opt_${Date.now().toString(36)}_${optimisticMsgSeq}`;
}

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
    goalBySession: rawState.goalBySession,
    lastSeqBySession: rawState.lastSeqBySession,
    compactionBySession: rawState.compactionBySession,
    config: rawState.config,
    warnings: rawState.warnings,
  };
  const next = reduceAppEvent(snapshot, event, { sessionId, seq });
  // Assign back to the reactive proxy
  setSessions(next.sessions);
  setActiveSessionId(next.activeSessionId);
  setMessagesBySession(next.messagesBySession);
  rawState.approvalsBySession = next.approvalsBySession;
  rawState.questionsBySession = next.questionsBySession;
  rawState.tasksBySession = next.tasksBySession;
  rawState.goalBySession = next.goalBySession;
  rawState.lastSeqBySession = next.lastSeqBySession;
  rawState.compactionBySession = next.compactionBySession;
  rawState.config = next.config ?? null;
  rawState.warnings = next.warnings;

  if (event.type === 'configChanged') {
    rawState.defaultModel = event.config.defaultModel ?? null;
  }

  if (event.type === 'sessionUsageUpdated' && event.sessionId === rawState.activeSessionId && event.swarmMode !== undefined) {
    rawState.swarmMode = event.swarmMode;
  }
  // Reflect the agent's live plan-mode state (e.g. it auto-entered plan mode)
  // in the composer toggle.
  if (event.type === 'sessionUsageUpdated' && event.sessionId === rawState.activeSessionId && event.planMode !== undefined) {
    rawState.planMode = event.planMode;
  }
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
      // Workspace lifecycle events are global (not session-scoped) and update
      // rawState.workspaces directly — they bypass the reducer, which has no
      // workspace state.
      if (
        appEvent.type === 'workspaceCreated' ||
        appEvent.type === 'workspaceUpdated' ||
        appEvent.type === 'workspaceDeleted'
      ) {
        workspaceState.applyWorkspaceEvent(appEvent);
        return;
      }

      // meta carries wire-level seq/sessionId so the reducer can advance
      // lastSeqBySession[sessionId] = seq. Compaction completion appends a
      // persistent divider marker in the reducer (TUI parity: the scrollback
      // is kept, only a marker line records the compaction).
      applyEvent(appEvent, meta.sessionId, meta.seq);

      const sideTarget = sideChat.sideChatTargetBySession.value[meta.sessionId];
      if (sideTarget) {
        const { agentId } = sideTarget;
        const parentId = meta.sessionId;
        if (appEvent.type === 'agentDelta' && appEvent.agentId === agentId) {
          if (appEvent.delta.text) {
            sideChat.appendSideChatAssistantText(agentId, parentId, appEvent.delta.text);
          }
        } else if (appEvent.type === 'agentTurnEnded' && appEvent.agentId === agentId) {
          sideChat.finishSideChatAgent(agentId, parentId);
        } else if (appEvent.type === 'taskProgress' && appEvent.taskId === agentId) {
          sideChat.appendSideChatAssistantText(agentId, parentId, appEvent.outputChunk);
        } else if (appEvent.type === 'taskCompleted' && appEvent.taskId === agentId) {
          sideChat.finishSideChatAgent(agentId, parentId, appEvent.outputPreview);
        }
      }

      // The daemon's prompt.submitted event is projected as a user messageCreated
      // carrying the real prompt_id. When the HTTP submit response is lost
      // (timeout / network error) this is the fallback that lets Stop work.
      if (
        appEvent.type === 'messageCreated' &&
        appEvent.message.role === 'user' &&
        appEvent.message.promptId !== undefined
      ) {
        const sid = appEvent.message.sessionId;
        if (rawState.promptIdBySession[sid] !== appEvent.message.promptId) {
          rawState.promptIdBySession = {
            ...rawState.promptIdBySession,
            [sid]: appEvent.message.promptId,
          };
        }
      }

      if (appEvent.type === 'assistantDelta' && meta.sessionId === rawState.activeSessionId) {
        appearance.recordMoonDelta((appEvent.delta.text?.length ?? 0) + (appEvent.delta.thinking?.length ?? 0));
      }

      // Turn-end cleanup for the session the event belongs to — including
      // sessions running in the background (see onSessionIdle).
      // Turn-end: both 'idle' and 'aborted' mean the prompt is no longer in
      // flight, so both must flush in-flight/queued state. (Awaiting-* is still
      // in flight — it's waiting on the user — and must NOT flush.)
      if (
        appEvent.type === 'sessionStatusChanged' &&
        (appEvent.status === 'idle' || appEvent.status === 'aborted')
      ) {
        onSessionIdle(appEvent.sessionId, appEvent.status);
      }
    },

    onResync(sessionId: string, currentSeq: number, epoch?: string) {
      // The server-announced cursor is only a hint; the snapshot fetch
      // returns the authoritative {asOfSeq, epoch} and re-subscribes.
      if (epoch !== undefined) epochBySession[sessionId] = epoch;
      void currentSeq;
      void syncSessionFromSnapshot(sessionId);
    },

    onError(_code: number, msg: string, _fatal: boolean) {
      pushWarning({
        severity: 'error',
        title: i18n.global.t('warnings.wsTitle'),
        message: msg,
        details: [warningDetail('message', msg)].filter(
          (detail): detail is AppNoticeDetail => detail !== undefined,
        ),
      });
    },

    onConnectionChange(connected: boolean) {
      rawState.connected = connected;
      rawState.connection = connected ? 'connected' : 'disconnected';
    },
  });
}

// Journal epoch per session, learned from snapshots / resync frames. Not
// reactive — only consulted when building the subscribe cursor.
const epochBySession: Record<string, string> = {};

// Sessions created locally in this client instance are known to be empty until
// they receive their first message. This is more reliable than the daemon's
// messageCount field, which can be stale for old sessions and would otherwise
// flash the empty-composer before the real snapshot arrives.
const sessionsKnownEmpty = new Set<string>();

/**
 * v2 initial sync (IM-style rebuild): fetch the atomic session snapshot,
 * install its state, seed the projector's in-flight turn, then subscribe the
 * WS at the snapshot's `{seq: asOfSeq, epoch}` cursor. The watermark ties
 * the REST snapshot to the event stream — no gap, no duplication.
 */
type SyncSessionResult = 'ok' | 'not-found' | 'failed';

function isSessionNotFoundError(err: unknown): boolean {
  if (isDaemonApiError(err) && err.code === SESSION_NOT_FOUND_CODE) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === SESSION_NOT_FOUND_CODE
  );
}

function warningDetail(labelKey: string, value: unknown): AppNoticeDetail | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return { label: i18n.global.t(`warnings.details.${labelKey}`), value: formatDetailValue(value) };
}

function formatDetailValue(value: unknown): string {
  if (value instanceof Error) {
    return value.message ? `${value.name}: ${value.message}` : value.name;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorName(err: unknown): string | undefined {
  return err instanceof Error
    ? err.name
    : typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string'
      ? (err as { name: string }).name
      : undefined;
}

function errorMessage(err: unknown): string | undefined {
  return err instanceof Error
    ? err.message
    : typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message
      : undefined;
}

function errorDetails(operation: string, err: unknown, sessionId?: string): AppNoticeDetail[] {
  const details: Array<AppNoticeDetail | undefined> = [
    warningDetail('operation', operation),
    warningDetail('sessionId', sessionId),
  ];

  if (isDaemonNetworkError(err)) {
    details.push(
      warningDetail('request', `${err.method} ${err.path}`),
      warningDetail('endpoint', err.url),
      warningDetail('requestId', err.requestId),
      warningDetail('phase', err.phase),
      warningDetail('timeout', `${err.timeoutMs}ms`),
      warningDetail('status', err.status === undefined ? undefined : `${err.status} ${err.statusText ?? ''}`.trim()),
      warningDetail('contentType', err.contentType),
      warningDetail('responsePreview', err.bodyPreview),
      warningDetail('cause', err.cause),
    );
  } else if (isDaemonApiError(err)) {
    details.push(
      warningDetail('code', err.code),
      warningDetail('requestId', err.requestId),
      warningDetail('message', err.message),
      warningDetail('details', err.details),
    );
  } else {
    details.push(
      warningDetail('errorName', errorName(err)),
      warningDetail('message', errorMessage(err) ?? formatDetailValue(err)),
    );
  }

  return details.filter((detail): detail is AppNoticeDetail => detail !== undefined);
}

function operationFailureNotice(
  operation: string,
  err: unknown,
  opts: { title?: string; message?: string; sessionId?: string } = {},
): AppNotice {
  const network = isDaemonNetworkError(err);
  const api = isDaemonApiError(err);
  const title =
    opts.title ??
    (network
      ? i18n.global.t('warnings.daemonNetworkTitle')
      : api
        ? i18n.global.t('warnings.daemonApiTitle')
        : i18n.global.t('warnings.operationFailedTitle'));
  const message =
    opts.message ??
    (network
      ? i18n.global.t('warnings.daemonNetworkMessage')
      : api
        ? err.message
        : i18n.global.t('warnings.operationFailedMessage'));
  return {
    severity: 'error',
    title,
    message,
    details: errorDetails(operation, err, opts.sessionId),
  };
}

function pushWarning(warning: AppWarning): void {
  rawState.warnings = [...rawState.warnings, warning];
}

function pushOperationFailure(
  operation: string,
  err: unknown,
  opts?: { title?: string; message?: string; sessionId?: string },
): void {
  pushWarning(operationFailureNotice(operation, err, opts));
}

// Goal-specific protocol error codes (40913–40918). The daemon now returns
// these instead of a bare 500, so map them to a friendly explanation rather
// than dumping the raw envelope message on the user.
const GOAL_ERROR_KEYS: Record<number, string> = {
  40913: 'warnings.goal.alreadyExists',
  40914: 'warnings.goal.notFound',
  40915: 'warnings.goal.statusInvalid',
  40916: 'warnings.goal.notResumable',
  40918: 'warnings.goal.objectiveTooLong',
};

function goalErrorMessage(err: unknown): string | undefined {
  if (!isDaemonApiError(err)) return undefined;
  const key = GOAL_ERROR_KEYS[err.code];
  return key ? i18n.global.t(key) : undefined;
}

async function handleSessionNotFound(sessionId: string): Promise<void> {
  forgetSession(sessionId);

  if (rawState.activeSessionId !== sessionId) return;

  const next = rawState.sessions[0];
  if (next) {
    await workspaceState.selectSession(next.id, { urlMode: 'replace' });
  } else {
    setActiveSessionId(undefined);
    rawState.sessionLoading = false;
    workspaceState.writeSessionUrl(undefined, 'replace');
  }
}

async function syncSessionFromSnapshot(sessionId: string): Promise<SyncSessionResult> {
  try {
    const api = getKimiWebApi();
    const snap = await api.getSessionSnapshot(sessionId);

    updateSession(sessionId, (s) => ({
      ...snap.session,
      model:
        snap.session.model && snap.session.model.length > 0
          ? snap.session.model
          : s.model,
    }));
    setSessionMessages(sessionId, snap.messages);
    rawState.messagesHasMoreBySession = {
      ...rawState.messagesHasMoreBySession,
      [sessionId]: snap.hasMoreMessages,
    };
    rawState.approvalsBySession = {
      ...rawState.approvalsBySession,
      [sessionId]: snap.pendingApprovals,
    };
    rawState.questionsBySession = {
      ...rawState.questionsBySession,
      [sessionId]: snap.pendingQuestions,
    };
    rawState.lastSeqBySession = {
      ...rawState.lastSeqBySession,
      [sessionId]: snap.asOfSeq,
    };
    epochBySession[sessionId] = snap.epoch;

    connectEventsIfNeeded();
    if (eventConn) {
      // Seed BEFORE subscribing: the in-flight assistant message must exist
      // before live deltas (aligned by wire offset) start appending to it.
      eventConn.seedSnapshot(sessionId, snap);
      eventConn.subscribe(sessionId, { seq: snap.asOfSeq, epoch: snap.epoch });
    }
    return 'ok';
  } catch (err) {
    if (isSessionNotFoundError(err)) {
      await handleSessionNotFound(sessionId);
      return 'not-found';
    }
    pushOperationFailure('getSessionSnapshot', err, {
      title: i18n.global.t('warnings.sessionSnapshotTitle'),
      message: i18n.global.t('warnings.sessionSnapshotMessage'),
      sessionId,
    });
    return 'failed';
  }
}

function hasLoadedMessages(sessionId: string): boolean {
  return Object.prototype.hasOwnProperty.call(rawState.messagesBySession, sessionId);
}

function subscribeToSessionEvents(sessionId: string): void {
  connectEventsIfNeeded();
  if (eventConn) {
    const seq = rawState.lastSeqBySession[sessionId] ?? 0;
    const epoch = epochBySession[sessionId];
    eventConn.subscribe(sessionId, { seq, epoch });
  }
}

// ---------------------------------------------------------------------------
// View-model mappers
// ---------------------------------------------------------------------------

/** Whether the session should show the "working" spinner. Only a `running`
    session qualifies — `awaiting*` is waiting on the user (not working) and
    `aborted` is finished, so neither spins. Additionally, a session whose only
    running task is its BTW side-channel agent should not look busy. When tasks
    have not been loaded yet — e.g. right after a page refresh — we trust the
    daemon-reported `running` status rather than hiding the spinner. */
function isSessionEffectivelyRunning(sessionId: string): boolean {
  const session = rawState.sessions.find((s) => s.id === sessionId);
  if (!session) return false;
  if (session.status !== 'running') return false;
  const hiddenBtwAgentId = sideChat.sideChatTargetBySession.value[sessionId]?.agentId;
  const tasks = rawState.tasksBySession[sessionId] ?? [];
  const runningTasks = tasks.filter((t) => t.status === 'running');
  if (runningTasks.length === 0) {
    // No task list yet (fresh refresh) — trust the daemon-reported session status,
    // unless the only active work is a BTW side-chat agent. In that window the
    // side chat is sending and its task hasn't been loaded, so suppress the main
    // session spinner so the main composer stays usable.
    if (hiddenBtwAgentId && rawState.sideChatSendingByAgent[hiddenBtwAgentId]) {
      return false;
    }
    return true;
  }
  return runningTasks.some((t) => t.id !== hiddenBtwAgentId);
}

/** Format createdAt/updatedAt into a short display string */
function formatTime(iso: string, _status: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffH = diffMs / 3600000;
    if (diffMs < 60000) return i18n.global.t('sessions.justNow');
    if (diffH < 1) return `${Math.round(diffMs / 60000)}m`;
    if (diffH < 24) return `${Math.round(diffH)}h`;
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

const SESSION_TIME_CLOCK_INTERVAL_MS = 30_000;
const sessionTimeClock = ref(0);
let sessionTimeClockTimer: ReturnType<typeof setInterval> | null = null;

function ensureSessionTimeClock(): void {
  if (sessionTimeClockTimer !== null) return;
  sessionTimeClockTimer = setInterval(() => {
    sessionTimeClock.value = (sessionTimeClock.value + 1) % Number.MAX_SAFE_INTEGER;
  }, SESSION_TIME_CLOCK_INTERVAL_MS);
  (sessionTimeClockTimer as { unref?: () => void }).unref?.();
}

function stopSessionTimeClock(): void {
  if (sessionTimeClockTimer === null) return;
  clearInterval(sessionTimeClockTimer);
  sessionTimeClockTimer = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(stopSessionTimeClock);
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
        title: typeof it.title === 'string' ? it.title : '',
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
        recommended: o.recommended,
      })),
      multiSelect: qi.multiSelect,
      allowOther: qi.allowOther,
      otherLabel: qi.otherLabel,
    })),
  };
}

// messagesToTurns is imported from ./messagesToTurns (extracted module that
// groups consecutive assistant messages by promptId into a single turn).

/**
 * Try to recover the original bash command for a background task when the
 * task object itself does not carry it. The command lives in the matching
 * `Bash` tool_use message whose tool_result mentions this task's id.
 */
function findBashCommandForTask(task: AppTask): string | undefined {
  const messages = rawState.messagesBySession[task.sessionId];
  if (!messages || messages.length === 0) return undefined;

  const bashCommandsByToolCallId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const part of msg.content) {
      if (part.type !== 'toolUse') continue;
      if (part.toolName !== 'Bash' && part.toolName !== 'bash') continue;
      const input = part.input as { command?: unknown } | undefined;
      const command = input && typeof input.command === 'string' ? input.command : undefined;
      if (command) {
        bashCommandsByToolCallId.set(part.toolCallId, command);
      }
    }
  }
  if (bashCommandsByToolCallId.size === 0) return undefined;

  const taskIdMarker = `task_id: ${task.id}`;
  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    for (const part of msg.content) {
      if (part.type !== 'toolResult') continue;
      const outputText =
        typeof part.output === 'string'
          ? part.output
          : part.output !== undefined
            ? JSON.stringify(part.output)
            : '';
      if (outputText.includes(taskIdMarker)) {
        const command = bashCommandsByToolCallId.get(part.toolCallId);
        if (command) return command;
      }
    }
  }
  return undefined;
}

/** Map AppTask to UI TaskItem */
function toUiTask(task: AppTask): TaskItem {
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
        ? task.outputPreview.split(/\r?\n/)
        : undefined;

  // Show the real terminal command for bash tasks so users can see what is
  // running without expanding the row. Fall back to the matching Bash tool_use
  // message when the task itself does not carry the command field.
  const command = task.command ?? findBashCommandForTask(task);
  const meta = task.kind === 'bash' && command ? `$ ${command}` : undefined;

  return {
    id: task.id,
    name: task.description,
    kind: task.kind,
    state,
    timing,
    meta,
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

const sessions = computed<Session[]>(() => {
  void sessionTimeClock.value;
  return rawState.sessions
    .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map((s) => ({
      id: s.id,
      title: s.title,
      time: formatTime(s.updatedAt, s.status),
      status: s.status,
      busy: isSessionEffectivelyRunning(s.id),
    }));
});

const activeSessionId = computed<string>(() => rawState.activeSessionId ?? '');

/** Slash-invocable skills for the active session (feeds the composer `/` menu). */
const skills = computed<AppSkill[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return modelProvider.skillsBySession.value[sid] ?? [];
});

const isSending = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return false;
  return rawState.sendingBySession[sid] ?? false;
});

const sideChat = useSideChat(rawState, {
  pushOperationFailure,
  nextOptimisticMsgId,
  connectEventsIfNeeded,
  getEventConn: () => eventConn,
});

const activeAppTasks = computed<AppTask[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const hiddenBtwAgentId = sideChat.sideChatTargetBySession.value[sid]?.agentId;
  return (rawState.tasksBySession[sid] ?? []).filter((task) => task.id !== hiddenBtwAgentId);
});

const taskPoller = useTaskPoller(rawState, activeAppTasks);

const turns = computed<ChatTurn[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const hiddenIds = new Set(rawState.sideChatUserMessageIdsBySession[sid] ?? []);
  const messages = (rawState.messagesBySession[sid] ?? []).filter((m) => !hiddenIds.has(m.id));
  const approvals = rawState.approvalsBySession[sid] ?? [];
  return messagesToTurns(
    messages,
    approvals,
    (fileId) => getKimiWebApi().getFileUrl(fileId),
    activity.value !== 'idle',
    activeAppTasks.value,
  );
});

const tasks = computed<TaskItem[]>(() => {
  // Touch the clock so a running task's elapsed time recomputes each tick.
  void taskPoller.taskClock.value;
  return activeAppTasks.value.map(toUiTask);
});

const swarms = computed<SwarmGroup[]>(() => buildSwarmGroups(activeAppTasks.value));

const goal = computed<AppGoal | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  return rawState.goalBySession[sid] ?? null;
});

/** Current todo list of the active session (TodoList tool, latest write wins). */
const todos = computed<TodoView[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return latestTodos(rawState.messagesBySession[sid] ?? []);
});

/** Live compaction state of the active session (present only while running). */
const compaction = computed<CompactionStatus | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  return rawState.compactionBySession[sid] ?? null;
});

const connection = computed<ConnectionState>(() => rawState.connection);

const loading = computed<boolean>(() => rawState.loading);
const sessionLoading = computed<boolean>(() => rawState.sessionLoading);
const loadingMoreMessages = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? rawState.messagesLoadingMoreBySession[sid] ?? false : false;
});
const hasMoreMessages = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? rawState.messagesHasMoreBySession[sid] ?? false : false;
});
const loadMoreMessagesError = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? rawState.messagesLoadMoreErrorBySession[sid] ?? false : false;
});
const serverVersion = computed<string>(() => rawState.serverVersion);

const permission = computed<PermissionMode>(() => rawState.permission);
const thinking = computed<ThinkingLevel>(() => rawState.thinking);
const planMode = computed<boolean>(() => rawState.planMode);
const swarmMode = computed<boolean>(() => rawState.swarmMode);
const goalMode = computed<boolean>(() => rawState.goalMode);

const activationBadges = computed<ActivationBadges>(() => {
  const swarmCounts = countSwarmMembers(swarms.value);
  return {
    plan: rawState.planMode,
    goal: goal.value && goal.value.status !== 'complete'
      ? {
          status: goal.value.status,
          turnsUsed: goal.value.turnsUsed,
          elapsedMs: goal.value.wallClockMs,
        }
      : null,
    swarm: swarmCounts.total > 0 ? swarmCounts : null,
  };
});

/** Queued messages for the active session (text + attachment count for the
    composer strip — an image-only prompt would otherwise render as an empty
    string). */
const queued = computed<QueuedPromptView[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return (rawState.queuedBySession[sid] ?? []).map((q) => ({
    text: q.text,
    attachmentCount: q.attachments?.length ?? 0,
  }));
});

/** Pending warnings list */
const warnings = computed<AppWarning[]>(() => rawState.warnings);

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

  if (isSessionEffectivelyRunning(sid)) {
    return 'running';
  }

  return 'idle';
});

const modelProvider = useModelProviderState(rawState, {
  pushOperationFailure,
  refreshSessionStatus,
  persistSessionProfile,
  activity,
  inFlightPromptSessions,
  saveThinkingToStorage,
  updateSession,
  updateSessionMessages,
});

/** Git info for the active session from the daemon's fs:git_status response */
const gitInfo = computed<{ branch: string; ahead: number; behind: number } | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  const gs = rawState.gitStatusBySession[sid];
  if (!gs) return null;
  return { branch: gs.branch, ahead: gs.ahead, behind: gs.behind };
});

/** GitHub pull request for the active session's current branch. Null when
    unknown, not a GitHub repo, or the branch has no PR — the header hides it. */
const activePullRequest = computed<{ number: number; state: string; url: string } | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  return rawState.gitStatusBySession[sid]?.pullRequest ?? null;
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

/** Aggregate working-tree line stats (vs HEAD) for the active session's header
    diff counter. Null when no git status is loaded, so the header hides it. */
const gitDiffStats = computed<{ totalAdditions: number; totalDeletions: number } | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  const gs = rawState.gitStatusBySession[sid];
  if (!gs) return null;
  return { totalAdditions: gs.additions, totalDeletions: gs.deletions };
});

const status = computed<ConversationStatus>(() => {
  const activeSession = rawState.sessions.find((s) => s.id === rawState.activeSessionId);
  // Prefer real git branch from daemon; fall back to cwd basename
  const branch =
    gitInfo.value?.branch ??
    (activeSession ? activeSession.cwd.split('/').pop() ?? activeSession.cwd : 'main');
  // session.model is kept live by GET /status (on select/idle) and the WS
  // agent.status.updated event during a turn; fall back to the daemon default.
  // In the draft state (no active session) the user's draft pick wins, so the
  // composer dropdown reflects the selection before the session exists.
  const draftPick = activeSession === undefined ? modelProvider.draftModel.value : null;
  const rawModel =
    (activeSession?.model && activeSession.model.length > 0
      ? activeSession.model
      : draftPick ?? rawState.defaultModel) ?? '—';

  // Use the friendly displayName from the models list; fall back to stripping
  // the provider prefix (e.g. "moonshot/moonshot-v1-128k" → "moonshot-v1-128k").
  const matched = modelProvider.models.value.find((m) => m.id === rawModel || m.model === rawModel);
  const displayModel =
    matched?.displayName ||
    matched?.model ||
    (rawModel.includes('/') ? rawModel.split('/').pop()! : rawModel);

  return {
    model: displayModel,
    // Raw id for exact comparison in pickers (display name diverges from id).
    modelId: matched?.id ?? rawModel,
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
const config = computed<AppConfig | null>(() => rawState.config);

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
  return rawState.workspaces.find((w) => w.root === s.cwd)?.id ?? s.workspaceId ?? s.cwd;
}

/**
 * Merge real (daemon) workspaces with workspaces DERIVED from the current
 * sessions' cwds. Each distinct cwd with no matching real workspace becomes one
 * derived workspace (id = root = cwd). This makes the switcher + grouping work
 * immediately off existing sessions until /workspaces ships.
 */
const mergedWorkspaces = computed<AppWorkspace[]>(() => {
  const hidden = new Set(rawState.hiddenWorkspaceRoots);
  const byRoot = new Map<string, AppWorkspace>();
  // Real workspaces win on root (unless the user removed them from the sidebar).
  for (const w of rawState.workspaces) {
    if (hidden.has(w.root)) continue;
    byRoot.set(w.root, { ...w });
  }
  // Derive from sessions for any cwd without a real workspace.
  for (const s of rawState.sessions) {
    const root = s.cwd;
    if (!root) continue;
    if (hidden.has(root)) continue; // removed from the sidebar — keep it hidden
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

  // Order: real workspaces in listWorkspaces order, then derived workspaces
  // sorted by root path so the order is stable (not tied to session activity).
  const realRoots = rawState.workspaces.map((w) => w.root);
  const derivedRoots = [...byRoot.keys()].filter((r) => !realRoots.includes(r));
  derivedRoots.sort((a, b) => a.localeCompare(b));

  const result: AppWorkspace[] = [];
  for (const root of [...realRoots, ...derivedRoots]) {
    const w = byRoot.get(root)!;
    // Match count by either id or root (derived id === root). Once sessions
    // have loaded, trust the live local count (0 when no sessions remain) rather
    // than the daemon's sessionCount, which historically counted archived
    // sessions and would keep a workspace looking non-empty after its last
    // session was archived.
    const count = counts.get(w.id) ?? counts.get(w.root) ?? (rawState.loading ? w.sessionCount : 0);
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

/**
 * All sessions for the sidebar (grouped by workspace via workspaceGroups).
 */
const sessionsForView = computed<Session[]>(() => {
  void sessionTimeClock.value;
  const visibleWorkspaceIds = new Set(workspacesView.value.map((w) => w.id));
  // Child ("side chat") sessions never appear in the main list — they live in
  // the side-chat panel only. Sessions under a removed (hidden) workspace are
  // excluded too, so this flat list matches what the grouped sidebar renders
  // and sidebar search can't resurrect sessions from a removed workspace.
  return rawState.sessions
    .filter((s) => !s.parentSessionId && visibleWorkspaceIds.has(workspaceIdForSession(s)))
    .map((s) => ({
      id: s.id,
      title: s.title,
      time: formatTime(s.updatedAt, s.status),
      status: s.status,
      busy: isSessionEffectivelyRunning(s.id),
      lastPrompt: s.lastPrompt,
    }));
});

/** Per-workspace groups for the 'all workspaces' scope. */
const workspaceGroups = computed<WorkspaceGroup[]>(() => {
  void sessionTimeClock.value;
  const byId = new Map<string, Session[]>();
  for (const s of rawState.sessions.toSorted(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )) {
    if (s.parentSessionId) continue; // child sessions stay out of the list
    const wid = workspaceIdForSession(s);
    const view: Session = {
      id: s.id,
      title: s.title,
      time: formatTime(s.updatedAt, s.status),
      status: s.status,
      busy: isSessionEffectivelyRunning(s.id),
      updatedAt: s.updatedAt,
    };
    const list = byId.get(wid) ?? [];
    list.push(view);
    byId.set(wid, list);
  }
  return workspacesView.value.map((w) => ({
    workspace: w,
    sessions: byId.get(w.id) ?? [],
  }));
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
 * Per-session pending counts split by KIND, so the sidebar can show distinct
 * coloured tags: one for "awaiting your answer" (askUserQuestion) and one for
 * "awaiting your approval" (permission request). The merged count above stays
 * for the workspace rail / dialogs that only need a single number.
 */
const pendingBySession = computed<Record<string, { approvals: number; questions: number }>>(() => {
  const out: Record<string, { approvals: number; questions: number }> = {};
  for (const [sid, list] of Object.entries(rawState.approvalsBySession)) {
    if (list.length > 0) (out[sid] ??= { approvals: 0, questions: 0 }).approvals = list.length;
  }
  for (const [sid, list] of Object.entries(rawState.questionsBySession)) {
    if (list.length > 0) (out[sid] ??= { approvals: 0, questions: 0 }).questions = list.length;
  }
  return out;
});

/** Per-session unread flag (a background turn finished, not yet opened). */
const unreadBySession = computed<Record<string, boolean>>(() => {
  const out: Record<string, boolean> = {};
  for (const [sid, unread] of Object.entries(rawState.unreadBySession)) {
    if (unread) out[sid] = true;
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

/** Installed external apps the "Open in app" menu may offer for this host. */
const availableOpenInApps = computed<string[]>(() => rawState.availableOpenInApps);

// ---------------------------------------------------------------------------
// Per-session turn-end cleanup + queue auto-flush.
// Driven by the daemon's sessionStatusChanged → idle event (wired in
// connectEventsIfNeeded), NOT by the active-session `activity` computed: a
// watcher on `activity` only ever saw the ACTIVE session, so a session that
// finished in the background kept its in-flight flag forever — every later
// prompt to it was silently enqueued and never flushed.
// ---------------------------------------------------------------------------

const workspaceState = useWorkspaceState(rawState, {
  taskPoller,
  sideChat,
  modelProvider,
  pushOperationFailure,
  activity,
  inFlightPromptSessions,
  sessionsKnownEmpty,
  setSessions,
  updateSession,
  upsertSessionFront,
  appendSession,
  forgetSession,
  setActiveSessionId,
  updateSessionMessages,
  nextOptimisticMsgId,
  getEventConn: () => eventConn,
  syncSessionFromSnapshot,
  subscribeToSessionEvents,
  hasLoadedMessages,
  refreshSessionStatus,
  persistSessionProfile,
  mergedWorkspaces,
  status,
  workspaceIdForSession,
  savePermissionToStorage,
  savePlanModeToStorage,
  saveSwarmModeToStorage,
  saveGoalModeToStorage,
  saveUnread,
  saveActiveWorkspaceToStorage,
  saveHiddenWorkspacesToStorage,
  goalErrorMessage,
  basename,
  resetFastMoon: appearance.resetFastMoon,
  initialized,
  selectedDiffPath,
  fileDiffLines,
  fileDiffLoading,
});

function onSessionIdle(sid: string, status: 'idle' | 'aborted'): void {
  // The turn finished — this session no longer has a prompt in flight.
  inFlightPromptSessions.delete(sid);
  rawState.sendingBySession = { ...rawState.sendingBySession, [sid]: false };
  // Drop any cached prompt_id so a later skill activation (which has no
  // prompt_id) doesn't accidentally reuse this stale id for :abort.
  if (rawState.promptIdBySession[sid] !== undefined) {
    const next = { ...rawState.promptIdBySession };
    delete next[sid];
    rawState.promptIdBySession = next;
  }

  // For the session on screen, refresh git status (edits the agent just made)
  // and runtime status (model/context usage may have changed this turn).
  if (sid === rawState.activeSessionId) {
    appearance.resetFastMoon();
    void workspaceState.loadGitStatus(sid);
    void refreshSessionStatus(sid);
  } else if (status === 'idle') {
    // A background session finished a turn the user hasn't seen — light up its
    // unread dot until they open it. Aborted (cancelled/failed) turns are
    // excluded on purpose: there is no fresh result to read, and counting them
    // is what made the sidebar fill with stale unreads after a refresh.
    rawState.unreadBySession = { ...rawState.unreadBySession, [sid]: true };
    saveUnread({ [sid]: true });
  }

  // Browser notification when the user isn't watching this session.
  notification.maybeNotifyCompletion(sid, {
    isActiveAndVisible:
      sid === rawState.activeSessionId &&
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible',
    sessionTitle: rawState.sessions.find((s) => s.id === sid)?.title ?? '',
    onClick: () => {
      void workspaceState.selectSession(sid);
    },
  });

  const queue = rawState.queuedBySession[sid] ?? [];
  if (queue.length === 0) return;

  const [next, ...rest] = queue;
  rawState.queuedBySession = { ...rawState.queuedBySession, [sid]: rest };
  // Flush the first queued message; on failure put it back at the head so a
  // transient error doesn't silently drop the prompt.
  if (next !== undefined) {
    void workspaceState.submitPromptInternal(sid, next.text, next.attachments).then((ok) => {
      if (!ok) {
        const current = rawState.queuedBySession[sid] ?? [];
        rawState.queuedBySession = {
          ...rawState.queuedBySession,
          [sid]: [next, ...current],
        };
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Composable return
// ---------------------------------------------------------------------------

export function useKimiWebClient() {
  ensureSessionTimeClock();

  return {
    // Reactive state / computed view props
    workspace,
    sessions,
    activeSessionId,

    // Workspace view props
    workspacesView,
    visibleWorkspace,
    activeWorkspaceId,
    sessionsForView,
    workspaceGroups,
    attentionBySession,
    pendingBySession,
    attentionByWorkspace,
    unreadBySession,
    recentRoots,

    turns,
    tasks,
    todos,
    goal,
    swarms,
    activationBadges,
    compaction,
    status,
    sessionCost,
    fileDiff,
    selectedDiffPath,
    fileDiffLoading,
    changes,
    gitInfo,
    gitDiffStats,
    activePullRequest,
    changesByPath,
    pendingApprovals,
    recentCwds,
    availableOpenInApps,

    // New Phase 1 computed
    connection,
    loading,
    sessionLoading,
    loadingMoreMessages,
    hasMoreMessages,
    loadMoreMessagesError,
    serverVersion,
    initialized,
    permission,
    thinking,
    planMode,
    swarmMode,
    goalMode,
    queued,
    warnings,
    questions,
    activity,
    isSending,
    fastMoon: appearance.fastMoon,

    // Model + Provider reactive state
    models: modelProvider.models,
    starredModelIds: modelProvider.starredModelIds,
    providers: modelProvider.providers,

    // Theme
    theme: appearance.theme,
    setTheme: appearance.setTheme,
    toggleTheme: appearance.toggleTheme,
    uiFontSize: appearance.uiFontSize,
    setUiFontSize: appearance.setUiFontSize,

    // Beta features
    betaToc,
    setBetaToc,

    // Color scheme
    colorScheme: appearance.colorScheme,
    setColorScheme: appearance.setColorScheme,

    accent: appearance.accent,
    setAccent: appearance.setAccent,
    notifyOnComplete: notification.notifyOnComplete,
    notifyPermission: notification.notifyPermission,
    setNotifyOnComplete: notification.setNotifyOnComplete,
    onboarded,
    setOnboarded,

    // Actions
    load: workspaceState.load,
    selectSession: workspaceState.selectSession,
    createSession: workspaceState.createSession,
    loadOlderMessages: workspaceState.loadOlderMessages,

    // Workspace actions
    loadWorkspaces: workspaceState.loadWorkspaces,
    selectWorkspace: workspaceState.selectWorkspace,
    openWorkspace: workspaceState.openWorkspace,
    openWorkspaceDraft: workspaceState.openWorkspaceDraft,
    createSessionInWorkspace: workspaceState.createSessionInWorkspace,
    startSessionAndSendPrompt: workspaceState.startSessionAndSendPrompt,
    addWorkspaceByPath: workspaceState.addWorkspaceByPath,
    browseFs: workspaceState.browseFs,
    getFsHome: workspaceState.getFsHome,

    sendPrompt: workspaceState.sendPrompt,
    steerPrompt: workspaceState.steerPrompt,
    // Side chat (BTW side-channel agent)
    sideChatVisible: sideChat.sideChatVisible,
    sideChatSessionId: sideChat.sideChatSessionId,
    sideChatTurns: sideChat.sideChatTurns,
    sideChatRunning: sideChat.sideChatRunning,
    sideChatSending: sideChat.sideChatSending,
    openSideChat: sideChat.openSideChat,
    closeSideChat: sideChat.closeSideChat,
    sendSideChatPrompt: sideChat.sendSideChatPrompt,
    uploadImage: workspaceState.uploadImage,
    abortCurrentPrompt: workspaceState.abortCurrentPrompt,
    respondApproval: workspaceState.respondApproval,
    respondQuestion: workspaceState.respondQuestion,
    dismissQuestion: workspaceState.dismissQuestion,
    cancelTask: workspaceState.cancelTask,

    // New Phase 1 actions
    setPermission: workspaceState.setPermission,
    setThinking: modelProvider.setThinking,
    setPlanMode: workspaceState.setPlanMode,
    togglePlanMode: workspaceState.togglePlanMode,
    setSwarmMode: workspaceState.setSwarmMode,
    toggleSwarmMode: workspaceState.toggleSwarmMode,
    setGoalMode: workspaceState.setGoalMode,
    toggleGoalMode: workspaceState.toggleGoalMode,
    createGoal: workspaceState.createGoal,
    controlGoal: workspaceState.controlGoal,
    enqueue: workspaceState.enqueue,
    dismissWarning: workspaceState.dismissWarning,
    renameSession: workspaceState.renameSession,
    renameWorkspace: workspaceState.renameWorkspace,
    deleteWorkspace: workspaceState.deleteWorkspace,
    archiveSession: workspaceState.archiveSession,
    compact: workspaceState.compact,
    forkSession: workspaceState.forkSession,
    undo: workspaceState.undo,

    // New Phase 4 actions
    unqueue: workspaceState.unqueue,
    searchFiles: workspaceState.searchFiles,
    loadGitStatus: workspaceState.loadGitStatus,
    loadFileDiff: workspaceState.loadFileDiff,
    clearFileDiff: workspaceState.clearFileDiff,

    // File system actions
    listDir: workspaceState.listDir,
    readFileContent: workspaceState.readFileContent,
    getFileDownloadUrl: workspaceState.getFileDownloadUrl,
    openWorkspaceFile: workspaceState.openWorkspaceFile,
    openInApp: workspaceState.openInApp,
    revealWorkspaceFile: workspaceState.revealWorkspaceFile,
    resolveImageUrl: workspaceState.resolveImageUrl,

    // Model + Provider actions
    refreshOAuthProviderModels: modelProvider.refreshOAuthProviderModels,
    loadModels: modelProvider.loadModels,
    loadProviders: modelProvider.loadProviders,
    skills,
    activateSkill: modelProvider.activateSkill,
    setModel: modelProvider.setModel,
    toggleStarModel: modelProvider.toggleStarModel,
    addProvider: modelProvider.addProvider,
    deleteProvider: modelProvider.deleteProvider,
    refreshProvider: modelProvider.refreshProvider,

    // Auth state
    authReady,
    defaultModel,
    managedProviderStatus,

    // Config state + actions
    config,
    updateConfig: workspaceState.updateConfig,

    // Auth actions
    checkAuth: workspaceState.checkAuth,
    startOAuthLogin: modelProvider.startOAuthLogin,
    pollOAuthLogin: modelProvider.pollOAuthLogin,
    cancelOAuthLogin: modelProvider.cancelOAuthLogin,
    logout: workspaceState.logout,
  };
}

// Re-export types used by wired components so they can import from one place
export type { ApprovalDecision, AppModel, AppProvider };
