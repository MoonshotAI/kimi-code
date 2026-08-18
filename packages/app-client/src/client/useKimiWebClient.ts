// Vue state composable — the shared client facade singleton. Components consume
// computed view props and call actions; they never touch the API or reducer.
// Platform differences arrive via ./deps injection (api / t / tracer / native
// terminal / telemetry), registered by each app's composition root.

import { computed, reactive, ref, watch } from 'vue';
import { formatDuration as formatTaskDuration } from '@moonshot-ai/app-core/lib';
import {
  getKimiWebApi,
  notifyPluginsShelfEvent,
  notifySessionDestroyed,
  notifyWorkspaceDestroyed,
  t,
  traceClientEvent,
  traceKeyEvent,
} from './deps';
import { isDaemonApiError, isDaemonNetworkError, isDaemonTimeoutError } from '@moonshot-ai/app-core/api';
import {
  buildWorkspaceRecencyKeys,
  currentActivityKeys,
  pruneRecencyFloor,
  reconcileRecencyFloor,
  reconcileWorkspaceOrder,
  sortByWorkspaceOrder,
  sortWorkspacesByRecent,
  type WorkspaceSortMode,
} from '@moonshot-ai/app-core/lib';
import { logError, logWarn } from '@moonshot-ai/app-core/lib';
import { track } from '../contracts';
import { mergeWorkspaces } from '@moonshot-ai/app-core/lib';
import { basename } from '@moonshot-ai/app-core/lib';
import { insertSessionByRecency, sessionDisplayStatus } from '@moonshot-ai/app-core/lib';
import { workspaceRootKey } from '@moonshot-ai/app-core/lib';
import { mergeSnapshotMessages } from '@moonshot-ai/app-core/lib';
import { mergeSnapshotSubagents } from '@moonshot-ai/app-core/lib';
import { createCoalescedAsyncRunner } from '@moonshot-ai/app-core/lib';
import { buildApprovalBlock } from '@moonshot-ai/app-core/client';
import { ackThinkingPending, foldDaemonThinkingLevel } from '@moonshot-ai/app-core/lib';
import {
  loadUnread,
  loadWorkspaceOrder,
  loadWorkspaceRecencyFloor,
  loadWorkspaceSort,
  safeGetString,
  safeRemove,
  safeSetString,
  saveUnread,
  saveWorkspaceOrder,
  saveWorkspaceRecencyFloor,
  saveWorkspaceSort,
  STORAGE_KEYS,
} from '@moonshot-ai/app-core/lib';
import { partitionByPinned } from '@moonshot-ai/app-core/lib';
import {
  coalesceAppRenderEvents,
  createEventBatcher,
  isRenderEvent,
  normalizeToolOutput,
  splitOversizedAppRenderEvent,
  type PendingAppEvent,
} from '@moonshot-ai/app-core/client';
import { applyRecordDiff } from '@moonshot-ai/app-core/client';
import { useAppearance } from '@moonshot-ai/app-core';
import { shouldNotifyCompletion } from '../composables/useNotification';
import { notificationsStore } from '../stores/notifications';
import { promptAttachmentToTurnAttachment } from './attachmentsToContent';
import { useModelProviderState } from './useModelProviderState';
import { useSideChat } from './useSideChat';
import { useTaskPoller } from './useTaskPoller';
import type { ExtendedState, ManagedMembership } from './types';
import { createAuxiliaryTranscriptPool } from '../composables/useAuxiliaryTranscripts';
import {
  beginLocalTurn,
  FLAT_SESSIONS_PAGE_SIZE,
  forgetLocalTurnState,
  SESSIONS_INITIAL_PAGE_SIZE,
  settleLocalTurn,
  useWorkspaceState,
} from './useWorkspaceState';
import { useSessionAdmin } from './useSessionAdmin';
import { useDocumentTitle } from '../composables/useDocumentTitle';
import { sessionsStore } from '../stores/sessions';
import { approvalsStore } from '../stores/approvals';
import { filesStore } from '../stores/files';

const appearance = useAppearance();
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
  SessionPlan, SessionPlanReview,
  AppSkill,
  AppTask,
  AppTurnError,
  AppTurnRetry,
  AppWarning,
  AppWorkspace,
  ApprovalDecision,
  KimiEventConnection,
  KimiEventMeta,
  ManagedUserInfo,
  ThinkingLevel,
} from '@moonshot-ai/app-core/api';
import {
  createInitialState,
  reduceAppEvent,
  toAppEvent,
  isPlaceholderSessionUsage,
  mergeSnapshotSession,
  shallowEqualArray,
  type CompactionStatus,
  type KimiClientState,
} from '@moonshot-ai/app-core/api';

import { createTurnsProjector } from '@moonshot-ai/app-core/client';
import { latestTodos } from '@moonshot-ai/app-core/client';
import { buildSwarmGroups, countSwarmMembers, swarmMembersByToolCall } from '@moonshot-ai/app-core/client';
import type { SwarmGroup, SwarmMember } from '@moonshot-ai/app-core/client';
import type {
  ActivityState,
  ActivationBadges,
  ApprovalBlock,
  ChatTurn,
  ConnectionState,
  ConversationStatus,
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
} from '@moonshot-ai/app-core/client/types';

// ---------------------------------------------------------------------------
// Internal reactive state (plain object wrapped in reactive())
// ---------------------------------------------------------------------------

const PERMISSION_STORAGE_KEY = STORAGE_KEYS.permission;
const ACTIVE_WORKSPACE_KEY = STORAGE_KEYS.activeWorkspace;
const PLAN_ARMED_STORAGE_KEY = STORAGE_KEYS.planArmed;
const SWARM_MODE_STORAGE_KEY = STORAGE_KEYS.swarmMode;
const GOAL_MODE_STORAGE_KEY = STORAGE_KEYS.goalMode;
const SESSION_NOT_FOUND_CODE = 40401;
const ONBOARDED_STORAGE_KEY = STORAGE_KEYS.onboarded;

// Appearance types + logic live in @moonshot-ai/app-core; re-exported here so
// existing `import type { ColorScheme } from './useKimiWebClient'` callers
// keep working.
export type { ColorScheme, FontScale } from '@moonshot-ai/app-core';

// The code-font setting was removed with its UI (b8a9e83). Clear the old
// persisted key so users who once picked a font aren't frozen on it forever.
safeRemove(STORAGE_KEYS.codeFont);
// The accent (blue / black) setting was removed with its UI — Kimi blue is now
// the single accent. Clear the old persisted key so it can't linger.
safeRemove(STORAGE_KEYS.accent);
// The UI theme (terminal / modern / kimi) was retired in favor of a single
// look. Clear the old persisted key so users who once picked one aren't frozen
// on a value the UI no longer reads.
safeRemove(STORAGE_KEYS.theme);
// The per-model thinking pick store was dropped in favor of the daemon's
// per-session thinking state — clear the old key so stale picks can't linger.
safeRemove(STORAGE_KEYS.thinking);
// The pre-intent planMode key mirrored the daemon FACT; the armed intent now
// persists under planArmed and the fact re-folds from /status. A stale true
// loaded as an INTENT would cash planMode:true into the next plain send —
// but as a FACT fallback it is the only persisted record of a daemon-side
// plan across a reload, so it seeds planModeBySession and is only removed
// once a successful /status fold replaces it (see the initializer and
// refreshSessionStatus).
// The three per-kind notification preferences were merged into a single
// notifyEnabled master switch, and the WebAudio completion sound was dropped
// in favor of the system notification sound — clear the old keys.
safeRemove(STORAGE_KEYS.notifyOnComplete);
safeRemove(STORAGE_KEYS.notifyOnQuestion);
safeRemove(STORAGE_KEYS.notifyOnApproval);
safeRemove(STORAGE_KEYS.soundOnComplete);

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
  saveModeMapToStorage(PLAN_ARMED_STORAGE_KEY, rawState.planArmedBySession);
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

// The facade state shape (ExtendedState) and the prompt-attachment /
// managed-membership types live in ./types so the client-layer modules can sit
// in the package. Re-exported here so existing
// `import type { … } from './useKimiWebClient'` callers keep working.
export type {
  ExtendedState,
  ManagedMembership,
  PromptAttachment,
} from './types';

const rawState: ExtendedState = reactive({
  ...createInitialState(),
  // The sessions slice (list + active id) lives in the sessions Pinia store
  // (stores/sessions.ts) since P8 — the store is the single source of truth and
  // every write lands in a store action. These accessors bridge legacy
  // read/write sites to the store so the P9–P15 teardown can migrate them
  // incrementally; new code must use sessionsStore() directly.
  get sessions() {
    return sessionsStore().sessions;
  },
  set sessions(next: AppSession[]) {
    sessionsStore().setSessions(next);
  },
  get activeSessionId() {
    return sessionsStore().activeSessionId;
  },
  set activeSessionId(id: string | undefined) {
    sessionsStore().setActiveSessionId(id);
  },
  // Pending approvals/questions live in the approvals store (P11). Read-only
  // accessors: writes go through the store's actions (the reducer write-back
  // uses applyApprovalsDiff/applyQuestionsDiff, per the applyRecordDiff
  // discipline), so these getters deliberately have no setters.
  get approvalsBySession() {
    return approvalsStore().approvalsBySession;
  },
  get questionsBySession() {
    return approvalsStore().questionsBySession;
  },
  // Per-session git status lives in the files store (P12) — read-only here;
  // writes go through loadGitStatus / clearSessionGitStatus actions.
  get gitStatusBySession() {
    return filesStore().gitStatusBySession;
  },
  connected: false,
  serverVersion: '',
  webTitle: '',
  dangerousBypassAuth: false,
  backend: 'v1',
  experimentalFlags: {},
  workspaceName: 'kimi-code',
  connection: 'disconnected' as ConnectionState,
  permission: loadPermissionFromStorage(),
  // Resolved per session/model once the catalog/session is known (loadModels
  // and the active-session watcher in useModelProviderState) — the per-session
  // map below starts empty and is fed by /status folds.
  thinking: undefined,
  thinkingBySession: {},
  pendingThinkingBySession: {},
  // The daemon fact starts empty and is fed by /status folds + the
  // status.updated projection — never from storage. The ARMED intent is the
  // persisted one (an unsent intent survives a reload).
  // Seeded from the deprecated planMode map: the daemon's plan profile
  // survives a reload, so the last mirrored fact is better than blank while
  // /status is unreachable (an old daemon or a transient failure). The first
  // successful /status fold replaces it.
  planModeBySession: loadModeMapFromStorage(STORAGE_KEYS.planMode),
  planArmedBySession: loadModeMapFromStorage(PLAN_ARMED_STORAGE_KEY),
  swarmModeBySession: loadModeMapFromStorage(SWARM_MODE_STORAGE_KEY),
  goalModeBySession: loadModeMapFromStorage(GOAL_MODE_STORAGE_KEY),
  loading: false,
  sessionLoading: false,
  queuedBySession: {},
  promptIdBySession: {},
  inFlightBySession: {},
  unreadBySession: loadUnread(),
  authReady: false,
  defaultModel: null,
  managedProviderStatus: null,
  managedUserInfo: null,
  managedMembership: null,
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
  flatSessionsNextPageToken: null,
  flatSessionsHasMore: true,
  flatSessionsLoading: false,
  flatSessionsLoadingMore: false,
  flatSessionsSeeded: false,
  flatSessionsFrontier: null,
  doneSessions: [],
  doneSessionsNextPageToken: null,
  doneSessionsHasMore: true,
  doneSessionsLoading: false,
  doneSessionsLoadingMore: false,
  doneSessionsSeeded: false,
  draftEntry: 'newChat',
  mainView: 'chat',
});

const plansBySession = reactive<Record<string, Record<string, SessionPlan>>>({});
/** Terminal review outcomes keyed by toolCallId — the freshest local word for
    plans the persisted receipts may not cover (old daemons without the plans
    endpoint, or a transient bulk-read failure). The sessionPlans transcript
    fallback merges these so the panel settles instead of showing "pending"
    forever. */
const settledPlanReviewByToolCallId = reactive<Record<string, SessionPlanReview>>({});
const planRequestSerialByKey = new Map<string, number>();
const planBulkVersionBySession = new Map<string, number>();

function planRequestKey(sessionId: string, toolCallId?: string): string {
  return `${sessionId}\0${toolCallId ?? '*'}`;
}

/** Record a terminal review outcome locally: the outcome map (merged by the
 *  transcript fallback) plus the cached receipt when one exists. Shared by
 *  the WS-event settle and respondApproval's POST-first settle. */
function settlePlanReviewLocally(sid: string, toolCallId: string, review: SessionPlanReview): void {
  settledPlanReviewByToolCallId[toolCallId] = review;
  // A cached PENDING receipt carries no review field at all — check the
  // record's existence, not its review, or the settle never reaches the
  // record sessionPlans actually prefers.
  const cached = plansBySession[sid]?.[toolCallId];
  if (cached) {
    plansBySession[sid] = { ...plansBySession[sid], [toolCallId]: { ...cached, review } };
  }
}

async function refreshSessionPlans(sessionId: string, toolCallId?: string): Promise<void> {
  // The bulk endpoint returns plans in transcript order; a targeted merge
  // would append in HTTP completion order and could crown an older plan
  // "latest". A targeted event is therefore just a cue to re-read the bulk.
  if (toolCallId !== undefined) {
    void refreshSessionPlans(sessionId);
    return;
  }
  const key = planRequestKey(sessionId, toolCallId);
  const requestSerial = (planRequestSerialByKey.get(key) ?? 0) + 1;
  planRequestSerialByKey.set(key, requestSerial);
  if (toolCallId !== undefined) {
    planBulkVersionBySession.set(sessionId, (planBulkVersionBySession.get(sessionId) ?? 0) + 1);
  }
  const bulkVersion = planBulkVersionBySession.get(sessionId) ?? 0;

  try {
    const plans = await getKimiWebApi().getSessionPlans(sessionId, {
      agentId: 'main',
      toolCallId,
    });
    if (
      planRequestSerialByKey.get(key) !== requestSerial ||
      (toolCallId === undefined &&
        (planBulkVersionBySession.get(sessionId) ?? 0) !== bulkVersion) ||
      !rawState.sessions.some((session) => session.id === sessionId)
    ) {
      return;
    }
    const fetched = Object.fromEntries(plans.map((plan) => [plan.toolCallId, plan]));
    // A locally settled terminal outcome (POST-first answer / WS event) is
    // fresher than a bulk read that hasn't projected the review yet — keep
    // it over a fetched record that is still pending or reviewless.
    for (const [id, plan] of Object.entries(fetched)) {
      const settled = settledPlanReviewByToolCallId[id];
      if (settled && (!plan.review || plan.review.state === 'pending')) {
        fetched[id] = { ...plan, review: settled };
      }
    }
    plansBySession[sessionId] =
      toolCallId === undefined
        ? fetched
        : { ...plansBySession[sessionId], ...fetched };
  } catch (error) {
    logWarn('[refreshSessionPlans] plan history unavailable for', sessionId, error);
  }
}

