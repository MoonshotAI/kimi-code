// apps/kimi-web/src/composables/useKimiWebClient.ts
// Vue state composable — the only place that imports both src/api/* and src/types.ts.
// Components consume computed view props and call actions; they never touch the API or reducer.

import { computed, reactive, ref, watch } from 'vue';
import { i18n } from '../i18n';
import { traceClientEvent } from '../debug/trace';
import { getKimiWebApi } from '../api';
import { isDaemonApiError, isDaemonNetworkError } from '../api/errors';
import {
  reconcileWorkspaceOrder,
  sortByWorkspaceOrder,
  sortWorkspacesByRecent,
  type WorkspaceSortMode,
} from '../lib/workspaceOrder';
import { mergeWorkspaces } from '../lib/mergeWorkspaces';
import { mergeSnapshotMessages } from '../lib/snapshotMessages';
import { mergeSnapshotSubagents } from '../lib/taskMerge';
import { createCoalescedAsyncRunner } from '../lib/snapshotSync';
import {
  loadUnread,
  loadWorkspaceOrder,
  loadWorkspaceSort,
  safeGetString,
  safeRemove,
  safeSetString,
  saveUnread,
  saveWorkspaceOrder,
  saveWorkspaceSort,
  STORAGE_KEYS,
} from '../lib/storage';
import { createEventBatcher, isRenderEvent } from './client/eventBatcher';
import { useAppearance } from './client/useAppearance';
import { useNotification, shouldNotifyCompletion } from './client/useNotification';
import { useSoundNotification } from './client/useSoundNotification';
import { useTaskPoller } from './client/useTaskPoller';
import { useModelProviderState } from './client/useModelProviderState';
import { useSideChat } from './client/useSideChat';
import {
  forgetLocalTurnState,
  SESSIONS_INITIAL_PAGE_SIZE,
  useWorkspaceState,
} from './client/useWorkspaceState';