function forgetSessionPlans(sessionId: string): void {
  const prefix = `${sessionId}\0`;
  for (const key of planRequestSerialByKey.keys()) {
    if (key.startsWith(prefix)) planRequestSerialByKey.delete(key);
  }
  planBulkVersionBySession.delete(sessionId);
  delete plansBySession[sessionId];
}

/** Drop the session's cached plan receipts after a rewind. A successful
 *  refresh replaces them anyway; when the sidecar fetch fails transiently
 *  the pill/panel must NOT keep showing a possibly-rewound plan — the
 *  transcript fallback in sessionPlans still recovers what remains. */
function invalidateSessionPlans(sessionId: string): void {
  delete plansBySession[sessionId];
}

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
/** Add or replace a session in the pool, keeping updatedAt-desc order
 *  (de-duped by id). Position comes from the timestamp alone — callers never
 *  force the front (a restore/fork lands at its content time, not the top). */
function upsertSessionSorted(session: AppSession): void {
  rawState.sessions = insertSessionByRecency(rawState.sessions, session);
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
    rawState.unreadBySession[active] = false;
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
  traceKeyEvent('ws:stale-reconnect', {
    sessionId: rawState.activeSessionId,
    status: 'stale',
  });
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
//
// All writers assign PER KEY, never replace the record itself: a wholesale
// `{...map}` replacement dirties every computed that reads the record —
// including other sessions' turns projector, which re-ran on every background
// session's streaming delta (cross-session invalidation). Per-key writes only
// trigger the deps of the key written (and iteration deps on add/delete).
// ---------------------------------------------------------------------------
/** Apply the reducer's next messages map key-by-key (e.g. from a snapshot). */
function setMessagesBySession(next: Record<string, AppMessage[]>): void {
  applyRecordDiff(rawState.messagesBySession, next);
}
/** Set one session's message list. */
function setSessionMessages(sessionId: string, messages: AppMessage[]): void {
  rawState.messagesBySession[sessionId] = messages;
}
/** Update one session's message list via a function of the current list. */
function updateSessionMessages(
  sessionId: string,
  update: (messages: AppMessage[]) => AppMessage[],
): void {
  rawState.messagesBySession[sessionId] = update(rawState.messagesBySession[sessionId] ?? []);
}
/** Remove one session's message list. */
function removeSessionMessages(sessionId: string): void {
  delete rawState.messagesBySession[sessionId];
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
  auxiliaryTranscripts.forgetSession(sessionId);
  subagentCardSerials.delete(sessionId);
  dropWsSubscription(sessionId);
  // Drop this session's queued render AND control events. Flushing them here is
  // unsafe: a delayed idle event can drain a queued prompt into the session
  // after the archive request succeeded. Other sessions keep their own ordered
  // backlog and scheduled continuation.
  enqueueEvent.discard(({ meta }) => meta.sessionId === sessionId);
  removeSession(sessionId);
  removeSessionMessages(sessionId);
  forgetSessionPlans(sessionId);
  approvalsStore().clearSessionApprovals(sessionId);
  approvalsStore().clearSessionQuestions(sessionId);
  delete rawState.tasksBySession[sessionId];
  delete rawState.goalBySession[sessionId];
  filesStore().clearSessionGitStatus(sessionId);
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
  // ends (onMainTurnEnd drains queuedBySession[sid] without re-checking
  // that the session still exists).
  forgetLocalTurnState(sessionId);
  delete rawState.queuedBySession[sessionId];
  delete rawState.promptIdBySession[sessionId];
  delete rawState.inFlightBySession[sessionId];
  delete rawState.turnActiveBySession[sessionId];
  delete rawState.turnEndedPromptIdBySession[sessionId];
  delete rawState.turnErrorBySession[sessionId];
  delete rawState.turnRetryBySession[sessionId];
  // Drop per-session mode toggles and re-persist so a deleted session's entry
  // doesn't linger in localStorage.
  delete rawState.planModeBySession[sessionId];
  delete rawState.planArmedBySession[sessionId];
  delete rawState.swarmModeBySession[sessionId];
  delete rawState.goalModeBySession[sessionId];
  delete rawState.thinkingBySession[sessionId];
  delete rawState.pendingThinkingBySession[sessionId];
  savePlanModeToStorage();
  saveSwarmModeToStorage();
  saveGoalModeToStorage();
  // A deleted/archived session also leaves the pinned section (and its
  // persisted id list) — both removal entry points funnel through here.
  sessionsStore().unpinSession(sessionId);
}

// Models + Providers reactive state and helpers live in
// ./client/useModelProviderState. It is instantiated below (after the
// `activity` computed it depends on) as `modelProvider`.

// The ~/diff view state and the per-session git status live in the files Pinia
// store (stores/files.ts, P12), together with the loadFileDiff / clearFileDiff
// / loadGitStatus / readFileContent actions.

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
  rawState.swarmModeBySession[sessionId] = st.swarmMode;
  rawState.planModeBySession[sessionId] = st.planMode;
  // The authoritative fold supersedes the deprecated-map seed — drop it.
  safeRemove(STORAGE_KEYS.planMode);
  // Fold the session's own thinking level too — per-session state wins over the
  // per-model storage pick (see thinkingBySession on ExtendedState).
  if (st.thinkingEffort.length > 0) {
    foldDaemonThinkingLevel(rawState, sessionId, st.thinkingEffort as ThinkingLevel);
  }
}

// A reload-time goal-state refill in flight (see useWorkspaceState load()).
// onMainTurnEnd treats these sessions as goal-active while the refill is
// pending: the first intermediate goal boundary after a reload could
// otherwise arrive before the refill lands and leak one unread dot +
// completion notification. Deliberately NOT set for ordinary
// refreshSessionGoal callers (e.g. selectSession's sidecar refresh) — a
// non-goal session's completion must never be suppressed.
const goalFetchPendingBySession = new Set<string>();

/** load()'s post-reload goal refill: fetch with the pending mark held, so a
 *  turn boundary landing mid-refetch still reads goal-active (see above). */
function refillSessionGoalOnReload(sessionId: string): void {
  goalFetchPendingBySession.add(sessionId);
  void refreshSessionGoal(sessionId).finally(() => {
    goalFetchPendingBySession.delete(sessionId);
  });
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
  if (goal === null || goal.status === 'complete') delete rawState.goalBySession[sessionId];
  else rawState.goalBySession[sessionId] = goal;
}
/** Persist runtime controls to a session via POST /profile, then re-read
 *  /status. `sessionId` overrides the active session — used when creating a
 *  session and immediately persisting its draft modes, so a concurrent session
 *  switch can't write the patch to the wrong session.
 *
 *  Resolves false when the daemon did not apply the patch (also surfaced via
 *  pushOperationFailure — the UI already updated optimistically, so the user
 *  must be told); true on success. Most callers fire-and-forget via
 *  `void persistSessionProfile(...)`; call sites that must order strictly
 *  after the profile (e.g. a skill activation that can't carry its own modes)
 *  await it and must NOT proceed on false — awaiting alone enforces nothing,
 *  since the promise never rejects. */
function persistSessionProfile(patch: {
  model?: string;
  permissionMode?: string;
  planMode?: boolean;
  swarmMode?: boolean;
  goalObjective?: string;
  goalControl?: 'pause' | 'resume' | 'cancel';
  thinking?: string;
}, sessionId?: string): Promise<boolean> {
  const sid = sessionId ?? rawState.activeSessionId;
  if (!sid) return Promise.resolve(false);
  // The token of the pending pick this patch carries, captured synchronously —
  // only a completion still holding it may clear the mark.
  const thinkingToken = patch.thinking !== undefined ? rawState.pendingThinkingBySession[sid] : undefined;
  // Promise.resolve wrap: tolerate a sync/undefined return (e.g. test mocks).
  return Promise.resolve(getKimiWebApi().updateSession(sid, patch))
    .then(() => {
      ackThinkingPending(rawState, sid, thinkingToken);
      return refreshSessionStatus(sid);
    })
    .then(() => true)
    .catch((err) => {
      // A failed write never reached the daemon: stop shielding it and re-fold
      // the daemon's actual level (an earlier acked report may have been
      // dropped while it was pending). A newer pick keeps its own shield.
      if (ackThinkingPending(rawState, sid, thinkingToken)) void refreshSessionStatus(sid);
      // Local state already reflects the change; tell the user (and the log)
      // that the daemon did not persist it.
      pushOperationFailure('persistSessionProfile', err, { sessionId: sid });
      return false;
    });
}

// ---------------------------------------------------------------------------
// Onboarding: a "has the user been onboarded" flag that gates the first-run
// onboarding wizard. Persisted in TWO places: origin-scoped localStorage
// (same-origin cache), and — on desktop — the main process's ui-state.json,
// injected as `?kimi_onboarded=1` on the boot URL and written back over IPC,
// so the flag survives dev-server port shifts and crosses dev/packaged. The
// main-process value wins ties via OR (the flag only ever goes false→true).
// Without the desktop bridge (web) only localStorage is used. An injected
// `true` is mirrored back into localStorage on read, because writeSessionUrl()
// drops the boot URL's query when it rewrites the location to /sessions/<id> —
// a plain renderer reload (Cmd+R / HMR full reload) would otherwise lose both
// sources and re-show the wizard.
// ---------------------------------------------------------------------------
function loadStringFromStorage(key: string): string {
  try {
    return safeGetString(key) ?? '';
  } catch {
    return '';
  }
}
function readInjectedOnboarded(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('kimi_onboarded') === '1';
}
const injectedOnboarded = readInjectedOnboarded();
if (injectedOnboarded && loadStringFromStorage(ONBOARDED_STORAGE_KEY) !== '1') {
  try {
    safeSetString(ONBOARDED_STORAGE_KEY, '1');
  } catch {
    /* ignore */
  }
}
const onboarded = ref<boolean>(
  injectedOnboarded || loadStringFromStorage(ONBOARDED_STORAGE_KEY) === '1',
);
function setOnboarded(done: boolean): void {
  onboarded.value = done;
  try {
    safeSetString(ONBOARDED_STORAGE_KEY, done ? '1' : '0');
  } catch {
    /* ignore */
  }
  if (done) {
    (window as { kimiDesktop?: { setOnboarded?: () => void } }).kimiDesktop?.setOnboarded?.();
  }
}

// Singleton WS connection
let eventConn: KimiEventConnection | null = null;
const auxiliaryTranscripts = createAuxiliaryTranscriptPool({
  api: getKimiWebApi(),
  connectEventsIfNeeded,
  getEventConnection: () => eventConn,
});

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
    turnActiveBySession: rawState.turnActiveBySession,
    turnEndedPromptIdBySession: rawState.turnEndedPromptIdBySession,
    turnErrorBySession: rawState.turnErrorBySession,
    turnRetryBySession: rawState.turnRetryBySession,
    compactionBySession: rawState.compactionBySession,
    config: rawState.config,
    warnings: rawState.warnings,
  };
  const next = reduceAppEvent(snapshot, event, { sessionId, seq }, {
    t: (k, p) => (p === undefined ? t(k) : t(k, p)),
  });
  // Assign back to the reactive proxy — but ONLY the slices the event actually
  // changed. cloneState gives every slice a fresh identity per event, so the
  // previous unconditional assignment dirtied every computed reading any of
  // these slices on EVERY event: a single streaming delta invalidated the whole
  // sidebar (sessionsForView / workspaceGroups read turnActiveBySession per
  // row), which at ~1k sessions × ~100 workspaces turned each delta into a
  // several-hundred-ms recompute storm. The reducer never mutates slice entries
  // in place (entries are always replaced or deleted), so a shallow reference
  // comparison is sufficient to tell "changed" from "merely cloned".
  //
  // Record slices go one step further: applyRecordDiff writes changed KEYS only
  // and keeps the record's own identity. A wholesale `{...map}` replacement —
  // even when guarded — re-triggers computeds that read a DIFFERENT session's
  // key (cross-session invalidation: the foreground turns projector re-ran on
  // every background session's streaming delta).
  if (next.sessions !== snapshot.sessions) setSessions(next.sessions);
  if (next.activeSessionId !== snapshot.activeSessionId) {
    setActiveSessionId(next.activeSessionId);
  }
  setMessagesBySession(next.messagesBySession);
  approvalsStore().applyApprovalsDiff(next.approvalsBySession);
  applyRecordDiff(rawState.planReviewByToolCallId, next.planReviewByToolCallId);
  approvalsStore().applyQuestionsDiff(next.questionsBySession);
  applyRecordDiff(rawState.tasksBySession, next.tasksBySession);
  applyRecordDiff(rawState.goalBySession, next.goalBySession);
  applyRecordDiff(rawState.goalVersionBySession, next.goalVersionBySession);
  applyRecordDiff(rawState.lastSeqBySession, next.lastSeqBySession);
  applyRecordDiff(rawState.turnActiveBySession, next.turnActiveBySession);
  applyRecordDiff(rawState.turnEndedPromptIdBySession, next.turnEndedPromptIdBySession);
  applyRecordDiff(rawState.turnErrorBySession, next.turnErrorBySession);
  applyRecordDiff(rawState.turnRetryBySession, next.turnRetryBySession);
  applyRecordDiff(rawState.compactionBySession, next.compactionBySession);
  if (next.config !== snapshot.config) rawState.config = next.config ?? null;
  if (!shallowEqualArray(next.warnings, snapshot.warnings)) {
    rawState.warnings = next.warnings;
  }

  // A live goal event supersedes any in-flight goal refetch (the refill's
  // version guard discards its result), so the pending mark must clear with
  // it — otherwise a goalUpdated(complete) followed by the terminal turn end
  // would still read "goal fetch pending" and suppress the one completion
  // alert (unread dot + notification) the user was supposed to get.
  if (event.type === 'goalUpdated') goalFetchPendingBySession.delete(sessionId);

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
      rawState.swarmModeBySession[event.sessionId] = event.swarmMode;
    }
    if (event.planMode !== undefined) {
      rawState.planModeBySession[event.sessionId] = event.planMode;
    }
    if (event.thinking !== undefined) {
      foldDaemonThinkingLevel(rawState, event.sessionId, event.thinking as ThinkingLevel);
    }
  }

  // A session deleted anywhere (e.g. from another client) also loses its pin:
  // the WS-driven deletion path bypasses forgetSession, so the pinned-id
  // cleanup lives here too.
  if (event.type === 'sessionDeleted') {
    unpinSession(event.sessionId);
    // Same teardown for its terminal bucket (bypasses the App.vue callbacks).
    // Injected by desktop; a no-op on web.
    notifySessionDestroyed(event.sessionId);
  }
  // A remote ARCHIVE arrives as sessionUpdated — same terminal teardown.
  if (event.type === 'sessionUpdated' && event.session.archived === true) {
    notifySessionDestroyed(event.session.id);
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
// Adjacent, offset-contiguous assistant/thinking deltas are merged before they
// reach the reducer. The remaining ordered groups are processed with a fixed
// per-frame budget and a task fallback, so a hidden tab cannot turn the entire
// backlog into one unbounded rAF drain. Lifecycle / control-flow events remain
// strict ordering barriers and are never dropped or merged.

function latestTurnExitPlanToolCallId(messages: AppMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'user') return undefined;
    if (message.role !== 'assistant') continue;
    for (let contentIndex = message.content.length - 1; contentIndex >= 0; contentIndex--) {
      const content = message.content[contentIndex]!;
      if (content.type === 'toolUse' && content.toolName === 'ExitPlanMode') {
        return content.toolCallId;
      }
    }
  }
  return undefined;
}

function processEvent(appEvent: AppEvent, meta: KimiEventMeta): void {
  // Capture BEFORE applyEvent advances lastSeqBySession: turn-end side
  // effects below only run when this event actually moves the durable cursor
  // forward. A late duplicate idle (e.g. replayed after a snapshot already
  // advanced past it) must not drain a second queued message.
  const prevSeq = rawState.lastSeqBySession[meta.sessionId] ?? 0;
  const wasMainTurnActive = rawState.turnActiveBySession[meta.sessionId] ?? false;
  const settledPlanToolCallId =
    appEvent.type === 'approvalResolved' || appEvent.type === 'approvalExpired'
      ? rawState.approvalsBySession[meta.sessionId]?.find(
          (approval) =>
            approval.approvalId === appEvent.approvalId &&
            approval.toolName === 'ExitPlanMode',
        )?.toolCallId
      : undefined;
  const sideTarget = sideChat.sideChatTargetBySession.value[meta.sessionId];
  if (
    appEvent.type === 'messageCreated' &&
    appEvent.message.role === 'user' &&
    appEvent.agentId !== undefined &&
    Object.prototype.hasOwnProperty.call(
      rawState.sideChatMessagesByAgent,
      appEvent.agentId,
    )
  ) {
    applyEvent(
      { type: 'unknown', raw: { _noop: true } },
      meta.sessionId,
      meta.seq,
    );
    sideChat.reconcileSideChatUserMessage(appEvent.agentId, appEvent.message);
    return;
  }
  // meta carries wire-level seq/sessionId so the reducer can advance
  // lastSeqBySession[sessionId] = seq. Compaction completion appends a
  // persistent divider marker in the reducer (TUI parity: the scrollback
  // is kept, only a marker line records the compaction).
  applyEvent(appEvent, meta.sessionId, meta.seq);

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
      rawState.promptIdBySession[sid] = appEvent.message.promptId;
    }
  }

  // Prompt-end cleanup. The MAIN agent's turn boundary is the authoritative
  // "the prompt is done" signal: it drives the in-flight/indicator cleanup, the
  // queued-message drain, and the completion side effects. The session may
  // stay busy afterwards (background subagents / BTW) — that must NOT hold
  // any of these. The session's idle/aborted status is only a fallback quiet
  // signal (a turn.ended can be lost on abrupt agent disposal): it clears the
  // boolean liveness flags, but drain/notify stay single-owned by the
  // turn-boundary path. Both are gated on the durable cursor advancing so a
  // late duplicate cannot fire twice.
  if (
    appEvent.type === 'turnActiveChanged' &&
    !appEvent.active &&
    meta.seq > prevSeq
  ) {
    const reason = appEvent.reason;
    // wasMainTurnActive was captured BEFORE the reducer consumed this event
    // (the reducer clears turnActiveBySession on turn end), so it is the only
    // remaining signal that this client witnessed a live turn — pass it down
    // so finishPromptLocal may drain queued prompts behind a turn the user
    // actually watched (including one started by another client).
    onMainTurnEnd(
      appEvent.sessionId,
      reason === 'cancelled' || reason === 'failed' || reason === 'blocked' ? 'aborted' : 'idle',
      wasMainTurnActive,
    );
    const exitPlanToolCallId = latestTurnExitPlanToolCallId(
      rawState.messagesBySession[appEvent.sessionId] ?? [],
    );
    if (exitPlanToolCallId !== undefined) {
      void refreshSessionPlans(appEvent.sessionId, exitPlanToolCallId);
    }
  }

  if (
    appEvent.type === 'sessionWorkChanged' &&
    ((appEvent.mainTurnActive === false && wasMainTurnActive) ||
      (appEvent.mainTurnActive === undefined && !appEvent.busy)) &&
    meta.seq > prevSeq
  ) {
    clearWorkingFlags(appEvent.sessionId);
  }

  // A prompt that never produced a turn gets no turn.ended and no session
  // status flip: a QUEUED prompt aborted before launch (prompt.aborted), or a
  // prompt blocked by a pre-submit hook (prompt.completed with reason
  // 'blocked'). Without this the local in-flight flag — and the working indicator —
  // would stick forever. Keyed on the promptId captured at submit: a normal
  // turn's prompt.completed/aborted arrives AFTER its status_changed (which
  // already cleared the id), so it no-ops; another client's prompt never
  // matches. Only fires when the event moves the durable cursor forward, same
  // as the status path above.
  if (
    (appEvent.type === 'promptAborted' ||
      (appEvent.type === 'promptCompleted' && appEvent.reason === 'blocked')) &&
    meta.seq > prevSeq &&
    rawState.promptIdBySession[appEvent.sessionId] === appEvent.promptId
  ) {
    workspaceState.finishPromptLocal(appEvent.sessionId);
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
  if (settledPlanToolCallId !== undefined) {
    // Record the terminal outcome regardless of whether a persisted receipt
    // exists — old daemons without /transcript/plan (or a transient bulk
    // failure) otherwise drop the decision entirely, and a fallback-built
    // plan would show "pending" forever.
    const outcome: SessionPlanReview =
      appEvent.type === 'approvalResolved'
        ? {
            state: appEvent.decision,
            selectedOption: appEvent.selectedLabel,
            feedback: appEvent.feedback,
          }
        : { state: 'cancelled' };
    // Settle locally FIRST (the cached receipt when present, plus the
    // outcome map the transcript fallback merges): a transient failure of
    // the bulk re-read below must not leave the panel showing "pending"
    // until an unrelated refresh.
    settlePlanReviewLocally(meta.sessionId, settledPlanToolCallId, outcome);
    void refreshSessionPlans(meta.sessionId, settledPlanToolCallId);
  }
}

const enqueueEvent = createEventBatcher<PendingAppEvent>(
  ({ appEvent, meta }) => processEvent(appEvent, meta),
  ({ appEvent }) => isRenderEvent(appEvent),
  { coalesce: coalesceAppRenderEvents },
);

interface SessionWorkBaselineRun {
  workEventSeqBySession: Map<string, number>;
  turnEventSeqBySession: Map<string, number>;
  pendingEventBySession: Map<
    string,
    { seq: number; source: 'work' | 'interaction' }
  >;
  turnStartBySession: Map<string, { generation: number; pending: boolean }>;
  witnessedTurnBySession: Set<string>;
}

const SESSION_WORK_BASELINE_RETRY_MAX_MS = 30_000;
let connectionGeneration = 0;
let sessionWorkBaselineRun: SessionWorkBaselineRun | null = null;
// REST list rows only authorize skipping older activity frames, not transcript data.
const sessionActivityWatermarkBySession = new Map<string, number>();
let sessionWorkBaselineRetryAttempt = 0;
let sessionWorkBaselineRetryTimer: ReturnType<typeof setTimeout> | null = null;

function cancelSessionWorkBaselineRetry(): void {
  if (sessionWorkBaselineRetryTimer === null) return;
  clearTimeout(sessionWorkBaselineRetryTimer);
  sessionWorkBaselineRetryTimer = null;
}

function scheduleSessionWorkBaselineRetry(error: unknown): void {
  if (!rawState.connected || sessionWorkBaselineRetryTimer !== null) return;
  const delay = Math.min(
    SESSION_WORK_BASELINE_RETRY_MAX_MS,
    1000 * 2 ** sessionWorkBaselineRetryAttempt,
  );
  sessionWorkBaselineRetryAttempt += 1;
  logWarn('[kimi-code] session work reconciliation incomplete; retrying', error);
  sessionWorkBaselineRetryTimer = setTimeout(() => {
    sessionWorkBaselineRetryTimer = null;
    if (rawState.connected) void reconcileSessionWorkAfterReconnect();
  }, delay);
}

function applySessionWorkBaseline(
  sessions: AppSession[],
  run: SessionWorkBaselineRun,
): void {
  const baselineById = new Map(sessions.map((session) => [session.id, session] as const));
  let sessionsChanged = false;
  let turnActiveChanged = false;
  const nextTurnActive = { ...rawState.turnActiveBySession };
  const finishedSessionIds: string[] = [];
  const authoritativePendingBySession = new Map<
    string,
    'none' | 'approval' | 'question'
  >();
  const nextSessions = rawState.sessions.map((session) => {
    const baseline = baselineById.get(session.id);
    if (baseline === undefined) return session;
    const workEventSeq = run.workEventSeqBySession.get(session.id) ?? 0;
    const turnEventSeq = run.turnEventSeqBySession.get(session.id) ?? 0;
    const pendingEvent = run.pendingEventBySession.get(session.id);
    const workChanged = workEventSeq > baseline.lastSeq;
    const turnChanged =
      turnEventSeq > baseline.lastSeq;
    const pendingChanged =
      pendingEvent !== undefined && pendingEvent.seq > baseline.lastSeq;
    const busy =
      workChanged || (turnChanged && session.mainTurnActive === true)
        ? session.busy || session.mainTurnActive === true
        : baseline.busy;
    const mainTurnActive =
      workChanged || turnChanged
        ? session.mainTurnActive
        : baseline.mainTurnActive ?? (busy ? session.mainTurnActive : false);
    const pendingInteraction = pendingChanged
      ? pendingEvent.source === 'work'
        ? session.pendingInteraction
        // The server uses the same approval-over-question priority when both exist.
        : (rawState.approvalsBySession[session.id]?.length ?? 0) > 0
          ? 'approval'
          : (rawState.questionsBySession[session.id]?.length ?? 0) > 0
            ? 'question'
            : 'none'
      : baseline.pendingInteraction ?? (busy ? session.pendingInteraction : 'none');
    if (
      ((pendingChanged && pendingEvent.source === 'work') ||
        (!pendingChanged &&
          (baseline.pendingInteraction !== undefined || baseline.busy === false))) &&
      pendingInteraction !== undefined
    ) {
      authoritativePendingBySession.set(session.id, pendingInteraction);
    }
    const lastTurnReason = workChanged ? session.lastTurnReason : baseline.lastTurnReason;
    sessionActivityWatermarkBySession.set(
      session.id,
      Math.max(
        sessionActivityWatermarkBySession.get(session.id) ?? 0,
        baseline.lastSeq,
      ),
    );
    const turnStart = run.turnStartBySession.get(session.id);
    if (
      (mainTurnActive === false || (mainTurnActive === undefined && !busy)) &&
      run.witnessedTurnBySession.has(session.id) &&
      turnStart !== undefined &&
      workspaceState.isLocalTurnSnapshotCurrent(session.id, turnStart)
    ) {
      finishedSessionIds.push(session.id);
    }

    if (mainTurnActive === true && !nextTurnActive[session.id]) {
      nextTurnActive[session.id] = true;
      turnActiveChanged = true;
    } else if (
      (mainTurnActive === false || !busy) &&
      nextTurnActive[session.id]
    ) {
      delete nextTurnActive[session.id];
      turnActiveChanged = true;
    }

    if (
      session.busy === busy &&
      session.mainTurnActive === mainTurnActive &&
      session.pendingInteraction === pendingInteraction &&
      session.lastTurnReason === lastTurnReason
    ) {
      return session;
    }
    sessionsChanged = true;
    return {
      ...session,
      busy,
      mainTurnActive,
      pendingInteraction,
      lastTurnReason,
    };
  });
  if (sessionsChanged) setSessions(nextSessions);
  if (turnActiveChanged) applyRecordDiff(rawState.turnActiveBySession, nextTurnActive);
  for (const [sessionId, pendingInteraction] of authoritativePendingBySession) {
    if (pendingInteraction === 'none') {
      approvalsStore().clearSessionApprovals(sessionId);
      approvalsStore().clearSessionQuestions(sessionId);
    } else if (pendingInteraction === 'question') {
      approvalsStore().clearSessionApprovals(sessionId);
    }
  }
  for (const sessionId of finishedSessionIds) {
    workspaceState.finishPromptLocal(sessionId, { turnWasActive: true });
  }
}

async function reconcileSessionWorkAfterReconnect(): Promise<void> {
  const run: SessionWorkBaselineRun = {
    workEventSeqBySession: new Map(),
    turnEventSeqBySession: new Map(),
    pendingEventBySession: new Map(),
    turnStartBySession: new Map(
      rawState.sessions.map((session) => [
        session.id,
        workspaceState.localTurnStartState(session.id),
      ]),
    ),
    witnessedTurnBySession: new Set(
      rawState.sessions
        .filter(
          (session) =>
            rawState.inFlightBySession[session.id] ||
            rawState.turnActiveBySession[session.id],
        )
        .map((session) => session.id),
    ),
  };
  sessionWorkBaselineRun = run;

  try {
    const result = await workspaceState.listAllSessionsGlobal({
      shouldContinue: () => sessionWorkBaselineRun === run && rawState.connected,
    });
    if (sessionWorkBaselineRun !== run || !rawState.connected) return;
    // Apply queued events first, then compare their seq with each REST row's
    // lastSeq so the newer source wins for each work-state field.
    enqueueEvent.flush();
    applySessionWorkBaseline(result.sessions, run);
    sessionWorkBaselineRun = null;
    if (result.error !== undefined) {
      scheduleSessionWorkBaselineRetry(result.error);
    } else {
      sessionWorkBaselineRetryAttempt = 0;
    }
  } catch (error) {
    if (sessionWorkBaselineRun !== run || !rawState.connected) return;
    sessionWorkBaselineRun = null;
    scheduleSessionWorkBaselineRetry(error);
  }
}

// ---------------------------------------------------------------------------
// WS subscription (lazy, only when a session is selected)
// ---------------------------------------------------------------------------