const appearance = useAppearance();
const notification = useNotification();
const sound = useSoundNotification();
import type {
  AppEvent,
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
import { isPlaceholderSessionUsage, toAppEvent } from '../api/daemon/mappers';

import { messagesToTurns } from './messagesToTurns';
import { latestTodos } from './latestTodos';
import { buildSwarmGroups, countSwarmMembers, swarmMembersByToolCall } from './swarmGroups';
import type { SwarmGroup, SwarmMember } from './swarmGroups';
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
// A persisted thinking level may be any non-empty effort string: the reserved
// 'off'/'on', or a model-declared level (e.g. 'low'/'high'/'max'). Since the
// set of legal levels comes from each model's support_efforts, we can't
// whitelist values — only guard against corrupted localStorage with a charset
// + length check. coerceThinkingForModel adapts the loaded value to the active
// model once the catalog is available.
const PERSISTED_THINKING_LEVEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

// Appearance types + logic live in ./client/useAppearance; re-exported here so
// existing `import type { ColorScheme, Accent } from './useKimiWebClient'`
// callers keep working.
export type { Accent, ColorScheme } from './client/useAppearance';

// The code-font setting was removed with its UI (b8a9e83). Clear the old
// persisted key so users who once picked a font aren't frozen on it forever.
safeRemove(STORAGE_KEYS.codeFont);
// The UI theme (terminal / modern / kimi) was retired in favor of a single
// look. Clear the old persisted key so users who once picked one aren't frozen
// on a value the UI no longer reads.
safeRemove(STORAGE_KEYS.theme);

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
    if (v && PERSISTED_THINKING_LEVEL_RE.test(v)) return v as ThinkingLevel;
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

// Plan / swarm / goal modes are per-session. Each is persisted as a compact
// JSON map of only the `true` entries (cleared sessions are dropped), keyed by
// session id — mirroring the unread map. The legacy global format (a bare
// 'true'/'false' string) is not an object and parses to an empty map, so it is
// discarded on first load rather than misapplied to every session.

function loadModeMapFromStorage(key: string): Record<string, boolean> {
  const raw = safeGetString(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true) out[id] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function saveModeMapToStorage(key: string, map: Record<string, boolean>): void {
  try {
    const out: Record<string, true> = {};
    for (const [id, value] of Object.entries(map)) {
      if (value) out[id] = true;
    }
    safeSetString(key, JSON.stringify(out));
  } catch {
    // storage unavailable (private mode, quota, etc.) — ignore
  }
}

function savePlanModeToStorage(): void {
  saveModeMapToStorage(PLAN_MODE_STORAGE_KEY, rawState.planModeBySession);
}

function saveSwarmModeToStorage(): void {
  saveModeMapToStorage(SWARM_MODE_STORAGE_KEY, rawState.swarmModeBySession);
}

function saveGoalModeToStorage(): void {
  saveModeMapToStorage(GOAL_MODE_STORAGE_KEY, rawState.goalModeBySession);
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
  /**
   * True when the connected server reports `dangerous_bypass_auth` in `/meta`,
   * meaning its bearer-token gate is disabled. The UI skips the server-token
   * prompt and connects without a credential.
   */
  dangerousBypassAuth: boolean;
  /**
   * Engine generation of the connected server: `'v2'` = kap-server /
   * agent-core-v2, `'v1'` = legacy @moonshot-ai/server. Read from `/meta`
   * (`backend` field; older servers omit it ⇒ v1). Drives the dev-mode
   * backend badge in the Sidebar.
   */
  backend: 'v1' | 'v2';
  workspaceName: string;
  connection: ConnectionState;
  permission: PermissionMode;
  thinking: ThinkingLevel;
  /** Plan-mode toggle per session. Bound to a session (not global) so toggling
   *  it in one session does not affect another. */
  planModeBySession: Record<string, boolean>;
  /** Swarm-mode toggle per session. */
  swarmModeBySession: Record<string, boolean>;
  /** Goal-mode (one-shot "next send creates a goal") toggle per session. */
  goalModeBySession: Record<string, boolean>;
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
  /** Whether the server has more sessions than currently loaded, per workspace. */
  sessionsHasMoreByWorkspace: Record<string, boolean>;
  /** True while the next page of sessions is being fetched for a workspace. */
  sessionsLoadingMoreByWorkspace: Record<string, boolean>;
  /** Paging cursor (`before_id`) for the next session page, per workspace. Tracks
   *  the end of the last fetched page so a deep-linked older session appended
   *  out of band does not shift the cursor and skip intervening sessions. */
  sessionsCursorByWorkspace: Record<string, string | undefined>;
  /** First-page capacity per workspace (sessions loaded on first paint, floored
   *  at one full page). Drives the sidebar's in-group show-less collapse target. */
  sessionsInitialCountByWorkspace: Record<string, number>;
  /** True once every session has been loaded (after a search-triggered full drain). */
  sessionsFullyLoaded: boolean;
}

const rawState: ExtendedState = reactive({
  ...createInitialState(),
  connected: false,
  serverVersion: '',
  dangerousBypassAuth: false,
  backend: 'v1',
  workspaceName: 'kimi-web',
  connection: 'disconnected' as ConnectionState,
  permission: loadPermissionFromStorage(),
  thinking: loadThinkingFromStorage(),
  planModeBySession: loadModeMapFromStorage(PLAN_MODE_STORAGE_KEY),
  swarmModeBySession: loadModeMapFromStorage(SWARM_MODE_STORAGE_KEY),
  goalModeBySession: loadModeMapFromStorage(GOAL_MODE_STORAGE_KEY),
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
  sessionsHasMoreByWorkspace: {},
  sessionsLoadingMoreByWorkspace: {},
  sessionsCursorByWorkspace: {},
  sessionsInitialCountByWorkspace: {},
  sessionsFullyLoaded: false,
});

// ---------------------------------------------------------------------------
// Draft mode staging (no active session yet).
// When the user toggles plan/swarm/goal in the empty composer before the first
// message is sent, there is no session to bind the toggle to. These staged
// values are transferred into the new session's per-session entry when the
// first prompt is sent (see startSessionAndSendPrompt), then cleared. Not
// persisted — the draft is ephemeral.
// ---------------------------------------------------------------------------
const draftModes = reactive<{ planMode: boolean; swarmMode: boolean; goalMode: boolean }>({
  planMode: false,
  swarmMode: false,
  goalMode: false,
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

/**
 * When the tab returns to the foreground, the WebSocket may be a silent
 * half-open: the browser still reports OPEN (so no auto-reconnect) yet no
 * frames have arrived for a while (frozen background tab, dropped NAT mapping,
 * daemon restart). On such a socket live streaming tokens freeze mid-turn with
 * no recovery short of a full page reload.
 *
 * If the socket looks stale, force a clean reconnect — the handshake
 * re-subscribes at the last durable cursor — then refresh the active session
 * from its authoritative snapshot to re-seed the volatile streaming tokens lost
 * during the gap.
 */
function recoverStaleConnection(): void {
  if (eventConn === null) return;
  if (!eventConn.health().stale) return;
  traceClientEvent('ws: stale socket on focus, reconnecting', {
    activeSessionId: rawState.activeSessionId,
  });
  eventConn.reconnect();
  const active = rawState.activeSessionId;
  if (active) snapshotSyncRunner.request(active);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      clearActiveUnread();
      recoverStaleConnection();
    }
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('focus', recoverStaleConnection);
  window.addEventListener('online', recoverStaleConnection);
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
  dropWsSubscription(sessionId);
  // Drain the streaming-event batcher too. unsubscribe() stops future server
  // frames, but events already queued for the next animation frame would
  // otherwise survive and be reduced AFTER the maps below are cleared —
  // recreating entries like messagesBySession[id] and lastSeqBySession[id].
  // That would make hasLoadedMessages() treat the stale empty cache as
  // authoritative and skip the next snapshot fetch for this id.
  enqueueEvent.flush();
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
  sessionsRequiringSnapshot.delete(sessionId);
  sessionsRetryingStaleSnapshot.delete(sessionId);
  sessionsKnownEmpty.delete(sessionId);
  // In-flight / queued prompt state: drop these too so a queued follow-up
  // can't be submitted to a session that was just archived when its turn later
  // goes idle (onSessionIdle drains queuedBySession[sid] without re-checking
  // that the session still exists).
  inFlightPromptSessions.delete(sessionId);
  forgetLocalTurnState(sessionId);
  delete rawState.queuedBySession[sessionId];
  delete rawState.promptIdBySession[sessionId];
  delete rawState.sendingBySession[sessionId];
  // Drop per-session mode toggles and re-persist so a deleted session's entry
  // doesn't linger in localStorage.
  delete rawState.planModeBySession[sessionId];
  delete rawState.swarmModeBySession[sessionId];
  delete rawState.goalModeBySession[sessionId];
  savePlanModeToStorage();
  saveSwarmModeToStorage();
  saveGoalModeToStorage();
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
// Short diagnostic shown on the connecting splash while the first-load /auth
// gate keeps retrying (e.g. the daemon's error message). Null when no attempt
// has failed yet or the last attempt got through.
const connectIssue = ref<string | null>(null);

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
  rawState.swarmModeBySession = { ...rawState.swarmModeBySession, [sessionId]: st.swarmMode };
  rawState.planModeBySession = { ...rawState.planModeBySession, [sessionId]: st.planMode };
}

/**
 * Fetch GET /sessions/{id}/goal and fold the result into goalBySession — the
 * recovery channel for the goal card after a full-page reload (the snapshot +
 * WS-replay path never carries the historical `goal.updated`, since its seq is
 * ≤ the snapshot watermark). Never throws — an old daemon without the /goal
 * endpoint keeps any live-event state.
 */
async function refreshSessionGoal(sessionId: string): Promise<void> {
  // A live `goal.updated` arriving during the request is newer than whatever
  // the server read when handling it — never let this recovery write override
  // such an event (it would resurrect a finished goal until the next reload).
  // Track the per-session goal event version, not the goal entry itself:
  // clear/complete events DELETE the entry, which would leave an
  // undefined === undefined comparison blind to exactly the race that matters.
  const versionBefore = rawState.goalVersionBySession[sessionId] ?? 0;
  let goal: AppGoal | null;
  try {
    goal = await getKimiWebApi().getSessionGoal(sessionId);
  } catch {
    return; // goal endpoint missing/unreachable — keep what we have.
  }
  if ((rawState.goalVersionBySession[sessionId] ?? 0) !== versionBefore) {
    return; // a live goal event won the race
  }
  // Mirror the reducer's goalUpdated branch: null (or a completed goal) clears
  // the card, anything else replaces it.
  const nextGoals = { ...rawState.goalBySession };
  if (goal === null || goal.status === 'complete') delete nextGoals[sessionId];
  else nextGoals[sessionId] = goal;
  rawState.goalBySession = nextGoals;
}

/** Persist runtime controls to a session via POST /profile, then re-read
 *  /status. `sessionId` overrides the active session — used when creating a
 *  session and immediately persisting its draft modes, so a concurrent session
 *  switch can't write the patch to the wrong session.
 *
 *  Returns the update promise (errors swallowed — the UI already updated
 *  optimistically). Most callers fire-and-forget via `void persistSessionProfile(...)`;
 *  call sites that must order strictly after the profile (e.g. a skill
 *  activation that can't carry its own modes) await it. */
function persistSessionProfile(patch: {
  model?: string;
  permissionMode?: string;
  planMode?: boolean;
  swarmMode?: boolean;
  goalObjective?: string;
  goalControl?: 'pause' | 'resume' | 'cancel';
  thinking?: string;
}, sessionId?: string): Promise<void> {
  const sid = sessionId ?? rawState.activeSessionId;
  if (!sid) return Promise.resolve();
  // Promise.resolve wrap: tolerate a sync/undefined return (e.g. test mocks).
  return Promise.resolve(getKimiWebApi().updateSession(sid, patch))
    .then(() => refreshSessionStatus(sid))
    .catch(() => {
      /* ignore — local state already reflects the change */
    });
}

// ---------------------------------------------------------------------------
// Conversation outline (TOC): proportional bubbles with a viewport indicator
// and hover tooltip. On by default; users can turn it off in Settings.
// Persisted per browser.
// ---------------------------------------------------------------------------
const CONVERSATION_TOC_STORAGE_KEY = STORAGE_KEYS.conversationToc;
function loadConversationTocFromStorage(): boolean {
  try {
    const raw = safeGetString(CONVERSATION_TOC_STORAGE_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}
function saveConversationTocToStorage(v: boolean): void {
  try {
    safeSetString(CONVERSATION_TOC_STORAGE_KEY, v ? 'true' : 'false');
  } catch {
    // ignore
  }
}
const conversationToc = ref<boolean>(loadConversationTocFromStorage());
function setConversationToc(v: boolean): void {
  conversationToc.value = v;
  saveConversationTocToStorage(v);
}

// ---------------------------------------------------------------------------
// Onboarding: a "has the user been onboarded" flag that gates the first-run
// onboarding screen (preference: language). Persisted; can be reset to re-open
// the screen from the settings popover.
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
    planReviewByToolCallId: rawState.planReviewByToolCallId,
    questionsBySession: rawState.questionsBySession,
    tasksBySession: rawState.tasksBySession,
    goalBySession: rawState.goalBySession,
    goalVersionBySession: rawState.goalVersionBySession,
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
  rawState.planReviewByToolCallId = next.planReviewByToolCallId;
  rawState.questionsBySession = next.questionsBySession;
  rawState.tasksBySession = next.tasksBySession;
  rawState.goalBySession = next.goalBySession;
  rawState.goalVersionBySession = next.goalVersionBySession;
  rawState.lastSeqBySession = next.lastSeqBySession;
  rawState.compactionBySession = next.compactionBySession;
  rawState.config = next.config ?? null;
  rawState.warnings = next.warnings;

  if (event.type === 'configChanged') {
    rawState.defaultModel = event.config.defaultModel ?? null;
  }

  if (event.type === 'modelCatalogChanged') {
    void modelProvider.loadModels();
    void modelProvider.loadProviders();
  }

  // Reflect the agent's live plan/swarm state per session (e.g. it auto-entered
  // plan mode). Applied to the event's own session — not gated on the active
  // session — so a background session keeps its own independent toggle state.
  if (event.type === 'sessionUsageUpdated') {
    if (event.swarmMode !== undefined) {
      rawState.swarmModeBySession = { ...rawState.swarmModeBySession, [event.sessionId]: event.swarmMode };
    }
    if (event.planMode !== undefined) {
      rawState.planModeBySession = { ...rawState.planModeBySession, [event.sessionId]: event.planMode };
    }
  }
}

// ---------------------------------------------------------------------------
// Streaming event batching
// ---------------------------------------------------------------------------
//
// High-frequency "append a chunk" events (assistant/agent deltas, tool/task
// output) can arrive dozens to hundreds of times per second. Applying each one
// synchronously triggers a full Vue re-render per event, which saturates the
// main thread and makes the stream look janky (see messagesToTurns / Markdown).
//
// We coalesce those render-only events onto the next animation frame so Vue
// commits a single render per frame. Lifecycle / control-flow events
// (sessionStatusChanged, messageCreated, approval*, question*, ...) are applied
// immediately: they are infrequent, and some (e.g. sessionStatusChanged idle)
// drive turn-end cleanup that must not be delayed by a throttled rAF in a
// background tab. Ordering is preserved by draining any pending render events
// before applying an immediate event.

type PendingEvent = { appEvent: AppEvent; meta: { sessionId: string; seq: number } };

function processEvent(appEvent: AppEvent, meta: { sessionId: string; seq: number }): void {
  // Capture BEFORE applyEvent advances lastSeqBySession: turn-end side
  // effects below only run when this event actually moves the durable cursor
  // forward. A late duplicate idle (e.g. replayed after a snapshot already
  // advanced past it) must not drain a second queued message.
  const prevSeq = rawState.lastSeqBySession[meta.sessionId] ?? 0;
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
  // Gated on the durable cursor advancing: a late duplicate of an idle we
  // already consumed (directly or via a snapshot past it) must not run the
  // side effects again — above all, it must not drain another queued message.
  if (
    appEvent.type === 'sessionStatusChanged' &&
    (appEvent.status === 'idle' || appEvent.status === 'aborted') &&
    meta.seq > prevSeq
  ) {
    onSessionIdle(appEvent.sessionId, appEvent.status);
  }

  // The agent asked a question and is waiting for an answer — surface it so
  // the user comes back. Hooked on the request event (fires once per new
  // question, and not for questions restored from a snapshot) rather than the
  // awaitingQuestion status flip, which can arrive in any order relative to it.
  if (appEvent.type === 'questionRequested') {
    onQuestionRequested(appEvent.sessionId, appEvent.question);
  }

  // The agent needs approval for a tool call — surface it so the user comes back.
  if (appEvent.type === 'approvalRequested') {
    onApprovalRequested(appEvent.sessionId, appEvent.approval);
  }
}

const enqueueEvent = createEventBatcher<PendingEvent>(
  ({ appEvent, meta }) => processEvent(appEvent, meta),
  ({ appEvent }) => isRenderEvent(appEvent),
);

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

      // Coalesce high-frequency render events onto the next animation frame;
      // everything else is applied immediately. See createEventBatcher /
      // processEvent above.
      enqueueEvent({ appEvent, meta });
    },

    onResync(sessionId: string, currentSeq: number, epoch?: string) {
      // Flush streaming deltas already queued so they render on the
      // pre-snapshot state (the snapshot is authoritative and will overwrite
      // them). Stragglers that arrive during the snapshot fetch are drained
      // again right before the snapshot write inside syncSessionFromSnapshot,
      // so they are applied to the pre-snapshot array too rather than on top
      // of the fresh snapshot (which would duplicate text / tool output).
      enqueueEvent.flush();
      // The server-announced cursor is only a hint; keep the previous epoch
      // until the snapshot arrives so seq values from two epochs are never
      // compared with each other.
      void currentSeq;
      void epoch;
      sessionsRequiringSnapshot.add(sessionId);
      snapshotSyncRunner.request(sessionId);
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
      // The data channel is healthy again (server_hello received). Clear any
      // stale "Realtime connection error" toast instead of relying on its
      // auto-dismiss timer: iOS Safari freezes timers while a tab is
      // backgrounded, so the toast would otherwise linger until a manual
      // refresh even though the reconnect already succeeded.
      if (connected) {
        dismissWsError();
        // A (re)connect can mean the backend was restarted — or switched, when
        // the dev proxy was moved to the other engine. Re-read /meta so
        // serverVersion / backend never go stale.
        void workspaceState.refreshServerMeta();
      }
    },
  });
}