// connection_lost only counts drops AFTER the first established connection —
// the initial connect attempt failing is startup, not a lost connection.
let wsEverConnected = false;
let wsDisconnectedAt: number | null = null;

// Exported (desktop-only consumer: the settings plugins shelf — web's copy
// needs no such export; see docs/native-todos.md).
export function connectEventsIfNeeded(): void {
  if (eventConn !== null) return;
  // Guard: jsdom and some environments have no WebSocket
  if (typeof WebSocket === 'undefined') return;

  traceKeyEvent('ws:connection', { status: 'connecting' });
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
        if (appEvent.type === 'workspaceDeleted') {
          // Terminal teardown mirrors the App.vue confirm-delete cleanup.
          // Injected by desktop (native PTYs); a no-op on web.
          const sessionIds = rawState.sessions
            .filter(
              (session) =>
                session.workspaceId === appEvent.workspaceId ||
                session.cwd === appEvent.root,
            )
            .map((session) => session.id);
          notifyWorkspaceDestroyed(appEvent.workspaceId, appEvent.root, sessionIds);
        }
        workspaceState.applyWorkspaceEvent(appEvent);
        return;
      }
      // Plugin/capability lifecycle fan-out feeds the desktop settings plugins
      // shelf. Web registers no handler — the events fall through to the
      // normal reducer path.
      if (
        (appEvent.type === 'pluginsChanged' || appEvent.type === 'capabilityChanged') &&
        notifyPluginsShelfEvent(appEvent)
      ) {
        return;
      }
      const isWorkEvent = appEvent.type === 'sessionWorkChanged';
      const isTurnEvent = appEvent.type === 'turnActiveChanged';
      const isInteractionEvent =
        appEvent.type === 'approvalRequested' ||
        appEvent.type === 'approvalResolved' ||
        appEvent.type === 'approvalExpired' ||
        appEvent.type === 'questionRequested' ||
        appEvent.type === 'questionAnswered' ||
        appEvent.type === 'questionDismissed';
      if ((isWorkEvent || isTurnEvent || isInteractionEvent) && meta.seq > 0) {
        const watermark =
          sessionActivityWatermarkBySession.get(meta.sessionId) ?? 0;
        if (meta.seq <= watermark) return;
        sessionActivityWatermarkBySession.set(meta.sessionId, meta.seq);
      }
      if (
        sessionWorkBaselineRun !== null &&
        (isWorkEvent || isTurnEvent || isInteractionEvent)
      ) {
        if (isWorkEvent) {
          const previous =
            sessionWorkBaselineRun.workEventSeqBySession.get(meta.sessionId) ?? 0;
          if (meta.seq > previous) {
            sessionWorkBaselineRun.workEventSeqBySession.set(meta.sessionId, meta.seq);
          }
          if (appEvent.pendingInteraction !== undefined || !appEvent.busy) {
            const pending = sessionWorkBaselineRun.pendingEventBySession.get(
              meta.sessionId,
            );
            if (pending === undefined || meta.seq > pending.seq) {
              sessionWorkBaselineRun.pendingEventBySession.set(meta.sessionId, {
                seq: meta.seq,
                source: 'work',
              });
            }
          }
        } else if (isTurnEvent) {
          const previous =
            sessionWorkBaselineRun.turnEventSeqBySession.get(meta.sessionId) ?? 0;
          if (meta.seq > previous) {
            sessionWorkBaselineRun.turnEventSeqBySession.set(meta.sessionId, meta.seq);
          }
        } else {
          const pending = sessionWorkBaselineRun.pendingEventBySession.get(
            meta.sessionId,
          );
          if (pending === undefined || meta.seq > pending.seq) {
            sessionWorkBaselineRun.pendingEventBySession.set(meta.sessionId, {
              seq: meta.seq,
              source: 'interaction',
            });
          }
        }
      }

      // Merge safe streaming chunks, then process the ordered queue in bounded
      // slices. See createEventBatcher / processEvent above.
      for (const pendingEvent of splitOversizedAppRenderEvent({ appEvent, meta })) {
        enqueueEvent(pendingEvent);
      }
    },

    onResync(sessionId: string, currentSeq: number, epoch?: string) {
      traceKeyEvent('ws:resync', {
        sessionId,
        status: 'required',
        seq: currentSeq,
      });
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

    onError(code: number, msg: string, fatal: boolean) {
      traceKeyEvent('ws:error', {
        status: 'failed',
        errorCode: code,
        fatal,
      });
      pushWarning({
        severity: 'error',
        title: t('warnings.wsTitle'),
        message: msg,
        details: [warningDetail('message', msg)].filter(
          (detail): detail is AppNoticeDetail => detail !== undefined,
        ),
      });
    },

    onConnectionChange(connected: boolean) {
      traceKeyEvent('ws:connection', {
        status: connected ? 'connected' : 'disconnected',
      });
      rawState.connected = connected;
      rawState.connection = connected ? 'connected' : 'disconnected';
      if (connected) {
        if (wsDisconnectedAt !== null) {
          track('connection_restored', {
            duration_ms: Math.min(Date.now() - wsDisconnectedAt, 86_400_000),
          });
          wsDisconnectedAt = null;
        }
        wsEverConnected = true;
      } else {
        if (wsEverConnected && wsDisconnectedAt === null) {
          track('connection_lost', {});
          wsDisconnectedAt = Date.now();
        }
        sessionWorkBaselineRun = null;
        sessionActivityWatermarkBySession.clear();
        cancelSessionWorkBaselineRetry();
        sessionWorkBaselineRetryAttempt = 0;
      }
      // The data channel is healthy again (server_hello received). Clear any
      // stale "Realtime connection error" toast instead of relying on its
      // auto-dismiss timer: iOS Safari freezes timers while a tab is
      // backgrounded, so the toast would otherwise linger until a manual
      // refresh even though the reconnect already succeeded.
      if (connected) {
        connectionGeneration += 1;
        dismissWsError();
        // A (re)connect can mean the backend was restarted — or switched, when
        // the dev proxy was moved to the other engine. Re-read /meta so
        // serverVersion / backend never go stale.
        void workspaceState.refreshServerMeta();
      }
    },

    onReplayComplete() {
      // Replay frames were queued for bounded rendering; drain them before the
      // REST baseline starts so the ACK is also a state-application barrier.
      enqueueEvent.flush();
      if (connectionGeneration > 1) {
        void reconcileSessionWorkAfterReconnect();
      }
    },

    onTranscriptReset(sessionId, agentId, snapshot, seq) {
      auxiliaryTranscripts.receiveReset(sessionId, agentId, snapshot, seq);
    },

    onTranscriptOps(sessionId, agentId, ops, seq) {
      return auxiliaryTranscripts.applyOps(sessionId, agentId, ops, seq);
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
  return { label: t(`warnings.details.${labelKey}`), value: formatDetailValue(value) };
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
  // A self-imposed abort (AbortSignal.timeout) means "still working, we stopped
  // waiting", not "unreachable" — say so instead of the connect-failure copy.
  const timeout = isDaemonTimeoutError(err);
  const title =
    opts.title ??
    (network
      ? timeout
        ? t('warnings.daemonTimeoutTitle')
        : t('warnings.daemonNetworkTitle')
      : api
        ? t('warnings.daemonApiTitle')
        : t('warnings.operationFailedTitle'));
  const message =
    opts.message ??
    (network
      ? timeout
        ? t('warnings.daemonTimeoutMessage')
        : t('warnings.daemonNetworkMessage')
      : api
        ? err.message
        : t('warnings.operationFailedMessage'));
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
  const title = t('warnings.wsTitle');
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
  // Always-on logging: a surfaced failure must be diagnosable from the console
  // and from the exported web log (session export), not just from the toast.
  logError(`[kimi-code] operation failed: ${operation}`, err);
  const api = isDaemonApiError(err);
  const network = isDaemonNetworkError(err);
  traceKeyEvent('operation:failed', {
    sessionId: opts?.sessionId,
    status: 'failed',
    operation,
    errorName: err instanceof Error ? err.name : typeof err,
    errorCode: api ? err.code : undefined,
    requestId: api || network ? err.requestId : undefined,
    phase: network ? err.phase : undefined,
    httpStatus: network ? err.status : undefined,
  });
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
  if (!isDaemonApiError(err) || err.code === undefined) return undefined;
  const key = GOAL_ERROR_KEYS[err.code];
  return key ? t(key) : undefined;
}

async function handleSessionNotFound(sessionId: string): Promise<void> {
  forgetSession(sessionId);

  if (rawState.activeSessionId !== sessionId) return;

  const next = rawState.sessions[0];
  if (next) {
    await workspaceState.selectSession(next.id, { urlMode: 'replace', skipTrack: true });
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
    const label = t('warnings.noteLabel');
    for (const warning of warnings) {
      pushWarning(`${label}: ${warning.message}`);
    }
  } catch {
    // best-effort: never block session sync on warning retrieval.
  }
}

async function syncSessionFromSnapshot(
  sessionId: string,
  opts?: { skipStatusRefresh?: boolean },
): Promise<SyncSessionResult> {
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

    // Every snapshot apply re-seeds liveness from the server: keep the cached
    // retry only while the snapshot's in-flight turn still owns it — an older
    // turn's backoff must never narrate a newer one, and a live retry keeps
    // showing through a re-open (its edge frames won't replay past the
    // snapshot cursor).
    const cachedRetry = rawState.turnRetryBySession[sessionId];
    if (cachedRetry !== undefined && cachedRetry.turnId !== snap.inFlightTurn?.turnId) {
      delete rawState.turnRetryBySession[sessionId];
    }
    if (mustApplySnapshot) {
      // A forced rebuild means the client lost ground (resync / stale cursor):
      // cached failure details may belong to a turn we never saw — drop them,
      // the card falls back to the generic copy rather than narrating the
      // wrong turn.
      delete rawState.turnErrorBySession[sessionId];
    } else if (snap.session.lastTurnReason !== 'failed') {
      // A fresh snapshot proving the latest turn is not the recorded failure
      // (a newer turn started, or ended differently) retires the cached
      // provider details; a 'failed' snapshot keeps them — a same-client
      // re-open holds prefix continuity and any newer failure's live error
      // frame replays in and overwrites on its own.
      delete rawState.turnErrorBySession[sessionId];
    }

    const snapUsagePlaceholder = isPlaceholderSessionUsage(snap.session.usage);
    // The effective main-turn liveness: older daemons omit mainTurnActive —
    // fall back to the snapshot's in-flight turn gated on busy. Shared by the
    // session merge (recency guard) and the indicator seeding below.
    const snapMainTurnActive =
      snap.session.mainTurnActive ?? (snap.inFlightTurn !== null && snap.session.busy);
    // Snapshot merge: keep the pool's live usage/model, newer local recency,
    // and the v2-only pullRequest — see mergeSnapshotSession.
    updateSession(sessionId, (s) => mergeSnapshotSession(s, snap.session, snapMainTurnActive));
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
    rawState.tasksBySession[sessionId] = mergeSnapshotSubagents(
      snap.subagents,
      rawState.tasksBySession[sessionId] ?? [],
    );
    rawState.messagesHasMoreBySession[sessionId] = snap.hasMoreMessages;
    approvalsStore().setSessionApprovals(sessionId, snap.pendingApprovals);
    // Preserve plan_review paths from the snapshot so the ExitPlanMode tool
    // card can link to the plan file even after a reload.
    for (const a of snap.pendingApprovals) {
      const display = a.display as { kind?: unknown; plan?: unknown; path?: unknown } | null | undefined;
      if (display?.kind === 'plan_review' && typeof display.plan === 'string' && display.plan.length > 0) {
        rawState.planReviewByToolCallId[a.toolCallId] = {
          plan: display.plan,
          path: typeof display.path === 'string' ? display.path : undefined,
        };
      }
    }
    approvalsStore().setSessionQuestions(sessionId, snap.pendingQuestions);
    rawState.lastSeqBySession[sessionId] = snap.asOfSeq;
    epochBySession[sessionId] = snap.epoch;
    sessionsRequiringSnapshot.delete(sessionId);
    sessionsRetryingStaleSnapshot.delete(sessionId);

    // Resync replaces the missed event stream, so a terminal snapshot must
    // also clear the local in-flight flag that normally ends with the turn.
    workspaceState.handleSessionSnapshot(
      sessionId,
      { inFlightTurn: snap.inFlightTurn, busy: snap.session.busy },
    );

    // The snapshot's inFlightTurn is main-agent-only — seed the indicator's
    // liveness flag from it (the projector was reset by the resync, so no
    // turn.ended may ever arrive for a turn that was live before it). Gated
    // on the snapshot's busy fact: the live tracker can hold a stale turn
    // whose turn.ended was lost (abrupt agent disposal) — the server-side
    // busy read is the reconciler, so a dead turn never relights the indicator.
    {
      if (snapMainTurnActive) rawState.turnActiveBySession[sessionId] = true;
      else delete rawState.turnActiveBySession[sessionId];
    }

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
    if (snapUsagePlaceholder && opts?.skipStatusRefresh !== true) void refreshSessionStatus(sessionId);
    void pullSessionWarnings(sessionId);
    return 'ok';
  } catch (err) {
    if (isSessionNotFoundError(err)) {
      await handleSessionNotFound(sessionId);
      return 'not-found';
    }
    pushOperationFailure('getSessionSnapshot', err, {
      title: t('warnings.sessionSnapshotTitle'),
      message: t('warnings.sessionSnapshotMessage'),
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

/** Whether the session should show a "working" indicator (sidebar spinner,
    row badge gating). ONE unified condition, shared with the working indicator and
    the Stop button: the main conversation has unfinished work — a prompt
    submitted but not yet terminated (`inFlightBySession`) or a main turn in
    flight (`turnActiveBySession`). Background tasks and subagent turns do NOT
    light it; an approval/question pause does NOT dim it (the turn is still
    open). */
function isMainTurnActive(sessionId: string, listed?: boolean): boolean {
  return (
    (rawState.inFlightBySession[sessionId] ?? false) ||
    (rawState.turnActiveBySession[sessionId] ?? false) ||
    (listed ??
      rawState.sessions.find((session) => session.id === sessionId)?.mainTurnActive ??
      false)
  );
}

/** Format createdAt/updatedAt into a short display string */
function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffH = diffMs / 3600000;
    if (diffMs < 60000) return t('sessions.justNow');
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
  import.meta.hot.dispose(() => {
    stopSessionTimeClock();
    enqueueEvent.dispose();
  });
}

/** Map AppQuestionRequest to UIQuestion */
function toUiQuestion(q: AppQuestionRequest): UIQuestion {
  return {
    questionId: q.questionId,
    sessionId: q.sessionId,
    toolCallId: q.toolCallId,
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
// One-shot bash-command index for the active session (task_id → command).
// The old findBashCommandForTask scanned the whole transcript twice PER task,
// and the tasks computed re-ran it every taskClock second while anything was
// running. This recomputes only when the session's messages change.
const bashCommandIndex = computed<Map<string, string>>(() => {
  const sid = rawState.activeSessionId;
  const messages = sid ? (rawState.messagesBySession[sid] ?? []) : [];
  const commandsByToolCallId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const part of msg.content) {
      if (part.type !== 'toolUse') continue;
      if (part.toolName !== 'Bash' && part.toolName !== 'bash') continue;
      const input = part.input as { command?: unknown } | undefined;
      const command = input && typeof input.command === 'string' ? input.command : undefined;
      if (command) commandsByToolCallId.set(part.toolCallId, command);
    }
  }
  const index = new Map<string, string>();
  if (commandsByToolCallId.size === 0) return index;
  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    for (const part of msg.content) {
      if (part.type !== 'toolResult') continue;
      // Flatten before matching (the transcript's normalizeToolOutput):
      // JSON.stringify on a ContentPart[] encodes newlines as literal "\n",
      // and \S+ would swallow them into the captured task id.
      const outputLines = normalizeToolOutput(part.output);
      if (!outputLines) continue;
      let taskId: string | undefined;
      for (const line of outputLines) {
        const match = /task_id:\s*(\S+)/.exec(line);
        if (match?.[1]) {
          taskId = match[1];
          break;
        }
      }
      if (!taskId) continue;
      const command = commandsByToolCallId.get(part.toolCallId);
      if (command) index.set(taskId, command);
    }
  }
  return index;
});

function findBashCommandForTask(task: AppTask): string | undefined {
  return bashCommandIndex.value.get(task.id);
}

// One-shot Agent-prompt index for the active session (parentToolCallId →
// prompt), same deal as the bash index: the old per-task traversal rescanning
// the transcript every taskClock second.
const agentPromptIndex = computed<Map<string, string | string[]>>(() => {
  const sid = rawState.activeSessionId;
  const messages = sid ? (rawState.messagesBySession[sid] ?? []) : [];
  const index = new Map<string, string | string[]>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const part of msg.content) {
      if (part.type !== 'toolUse') continue;
      const input = part.input as { prompt?: unknown; items?: unknown } | undefined;
      const prompt = input && typeof input.prompt === 'string' ? input.prompt : undefined;
      if (prompt && !index.has(part.toolCallId)) index.set(part.toolCallId, prompt);
      // AgentSwarm: one tool call spawns every member; each member's own task
      // text lives in input.items, addressed by the zero-based swarmIndex.
      const items = input?.items;
      if (!prompt && Array.isArray(items) && !index.has(part.toolCallId)) {
        const texts = items.filter((item): item is string => typeof item === 'string');
        if (texts.length > 0) index.set(part.toolCallId, texts);
      }
    }
  }
  return index;
});

/** The subagent's task prompt from its Agent tool call (linked through
    parentToolCallId) — the card grid's description line. */
function findSubagentPromptForTask(task: AppTask): string | undefined {
  if (!task.parentToolCallId) return undefined;
  const entry = agentPromptIndex.value.get(task.parentToolCallId);
  // A swarm's entry is the member list: pick this member's own task text.
  if (Array.isArray(entry)) {
    // swarmIndex is zero-based (see the session snapshot fixtures).
    return task.swarmIndex !== undefined ? entry[task.swarmIndex] : undefined;
  }
  return entry;
}

/** Map AppTask to UI TaskItem */
function toUiTask(task: AppTask): TaskItem {
  let state: TaskState;
  if (task.status === 'running') {
    state = 'run';
  } else if (task.status === 'completed') {
    state = 'done';
  } else if (task.status === 'cancelled') {
    // A user stop is not a failure — keep it distinct so cards/rows say so.
    state = 'cancelled';
  } else {
    state = 'fail';
  }

  // Compute timing string
  let timing = '';
  let durationMs: number | undefined;
  if (task.status === 'running' && task.startedAt) {
    durationMs = Date.now() - new Date(task.startedAt).getTime();
    const elapsed = Math.round(durationMs / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    timing = t('tasks.timingRunning', { time: `${m}:${String(s).padStart(2, '0')}` });
  } else if (task.completedAt && task.startedAt && !task.completedAtEstimated) {
    durationMs = new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime();
    timing = t('tasks.timingDone', {
      time: formatTaskDuration(durationMs, {
        h: t('status.timeUnitHour'),
        m: t('status.timeUnitMinute'),
        s: t('status.timeUnitSecond'),
      }),
    });
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
  // message when the task itself does not carry the command field. Subagent
  // cards show their task prompt (or type) the same way.
  const command = task.command ?? findBashCommandForTask(task);
  const meta =
    task.kind === 'bash' && command
      ? `$ ${command}`
      : task.kind === 'subagent'
        ? (findSubagentPromptForTask(task) ?? task.subagentType)
        : undefined;

  return {
    id: task.id,
    agentId: task.agentId,
    backgroundTaskId: task.backgroundTaskId,
    name: task.description,
    kind: task.kind,
    state,
    timing,
    durationMs,
    meta,
    output,
    runInBackground: task.runInBackground,
    parentToolCallId: task.parentToolCallId,
    swarmIndex: task.swarmIndex,
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    model: task.model,
    thinkingEffort: task.thinkingEffort,
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
      time: formatTime(s.updatedAt),
      busy: isMainTurnActive(s.id, s.mainTurnActive),
      pendingInteraction: s.pendingInteraction,
      lastTurnReason: s.lastTurnReason,
      // App.vue's workspace-delete cleanup matches sessions by workspaceId /
      // root — project both (they were read but never projected, so the match
      // silently never hit).
      workspaceId: workspaceIdForSession(s),
      cwd: s.cwd,
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

/** Whether the current scope's skill fetch has FINISHED (success or failure —
 *  the fetched marker lives apart from the data map so a failed fetch can
 *  still be retried on the next scope switch). The mention tooltip uses this
 *  to tell "skill not in the list" (degrade the pill) from "list still
 *  loading" (leave the pill focusable so a keyboard user can return once it
 *  arrives). */
const skillsLoaded = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  if (sid) return modelProvider.skillsFetchedBySession.value[sid] === true;
  const wid = activeWorkspaceId.value;
  return wid ? modelProvider.skillsFetchedByWorkspace.value[wid] === true : false;
});

const inFlight = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return false;
  return rawState.inFlightBySession[sid] ?? false;
});

// True while the empty-composer first prompt for the active workspace is being
// created + submitted (before the session id exists). Drives the empty-session
// "starting conversation…" loading state in ConversationPane / Composer.
const isStartingFirstPrompt = computed<boolean>(() => workspaceState.isStartingFirstPrompt());

const sideChat = useSideChat(rawState, {
  api: getKimiWebApi(),
  pushOperationFailure,
  nextOptimisticMsgId,
  connectEventsIfNeeded,
  getEventConn: () => eventConn,
  // modelProvider is defined further below; deferred like eventConn above.
  resolveThinkingForPrompt: (sessionId, modelId) =>
    modelProvider.resolveThinkingForPrompt(sessionId, modelId),
  refreshSessionStatus,
});

const activeAppTasks = computed<AppTask[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const hiddenBtwAgentId = sideChat.sideChatTargetBySession.value[sid]?.agentId;
  return (rawState.tasksBySession[sid] ?? []).filter((task) => task.id !== hiddenBtwAgentId);
});

const taskPoller = useTaskPoller(rawState, activeAppTasks, { api: getKimiWebApi() });

/** The MAIN agent of the active session has a turn in flight — the working
 *  indicator's authoritative half (the optimistic `inFlight` window covers the gap
 *  before the turn.started round-trips). Background agents and BTW side chats
 *  do NOT set this; the session-busy status lives on `activity`. */
const turnActive = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return false;
  return (
    (rawState.turnActiveBySession[sid] ?? false) ||
    (rawState.sessions.find((session) => session.id === sid)?.mainTurnActive ?? false)
  );
});

/** The active session's latest main-turn terminal error (provider failure
 *  after retry exhaustion), captured live from the agent's error event. Drives
 *  the persistent failed-turn card; undefined once a new turn starts. */
const activeTurnError = computed<AppTurnError | undefined>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return undefined;
  return rawState.turnErrorBySession[sid];
});

/** The active session's live step-retry state (present only while the main
 *  turn's current step backs off before a retry — e.g. provider 429). Drives
 *  the working indicator's "retrying (n/max)" label. */
const activeTurnRetry = computed<AppTurnRetry | undefined>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return undefined;
  // A retry backoff only exists inside a live main turn — never surface one
  // for a turn the snapshot/baseline paths already retired.
  if (!turnActive.value) return undefined;
  return rawState.turnRetryBySession[sid];
});

// Turns run through an incremental projector: unchanged turns keep their object
// identity across streaming frames (see turnsProjector.ts), so the keyed v-for
// downstream only patches the live tail. The projector is stateful (it caches
// its own previous output), so a plain computed preserves the old synchronous
// pull semantics while reuse happens inside each re-evaluation.
const getFileUrlById = (fileId: string): string => getKimiWebApi().getFileUrl(fileId);
const getSessionMediaUrl = (sessionId: string, fileId: string): string =>
  getKimiWebApi().getSessionMediaUrl(sessionId, fileId);
// Hoisted empty fallback: a fresh `[]` literal per projection would break the
// projector's approvals-identity reuse gate (see turnsProjector.ts).
const NO_PENDING_APPROVALS: AppApprovalRequest[] = [];
const turnsProjector = createTurnsProjector();
const turns = computed<ChatTurn[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const hiddenIds = new Set(rawState.sideChatUserMessageIdsBySession[sid] ?? []);
  return turnsProjector({
    messages: (rawState.messagesBySession[sid] ?? []).filter((m) => !hiddenIds.has(m.id)),
    approvals: rawState.approvalsBySession[sid] ?? NO_PENDING_APPROVALS,
    getFileUrl: getFileUrlById,
    getSessionMediaUrl,
    sessionActive: turnActive.value,
    planReviewByToolCallId: rawState.planReviewByToolCallId,
    plansByToolCallId: plansBySession[sid],
  });
});

/** The working indicator: the main conversation has an unfinished prompt — either
 *  submitted-but-not-terminated (`inFlight`) or a main turn in flight
 *  (`turnActive`). */
const working = computed<boolean>(() => inFlight.value || turnActive.value);

// Stable per-session card numbers for background subagents (identity to
// serial); entries are dropped with the rest of the session's state.
const subagentCardSerials = new Map<string, Map<string, number>>();

const tasks = computed<TaskItem[]>(() => {
  // Touch the clock so a running task's elapsed time recomputes each tick.
  void taskPoller.taskClock.value;
  const items = activeAppTasks.value.map(toUiTask);
  // Card numbers live inside the background-subagent set only (the grid's
  // actual population), and must be unique ACROSS the session: the server's
  // swarmIndex is scoped PER SWARM, so two swarms would each show a member
  // 01 in one grid. Assign session-wide serials in creation order instead —
  // filtering can't renumber, and bash/tool/foreground rows never consume
  // one. Number in CREATION order, not array order: keepLiveSubagents
  // returns REST rows before live-only rows, so array order is not creation
  // order and a later poll or WS fold would otherwise renumber a card. (The
  // sort is stable, so a row missing createdAt keeps its relative slot; the
  // swarm card in the message stream keeps the per-swarm swarmIndex from
  // activeAppTasks, where the group makes the scope explicit.)
  const sid = rawState.activeSessionId;
  if (sid) {
    // Numbers stick to a task once shown: they live in a per-session
    // identity-to-serial map, so a late-arriving historical row takes the
    // next tail number instead of renumbering every card already on screen.
    // (New rows are numbered in creation order.)
    let serials = subagentCardSerials.get(sid);
    if (!serials) {
      serials = new Map();
      subagentCardSerials.set(sid, serials);
    }
    const cards = items.filter((item) => item.kind === 'subagent' && item.runInBackground);
    // A REST row first shows under its background-task id and later folds to
    // the agent id — carry an already-shown number across that rekey.
    for (const item of cards) {
      const key = item.agentId ?? item.id;
      if (item.agentId !== undefined && item.backgroundTaskId !== undefined && !serials.has(key)) {
        const carried = serials.get(item.backgroundTaskId);
        if (carried !== undefined) {
          serials.delete(item.backgroundTaskId);
          serials.set(key, carried);
        }
      }
    }
    const unnumbered = cards
      .filter((item) => !serials.has(item.agentId ?? item.id))
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    let next = serials.size === 0 ? 0 : Math.max(...serials.values()) + 1;
    for (const item of unnumbered) serials.set(item.agentId ?? item.id, next++);
    for (const item of cards) item.swarmIndex = serials.get(item.agentId ?? item.id);
  }
  return items;
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
const webTitle = computed<string>(() => rawState.webTitle);
const experimentalFlags = computed<Record<string, boolean>>(() => rawState.experimentalFlags);
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
const thinking = computed<ThinkingLevel | undefined>(() => rawState.thinking);
// Mode toggles reflect the ACTIVE session (or the draft when no session is
// open). Each session keeps its own value in the *BySession maps above.
const planMode = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? (rawState.planModeBySession[sid] ?? false) : draftModes.planMode;
});
// The user's not-yet-cashed plan intent for the ACTIVE session (or draft).
// The composer's in-input directive pill reads this; the dock's plan pill
// reads the daemon fact (planMode) instead.
const planArmed = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? (rawState.planArmedBySession[sid] ?? false) : draftModes.planMode;
});
const swarmMode = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? (rawState.swarmModeBySession[sid] ?? false) : draftModes.swarmMode;
});
const goalMode = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? (rawState.goalModeBySession[sid] ?? false) : draftModes.goalMode;
});

/** The active session's persisted plans (ExitPlanMode receipts), keyed by
    toolCallId — the plan panel reads the latest one from here. Old daemons
    without /transcript/plan (or a transient sidecar failure) leave the bulk
    map empty even though the transcript still carries the ExitPlanMode
    payload, so recover those from the turns as a fallback. The merge keeps
    transcript order (a recovered newer plan stays last for latestPlan); the
    persisted record always wins per toolCallId. */