// Journal epoch per session, learned from snapshots / resync frames. Not
// reactive — only consulted when building the subscribe cursor.
const epochBySession: Record<string, string> = {};
// onResync resets the event projector, so that path must apply a snapshot even
// if a newer global event advances the local cursor while the GET is in flight.
const sessionsRequiringSnapshot = new Set<string>();
// A normal foreground refresh may race one newer event. Retry once with a
// fresh snapshot so volatile text missed during sleep is still restored.
const sessionsRetryingStaleSnapshot = new Set<string>();

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
    // A stack already starts with "Name: message" and carries the frames the
    // plain name/message would throw away, so prefer it when present.
    if (typeof value.stack === 'string' && value.stack) return value.stack;
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

function errorStack(err: unknown): string | undefined {
  return err instanceof Error && typeof err.stack === 'string' && err.stack ? err.stack : undefined;
}

function formatTimestamp(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function formatDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  return `${Math.round(ms)}ms`;
}

function errorDetails(operation: string, err: unknown, sessionId?: string): AppNoticeDetail[] {
  const network = isDaemonNetworkError(err);
  const api = isDaemonApiError(err);
  // Daemon errors carry the failure moment + round-trip time captured in the
  // HTTP layer; fall back to "now" for client-side errors that have neither.
  const timestamp = network || api ? err.timestamp : undefined;
  const durationMs = network || api ? err.durationMs : undefined;

  const details: Array<AppNoticeDetail | undefined> = [
    warningDetail('operation', operation),
    // Many call sites don't pass a session id; the active session is the best
    // guess and is what the user was looking at when the failure happened.
    warningDetail('sessionId', sessionId ?? rawState.activeSessionId),
    warningDetail('connection', rawState.connection),
    warningDetail('timestamp', formatTimestamp(timestamp ?? Date.now())),
  ];

  if (network) {
    details.push(
      warningDetail('duration', formatDuration(durationMs)),
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
  } else if (api) {
    details.push(
      warningDetail('duration', formatDuration(durationMs)),
      warningDetail('code', err.code),
      warningDetail('requestId', err.requestId),
      warningDetail('message', err.message),
      warningDetail('details', err.details),
    );
  } else {
    details.push(
      warningDetail('errorName', errorName(err)),
      warningDetail('message', errorMessage(err) ?? formatDetailValue(err)),
      warningDetail('stack', errorStack(err)),
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

// Drop every "Realtime connection error" notice pushed by the WS onError
// handler. Matched by severity + the localized wsTitle (the same i18n instance
// used to push it), so other errors are left untouched.
function dismissWsError(): void {
  const title = i18n.global.t('warnings.wsTitle');
  const next = rawState.warnings.filter(
    (w) => !(typeof w === 'object' && w !== null && w.severity === 'error' && w.title === title),
  );
  if (next.length !== rawState.warnings.length) {
    rawState.warnings = next;
  }
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

const sessionWarningsPulled = new Set<string>();

async function pullSessionWarnings(sessionId: string): Promise<void> {
  if (sessionWarningsPulled.has(sessionId)) return;
  sessionWarningsPulled.add(sessionId);
  try {
    const warnings = await getKimiWebApi().getSessionWarnings(sessionId);
    const label = i18n.global.t('warnings.noteLabel');
    for (const warning of warnings) {
      pushWarning(`${label}: ${warning.message}`);
    }
  } catch {
    // best-effort: never block session sync on warning retrieval.
  }
}

async function syncSessionFromSnapshot(sessionId: string): Promise<SyncSessionResult> {
  // A snapshot that races a local turn start must not overwrite that turn.
  const turnStartAtRequest = workspaceState.localTurnStartState(sessionId);
  try {
    const api = getKimiWebApi();
    const snap = await api.getSessionSnapshot(sessionId);
    if (!rawState.sessions.some((session) => session.id === sessionId)) return 'ok';

    // Drain any queued streaming deltas before the snapshot replaces
    // messagesBySession[sessionId]. The snapshot is authoritative (it already
    // contains everything up to asOfSeq); applying stale queued deltas on top
    // of it would duplicate text / tool output. Flushing here applies them to
    // the pre-snapshot array, which the snapshot then overwrites.
    enqueueEvent.flush();

    // Do not let an old snapshot overwrite state that moved forward while the
    // request was in flight. Retry once to recover volatile text at a fresh
    // cursor; resync/LRU rebuilds must always apply because their projector or
    // subscription was deliberately reset.
    const currentSeq = rawState.lastSeqBySession[sessionId] ?? 0;
    const knownEpoch = epochBySession[sessionId];
    const mustApplySnapshot =
      sessionsRequiringSnapshot.has(sessionId) || sessionsWithStaleCursor.has(sessionId);
    if (
      !mustApplySnapshot &&
      knownEpoch !== undefined &&
      knownEpoch === snap.epoch &&
      currentSeq > snap.asOfSeq
    ) {
      if (sessionsRetryingStaleSnapshot.delete(sessionId)) return 'ok';
      sessionsRetryingStaleSnapshot.add(sessionId);
      snapshotSyncRunner.request(sessionId);
      return 'ok';
    }
    if (!workspaceState.isLocalTurnSnapshotCurrent(sessionId, turnStartAtRequest)) {
      workspaceState.afterLocalTurnStartsSettle(sessionId, () => {
        snapshotSyncRunner.request(sessionId);
      });
      return 'ok';
    }

    const snapUsagePlaceholder = isPlaceholderSessionUsage(snap.session.usage);
    updateSession(sessionId, (s) => ({
      ...snap.session,
      model:
        snap.session.model && snap.session.model.length > 0
          ? snap.session.model
          : s.model,
      // The wire session's usage is a placeholder (both engines return zeros
      // for the heavy fields); keep the live usage folded in from /status and
      // the WS status stream instead of zeroing it on every snapshot sync.
      usage: snapUsagePlaceholder ? s.usage : snap.session.usage,
    }));
    // The snapshot only carries the most recent page; keep any older pages the
    // user already loaded so reopening does not reset scrollback.
    setSessionMessages(
      sessionId,
      mergeSnapshotMessages(rawState.messagesBySession[sessionId] ?? [], snap.messages),
    );
    // Seed the live subagent roster so swarm cards survive a page refresh
    // (their member rows otherwise only exist from non-replayed WS events).
    // loadTasksForSession's keepLiveSubagents preserves these across REST
    // reloads; the roster stays authoritative until then.
    rawState.tasksBySession = {
      ...rawState.tasksBySession,
      [sessionId]: mergeSnapshotSubagents(
        snap.subagents,
        rawState.tasksBySession[sessionId] ?? [],
      ),
    };
    rawState.messagesHasMoreBySession = {
      ...rawState.messagesHasMoreBySession,
      [sessionId]: snap.hasMoreMessages,
    };
    rawState.approvalsBySession = {
      ...rawState.approvalsBySession,
      [sessionId]: snap.pendingApprovals,
    };
    // Preserve plan_review paths from the snapshot so the ExitPlanMode tool
    // card can link to the plan file even after a reload.
    for (const a of snap.pendingApprovals) {
      const display = a.display as { kind?: unknown; plan?: unknown; path?: unknown } | null | undefined;
      if (display?.kind === 'plan_review' && typeof display.plan === 'string' && display.plan.length > 0) {
        rawState.planReviewByToolCallId = {
          ...rawState.planReviewByToolCallId,
          [a.toolCallId]: {
            plan: display.plan,
            path: typeof display.path === 'string' ? display.path : undefined,
          },
        };
      }
    }
    rawState.questionsBySession = {
      ...rawState.questionsBySession,
      [sessionId]: snap.pendingQuestions,
    };
    rawState.lastSeqBySession = {
      ...rawState.lastSeqBySession,
      [sessionId]: snap.asOfSeq,
    };
    epochBySession[sessionId] = snap.epoch;
    sessionsRequiringSnapshot.delete(sessionId);
    sessionsRetryingStaleSnapshot.delete(sessionId);

    // Resync replaces the missed event stream, so a terminal snapshot must
    // also clear the local sending flag that normally ends on a WS idle event.
    workspaceState.handleSessionSnapshot(
      sessionId,
      { inFlightTurn: snap.inFlightTurn, status: snap.session.status },
    );

    connectEventsIfNeeded();
    if (eventConn) {
      // Seed BEFORE subscribing: the in-flight assistant message must exist
      // before live deltas (aligned by wire offset) start appending to it.
      eventConn.seedSnapshot(sessionId, snap);
      eventConn.subscribe(sessionId, { seq: snap.asOfSeq, epoch: snap.epoch });
      retainWsSubscription(sessionId);
    }
    sessionsWithStaleCursor.delete(sessionId);
    // The snapshot carries placeholder usage, so a preserved cached value may
    // itself be stale — resync / stale-socket recovery reach here without
    // selectSession's sidecar refresh, and the volatile status frames that
    // would update it were exactly what the resync replaced. Re-read /status
    // so the ring converges on the live value.
    if (snapUsagePlaceholder) void refreshSessionStatus(sessionId);
    void pullSessionWarnings(sessionId);
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

const snapshotSyncRunner = createCoalescedAsyncRunner(syncSessionFromSnapshot);

function hasLoadedMessages(sessionId: string): boolean {
  return Object.prototype.hasOwnProperty.call(rawState.messagesBySession, sessionId);
}

// ---------------------------------------------------------------------------
// WS subscription cap (LRU eviction)
// ---------------------------------------------------------------------------
//
// Every opened session subscribes to its WS event stream, and the socket keeps
// subscriptions across reconnects (re-sending them in `client_hello`). Without
// a cap, a user who has opened hundreds of sessions stays subscribed to all of
// them: every background session's status/meta/usage event then flows through
// the reducer and dirties the sidebar computeds — the root cause of "the UI
// gets sluggish once I have a lot of sessions".
//
// Keep only the most-recently-opened sessions subscribed (MRU order, index 0 =
// newest). The active session is always retained.
//
// Eviction drops the live WS subscription but keeps the session's cursor so a
// quick re-open can resume cheaply. However, a cursor kept across an eviction
// can go stale: some session events (`event.session.status_changed`,
// `session.meta.updated`, ...) are broadcast to EVERY connection (see
// `isGlobalSessionEvent` on the server) and still advance `lastSeqBySession`
// for an unsubscribed session. If a session emits per-session durable events
// while evicted and then a global event, the cursor jumps past the missed
// events. Evicted sessions are therefore tracked in `sessionsWithStaleCursor`;
// when one is re-opened we rebuild from a snapshot (see `reopenSession`) rather
// than resume from a cursor that may have skipped events.
const MAX_WS_SUBSCRIPTIONS = 4;
const wsSubscriptionOrder: string[] = [];
const sessionsWithStaleCursor = new Set<string>();

function retainWsSubscription(sessionId: string): void {
  const idx = wsSubscriptionOrder.indexOf(sessionId);
  if (idx !== -1) wsSubscriptionOrder.splice(idx, 1);
  wsSubscriptionOrder.unshift(sessionId);
  // Evict the oldest entries past the cap, skipping the active session. The
  // active session is NOT guaranteed to sit at the front: first-time opens only
  // retain after an awaited snapshot, so rapid clicks can complete out of order
  // and leave the active session at the tail. Skipping it (rather than breaking
  // when the tail is active) keeps the cap effective.
  while (wsSubscriptionOrder.length > MAX_WS_SUBSCRIPTIONS) {
    let victimIdx = -1;
    for (let i = wsSubscriptionOrder.length - 1; i >= 0; i--) {
      if (wsSubscriptionOrder[i] !== rawState.activeSessionId) {
        victimIdx = i;
        break;
      }
    }
    if (victimIdx === -1) break;
    const [victim] = wsSubscriptionOrder.splice(victimIdx, 1);
    if (victim === undefined) break;
    eventConn?.unsubscribe(victim);
    sessionsWithStaleCursor.add(victim);
  }
}

function dropWsSubscription(sessionId: string): void {
  const idx = wsSubscriptionOrder.indexOf(sessionId);
  if (idx !== -1) wsSubscriptionOrder.splice(idx, 1);
  sessionsWithStaleCursor.delete(sessionId);
}

/** Re-open an already-loaded session: always rebuild from a fresh snapshot.
 *
 *  Volatile `assistant.delta` frames are never journaled or replayed: if a
 *  transport hiccup covered the tail of a turn while the user was away, the
 *  local transcript silently lost the model's final text, and a cursor
 *  resubscribe has nothing to recover it with. Always fetching the authoritative
 *  snapshot keeps the logic trivially correct (no freshness heuristics, no
 *  races to reason about); the snapshot is cheap server-side (LRU on the wire
 *  file). Trade-off: a snapshot GET in flight during a steep local send can
 *  momentarily overwrite that optimistic message — the user notices immediately
 *  and the next re-open (or a refresh) reconciles. */
async function reopenSession(sessionId: string): Promise<SyncSessionResult> {
  return syncSessionFromSnapshot(sessionId);
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
function isSessionEffectivelyRunning(session: AppSession | undefined): boolean {
  if (!session) return false;
  if (session.status !== 'running') return false;
  const sessionId = session.id;
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
    const diffD = diffMs / 86400000;
    if (diffD < 7) return `${Math.round(diffD)}d`;
    if (diffD < 30) return `${Math.round(diffD / 7)}w`;
    if (diffD < 365) return `${Math.round(diffD / 30)}mo`;
    return `${Math.round(diffD / 365)}y`;
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

  // plan_review — finalised plan presented at plan-mode exit
  if (kind === 'plan_review') {
    const plan = typeof d.plan === 'string' ? d.plan : '';
    const path = typeof d.path === 'string' ? d.path : undefined;
    const rawOptions = Array.isArray(d.options) ? d.options : [];
    const options = rawOptions
      .map((item: unknown): { label: string; description?: string } | null => {
        const it = (item ?? {}) as Record<string, unknown>;
        const label = typeof it.label === 'string' ? it.label : '';
        if (!label) return null;
        const description = typeof it.description === 'string' ? it.description : undefined;
        return { label, description };
      })
      .filter((o): o is { label: string; description?: string } => o !== null);
    return { kind: 'plan_review', plan, path, options: options.length > 0 ? options : undefined };
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
    runInBackground: task.runInBackground,
    parentToolCallId: task.parentToolCallId,
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
      busy: isSessionEffectivelyRunning(s),
    }));
});

const activeSessionId = computed<string>(() => rawState.activeSessionId ?? '');

/** Slash-invocable skills for the composer `/` menu — the active session's skills,
 *  or, before a session exists, the active workspace's skills. */
const skills = computed<AppSkill[]>(() => {
  const sid = rawState.activeSessionId;
  if (sid) return modelProvider.skillsBySession.value[sid] ?? [];
  const wid = activeWorkspaceId.value;
  return wid ? (modelProvider.skillsByWorkspace.value[wid] ?? []) : [];
});

const isSending = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return false;
  return rawState.sendingBySession[sid] ?? false;
});

// True while the empty-composer first prompt for the active workspace is being
// created + submitted (before the session id exists). Drives the empty-session
// "starting conversation…" loading state in ConversationPane / Composer.
const isStartingFirstPrompt = computed<boolean>(() => workspaceState.isStartingFirstPrompt());

const sideChat = useSideChat(rawState, {
  pushOperationFailure,
  nextOptimisticMsgId,
  connectEventsIfNeeded,
  getEventConn: () => eventConn,
  models: () => modelProvider.models.value,
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
    rawState.planReviewByToolCallId,
  );
});

const tasks = computed<TaskItem[]>(() => {
  // Touch the clock so a running task's elapsed time recomputes each tick.
  void taskPoller.taskClock.value;
  return activeAppTasks.value.map(toUiTask);
});

const swarms = computed<SwarmGroup[]>(() => buildSwarmGroups(activeAppTasks.value));
// Foreground/background subagents keyed by their spawning tool call id — used by
// the inline AgentSwarm tool card to stream each subagent's live progress.
const swarmMembersByToolCallId = computed<Map<string, SwarmMember[]>>(() =>
  swarmMembersByToolCall(activeAppTasks.value),
);

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
const backend = computed<'v1' | 'v2'>(() => rawState.backend);
const dangerousBypassAuth = computed<boolean>(() => rawState.dangerousBypassAuth);

/**
 * Drop the cached `dangerous_bypass_auth` value read from `/meta`. Called when
 * the server demands authentication (HTTP 401) so a stale "bypass" value from
 * a previous server mode does not keep hiding the token prompt after the same
 * origin is restarted without `--dangerous-bypass-auth`.
 */
function clearDangerousBypassAuth(): void {
  rawState.dangerousBypassAuth = false;
}

const permission = computed<PermissionMode>(() => rawState.permission);
const thinking = computed<ThinkingLevel>(() => rawState.thinking);
// Mode toggles reflect the ACTIVE session (or the draft when no session is
// open). Each session keeps its own value in the *BySession maps above.
const planMode = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? (rawState.planModeBySession[sid] ?? false) : draftModes.planMode;
});
const swarmMode = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? (rawState.swarmModeBySession[sid] ?? false) : draftModes.swarmMode;
});
const goalMode = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? (rawState.goalModeBySession[sid] ?? false) : draftModes.goalMode;
});