const sessionPlans = computed<Record<string, SessionPlan>>(() => {
  const sid = rawState.activeSessionId;
  const persisted = (sid ? plansBySession[sid] : undefined) ?? {};
  const byTurn: Record<string, SessionPlan> = {};
  const inTurns = new Set<string>();
  for (const turn of turns.value) {
    for (const tool of turn.tools ?? []) {
      if (tool.name !== 'ExitPlanMode') continue;
      inTurns.add(tool.id);
      const persistedPlan = persisted[tool.id];
      if (persistedPlan) {
        byTurn[tool.id] = persistedPlan;
        continue;
      }
      const review = rawState.planReviewByToolCallId[tool.id];
      const argPayload = parseExitPlanModeArg(tool.arg);
      const planText = review?.plan ?? argPayload?.plan;
      const path = tool.planPath ?? review?.path;
      if (!planText && !path) continue;
      byTurn[tool.id] = {
        agentId: 'main',
        toolCallId: tool.id,
        turnId: turn.id,
        source: 'interaction',
        plan: planText ?? '',
        path,
        options: argPayload?.options,
        // No persisted receipt covers this record — the settle event's
        // locally recorded outcome is the only review truth.
        review: settledPlanReviewByToolCallId[tool.id],
      };
    }
  }
  // Persisted records whose tool calls fall outside the loaded turns predate
  // the window — keep them ahead so at(-1) really is the transcript's last.
  const older = Object.fromEntries(Object.entries(persisted).filter(([id]) => !inTurns.has(id)));
  return { ...older, ...byTurn };
});

/** Read the ExitPlanMode tool input: the plan text and its option list. */
function parseExitPlanModeArg(
  arg: string,
): { plan?: string; options?: { label: string; description?: string }[] } | undefined {
  try {
    const input = JSON.parse(arg) as Record<string, unknown>;
    return {
      plan: typeof input['plan'] === 'string' ? input['plan'] : undefined,
      options: Array.isArray(input['options'])
        ? (input['options'] as { label: string; description?: string }[])
        : undefined,
    };
  } catch {
    return undefined;
  }
}

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
    transcript. Carries attachment thumbnails resolved from their owning store
    so image prompts don't render as empty bubbles. */
const queued = computed<QueuedPromptView[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const api = getKimiWebApi();
  return (rawState.queuedBySession[sid] ?? []).map((q) => ({
    // enqueue() always assigns an id; the text fallback mirrors the flush
    // failure-budget key for any hand-built entry.
    id: q.id ?? q.text,
    text: q.text,
    attachmentCount: q.attachments?.length ?? 0,
    attachments: q.attachments?.map((a) => promptAttachmentToTurnAttachment(api, a)),
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
  { approvalId: string; block: ApprovalBlock; agentName?: string; toolCallId?: string }[]
>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return (rawState.approvalsBySession[sid] ?? []).map((a) => ({
    approvalId: a.approvalId,
    block: buildApprovalBlock(a),
    agentName: (a as { agentName?: string }).agentName,
    toolCallId: a.toolCallId,
  }));
});

/**
 * Activity state for the active session.
 * Priority: awaiting-approval > awaiting-question > running > idle
 *
 * `running` is main-conversation liveness — the same condition as the working
 * indicator (the optimistic submit window or an in-flight main turn). The wire
 * `busy` fact deliberately includes background tasks, but everything driven
 * by `activity` (Stop button, composer/page-title spinners, send-vs-queue
 * gating) follows the main conversation only: a session left with only
 * background tasks is idle here, exactly like the retired turn-scoped status.
 */
const activity = computed<ActivityState>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return 'idle';

  const approvals = rawState.approvalsBySession[sid] ?? [];
  if (approvals.length > 0) return 'awaiting-approval';

  const questionList = rawState.questionsBySession[sid] ?? [];
  if (questionList.length > 0) return 'awaiting-question';

  if (inFlight.value || turnActive.value) {
    return 'running';
  }

  return 'idle';
});

const modelProvider = useModelProviderState(rawState, {
  api: getKimiWebApi(),
  pushOperationFailure,
  refreshSessionStatus,
  persistSessionProfile,
  savePlanModeToStorage,
  activity,
  updateSession,
  updateSessionMessages,
  // Lazy: workspaceState is composed below, but only invoked after creation.
  loadConfig: () => workspaceState.loadConfig(),
  checkAuth: () => workspaceState.checkAuth(),
  beginLocalTurn,
  settleLocalTurn,
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
const fileDiff = computed<DiffViewLine[]>(() => filesStore().fileDiffLines);

/** Cumulative cost (USD) for the active session, from daemon usage. 0 if unknown. */
const sessionCost = computed<number>(() => {
  const activeSession = rawState.sessions.find((s) => s.id === rawState.activeSessionId);
  return activeSession?.usage.totalCostUsd ?? 0;
});

const authReady = computed<boolean>(() => rawState.authReady);
const defaultModel = computed<string | null>(() => rawState.defaultModel);
const managedProviderStatus = computed<string | null>(() => rawState.managedProviderStatus);
const managedUserInfo = computed<ManagedUserInfo | null>(() => rawState.managedUserInfo);
const managedMembership = computed<ManagedMembership>(() => rawState.managedMembership);
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
 * root → workspace id lookup, rebuilt only when the workspace registry changes
 * (not on every session event). Keeps the FIRST entry per root — the daemon
 * orders by last_opened_at desc — matching mergeWorkspaces' dedup so sessions
 * land under the workspace the sidebar actually renders. The per-session
 * linear `workspaces.find` this replaces made every sidebar recompute
 * O(sessions × workspaces).
 */
const workspaceIdByRoot = computed(() => {
  const map = new Map<string, string>();
  for (const w of rawState.workspaces) {
    const key = workspaceRootKey(w.root);
    if (!map.has(key)) map.set(key, w.id);
  }
  return map;
});

/**
 * The workspace id a session belongs to: the first registered workspace whose
 * root identity-matches the session cwd (folds Windows case/slash variants —
 * keeps grouping consistent with `mergeWorkspaces` so a session never falls
 * out of the group the merge rendered); otherwise the daemon-provided
 * session.workspaceId; otherwise the cwd itself (derived/fallback mode).
 */
function workspaceIdForSession(s: { workspaceId?: string; cwd: string }): string {
  return workspaceIdByRoot.value.get(workspaceRootKey(s.cwd)) ?? s.workspaceId ?? s.cwd;
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
    sessionsHasMoreByWorkspace: rawState.sessionsHasMoreByWorkspace,
  }),
);

/**
 * User-defined display order of workspace ids, persisted to localStorage. The
 * sidebar stops following the daemon's recency-based order: once a workspace is
 * known, its position is fixed until the user drags it elsewhere.
 */
const workspaceOrder = ref<string[]>(loadWorkspaceOrder());

/** Sidebar workspace sort mode: the persisted manual order (default) or the
 *  recency ordering below. */
const workspaceSortMode = ref<WorkspaceSortMode>(loadWorkspaceSort());

function setWorkspaceSortMode(mode: WorkspaceSortMode): void {
  if (workspaceSortMode.value === mode) return;
  workspaceSortMode.value = mode;
  saveWorkspaceSort(mode);
}

/** Monotonic per-workspace recency floor (id → epoch ms), persisted. Folded
 *  from the session pool below; it only ever advances, so archiving or
 *  deleting a group's anchor session does not reshuffle the sidebar, while
 *  another group still overtakes it on real new activity. */
const workspaceRecencyFloor = ref<Record<string, number>>(loadWorkspaceRecencyFloor());

// Fold the pool's per-workspace max(updatedAt) into the floor. The pool only
// bumps updatedAt on real activity (the eventReducer's whitelist), so every
// fold is a durable signal. Session-array writes are always replace-style, so
// watching the reference is sufficient.
watch(
  () => rawState.sessions,
  (sessions) => {
    const current = currentActivityKeys(sessions, workspaceIdForSession);
    const { next, changed } = reconcileRecencyFloor(workspaceRecencyFloor.value, current);
    if (!changed) return;
    workspaceRecencyFloor.value = next;
    saveWorkspaceRecencyFloor(next);
  },
);

/** Recency key per workspace for the 'recent' sort: max(floor, last_opened_at)
 *  — both monotonic while a workspace lives, so a group only ever floats up,
 *  never sinks mid-session (e.g. on refresh while its first session page is
 *  still loading). */
const workspaceRecencyKeys = computed<ReadonlyMap<string, number>>(() =>
  buildWorkspaceRecencyKeys(mergedWorkspaces.value, workspaceRecencyFloor.value),
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
    // First launch (nothing stored): seed by recency (floor ∪ last_opened_at)
    // instead of the wire's append order. Once anything is stored the rank is
    // ignored and new ids keep prepending.
    const next = reconcileWorkspaceOrder(
      current,
      workspaceOrder.value,
      workspaceRecencyKeys.value,
    );
    if (next !== null) {
      workspaceOrder.value = next;
      saveWorkspaceOrder(next);
    }
    // GC recency-floor entries for workspaces that are gone (covers every
    // removal path: local delete, remote WS event, hide). Under the same
    // loading guard as the reconciler — a partial set must never prune.
    const { next: prunedFloor, changed: floorChanged } = pruneRecencyFloor(
      workspaceRecencyFloor.value,
      new Set(current),
    );
    if (floorChanged) {
      workspaceRecencyFloor.value = prunedFloor;
      saveWorkspaceRecencyFloor(prunedFloor);
    }
  },
);

// ---------------------------------------------------------------------------
// Pinned sessions (sidebar section above all workspace groups). The id list's
// truth source is the sessions store (persisted there to localStorage); this
// computed alias keeps the facade's read sites unchanged, and the actions
// below delegate to the store.
// ---------------------------------------------------------------------------
const pinnedSessionIds = computed<string[]>(() => sessionsStore().pinnedSessionIds);

/** Pin a session. New pins land at the END of the pinned section. */
function pinSession(id: string): void {
  sessionsStore().pinSession(id);
}

/** Unpin a session (no-op when it isn't pinned). */
function unpinSession(id: string): void {
  sessionsStore().unpinSession(id);
}

/** Unpin a batch of sessions (e.g. the backfill's stale-id cleanup). */
function unpinSessions(ids: string[]): void {
  sessionsStore().unpinSessions(ids);
}

/** Toggle entry point for the session-row menu (pin ↔ unpin). */
function togglePinSession(id: string): void {
  sessionsStore().togglePinSession(id);
}

/** Sidebar-facing workspace list. 'manual' mode follows the user's dragged /
 *  persisted order (reconciled against the daemon's workspace set by the
 *  watcher above); 'recent' mode sorts by the recency keys — monotonic, so a
 *  group never sinks while its workspace lives. */
const workspacesView = computed<WorkspaceView[]>(() => {
  const views = mergedWorkspaces.value.map((w) => ({
    id: w.id,
    name: w.name,
    root: w.root,
    shortPath: shortenHome(w.root, rawState.fsHome),
    sessionCount: w.sessionCount,
  }));
  if (workspaceSortMode.value === 'recent') {
    return sortWorkspacesByRecent(views, workspaceRecencyKeys.value);
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

// Browser tab base title: a `--web-title` override (reported via /meta) wins
// and stays fixed for the instance's lifetime; otherwise the title follows the
// active workspace's directory name (`<dir> | Kimi Code`). App.vue feeds this
// to usePageTitle — the single document.title writer — which prefixes the
// running spinner on top.
const documentBaseTitle = useDocumentTitle({
  webTitle,
  activeWorkspaceRoot: () => visibleWorkspace.value?.root ?? null,
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
        time: formatTime(s.updatedAt),
        busy: isMainTurnActive(s.id, s.mainTurnActive),
        pendingInteraction: s.pendingInteraction,
        lastTurnReason: s.lastTurnReason,
        lastPrompt: s.lastPrompt,
        workspaceId,
        workspaceName: nameByWorkspaceId.get(workspaceId),
      };
    });
});

/**
 * Flat sidebar list: every session across workspaces, newest first — the "flat"
 * counterpart of workspaceGroups. Data comes from the shared session pool; the
 * v2 paging actions (ensureFlatSessions/loadMoreFlatSessions) only pull older
 * sessions INTO the pool, so live WS updates, freshly created sessions and
 * local archives show up here for free (the v2 doc: the list endpoint is a
 * baseline seed, increments ride the WS). Pinned sessions are excluded — they
 * render in the pinned section, and a session renders exactly once (same rule
 * as the grouped list).
 *
 * The view paginates LOCALLY on top of the pool: the pool usually covers far
 * more than one v2 page on first paint (the grouped mode's per-workspace first
 * pages share the pool), so the flat list renders only the newest
 * `flatVisibleCount` rows and each "load more" click grows the window by one
 * page — revealing locally first, fetching only when the window outgrows the
 * pool (see the loadMoreFlatSessions wrapper below).
 */
const flatVisibleCount = ref(FLAT_SESSIONS_PAGE_SIZE);

const flatSessionsAll = computed<Session[]>(() => {
  void sessionTimeClock.value;
  const visibleWorkspaceIds = new Set(workspacesView.value.map((w) => w.id));
  const nameByWorkspaceId = new Map(workspacesView.value.map((w) => [w.id, w.name]));
  const pinnedSet = new Set(pinnedSessionIds.value);
  const byUpdatedDesc = (a: AppSession, b: AppSession) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  // Pure recency order (updatedAt desc) — no attention tiering: a status
  // (running / awaiting / aborted / unread) never floats a session above
  // newer ones, it only renders as the row's pill/spinner/dot.
  // The frontier still gates which pool rows may render: rows from other
  // sources (per-workspace v1 pages) carry no global-order guarantee beyond
  // the v2 walk's frontier (one workspace owning the newest 100 sessions
  // would otherwise leave a hole at rows 51–100). Rows with a live status
  // are exempt from the frontier — a session that just started running must
  // not vanish because its page hasn't been walked yet (visibility only;
  // its position is still its timestamp).
  const frontier = rawState.flatSessionsFrontier;
  const rows: AppSession[] = [];
  for (const s of rawState.sessions) {
    if (
      s.parentSessionId ||
      s.archived ||
      pinnedSet.has(s.id) ||
      !visibleWorkspaceIds.has(workspaceIdForSession(s))
    ) {
      continue;
    }
    const hasStatus =
      sessionDisplayStatus({
        busy: isMainTurnActive(s.id, s.mainTurnActive),
        unread: unreadBySession.value[s.id] ?? false,
        questionCount: pendingBySession.value[s.id]?.questions ?? 0,
        approvalCount: pendingBySession.value[s.id]?.approvals ?? 0,
        pendingInteraction: s.pendingInteraction,
        lastTurnReason: s.lastTurnReason,
      }) !== 'idle';
    if (!hasStatus && frontier !== null && new Date(s.updatedAt).getTime() < frontier) continue;
    rows.push(s);
  }
  rows.sort(byUpdatedDesc);
  return rows.map((s) => {
    const workspaceId = workspaceIdForSession(s);
    return {
      id: s.id,
      title: s.title,
      time: formatTime(s.updatedAt),
      busy: isMainTurnActive(s.id, s.mainTurnActive),
      pendingInteraction: s.pendingInteraction,
      lastTurnReason: s.lastTurnReason,
      lastPrompt: s.lastPrompt,
      updatedAt: s.updatedAt,
      workspaceId,
      workspaceName: nameByWorkspaceId.get(workspaceId),
      // 平铺行第二行：只显示最终目录名（产品约定）；cwd 缺失时显示 '-'。
      cwdLabel: s.cwd ? basename(s.cwd) : '-',
      pullRequest: s.pullRequest,
    };
  });
});

/** The flat list's visible window: the newest N rows — stretched to also
 *  cover any row with a live status beyond the window. A session that starts
 *  running / awaiting input / turns unread deep in the list keeps its
 *  timestamp position (pure time order) but must still RENDER: its status is
 *  the whole point of the row. Load-more still grows the base window. */
/** Row-level live-status check on the projected flat row (busy here is the
 *  effective main-turn flag; unread/pending counts ride the facade maps). */
function flatRowHasStatus(s: Session): boolean {
  return (
    sessionDisplayStatus({
      busy: s.busy,
      unread: unreadBySession.value[s.id] ?? false,
      questionCount: pendingBySession.value[s.id]?.questions ?? 0,
      approvalCount: pendingBySession.value[s.id]?.approvals ?? 0,
      pendingInteraction: s.pendingInteraction,
      lastTurnReason: s.lastTurnReason,
    }) !== 'idle'
  );
}

/** The effective render window: the base (user-driven) window stretched to
 *  also cover any row with a live status beyond it. A session that starts
 *  running / awaiting input / turns unread deep in the list keeps its
 *  timestamp position (pure time order) but must still RENDER: its status is
 *  the whole point of the row. This is the single source for the rendered
 *  slice AND the load-more bookkeeping, so the two never drift apart. */
const flatRenderCount = computed<number>(() => {
  const all = flatSessionsAll.value;
  let window = flatVisibleCount.value;
  for (let i = all.length - 1; i >= window; i--) {
    if (flatRowHasStatus(all[i]!)) {
      window = i + 1;
      break;
    }
  }
  return window;
});

const flatSessions = computed<Session[]>(() =>
  flatSessionsAll.value.slice(0, flatRenderCount.value),
);

/** More rows available, either on the server or already loaded past the
 *  (status-stretched) render window. */
const flatListHasMore = computed(
  () =>
    rawState.flatSessionsHasMore || flatRenderCount.value < flatSessionsAll.value.length,
);

/** One "load more" click: widen the window by one page PAST any status
 *  stretch (so the click always reveals fresh rows), and top the pool up
 *  only when the window outgrows it. */
function loadMoreFlatSessions(): void {
  flatVisibleCount.value = flatRenderCount.value + FLAT_SESSIONS_PAGE_SIZE;
  if (
    flatVisibleCount.value > flatSessionsAll.value.length &&
    rawState.flatSessionsHasMore
  ) {
    void workspaceState.loadMoreFlatSessions();
  }
}

// ---------------------------------------------------------------------------
// Done list (status view's 已完成 tab) — projection over rawState.doneSessions
// (kept out of the shared pool; see ExtendedState.doneSessions). A done session
// can still be chatted with, so rows carry the live status cluster like open
// rows: the v2 row's own activity snapshot is the baseline, and a pool row
// (present once the session has been opened this run) overrides it with live
// WS-driven state. The pool also bumps updatedAt on real activity, so the
// effective time is the newer of the two and the list re-sorts by it — a done
// session you keep chatting with floats to the top like an open one.
// ---------------------------------------------------------------------------
const doneVisibleCount = ref(FLAT_SESSIONS_PAGE_SIZE);