const activationBadges = computed<ActivationBadges>(() => {
  const swarmCounts = countSwarmMembers(swarms.value);
  return {
    plan: planMode.value,
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

/** Queued messages for the active session, rendered inline at the tail of the
    transcript. Carries attachment thumbnails (resolved via getFileUrl) so image
    prompts don't render as empty bubbles. */
const queued = computed<QueuedPromptView[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const api = getKimiWebApi();
  return (rawState.queuedBySession[sid] ?? []).map((q) => ({
    text: q.text,
    attachmentCount: q.attachments?.length ?? 0,
    attachments: q.attachments?.map((a) => ({
      fileId: a.fileId,
      kind: a.kind,
      url: api.getFileUrl(a.fileId),
    })),
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

  const activeSession = rawState.sessions.find((s) => s.id === sid);
  if (isSessionEffectivelyRunning(activeSession)) {
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
  // Prefer the exact id — model names can collide across providers, so a
  // name-only match may resolve to the wrong provider's entry.
  const matched =
    modelProvider.models.value.find((m) => m.id === rawModel) ??
    modelProvider.models.value.find((m) => m.model === rawModel);
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
const mergedWorkspaces = computed<AppWorkspace[]>(() =>
  mergeWorkspaces({
    workspaces: rawState.workspaces,
    sessions: rawState.sessions,
    hiddenWorkspaceRoots: rawState.hiddenWorkspaceRoots,
    activeRoot: rawState.sessions.find((s) => s.id === rawState.activeSessionId)?.cwd,
    activeBranch: gitInfo.value?.branch ?? null,
    sessionsHasMoreByWorkspace: rawState.sessionsHasMoreByWorkspace,
  }),
);

/**
 * User-defined display order of workspace ids, persisted to localStorage. The
 * sidebar stops following the daemon's recency-based order: once a workspace is
 * known, its position is fixed until the user drags it elsewhere.
 */
const workspaceOrder = ref<string[]>(loadWorkspaceOrder());

/**
 * Sidebar workspace sort mode. `recent` (default) re-sorts by each workspace's
 * most recent session activity and stays live as sessions update; `manual` keeps
 * the persisted/dragged order. Persisted so the choice survives a refresh.
 */
const workspaceSortMode = ref<WorkspaceSortMode>(
  loadWorkspaceSort() === 'manual' ? 'manual' : 'recent',
);

// Reconcile the persisted order with the set of currently-known workspaces:
// drop ids that no longer exist, and prepend newly-seen ids (newest first,
// matching "createdAt desc" — the closest signal we have without a real
// workspace creation timestamp). Watched on the id *set* (joined) so a pure
// daemon reorder of the same workspaces does not rewrite the user's order, and
// a drag reorder (which also writes `workspaceOrder` but keeps the same id set)
// does not re-trigger it.
//
// The watch also tracks `loading` and bails out while a load is in progress.
// During `load()`, sessions (and thus derived workspaces) are set *before* the
// real workspaces arrive, so a real workspace with no sessions is momentarily
// absent from `mergedWorkspaces`. Without the loading guard the reconciler would
// drop it as "deleted" and then, when it appears a tick later, re-add it at the
// top — undoing the user's drag on refresh. Waiting until the load settles
// means we always reconcile against the complete set.
watch(
  () => [mergedWorkspaces.value.map((w) => w.id).join('\0'), rawState.loading] as const,
  ([idsKey, loading]) => {
    if (loading) return;
    const current = idsKey ? idsKey.split('\0') : [];
    const next = reconcileWorkspaceOrder(current, workspaceOrder.value);
    if (next === null) return;
    workspaceOrder.value = next;
    saveWorkspaceOrder(next);
  },
);

/** Sidebar-facing workspace list. Order follows `workspaceSortMode`: the
 *  persisted/dragged order in `manual` mode, or most-recent-session-first in
 *  `recent` mode. The recent map is only built (and `rawState.sessions` only
 *  read) in the recent branch, so manual mode does not re-sort on every session
 *  update. */
const workspacesView = computed<WorkspaceView[]>(() => {
  const views = mergedWorkspaces.value.map((w) => ({
    id: w.id,
    name: w.name,
    root: w.root,
    shortPath: shortenHome(w.root, rawState.fsHome),
    branch: w.branch,
    sessionCount: w.sessionCount,
  }));
  if (workspaceSortMode.value === 'recent') {
    const lastEditedAt = new Map<string, number>();
    for (const s of rawState.sessions) {
      if (s.parentSessionId) continue;
      const wid = workspaceIdForSession(s);
      const t = new Date(s.updatedAt).getTime();
      if (t > (lastEditedAt.get(wid) ?? Number.NEGATIVE_INFINITY)) {
        lastEditedAt.set(wid, t);
      }
    }
    return sortWorkspacesByRecent(views, lastEditedAt);
  }
  return sortByWorkspaceOrder(views, workspaceOrder.value);
});

/** The active workspace id, falling back to the first available workspace. */
const activeWorkspaceId = computed<string | null>(() => {
  const id = rawState.activeWorkspaceId;
  // Use the reordered list (not the raw daemon order) so the default/fallback
  // workspace matches the first group the user actually sees in the sidebar.
  const list = workspacesView.value;
  if (id && list.some((w) => w.id === id)) return id;
  return list[0]?.id ?? null;
});

// Pre-warm workspace-scoped skills so the onboarding composer's `/` menu is
// populated before a session exists. Loaded once per workspace (guard mirrors
// the per-session guard in refreshSessionSidecars); session skills take over
// via refreshSessionSidecars once a session is created.
watch(
  activeWorkspaceId,
  (id) => {
    if (!id) return;
    if (!Object.prototype.hasOwnProperty.call(modelProvider.skillsByWorkspace.value, id)) {
      void modelProvider.loadSkillsForWorkspace(id);
    }
  },
  { immediate: true },
);

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
  // Join each session to its workspace name so the search dialog can show which
  // workspace a hit belongs to. Built once per recompute (O(n+m)) instead of a
  // per-session find.
  const nameByWorkspaceId = new Map(workspacesView.value.map((w) => [w.id, w.name]));
  // Child ("side chat") sessions never appear in the main list — they live in
  // the side-chat panel only. Sessions under a removed (hidden) workspace are
  // excluded too, so this flat list matches what the grouped sidebar renders
  // and sidebar search can't resurrect sessions from a removed workspace.
  return rawState.sessions
    .filter((s) => !s.parentSessionId && visibleWorkspaceIds.has(workspaceIdForSession(s)))
    .map((s) => {
      const workspaceId = workspaceIdForSession(s);
      return {
        id: s.id,
        title: s.title,
        time: formatTime(s.updatedAt, s.status),
        status: s.status,
        busy: isSessionEffectivelyRunning(s),
        lastPrompt: s.lastPrompt,
        workspaceId,
        workspaceName: nameByWorkspaceId.get(workspaceId),
      };
    });
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
      busy: isSessionEffectivelyRunning(s),
      updatedAt: s.updatedAt,
    };
    const list = byId.get(wid) ?? [];
    list.push(view);
    byId.set(wid, list);
  }
  return workspacesView.value.map((w) => ({
    workspace: w,
    sessions: byId.get(w.id) ?? [],
    hasMore: rawState.sessionsHasMoreByWorkspace[w.id] ?? false,
    loadingMore: rawState.sessionsLoadingMoreByWorkspace[w.id] ?? false,
    initialCount: rawState.sessionsInitialCountByWorkspace[w.id] ?? SESSIONS_INITIAL_PAGE_SIZE,
  }));
});

/**
 * Replace the workspace display order (e.g. after a drag reorder in the
 * sidebar) and persist it. The id set is unchanged, so the reconciliation
 * watcher above will not fire — only the sort in `workspacesView` reacts.
 */
function reorderWorkspaces(ids: string[]): void {
  workspaceOrder.value = ids;
  saveWorkspaceOrder(ids);
  // A drag is an explicit manual ordering, so drop out of `recent` mode — the
  // dragged order would otherwise be overwritten by the live recency sort.
  if (workspaceSortMode.value !== 'manual') {
    workspaceSortMode.value = 'manual';
    saveWorkspaceSort('manual');
  }
}

/** Switch the sidebar workspace sort mode and persist the choice. */
function setWorkspaceSortMode(mode: WorkspaceSortMode): void {
  if (workspaceSortMode.value === mode) return;
  workspaceSortMode.value = mode;
  saveWorkspaceSort(mode);
}

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
  reopenSession,
  hasLoadedMessages,
  refreshSessionStatus,
  refreshSessionGoal,
  persistSessionProfile,
  mergedWorkspaces,
  workspacesView,
  status,
  workspaceIdForSession,
  savePermissionToStorage,
  savePlanModeToStorage,
  saveSwarmModeToStorage,
  saveGoalModeToStorage,
  draftModes,
  saveUnread,
  saveActiveWorkspaceToStorage,
  saveHiddenWorkspacesToStorage,
  goalErrorMessage,
  resetFastMoon: appearance.resetFastMoon,
  initialized,
  connectIssue,
  selectedDiffPath,
  fileDiffLines,
  fileDiffLoading,
});

/** True when the user is actually watching this session: it is the active
    session, the page is visible, and the window has focus. Focus matters on
    top of visibility: a window that lost focus to another app often stays
    (partially) visible on screen, but the user is working elsewhere and would
    miss the moment without a notification. */
function isUserWatching(sid: string): boolean {
  return (
    sid === rawState.activeSessionId &&
    typeof document !== 'undefined' &&
    document.visibilityState === 'visible' &&
    document.hasFocus()
  );
}

function onSessionIdle(sid: string, status: 'idle' | 'aborted'): void {
  // Capture before finishPromptLocal drops it — it keys the completion
  // notification's dedup tag so each finished turn alerts once.
  const finishedPromptId = rawState.promptIdBySession[sid];
  // Shared finish cleanup: clears in-flight/sending/prompt-id and drains one
  // queued message. The notification/sound/unread side effects below stay
  // WS-event-only — the snapshot path (handleSessionSnapshot) must not cry
  // wolf when opening a historical session.
  workspaceState.finishPromptLocal(sid);

  // For the session on screen, refresh git status (edits the agent just made)
  // and runtime status (model/context usage may have changed this turn).
  if (sid === rawState.activeSessionId) {
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
  // Only real completions notify; aborted turns and turns that ended up
  // blocked on approval/question do not fire the generic "Turn finished" alert.
  const hasPendingApproval = (rawState.approvalsBySession[sid] ?? []).length > 0;
  const hasPendingQuestion = (rawState.questionsBySession[sid] ?? []).length > 0;
  if (shouldNotifyCompletion(status, hasPendingApproval, hasPendingQuestion)) {
    notification.maybeNotifyCompletion(sid, {
      isUserWatching: isUserWatching(sid),
      sessionTitle: rawState.sessions.find((s) => s.id === sid)?.title ?? '',
      promptId: finishedPromptId,
      onClick: () => {
        void workspaceState.selectSession(sid);
      },
    });
  }

  // Completion sound — only for real completions (aborted/cancelled turns stay
  // silent). Plays regardless of visibility so it also reaches a backgrounded tab.
  if (status === 'idle') {
    sound.maybePlayCompletionSound();
  }
}

function onQuestionRequested(sid: string, question: AppQuestionRequest): void {
  const first = question.questions[0];
  // Lead with the actionable question text; keep the short header as context
  // when both are present so the desktop notification actually says what is
  // being asked (e.g. "Storage: Which database?").
  const header = first?.header?.trim() ?? '';
  const questionText = first?.question?.trim() ?? '';
  const preview =
    header && questionText ? `${header}: ${questionText}` : questionText || header;

  // Browser notification when the user isn't watching this session.
  notification.maybeNotifyQuestion({
    isUserWatching: isUserWatching(sid),
    sessionTitle: rawState.sessions.find((s) => s.id === sid)?.title ?? '',
    questionPreview: preview,
    questionId: question.questionId,
    onClick: () => {
      void workspaceState.selectSession(sid);
    },
  });

  // Attention sound — plays regardless of visibility so it also reaches a
  // backgrounded tab (same as the completion sound).
  sound.maybePlayQuestionSound();
}

function onApprovalRequested(sid: string, approval: AppApprovalRequest): void {
  // Browser notification when the user isn't watching this session.
  notification.maybeNotifyApproval({
    isUserWatching: isUserWatching(sid),
    sessionTitle: rawState.sessions.find((s) => s.id === sid)?.title ?? '',
    toolName: approval.toolName,
    approvalId: approval.approvalId,
    onClick: () => {
      void workspaceState.selectSession(sid);
    },
  });

  // Attention sound — plays regardless of visibility so it also reaches a
  // backgrounded tab (same as the completion sound).
  sound.maybePlayApprovalSound();
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
    workspaceSortMode,
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
    /** Live `AppTask[]` for the active session — the subagent detail panel
     *  sources a subagent's streaming `outputLines` from here. */
    activeAppTasks,
    todos,
    goal,
    swarms,
    swarmMembersByToolCallId,
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
    availableOpenInApps,

    // New Phase 1 computed
    connection,
    loading,
    sessionLoading,
    loadingMoreMessages,
    hasMoreMessages,
    loadMoreMessagesError,
    serverVersion,
    backend,
    dangerousBypassAuth,
    clearDangerousBypassAuth,
    initialized,
    connectIssue,
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
    isStartingFirstPrompt,
    fastMoon: appearance.fastMoon,

    // Model + Provider reactive state
    models: modelProvider.models,
    starredModelIds: modelProvider.starredModelIds,
    providers: modelProvider.providers,

    uiFontSize: appearance.uiFontSize,
    setUiFontSize: appearance.setUiFontSize,

    // Conversation outline (TOC)
    conversationToc,
    setConversationToc,

    // Color scheme
    colorScheme: appearance.colorScheme,
    setColorScheme: appearance.setColorScheme,

    accent: appearance.accent,
    setAccent: appearance.setAccent,
    notifyOnComplete: notification.notifyOnComplete,
    notifyOnQuestion: notification.notifyOnQuestion,
    notifyOnApproval: notification.notifyOnApproval,
    notifyPermission: notification.notifyPermission,
    setNotifyOnComplete: notification.setNotifyOnComplete,
    setNotifyOnQuestion: notification.setNotifyOnQuestion,
    setNotifyOnApproval: notification.setNotifyOnApproval,
    soundOnComplete: sound.soundOnComplete,
    setSoundOnComplete: sound.setSoundOnComplete,
    onboarded,
    setOnboarded,

    // Actions
    load: workspaceState.load,
    selectSession: workspaceState.selectSession,
    clearActiveSession: workspaceState.clearActiveSession,
    loadOlderMessages: workspaceState.loadOlderMessages,

    // Workspace actions
    loadWorkspaces: workspaceState.loadWorkspaces,
    loadMoreSessions: workspaceState.loadMoreSessions,
    loadAllSessions: workspaceState.loadAllSessions,
    selectWorkspace: workspaceState.selectWorkspace,
    openWorkspace: workspaceState.openWorkspace,
    openWorkspaceDraft: workspaceState.openWorkspaceDraft,
    startSessionAndSendPrompt: workspaceState.startSessionAndSendPrompt,
    startSessionAndActivateSkill: workspaceState.startSessionAndActivateSkill,
    startSessionAndOpenSideChat: workspaceState.startSessionAndOpenSideChat,
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
    pendingQuestionActions: workspaceState.pendingQuestionActions,
    pendingApprovalActions: workspaceState.pendingApprovalActions,
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
    reorderWorkspaces,
    setWorkspaceSortMode,
    archiveSession: workspaceState.archiveSession,
    restoreSession: workspaceState.restoreSession,
    loadArchivedSessions: workspaceState.loadArchivedSessions,
    compact: workspaceState.compact,
    forkSession: workspaceState.forkSession,
    undo: workspaceState.undo,

    // New Phase 4 actions
    unqueue: workspaceState.unqueue,
    reorderQueue: workspaceState.reorderQueue,
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
    refreshAllProviders: modelProvider.refreshAllProviders,

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