const doneSessionsAll = computed<Session[]>(() => {
  void sessionTimeClock.value;
  const visibleWorkspaceIds = new Set(workspacesView.value.map((w) => w.id));
  const nameByWorkspaceId = new Map(workspacesView.value.map((w) => [w.id, w.name]));
  return rawState.doneSessions
    .filter((s) => visibleWorkspaceIds.has(workspaceIdForSession(s)))
    .map((s) => {
      const workspaceId = workspaceIdForSession(s);
      const live = rawState.sessions.find((p) => p.id === s.id);
      const updatedAt =
        live !== undefined && new Date(live.updatedAt).getTime() > new Date(s.updatedAt).getTime()
          ? live.updatedAt
          : s.updatedAt;
      return {
        id: s.id,
        title: s.title,
        time: formatTime(updatedAt),
        busy: live?.busy ?? s.busy,
        pendingInteraction: live?.pendingInteraction ?? s.pendingInteraction,
        lastTurnReason: live?.lastTurnReason ?? s.lastTurnReason,
        lastPrompt: s.lastPrompt,
        updatedAt,
        workspaceId,
        workspaceName: nameByWorkspaceId.get(workspaceId),
        archived: true,
        cwdLabel: s.cwd ? basename(s.cwd) : '-',
        pullRequest: s.pullRequest,
      };
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
});

const doneSessions = computed<Session[]>(() =>
  doneSessionsAll.value.slice(0, doneVisibleCount.value),
);

const doneListHasMore = computed(
  () => rawState.doneSessionsHasMore || doneVisibleCount.value < doneSessionsAll.value.length,
);

/** One "load more" click on the done list: widen the window, topping up from
 *  the server only when the window outgrows the loaded rows. */
function loadMoreDoneSessions(): void {
  doneVisibleCount.value += FLAT_SESSIONS_PAGE_SIZE;
  if (doneVisibleCount.value > doneSessionsAll.value.length && rawState.doneSessionsHasMore) {
    void workspaceState.loadMoreDoneSessions();
  }
}

/** True when the ACTIVE session is archived (completed). Reachable only via a
 *  remote/WS archive while the session is open or a deep link — the local
 *  complete flow switches away from the session it archives. Drives the chat
 *  header's Done pill + reopen button. */
const activeSessionArchived = computed<boolean>(() => {
  const id = rawState.activeSessionId;
  if (!id) return false;
  return rawState.sessions.find((s) => s.id === id)?.archived === true;
});

/** Recent sessions of one workspace for the draft-state workspace home: open
 *  ones first (updatedAt desc), then done ones, capped. Read-only projection;
 *  the caller computes it inside its own computed for reactivity. */
function recentSessionsForWorkspace(workspaceId: string | null, limit = 6): Session[] {
  if (!workspaceId) return [];
  const nameByWorkspaceId = new Map(workspacesView.value.map((w) => [w.id, w.name]));
  const toRow = (s: AppSession, doneAt?: string): Session => ({
    id: s.id,
    title: s.title,
    time: formatTime(doneAt ?? s.updatedAt),
    busy: doneAt === undefined && isMainTurnActive(s.id, s.mainTurnActive),
    pendingInteraction: doneAt === undefined ? s.pendingInteraction : undefined,
    lastTurnReason: doneAt === undefined ? s.lastTurnReason : undefined,
    lastPrompt: s.lastPrompt,
    updatedAt: doneAt ?? s.updatedAt,
    workspaceId,
    workspaceName: nameByWorkspaceId.get(workspaceId),
    archived: doneAt !== undefined,
    cwdLabel: s.cwd ? basename(s.cwd) : '-',
    pullRequest: s.pullRequest,
  });
  const open = rawState.sessions
    .filter(
      (s) => !s.parentSessionId && !s.archived && workspaceIdForSession(s) === workspaceId,
    )
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const done = rawState.doneSessions.filter((s) => workspaceIdForSession(s) === workspaceId);
  return [
    ...open.map((s) => toRow(s)),
    ...done.map((s) => toRow(s, s.updatedAt)),
  ].slice(0, limit);
}

/**
 * Per-workspace groups for the 'all workspaces' scope. With `excludePinned`,
 * pinned sessions move OUT of their group into the pinned section above the
 * groups (counted per workspace so the group can note them instead of the
 * plain empty state). The mobile switcher sheet builds WITHOUT the filter —
 * it has no pinned section, and filtering would make a session pinned on
 * desktop unreachable (and un-unpinnable) on mobile.
 */
function buildWorkspaceGroups(excludePinned: boolean): WorkspaceGroup[] {
  void sessionTimeClock.value;
  const pinnedSet = new Set(pinnedSessionIds.value);
  const byId = new Map<string, Session[]>();
  const pinnedCountByWorkspace = new Map<string, number>();
  for (const s of rawState.sessions.toSorted(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )) {
    if (s.parentSessionId) continue; // child sessions stay out of the list
    // Archived rows normally never enter the pool, but opening a done session
    // pulls it in via fetchSessionIntoList — the flat list already excludes
    // archived rows; the grouped projection must too, or the open tab would
    // show (and re-offer completing) a completed session.
    if (s.archived) continue;
    const wid = workspaceIdForSession(s);
    if (excludePinned && pinnedSet.has(s.id)) {
      // Pinned sessions live in the pinned section — counted per workspace so
      // the group can say so when nothing unpinned remains (see the group
      // empty state).
      pinnedCountByWorkspace.set(wid, (pinnedCountByWorkspace.get(wid) ?? 0) + 1);
      continue;
    }
    const view: Session = {
      id: s.id,
      title: s.title,
      time: formatTime(s.updatedAt),
      busy: isMainTurnActive(s.id, s.mainTurnActive),
      pendingInteraction: s.pendingInteraction,
      lastTurnReason: s.lastTurnReason,
      updatedAt: s.updatedAt,
    };
    const list = byId.get(wid) ?? [];
    list.push(view);
    byId.set(wid, list);
  }
  return workspacesView.value.map((w) => ({
    workspace: w,
    sessions: byId.get(w.id) ?? [],
    pinnedCount: pinnedCountByWorkspace.get(w.id) ?? 0,
    hasMore: rawState.sessionsHasMoreByWorkspace[w.id] ?? false,
    loadingMore: rawState.sessionsLoadingMoreByWorkspace[w.id] ?? false,
    initialCount: rawState.sessionsInitialCountByWorkspace[w.id] ?? SESSIONS_INITIAL_PAGE_SIZE,
  }));
}

/** Sidebar groups: pinned sessions render in the pinned section, never here. */
const workspaceGroups = computed<WorkspaceGroup[]>(() => buildWorkspaceGroups(true));

/** Mobile switcher sheet groups: pinned sessions stay in their home groups. */
const mobileWorkspaceGroups = computed<WorkspaceGroup[]>(() => buildWorkspaceGroups(false));

/**
 * The pinned sidebar section: every pinned session across workspaces, in pure
 * recency order (updatedAt desc — no attention tiering, no manual order: the
 * stored id list is just a membership set). Pinned sessions are filtered
 * OUT of `workspaceGroups` above, so a session renders exactly once.
 * Visibility matches `sessionsForView`: child sessions, archived sessions
 * (archived elsewhere — a local archive already dropped the pin via
 * forgetSession), and sessions under a removed (hidden) workspace stay out.
 * A pinned id whose session is not loaded yet (the first page per workspace
 * is small) is backfilled during `load()` — until then it simply does not
 * render.
 */
const pinnedSessions = computed<Session[]>(() => {
  void sessionTimeClock.value;
  const visibleWorkspaceIds = new Set(workspacesView.value.map((w) => w.id));
  const nameByWorkspaceId = new Map(workspacesView.value.map((w) => [w.id, w.name]));
  const candidates = rawState.sessions.filter(
    (s) =>
      !s.parentSessionId && !s.archived && visibleWorkspaceIds.has(workspaceIdForSession(s)),
  );
  const pinned = partitionByPinned(candidates, pinnedSessionIds.value)
    .pinned.toSorted(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  return pinned.map((s) => {
    const workspaceId = workspaceIdForSession(s);
    return {
      id: s.id,
      title: s.title,
      time: formatTime(s.updatedAt),
      busy: isMainTurnActive(s.id, s.mainTurnActive),
      pendingInteraction: s.pendingInteraction,
      lastTurnReason: s.lastTurnReason,
      updatedAt: s.updatedAt,
      workspaceId,
      workspaceName: nameByWorkspaceId.get(workspaceId),
      pinned: true,
      // The pinned section is itself a flat list, so its rows always take the
      // flat-style layout (two lines, status on the right) regardless of the
      // sidebar's view mode — SessionRow keys that off cwdLabel.
      cwdLabel: s.cwd ? basename(s.cwd) : '-',
      pullRequest: s.pullRequest,
    };
  });
});

/**
 * Replace the workspace display order (e.g. after a drag reorder in the
 * sidebar) and persist it. The id set is unchanged, so the reconciliation
 * watcher above will not fire — only the sort in `workspacesView` reacts.
 */
function reorderWorkspaces(ids: string[]): void {
  workspaceOrder.value = ids;
  saveWorkspaceOrder(ids);
}

/**
 * Per-session pending-attention count = pending approvals + pending questions.
 * For the active session this is live (driven by WS events). Other sessions
 * are derived from whatever approvals/questions we've already seen; the row's
 * list-level pendingInteraction fact supplies the pre-status badge fallback.
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
// Driven by the main agent's turn.ended boundary (wired in
// connectEventsIfNeeded), NOT by the active-session `activity` computed: a
// watcher on `activity` only ever saw the ACTIVE session, so a session that
// finished in the background kept its in-flight flag forever — every later
// prompt to it was silently enqueued and never flushed. The session-busy
// status stream is deliberately NOT the trigger: background agents keep it
// non-idle past the main turn's end, which would hold the indicator and the queue.
// ---------------------------------------------------------------------------

const workspaceState = useWorkspaceState(rawState, {
  taskPoller,
  sideChat,
  modelProvider,
  pushOperationFailure,
  notify: pushWarning,
  activity,
  sessionsKnownEmpty,
  setSessions,
  updateSession,
  upsertSessionSorted,
  appendSession,
  forgetSession,
  unpinSessions,
  setActiveSessionId,
  updateSessionMessages,
  nextOptimisticMsgId,
  getEventConn: () => eventConn,
  syncSessionFromSnapshot,
  reopenSession,
  hasLoadedMessages,
  refreshSessionStatus,
  refreshSessionGoal,
  refillSessionGoalOnReload,
  refreshSessionPlans,
  settlePlanReviewLocally,
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
  initialized,
  connectIssue,
});

// Session admin page (/admin/sessions) data layer — server-side paged table.
// Seeded on entry into the page (the facade owns mainView, so the watcher
// lives here rather than in the view component).
const sessionAdmin = useSessionAdmin({
  pushOperationFailure,
  applySessionsArchivedLocally: workspaceState.applySessionsArchivedLocally,
});
watch(
  () => rawState.mainView,
  (view) => {
    if (view === 'sessionAdmin') sessionAdmin.ensureSeeded();
  },
);

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

/**
 * Authoritative-quiet escape hatch. The session's idle/aborted status means no
 * main turn can still be in flight (an awaiting interaction would report
 * awaiting_*, not idle), so both working-indicator flags are cleared even when the
 * turn.ended that owned them never arrived (e.g. abrupt agent disposal). This
 * is the ONLY writer of `turnActiveBySession` outside the reducer /
 * snapshot seed, and the ONLY clearer of `inFlightBySession` outside
 * finishPromptLocal / the entry points' error paths. Drain and completion
 * side effects are NOT run here — they stay single-owned by the turn.ended
 * path (onMainTurnEnd).
 */
function clearWorkingFlags(sid: string): void {
  if (rawState.turnActiveBySession[sid]) {
    delete rawState.turnActiveBySession[sid];
  }
  if (rawState.inFlightBySession[sid]) {
    rawState.inFlightBySession[sid] = false;
  }
}

function onMainTurnEnd(sid: string, status: 'idle' | 'aborted', turnWasActive: boolean): void {
  // Capture before finishPromptLocal drops it — it keys the completion
  // notification's dedup tag so each finished turn alerts once.
  const finishedPromptId = rawState.promptIdBySession[sid];
  // A goal run drives many turn boundaries (each continuation is a full
  // prompt→turn cycle). Intermediate boundaries must not light the unread dot
  // or fire a notification per turn — the user should be told once, when the
  // goal STOPS needing to run. Timing makes this predicate exact: a terminal
  // UpdateGoal fires goalUpdated mid-turn (seq ahead of that turn's turn.ended;
  // 'complete' clears the entry, 'blocked'/'paused' keep a non-active status),
  // so only genuinely-intermediate boundaries read 'active' here. A goal-state
  // refetch still in flight (the post-reload refill) counts as active too —
  // the first intermediate boundary could otherwise beat the refill.
  const goalActive =
    rawState.goalBySession[sid]?.status === 'active' || goalFetchPendingBySession.has(sid);
  // Shared finish cleanup: clears in-flight/prompt-id and drains one
  // queued message. The notification/unread side effects below stay
  // WS-event-only — the snapshot path (handleSessionSnapshot) must not cry
  // wolf when opening a historical session.
  workspaceState.finishPromptLocal(sid, { turnWasActive });

  // AI auto-title retry boundary: no-op once a title has been applied (or the
  // attempt budget is spent) — see maybeGenerateSessionTitle. Rides the
  // experimental `auto_session_title` flag (server meta flags win over the
  // persisted [experimental] config section).
  if (
    (rawState.experimentalFlags?.['auto_session_title'] ??
      rawState.config?.experimental?.['auto_session_title']) === true
  ) {
    workspaceState.maybeGenerateSessionTitle(sid);
  }

  // Refresh git status after every turn (the agent may have edited files or
  // opened a PR): for the on-screen session this drives the header; the load
  // also mirrors pullRequest into the sessions pool — the sidebar row's only
  // live update channel, since WS events never carry the git domain.
  void filesStore().loadGitStatus(sid);
  if (sid === rawState.activeSessionId) {
    // Runtime status (model/context usage may have changed this turn) is only
    // shown for the session on screen.
    void refreshSessionStatus(sid);
  } else if (status === 'idle' && !goalActive) {
    // A background session finished a turn the user hasn't seen — light up its
    // unread dot until they open it. Aborted (cancelled/failed) turns are
    // excluded on purpose: there is no fresh result to read, and counting them
    // is what made the sidebar fill with stale unreads after a refresh.
    rawState.unreadBySession[sid] = true;
    saveUnread({ [sid]: true });
  }

  // Browser notification when the user isn't watching this session.
  // Only real completions notify; aborted turns and turns that ended up
  // blocked on approval/question do not fire the generic "Turn finished" alert.
  const hasPendingApproval = (rawState.approvalsBySession[sid] ?? []).length > 0;
  const hasPendingQuestion = (rawState.questionsBySession[sid] ?? []).length > 0;
  if (!goalActive && shouldNotifyCompletion(status, hasPendingApproval, hasPendingQuestion)) {
    notificationsStore().maybeNotifyCompletion(sid, {
      isUserWatching: isUserWatching(sid),
      sessionTitle: rawState.sessions.find((s) => s.id === sid)?.title ?? '',
      promptId: finishedPromptId,
      onClick: () => {
        void workspaceState.selectSession(sid, { source: 'notification' });
      },
    });
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
  notificationsStore().maybeNotifyQuestion({
    isUserWatching: isUserWatching(sid),
    sessionTitle: rawState.sessions.find((s) => s.id === sid)?.title ?? '',
    questionPreview: preview,
    questionId: question.questionId,
    onClick: () => {
      void workspaceState.selectSession(sid, { source: 'notification' });
    },
  });
}

function onApprovalRequested(sid: string, approval: AppApprovalRequest): void {
  // Browser notification when the user isn't watching this session.
  notificationsStore().maybeNotifyApproval({
    isUserWatching: isUserWatching(sid),
    sessionTitle: rawState.sessions.find((s) => s.id === sid)?.title ?? '',
    toolName: approval.toolName,
    approvalId: approval.approvalId,
    onClick: () => {
      void workspaceState.selectSession(sid, { source: 'notification' });
    },
  });
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
    mobileWorkspaceGroups,
    pinnedSessions,
    flatSessions,
    flatSessionsHasMore: flatListHasMore,
    flatSessionsLoadingMore: computed(() => rawState.flatSessionsLoadingMore),
    doneSessions,
    doneSessionsHasMore: doneListHasMore,
    doneSessionsLoadingMore: computed(() => rawState.doneSessionsLoadingMore),
    activeSessionArchived,
    recentSessionsForWorkspace,
    draftEntry: computed(() => rawState.draftEntry),
    mainView: computed(() => rawState.mainView),
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
    findBashCommandForTask,
    auxiliaryTranscripts,
    getFileUrl: getFileUrlById,
    getSessionMediaUrl,
    todos,
    goal,
    sessionPlans,
    refreshSessionPlans,
    invalidateSessionPlans,
    swarms,
    swarmMembersByToolCallId,
    activationBadges,
    compaction,
    status,
    sessionCost,
    fileDiff,
    selectedDiffPath: computed(() => filesStore().selectedDiffPath),
    fileDiffLoading: computed(() => filesStore().fileDiffLoading),
    fileDiffTexts: computed(() => filesStore().fileDiffTexts),
    fileDiffEmptyFile: computed(() => filesStore().fileDiffEmptyFile),
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
    webTitle,
    documentBaseTitle,
    backend,
    dangerousBypassAuth,
    experimentalFlags,
    clearDangerousBypassAuth,
    initialized,
    connectIssue,
    permission,
    thinking,
    planMode,
    planArmed,
    swarmMode,
    goalMode,
    queued,
    warnings,
    questions,
    activity,
    turnActive,
    activeTurnError,
    activeTurnRetry,
    inFlight,
    working,
    isStartingFirstPrompt,

    // Model + Provider reactive state
    models: modelProvider.models,
    starredModelIds: modelProvider.starredModelIds,
    providers: modelProvider.providers,

    fontScale: appearance.fontScale,
    setFontScale: appearance.setFontScale,

    // Color scheme
    colorScheme: appearance.colorScheme,
    setColorScheme: appearance.setColorScheme,

    notifyEnabled: computed(() => notificationsStore().notifyEnabled),
    notifySound: computed(() => notificationsStore().notifySound),
    notifyPermission: computed(() => notificationsStore().notifyPermission),
    setNotifyEnabled: (on: boolean) => notificationsStore().setNotifyEnabled(on),
    setNotifySound: (on: boolean) => notificationsStore().setNotifySound(on),
    onboarded,
    setOnboarded,

    // Actions
    load: workspaceState.load,
    selectSession: workspaceState.selectSession,
    clearActiveSession: workspaceState.clearActiveSession,
    /** Open the session admin page. A workspace id (the workspace home's
     *  查看更多 entry) pre-selects that workspace in the filter bar — applied
     *  BEFORE the view switch so its fetch doubles as the seed, and the
     *  entry watcher's ensureSeeded no-ops: one entry, one list request.
     *  The sidebar menu entry passes none and keeps the current conditions. */
    openSessionAdmin: (workspaceId?: string) => {
      if (workspaceId !== undefined) {
        sessionAdmin.applyFilters({
          workspaceIds: [workspaceId],
          status: 'all',
          updatedFrom: '',
          updatedTo: '',
        });
      }
      workspaceState.openSessionAdmin();
    },
    closeSessionAdmin: workspaceState.closeSessionAdmin,

    // Session admin page (/admin/sessions): server-side paged table state +
    // filter/page setters. Row mapping (workspace names, time strings) is the
    // view's job — items stay raw V2Session.
    sessionAdminItems: computed(() => sessionAdmin.state.items),
    sessionAdminTotal: computed(() => sessionAdmin.state.total),
    sessionAdminLoading: computed(() => sessionAdmin.state.loading),
    sessionAdminFilters: computed(() => sessionAdmin.state.filters),
    sessionAdminPage: computed(() => sessionAdmin.state.page),
    sessionAdminPageSize: computed(() => sessionAdmin.state.pageSize),
    refreshSessionAdminSessions: sessionAdmin.refresh,
    applySessionAdminFilters: sessionAdmin.applyFilters,
    setSessionAdminWorkspaceFilter: sessionAdmin.setWorkspaceIds,
    setSessionAdminStatusFilter: sessionAdmin.setStatus,
    setSessionAdminTimeRange: sessionAdmin.setTimeRange,
    setSessionAdminPage: sessionAdmin.setPage,
    setSessionAdminPageSize: sessionAdmin.setPageSize,

    // Session admin selection (kept across pages/filters) + batch ops. The
    // Set/Map are reactive — template .has()/.size reads track fine.
    sessionAdminSelectedIds: computed(() => sessionAdmin.state.selectedIds),
    sessionAdminSelectedCount: computed(() => sessionAdmin.state.selectedIds.size),
    /** Selected ids split by lifecycle: the batch bar's Mark-as-done runs on
     *  the open subset, Reopen on the done subset (counts + disables). */
    sessionAdminOpenSelectedIds: computed(() => sessionAdmin.selectedIdsByArchived(false)),
    sessionAdminDoneSelectedIds: computed(() => sessionAdmin.selectedIdsByArchived(true)),
    toggleSessionAdminSelection: sessionAdmin.toggleSelection,
    toggleSessionAdminPageSelection: sessionAdmin.togglePageSelection,
    setSessionAdminSelection: sessionAdmin.setSelection,
    clearSessionAdminSelection: sessionAdmin.clearSelection,
    /** Gmail-style select-all-matching: materialize every id matching the
     *  current filters into the selection (ids projection, cursor-walked). */
    selectSessionAdminAllMatching: sessionAdmin.selectAllMatching,
    sessionAdminAllMatching: computed(() => sessionAdmin.state.allMatching),
    sessionAdminMaterializingAll: computed(() => sessionAdmin.state.materializingAll),
    archiveSessions: sessionAdmin.archiveSessions,
    restoreSessions: sessionAdmin.restoreSessions,
    loadOlderMessages: workspaceState.loadOlderMessages,

    // Workspace actions
    loadWorkspaces: workspaceState.loadWorkspaces,
    loadMoreSessions: workspaceState.loadMoreSessions,
    loadAllSessions: workspaceState.loadAllSessions,
    ensureFlatSessions: workspaceState.ensureFlatSessions,
    loadMoreFlatSessions,
    ensureDoneSessions: workspaceState.ensureDoneSessions,
    loadMoreDoneSessions,
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
    regenerateSessionTitle: workspaceState.regenerateSessionTitle,
    renameWorkspace: workspaceState.renameWorkspace,
    deleteWorkspace: workspaceState.deleteWorkspace,
    reorderWorkspaces,
    setWorkspaceSortMode,
    pinSession,
    unpinSession,
    togglePinSession,
    archiveSession: workspaceState.archiveSession,
    exportSession: workspaceState.exportSession,
    restoreSession: workspaceState.restoreSession,
    loadArchivedSessions: workspaceState.loadArchivedSessions,
    compact: workspaceState.compact,
    forkSession: workspaceState.forkSession,
    undo: workspaceState.undo,

    // New Phase 4 actions
    unqueue: workspaceState.unqueue,
    reorderQueue: workspaceState.reorderQueue,
    searchFiles: workspaceState.searchFiles,
    loadGitStatus: filesStore().loadGitStatus,
    loadFileDiff: filesStore().loadFileDiff,
    clearFileDiff: filesStore().clearFileDiff,

    // File system actions
    listDir: workspaceState.listDir,
    readFileContent: filesStore().readFileContent,
    readHostFileContent: workspaceState.readHostFileContent,
    probeWorkspacePath: workspaceState.probeWorkspacePath,
    getFileDownloadUrl: workspaceState.getFileDownloadUrl,
    openWorkspaceFile: workspaceState.openWorkspaceFile,
    openInApp: workspaceState.openInApp,
    revealWorkspaceFile: workspaceState.revealWorkspaceFile,
    resolveImageUrl: workspaceState.resolveImageUrl,

    // Model + Provider actions
    loadModels: modelProvider.loadModels,
    loadProviders: modelProvider.loadProviders,
    skills,
    skillsLoaded,
    activateSkill: modelProvider.activateSkill,
    setModel: modelProvider.setModel,
    toggleStarModel: modelProvider.toggleStarModel,
    addProvider: modelProvider.addProvider,
    updateProvider: modelProvider.updateProvider,
    getProvider: modelProvider.getProvider,
    deleteProvider: modelProvider.deleteProvider,
    refreshProvider: modelProvider.refreshProvider,
    refreshAllProviders: modelProvider.refreshAllProviders,
    loadCatalogProviders: modelProvider.loadCatalogProviders,
    importCatalogProvider: modelProvider.importCatalogProvider,
    importCustomRegistry: modelProvider.importCustomRegistry,

    // Auth state
    authReady,
    defaultModel,
    managedProviderStatus,
    managedUserInfo,
    managedMembership,

    // Transient notices (WarningToasts)
    notify: pushWarning,

    // Config state + actions
    config,
    loadConfig: workspaceState.loadConfig,
    updateConfig: workspaceState.updateConfig,

    // Auth actions
    checkAuth: workspaceState.checkAuth,
    probeManagedMembership: workspaceState.probeManagedMembership,
    startOAuthLogin: modelProvider.startOAuthLogin,
    pollOAuthLogin: modelProvider.pollOAuthLogin,
    cancelOAuthLogin: modelProvider.cancelOAuthLogin,
    getUsage: modelProvider.getUsage,
    logout: workspaceState.logout,
  };
}

// Re-export types used by wired components so they can import from one place
export type { ApprovalDecision, AppModel, AppProvider };
