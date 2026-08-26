// Vue state composable — the shared client facade singleton. Components consume
// computed view props and call actions; they never touch the API or reducer.
// Platform differences arrive via ./deps injection (api / t / tracer / native
// terminal / telemetry), registered by each app's composition root.

import { computed, reactive, ref, shallowReactive, watch } from 'vue';
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
import { buildApprovalBlock } from '@moonshot-ai/app-core/client';
import { ackThinkingPending, foldDaemonThinkingLevel } from '@moonshot-ai/app-core/lib';
import { ackSwarmPending, foldDaemonSwarmMode } from '@moonshot-ai/app-core/lib';
import { ackPlanPending, foldDaemonPlanMode } from '@moonshot-ai/app-core/lib';
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
  splitOversizedAppRenderEvent,
  type PendingAppEvent,
} from '@moonshot-ai/app-core/client';
import { applyRecordDiff } from '@moonshot-ai/app-core/client';
import { createMainTurnsProjector, interactionToApproval, interactionToQuestion } from '@moonshot-ai/app-core/client';
import { transcriptTasksToAppTasks, spawnedParentByAgentId, type SpawnedIndex } from '@moonshot-ai/app-core/client';
import { messagesToTurns } from '@moonshot-ai/app-core/client';
import { normalizeToolOutput } from '@moonshot-ai/app-core/client';
import { useAppearance } from '@moonshot-ai/app-core';
import { shouldNotifyCompletion } from '../composables/useNotification';
import { notificationsStore } from '../stores/notifications';
import { promptAttachmentToTurnAttachment } from './attachmentsToContent';
import { useModelProviderState } from './useModelProviderState';
import { useSideChat } from './useSideChat';
import { useTaskPoller } from './useTaskPoller';
import type { ExtendedState, ManagedMembership } from './types';
import { createAuxiliaryTranscriptPool } from '../composables/useAuxiliaryTranscripts';
import { createMainTranscriptHost } from '../composables/useMainTranscriptHost';
import type { MainTranscriptEntry } from '../composables/useMainTranscripts';
import type { TranscriptTurn } from '@moonshot-ai/app-core/transcript';
import { itemId as transcriptItemId, type AgentTranscriptSnapshot, type TranscriptItem, type TranscriptPrompt } from '@moonshot-ai/app-core/transcript';
import {
  beginLocalTurn,
  FLAT_SESSIONS_PAGE_SIZE,
  forgetLocalTurnState,
  localTurnStartState,
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
  buildAgentErrorNotice,
  toAppEvent,
  shallowEqualArray,
  type CompactionStatus,
  type KimiClientState,
} from '@moonshot-ai/app-core/api';

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
  draftThinkingExplicit: false,
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
  pendingPlanBySession: {},
  swarmModeBySession: loadModeMapFromStorage(SWARM_MODE_STORAGE_KEY),
  pendingSwarmBySession: {},
  goalModeBySession: loadModeMapFromStorage(GOAL_MODE_STORAGE_KEY),
  loading: false,
  sessionLoading: false,
  queuedBySession: {},
  promptIdBySession: {},
  abortPromptIdBySession: {},
  inFlightBySession: {},
  optimisticMessagesBySession: {},
  sessionLastTurnReasonSeqBySession: {},
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
  sideChatUserMessageIdsBySession: {},
  sideChatSendingByAgent: {},
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
 * re-subscribes at the last durable cursor. The transcript channels recover
 * themselves (their own stale check + gap-driven baseline refresh).
 */
function recoverStaleConnection(): void {
  if (eventConn !== null && eventConn.health().stale) {
    traceKeyEvent('ws:stale-reconnect', {
      sessionId: rawState.activeSessionId,
      status: 'stale',
    });
    traceClientEvent('ws: stale socket on focus, reconnecting', {
      activeSessionId: rawState.activeSessionId,
    });
    eventConn.reconnect();
  }
  mainTranscriptHost.recoverIfStale();
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

// The seq of the latest ARCHIVED-state-changing event per session (archive OR
// restore): the resync session-fact read compares against this — an archived
// answer from inside the gap must not apply when a restore landed mid-read,
// and a same-value ABA flip can't be told by field comparison alone.
const sessionArchivedSeqBySid = new Map<string, number>();
// Same gate for the title: sessionMetaUpdated patches can ABA the field
// mid-read (A→B→A), and no later baseline restores a title overwritten stale.
const sessionTitleSeqBySid = new Map<string, number>();
// Bumped synchronously on every resync per session: a getSession read
// superseded by a LATER resync must drop its result — the newer resync's own
// read converges everything, and the older one's stale fields (REST commits
// don't advance the event seq) would otherwise win on landing order alone.
const resyncGenerationBySid = new Map<string, number>();

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
  mainTranscriptHost.forgetSession(sessionId);
  // Side-chat buckets keyed by this session (and its BTW agent): target,
  // messages, sending flags, and the user-message id set.
  sideChat.clearSideChatForSession(sessionId);
  subagentCardSerials.delete(sessionId);
  dropWsSubscription(sessionId);
  // Drop this session's queued render AND control events. Flushing them here is
  // unsafe: a delayed idle event can drain a queued prompt into the session
  // after the archive request succeeded. Other sessions keep their own ordered
  // backlog and scheduled continuation.
  enqueueEvent.discard(({ meta }) => meta.sessionId === sessionId);
  removeSession(sessionId);
  forgetSessionPlans(sessionId);
  approvalsStore().clearSessionApprovals(sessionId);
  approvalsStore().clearSessionQuestions(sessionId);
  delete rawState.tasksBySession[sessionId];
  delete rawState.goalBySession[sessionId];
  filesStore().clearSessionGitStatus(sessionId);
  delete rawState.lastSeqBySession[sessionId];
  delete rawState.compactionBySession[sessionId];
  delete rawState.optimisticMessagesBySession[sessionId];
  settledTurnEndBySession.delete(sessionId);
  spawnedIndexCacheBySid.delete(sessionId);
  loadOlderFailedAtBySid.delete(sessionId);
  sessionArchivedSeqBySid.delete(sessionId);
  sessionTitleSeqBySid.delete(sessionId);
  resyncGenerationBySid.delete(sessionId);
  sessionStatusVersionBySid.delete(sessionId);
  {
    const retry = statusConfirmRetryBySid.get(sessionId);
    if (retry?.timer != null) clearTimeout(retry.timer);
    statusConfirmRetryBySid.delete(sessionId);
  }
  consumedEchoPromptIdsBySid.delete(sessionId);
  consumedSkillEchoIdsBySid.delete(sessionId);
  for (const key of [...auxNotifiedInteractionIdsByKey.keys()]) {
    if (key.startsWith(`${sessionId}:`)) auxNotifiedInteractionIdsByKey.delete(key);
  }
  delete rawState.sessionLastTurnReasonSeqBySession[sessionId];
  sessionsKnownEmpty.delete(sessionId);
  // In-flight / queued prompt state: drop these too so a queued follow-up
  // can't be submitted to a session that was just archived when its turn later
  // ends (onMainTurnEnd drains queuedBySession[sid] without re-checking
  // that the session still exists).
  forgetLocalTurnState(sessionId);
  delete rawState.queuedBySession[sessionId];
  delete rawState.promptIdBySession[sessionId];
  delete rawState.abortPromptIdBySession[sessionId];
  delete rawState.inFlightBySession[sessionId];
  delete rawState.turnActiveBySession[sessionId];
  delete rawState.turnEndedPromptIdBySession[sessionId];
  delete rawState.turnErrorBySession[sessionId];
  delete rawState.turnRetryBySession[sessionId];
  // Drop per-session mode toggles and re-persist so a deleted session's entry
  // doesn't linger in localStorage.
  delete rawState.planModeBySession[sessionId];
  delete rawState.planArmedBySession[sessionId];
  delete rawState.pendingPlanBySession[sessionId];
  delete rawState.swarmModeBySession[sessionId];
  delete rawState.pendingSwarmBySession[sessionId];
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

/** Full teardown for a session discovered gone server-side (a not-found read
 *  or a deletion inside the resync gap): the forgetSession wipe PLUS the
 *  live-deletion path's native teardown, and — when the session was on
 *  screen — navigation/loading cleanup so the UI doesn't wait on a baseline
 *  that can never arrive. */
function handleSessionGone(sessionId: string): void {
  const wasActive = rawState.activeSessionId === sessionId;
  forgetSession(sessionId);
  notifySessionDestroyed(sessionId);
  if (wasActive) {
    workspaceState.clearActiveSession();
    rawState.sessionLoading = false;
  }
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
async function refreshSessionStatus(
  sessionId: string,
  opts?: {
    throughShield?: { swarm?: boolean; plan?: boolean };
    /** The write tokens the confirmation carries: a field may fold through
     *  the shield only while its token is still the field's CURRENT pending
     *  token — a newer write since makes this answer stale for the field. */
    throughTokens?: { swarm?: number; plan?: number };
  },
): Promise<boolean> {
  const statusVersionBefore = sessionStatusVersionBySid.get(sessionId) ?? 0;
  let st: AppSessionRuntimeStatus;
  try {
    st = await getKimiWebApi().getSessionStatus(sessionId);
  } catch {
    return false; // status endpoint missing/unreachable — keep what we have.
  }
  // A transcript meta fold landed mid-read — the live fact is newer; this
  // stale answer must not revert model/thinking/modes back to it.
  if ((sessionStatusVersionBySid.get(sessionId) ?? 0) !== statusVersionBefore) return false;
  updateSession(sessionId, (s) => ({
    ...s,
    model: st.model || s.model,
    usage: {
      ...s.usage,
      contextTokens: st.contextTokens,
      contextLimit: st.maxContextTokens,
    },
  }));
  // persistSessionProfile's confirmation read folds THROUGH the mode shields:
  // it is the write's own authoritative echo (the shield only exists to hold
  // back information OLDER than the write — this answer is newer). Only the
  // fields THIS confirmation covers get folded: interleaved writes mean an
  // older confirmation answering last must not overwrite a newer field's
  // already-confirmed pick. And a covered field folds only while the
  // request's token still IS the field's current pending token: a newer
  // write since makes this answer stale for the field — the newer shield
  // survives the ack mismatch but cannot undo an overwrite of the base.
  if (opts?.throughShield !== undefined) {
    const swarmOwned =
      opts.throughShield.swarm === true &&
      (opts.throughTokens?.swarm === undefined ||
        rawState.pendingSwarmBySession[sessionId] === opts.throughTokens.swarm);
    const planOwned =
      opts.throughShield.plan === true &&
      (opts.throughTokens?.plan === undefined ||
        rawState.pendingPlanBySession[sessionId] === opts.throughTokens.plan);
    if (swarmOwned) {
      rawState.swarmModeBySession = {
        ...rawState.swarmModeBySession,
        [sessionId]: st.swarmMode,
      };
    } else if (opts.throughShield.swarm !== true) {
      foldDaemonSwarmMode(rawState, sessionId, st.swarmMode);
    }
    if (planOwned) {
      rawState.planModeBySession = {
        ...rawState.planModeBySession,
        [sessionId]: st.planMode,
      };
    } else if (opts.throughShield.plan !== true) {
      foldDaemonPlanMode(rawState, sessionId, st.planMode);
    }
  } else {
    foldDaemonSwarmMode(rawState, sessionId, st.swarmMode);
    foldDaemonPlanMode(rawState, sessionId, st.planMode);
  }
  // The authoritative fold supersedes the deprecated-map seed — drop it.
  safeRemove(STORAGE_KEYS.planMode);
  // Fold the session's own thinking level too — per-session state wins over the
  // per-model storage pick (see thinkingBySession on ExtendedState).
  if (st.thinkingEffort.length > 0) {
    foldDaemonThinkingLevel(rawState, sessionId, st.thinkingEffort as ThinkingLevel);
  }
  return true;
}

// A reload-time goal-state refill in flight (see useWorkspaceState load()).
// onMainTurnEnd treats these sessions as goal-active while the refill is
// pending: the first intermediate goal boundary after a reload could
// otherwise arrive before the refill lands and leak one unread dot +
// completion notification. Deliberately NOT set for ordinary
// refreshSessionGoal callers (e.g. selectSession's sidecar refresh) — a
// non-goal session's completion must never be suppressed.
const goalFetchPendingBySession = new Set<string>();
// The /goal request mutex for EVERY backfill path. Distinct from
// goalFetchPendingBySession on purpose: that mark feeds onMainTurnEnd's
// goalActive predicate (only an ACTIVE goal may arm it), while this one
// serializes the HTTP reads themselves — a non-active goal's backfill must
// not arm the predicate, but must still not storm or reorder requests.
const goalBackfillInFlight = new Set<string>();
// The meta status each in-flight first-sight backfill was STARTED with: the
// transcript fold compares every later meta against it — a mismatch means
// the pending REST response was built for a state the daemon already left,
// and must be invalidated by a version bump (a plain mutex alone would let
// the stale read land and pin the card at the old status).
const goalBackfillStatusBySid = new Map<string, string>();

/** First-sight goal backfill over REST. The meta status the read STARTS with
 *  is recorded per session; if the meta moved while it was in flight (the
 *  fold's invalidation branch rewrites the record and version-bumps the
 *  answer away), the settlement refills with the CURRENT status instead of
 *  leaving the card empty until an unrelated refresh. */
function startGoalBackfill(sessionId: string, status: string): void {
  goalBackfillInFlight.add(sessionId);
  goalBackfillStatusBySid.set(sessionId, status);
  if (status === 'active') goalFetchPendingBySession.add(sessionId);
  void refreshSessionGoal(sessionId).finally(() => {
    goalBackfillInFlight.delete(sessionId);
    goalFetchPendingBySession.delete(sessionId);
    const wanted = goalBackfillStatusBySid.get(sessionId);
    goalBackfillStatusBySid.delete(sessionId);
    if (
      wanted !== undefined &&
      wanted !== status &&
      rawState.goalBySession[sessionId] === undefined
    ) {
      startGoalBackfill(sessionId, wanted);
    }
  });
}

/** load()'s post-reload goal refill: fetch with the pending mark held, so a
 *  turn boundary landing mid-refetch still reads goal-active (see above). The
 *  mark doubles as the in-flight mutex — the transcript fold re-triggers this
 *  on every streaming version bump, and without it a slow /goal read would
 *  fan out one request per frame (each finally also clearing the mark early
 *  for the others still in flight). */
function refillSessionGoalOnReload(sessionId: string): void {
  if (goalBackfillInFlight.has(sessionId)) return;
  goalBackfillInFlight.add(sessionId);
  goalFetchPendingBySession.add(sessionId);
  void refreshSessionGoal(sessionId).finally(() => {
    goalBackfillInFlight.delete(sessionId);
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

/** One bounded confirmation-retry chain per session: a profile write whose
 *  authoritative /status confirmation didn't land keeps its mode shields
 *  until a re-read succeeds (attempt×2s, capped at 15s). Tokens and the
 *  through-folded fields merge PER FIELD across chains: a second write's
 *  chain must not strand the first write's still-pending field. The acks'
 *  own token checks make a newer pick supersede any stale chain. */
const statusConfirmRetryBySid = new Map<
  string,
  {
    attempt: number;
    timer: ReturnType<typeof setTimeout> | null;
    tokens: { thinking?: number; swarm?: number; plan?: number };
    fields: { swarm: boolean; plan: boolean };
  }
>();

function scheduleStatusConfirmRetry(
  sid: string,
  tokens: { thinking?: number; swarm?: number; plan?: number },
  attempt: number,
): void {
  const existing = statusConfirmRetryBySid.get(sid);
  // Merge per field: the new call's token wins for the fields it carries;
  // fields it doesn't carry keep their still-unconfirmed predecessor.
  const mergedTokens = {
    thinking: tokens.thinking ?? existing?.tokens.thinking,
    swarm: tokens.swarm ?? existing?.tokens.swarm,
    plan: tokens.plan ?? existing?.tokens.plan,
  };
  const fields = {
    swarm: tokens.swarm !== undefined || existing?.fields.swarm === true,
    plan: tokens.plan !== undefined || existing?.fields.plan === true,
  };
  if (existing?.timer != null) clearTimeout(existing.timer);
  const state = { attempt, timer: null as ReturnType<typeof setTimeout> | null, tokens: mergedTokens, fields };
  statusConfirmRetryBySid.set(sid, state);
  state.timer = setTimeout(() => {
    state.timer = null;
    void refreshSessionStatus(sid, { throughShield: state.fields, throughTokens: state.tokens }).then((confirmed) => {
      if (confirmed) {
        if (statusConfirmRetryBySid.get(sid) === state) statusConfirmRetryBySid.delete(sid);
        ackThinkingPending(rawState, sid, state.tokens.thinking);
        ackSwarmPending(rawState, sid, state.tokens.swarm);
        ackPlanPending(rawState, sid, state.tokens.plan);
        return;
      }
      // The chain may be dead meanwhile: the session was torn down (its
      // timer/map entry cleared by forgetSession) or a newer write replaced
      // the state — rescheduling then would poll a gone session every 15s
      // forever.
      if (statusConfirmRetryBySid.get(sid) !== state) return;
      if (!rawState.sessions.some((s) => s.id === sid)) {
        statusConfirmRetryBySid.delete(sid);
        return;
      }
      scheduleStatusConfirmRetry(sid, tokens, attempt + 1);
    });
  }, Math.min(attempt * 2000, 15_000));
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
  const swarmToken = patch.swarmMode !== undefined ? rawState.pendingSwarmBySession[sid] : undefined;
  const planToken = patch.planMode !== undefined ? rawState.pendingPlanBySession[sid] : undefined;
  // Promise.resolve wrap: tolerate a sync/undefined return (e.g. test mocks).
  return Promise.resolve(getKimiWebApi().updateSession(sid, patch))
    .then(() =>
      refreshSessionStatus(sid, {
        throughShield: {
          swarm: patch.swarmMode !== undefined,
          plan: patch.planMode !== undefined,
        },
        throughTokens: { swarm: swarmToken, plan: planToken },
      }),
    )
    .then((confirmed) => {
      if (!confirmed) {
        // The confirmation read never landed (fetch failed or a newer meta
        // fold won the version race): the shields must NOT drop here — an
        // unprotected stale meta fold would revert the optimistic value for
        // good. Hold them on a bounded retry; the acks' token checks make a
        // newer pick supersede the chain.
        scheduleStatusConfirmRetry(sid, {
          thinking: thinkingToken,
          swarm: swarmToken,
          plan: planToken,
        }, 1);
        return true;
      }
      // Ack AFTER the authoritative /status re-read lands: clearing the
      // shield at POST success leaves a window where a stale transcript meta
      // fold reverts the optimistic value AND bumps the status version —
      // which then discards the very re-read meant to confirm the write.
      ackThinkingPending(rawState, sid, thinkingToken);
      ackSwarmPending(rawState, sid, swarmToken);
      ackPlanPending(rawState, sid, planToken);
      return true;
    })
    .catch((err) => {
      // A failed write never reached the daemon: stop shielding it and re-fold
      // the daemon's actual level (an earlier acked report may have been
      // dropped while it was pending). A newer pick keeps its own shield.
      if (ackThinkingPending(rawState, sid, thinkingToken)) void refreshSessionStatus(sid);
      if (ackSwarmPending(rawState, sid, swarmToken)) void refreshSessionStatus(sid);
      if (ackPlanPending(rawState, sid, planToken)) void refreshSessionStatus(sid);
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

// The main-flow transcript migration (docs/plans/2026-08-19-main-transcript-protocol.md)
// is complete: the per-session transcript channel pool is THE message pipeline
// in every build. The daemon suppresses the legacy session_event frames for
// the main agent on the shared connection, so every slice reads from the
// transcript snapshot/entities.
const mainTranscriptHost = createMainTranscriptHost({
  api: getKimiWebApi(),
  getSharedConnection: () => eventConn,
  ensureSharedConnection: connectEventsIfNeeded,
  onSessionGone: (sessionId) => handleSessionGone(sessionId),
  getLocalTurnState: (sessionId) => workspaceState.localTurnStartState(sessionId),
  hasPendingLocalWork: (sessionId) =>
    rawState.inFlightBySession[sessionId] === true ||
    (rawState.queuedBySession[sessionId] ?? []).length > 0 ||
    (rawState.optimisticMessagesBySession[sessionId] ?? []).length > 0,
  onBaselineError: (sessionId, err) =>
    pushOperationFailure('loadSessionTranscript', err, { sessionId }),
});

/** The active session's transcript entry once its baseline is loaded — the
 *  slices read from it. Reading it here also subscribes the caller's computed
 *  to the entry's per-frame version bump. */
function activeMainTranscriptEntry(): MainTranscriptEntry | null {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  const entry = mainTranscriptHost.pool.getEntry(sid);
  void entry?.version.value;
  return entry !== undefined && entry.baselineLoaded ? entry : null;
}

/** A session's main-transcript tail turn id — the anchor stamped onto
 *  optimistic bubbles at submit time (shared by the prompt and skill paths). */
function mainTranscriptTailTurnId(sessionId: string): string | undefined {
  const tail = mainTranscriptHost.pool
    .getEntry(sessionId)
    ?.channel.snapshot.items.findLast((item) => item.kind === 'turn');
  return tail?.kind === 'turn' ? tail.turnId : undefined;
}

/** A session's newest transcript prompt's createdAt — the FALLBACK echo floor
 *  stamped onto optimistic bubbles at submit time. A session can have prompt
 *  history (hook-blocked/aborted sends) without any turn, so "no anchor turn"
 *  must not mean "no floor": an unanchored same-text match would otherwise
 *  eat that history as this send's echo. */
function mainTranscriptTailPromptCreatedAt(sessionId: string): string | undefined {
  const prompts = mainTranscriptHost.pool.getEntry(sessionId)?.channel.snapshot.prompts;
  if (prompts === undefined || prompts.length === 0) return undefined;
  // Max by stamp, not array order: a status re-upsert may rewrite an earlier
  // entry, and the floor must bound EVERY piece of history at submit time.
  let newest: string | undefined;
  for (const prompt of prompts) {
    if (newest === undefined || prompt.createdAt > newest) newest = prompt.createdAt;
  }
  return newest;
}

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
      foldDaemonSwarmMode(rawState, event.sessionId, event.swarmMode);
    }
    if (event.planMode !== undefined) {
      foldDaemonPlanMode(rawState, event.sessionId, event.planMode);
    }
    if (event.thinking !== undefined) {
      foldDaemonThinkingLevel(rawState, event.sessionId, event.thinking as ThinkingLevel);
    }
  }

  // A session deleted anywhere (e.g. from another client) also loses its pin:
  // the WS-driven deletion path bypasses forgetSession, so the pinned-id
  // cleanup lives here too.
  if (event.type === 'sessionUpdated' && 'archived' in event.session) {
    sessionArchivedSeqBySid.set(event.session.id, seq);
  }
  if (event.type === 'sessionArchived') {
    sessionArchivedSeqBySid.set(event.sessionId, seq);
  }
  if (event.type === 'sessionMetaUpdated' && 'title' in event) {
    sessionTitleSeqBySid.set(event.sessionId, seq);
  }
  if (
    (event.type === 'sessionWorkChanged' || event.type === 'turnActiveChanged') &&
    'lastTurnReason' in event
  ) {
    rawState.sessionLastTurnReasonSeqBySession[event.sessionId] = seq;
  }
  // A session deleted anywhere (e.g. from another client) gets the same full
  // teardown as a local removal: the reducer above already dropped the session
  // row and its messages, but the sidecar state (projector session state, aux
  // transcripts, side-chat maps, turn/mode buckets) would otherwise pin the
  // deleted session's data for the app's lifetime. forgetSession re-issues the
  // unpin and the WS unsubscribe — both idempotent for an already-gone session.
  if (event.type === 'sessionDeleted') {
    // A remote deletion runs the SAME teardown as a local one: the reducer
    // path only drops the list row, which would leak the transcript entry,
    // its subscription and every per-session slice (prompt/queue lifecycle
    // included) for a session that no longer exists. forgetSession re-issues
    // the unpin and the WS unsubscribe — both idempotent for an already-gone
    // session.
    forgetSession(event.sessionId);
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
  // lastSeqBySession[sessionId] = seq.
  applyEvent(appEvent, meta.sessionId, meta.seq);

  if (sideTarget) {
    const { agentId } = sideTarget;
    const parentId = meta.sessionId;
    if (appEvent.type === 'agentDelta' && appEvent.agentId === agentId) {
      if (appEvent.delta.text) {
        sideChat.appendSideChatAssistantText(agentId, parentId, appEvent.delta.text);
      }
    } else if (appEvent.type === 'taskProgress' && appEvent.taskId === agentId) {
      sideChat.appendSideChatAssistantText(agentId, parentId, appEvent.outputChunk);
    }
  }
  // Terminal routing goes by the KNOWN agent id (terminated included), not
  // the open panel: closing the BTW panel mid-turn drops the target, and a
  // taskCompleted landing after turn.ended must still route its output here.
  if (appEvent.type === 'agentTurnEnded' && sideChat.wasSideChatAgent(appEvent.agentId)) {
    sideChat.finishSideChatAgent(appEvent.agentId, meta.sessionId);
  } else if (appEvent.type === 'taskCompleted' && sideChat.wasSideChatAgent(appEvent.taskId)) {
    sideChat.finishSideChatAgent(appEvent.taskId, meta.sessionId, appEvent.outputPreview, true);
  }

  if (
    appEvent.type === 'sessionWorkChanged' &&
    ((appEvent.mainTurnActive === false && wasMainTurnActive) ||
      (appEvent.mainTurnActive === undefined && !appEvent.busy)) &&
    meta.seq > prevSeq
  ) {
    clearWorkingFlags(appEvent.sessionId);
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
const sessionStatusVersionBySid = new Map<string, number>();
function bumpSessionStatusVersion(sid: string): void {
  sessionStatusVersionBySid.set(sid, (sessionStatusVersionBySid.get(sid) ?? 0) + 1);
}
const sessionActivityWatermarkBySession = new Map<string, number>();
/** Uncertain-bubble echo prompts already consumed by a retired bubble, per
 *  session — a prompt's one-to-one binding must survive the frame that
 *  retired its bubble (see uncertainEchoMatchedIds). Pruned to the prompt
 *  ids the current snapshot still carries (a slid-out prompt's bubble is
 *  long retired). */
const consumedEchoPromptIdsBySid = new Map<string, Set<string>>();
/** Skill turn/marker entities already consumed by a retired uncertain skill
 *  bubble, per session (the skill twin of consumedEchoPromptIdsBySid — see
 *  skillEchoMatchedIds). Pruned to entity ids the snapshot still carries. */
const consumedSkillEchoIdsBySid = new Map<string, Set<string>>();
/** Interaction ids an auxiliary (detail-panel/BTW) transcript has already
 *  NOTIFIED for, keyed `${sessionId}:${agentId}` — seeded from its first
 *  loaded baseline (history stays silent), since the server suppresses these
 *  agents' projected session events on this connection and a new approval
 *  would otherwise surface as a silent card only. */
const auxNotifiedInteractionIdsByKey = new Map<string, Set<string>>();
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
    // Settle the offline turn end through the transcript replay itself: the
    // channel's tail can be a turn BEFORE the one that finished offline, and
    // marking THAT one settled would let the replay's real ended turn run the
    // lifecycle a second time (reaping the freshly-drained prompt). Re-anchor
    // and let the edge watcher enumerate the actual ended turns — correct
    // watermarks, full side effects, one drain. The local path remains as the
    // fallback when the replay is unreachable.
    const entry = mainTranscriptHost.pool.getEntry(sessionId);
    if (entry !== undefined) {
      // The reads go through the POOL's serialized path (like undo's rewind):
      // a direct channel.refresh() bypasses resumePromise, so a reset
      // landing mid-read would apply immediately and then be overwritten by
      // the older REST page — leaving the UI stuck on a pre-reset running
      // snapshot when the reset carried the final turn-end. A failed read
      // must NOT settle locally without a turn identity — the replay would
      // settle the real turn a second time and reap the prompt this
      // drained. Retry the authoritative channel once; the next
      // baseline/replay converges the rest.
      void mainTranscriptHost.pool.refreshSession(sessionId).catch(() => {
        setTimeout(() => {
          if (mainTranscriptHost.pool.getEntry(sessionId) === entry) {
            void mainTranscriptHost.pool.refreshSession(sessionId).catch(() => undefined);
          }
        }, 2000);
      });
    } else {
      // No transcript channel for this session at all — the local settle is
      // the only convergence available.
      const reason = rawState.sessions.find((s) => s.id === sessionId)?.lastTurnReason;
      onMainTurnEnd(sessionId, reason === 'cancelled' || reason === 'failed' ? 'aborted' : 'idle', true);
    }
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
      // A frame reaching the at-resume watermark proves the resumed session's
      // replay flushed (single FIFO: replay frames precede any seq-newer one —
      // seqs are unique, so only the replay can deliver exactly throughSeq).
      // This runs BEFORE every freshness gate below: the frame proving the
      // flush is by definition stale to the seq watermark, and dropping it
      // there would leak the floor for a session that stays quiet after
      // catching up — its next eviction would re-freeze the stale watermark
      // and replay already-consumed frames.
      const resumeFloor = resumeFloorBySession.get(meta.sessionId);
      if (resumeFloor !== undefined && meta.seq >= resumeFloor.throughSeq) {
        resumeFloorBySession.delete(meta.sessionId);
      }
      // A remote archive (another client, or the server's cold archive path)
      // is reconciled exactly like a local one — handled upstream of the
      // reducer like the workspace lifecycle events.
      if (appEvent.type === 'sessionArchived') {
        void workspaceState
          .applyRemoteSessionArchived(appEvent.sessionId, appEvent.workspaceId)
          .then((genuine) => {
            if (!genuine) return;
            // Terminal teardown mirrors the sessionUpdated-archived path;
            // idempotent, so the echo of our own archive is safe too.
            notifySessionDestroyed(appEvent.sessionId);
          });
        return;
      }
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
      const resyncGeneration = (resyncGenerationBySid.get(sessionId) ?? 0) + 1;
      resyncGenerationBySid.set(sessionId, resyncGeneration);
      traceKeyEvent('ws:resync', {
        sessionId,
        status: 'required',
        seq: currentSeq,
      });
      // The client wrapper already reset the event projector. The main
      // transcript channel re-anchors itself on its own gap signal; an active
      // side chat has no such channel (its deltas are unrecoverable past the
      // gap), so rebuild it from its agent transcript.
      enqueueEvent.flush();
      // The server-announced cursor is the NEW authoritative watermark: a
      // journal epoch switch (daemon restart) restarts seq numbering, and
      // keeping the OLD high watermark would make isFreshEvent ignore every
      // new-epoch event (work changes, turn outcomes, recency) until seq
      // accidentally overtakes the pre-restart value. (After the flush so
      // already-buffered events are judged by the old watermark, not re-applied.)
      rawState.lastSeqBySession[sessionId] = currentSeq;
      // The activity watermark is an independent pre-filter for
      // work/turn/interaction events (onEvent) — a resync that arrives WITHOUT
      // a preceding disconnect (live-connection gap) never clears it, and an
      // old-epoch high watermark would keep dropping new-epoch events until
      // seq overtakes it. Re-anchor it with the rest of the cursors.
      sessionActivityWatermarkBySession.delete(sessionId);
      void sideChat.resyncSideChat(sessionId);
      // Everything OFF the message stream must be re-converged here too: the
      // gap also swallowed this session's work changes, title, archive — or
      // its deletion. Re-read the session fact, tear down on not-found, then
      // run the work baseline so an offline turn end still settles.
      void (async () => {
        // Capture the row BEFORE the read: fields the WS changed mid-flight
        // keep their live value, fields it didn't take the REST answer. An
        // unrelated side-channel delta must not veto the title update. The
        // archived flag additionally gates on its event SEQ: a restore can
        // flip the field back to the pre-read value (ABA), which the field
        // comparison alone can't see.
        const before = rawState.sessions.find((s) => s.id === sessionId);
        const archivedSeqBefore = sessionArchivedSeqBySid.get(sessionId);
        const titleSeqBefore = sessionTitleSeqBySid.get(sessionId);
        const lastTurnReasonSeqBefore = rawState.sessionLastTurnReasonSeqBySession[sessionId];
        try {
          const fresh = await getKimiWebApi().getSession(sessionId);
          // A later resync started while this read was in flight — its own
          // read is the fresher one; drop everything here.
          if (resyncGenerationBySid.get(sessionId) !== resyncGeneration) return;
          const current = rawState.sessions.find((s) => s.id === sessionId);
          if (
            fresh.archived === true &&
            current?.archived !== true &&
            before?.archived !== true &&
            sessionArchivedSeqBySid.get(sessionId) === archivedSeqBefore
          ) {
            // The archive landed inside the resync gap (and no restore raced
            // it) — converge EXACTLY like the live event (done list,
            // tombstone, pin, native teardown), not just a field write.
            await workspaceState.applyRemoteSessionArchived(sessionId, fresh.workspaceId);
            notifySessionDestroyed(sessionId);
            return;
          }
          updateSession(sessionId, (s) => ({
            ...s,
            // Seq-gated like archived: an ABA title flip mid-read (A→B→A)
            // must not be overwritten by the possibly-stale REST read.
            title:
              sessionTitleSeqBySid.get(sessionId) === titleSeqBefore ? fresh.title : s.title,
            archived:
              sessionArchivedSeqBySid.get(sessionId) === archivedSeqBefore
                ? s.archived || fresh.archived
                : s.archived,
            busy: s.busy !== before?.busy ? s.busy : fresh.busy,
            mainTurnActive:
              s.mainTurnActive !== before?.mainTurnActive
                ? s.mainTurnActive
                : fresh.mainTurnActive ?? s.mainTurnActive,
            pendingInteraction:
              s.pendingInteraction !== before?.pendingInteraction
                ? s.pendingInteraction
                : fresh.pendingInteraction ?? s.pendingInteraction,
            // Seq-gated like the rest: a turn outcome landing mid-read (even
            // an ABA back to the same value) discards the older REST answer;
            // otherwise it applies VERBATIM (the server omits the field when
            // the reason was cleared — no ?? fallback revival).
            lastTurnReason:
              rawState.sessionLastTurnReasonSeqBySession[sessionId] === lastTurnReasonSeqBefore
                ? fresh.lastTurnReason
                : s.lastTurnReason,
          }));
        } catch (err) {
          if (isDaemonApiError(err) && err.code === 40401) {
            // The deletion landed inside the gap — full teardown like the
            // transcript pool's not-found path.
            handleSessionGone(sessionId);
            return;
          }
          // A transient read failure: the work baseline below still reconciles.
        }
        void workspaceState.loadWorkspaces();
        void reconcileSessionWorkAfterReconnect();
      })();
      if (epoch !== undefined) lastKnownJournalEpoch = epoch;
      void currentSeq;
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
      if (agentId === 'main') mainTranscriptHost.pool.receiveReset(sessionId, snapshot, seq);
    },

    onTranscriptOps(sessionId, agentId, ops, seq) {
      const accepted = auxiliaryTranscripts.applyOps(sessionId, agentId, ops, seq);
      if (agentId === 'main') {
        return mainTranscriptHost.pool.applyOps(sessionId, ops, seq);
      }
      return accepted;
    },
  });
}

// Sessions created locally in this client instance are known to be empty until
// they receive their first message. This is more reliable than the daemon's
// messageCount field, which can be stale for old sessions and would otherwise
// flash the empty-composer before the real snapshot arrives.
const sessionsKnownEmpty = new Set<string>();

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

function hasLoadedMessages(sessionId: string): boolean {
  // The transcript pool retains an entry for every session this client opened;
  // a loaded baseline is the "this session's history is already here" fact the
  // legacy messagesBySession key used to provide.
  return mainTranscriptHost.pool.getEntry(sessionId)?.baselineLoaded === true;
}

/** Resolves once the session's transcript baseline is loaded — selectSession
 *  holds its loading state on this instead of clearing it synchronously. */
function whenMainTranscriptBaseline(sessionId: string): Promise<void> {
  if (hasLoadedMessages(sessionId)) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = watch(
      () => {
        const entry = mainTranscriptHost.pool.getEntry(sessionId);
        // Gone (forgetSession removed the entry — e.g. a 404 on first read):
        // resolve too, or the loading state would hang on a session that no
        // longer exists.
        if (entry === undefined) return true;
        // baselineLoaded is a plain field on an unproxied entry (the pool Map
        // is shallowReactive), so reading it alone tracks nothing — the flip
        // must be observed through the entry's version ref, which bumps when
        // the baseline (or its empty-reset retry) lands.
        void entry.version.value;
        return entry.baselineLoaded === true;
      },
      (loaded) => {
        if (!loaded) return;
        stop();
        resolve();
      },
    );
  });
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
const MAX_WS_SUBSCRIPTIONS = 4;
const wsSubscriptionOrder: string[] = [];
// The seq a session's subscription had actually consumed up to when the LRU
// evicted it. lastSeqBySession keeps advancing on broadcast frames (e.g.
// session.meta.updated) even while unsubscribed, so re-subscribing from the
// aggregate cursor would skip the side-channel (BTW) agent frames missed in
// between — freeze the consumed cursor at eviction instead.
const frozenSeqBySession = new Map<string, { seq: number; epoch?: string }>();
/** A session just RESUMED from a frozen watermark: its replay flushes before
 *  any seq-newer frame (the socket is one FIFO), so until a frame past
 *  `throughSeq` (the broadcast-inflated aggregate at resume) lands, the
 *  aggregate cursor does NOT prove subscription consumption — broadcasts
 *  kept advancing it while the replay was still in flight. A re-eviction in
 *  this window must re-freeze the original `seq`, or the next resume starts
 *  from the inflated value and permanently skips the side-channel (BTW) and
 *  terminal frames the replay never delivered. */
const resumeFloorBySession = new Map<string, { seq: number; throughSeq: number }>();
// The journal epoch the latest resync announced — a watermark only means
// anything inside the journal generation it was recorded in.
let lastKnownJournalEpoch: string | undefined;

function retainWsSubscription(sessionId: string): void {
  const idx = wsSubscriptionOrder.indexOf(sessionId);
  if (idx !== -1) wsSubscriptionOrder.splice(idx, 1);
  wsSubscriptionOrder.unshift(sessionId);
  // Evict the oldest entries past the cap, skipping the active session. The
  // active session is NOT guaranteed to sit at the front: rapid clicks can
  // complete out of order and leave the active session at the tail. Skipping
  // it (rather than breaking when the tail is active) keeps the cap effective.
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
    // A still-open resume window re-freezes its original watermark: the
    // aggregate is broadcast-inflated until the replay provably flushed.
    const consumedSeq =
      resumeFloorBySession.get(victim)?.seq ?? rawState.lastSeqBySession[victim];
    if (consumedSeq !== undefined) {
      frozenSeqBySession.set(victim, {
        seq: consumedSeq,
        ...(lastKnownJournalEpoch !== undefined ? { epoch: lastKnownJournalEpoch } : {}),
      });
    }
    eventConn?.unsubscribe(victim);
  }
}

function dropWsSubscription(sessionId: string): void {
  const idx = wsSubscriptionOrder.indexOf(sessionId);
  if (idx !== -1) wsSubscriptionOrder.splice(idx, 1);
  frozenSeqBySession.delete(sessionId);
  resumeFloorBySession.delete(sessionId);
}

// The last turn whose end each session already settled (transcript edge or
// REST work baseline): the same turn's end must never run the prompt lifecycle
// twice — a second pass reaps the freshly-drained prompt's in-flight state and
// drains ANOTHER queued entry, producing concurrent prompts.
const settledTurnEndBySession = new Map<string, string>();

/** Subscribe a session's session_event stream (plain, cursorless) and retain
 *  it under the LRU cap. The surviving events on that channel — session
 *  management, tasks, side-channel (BTW) — reconcile through their own REST
 *  reads; the main message stream lives on the transcript channel. */
function subscribeSessionEvents(sessionId: string): void {
  connectEventsIfNeeded();
  if (eventConn) {
    // Resume from the frozen eviction cursor when there is one — the aggregate
    // lastSeq may have run ahead on broadcast frames the subscription never
    // saw its own events for. The floor record keeps the honest watermark
    // alive until the replay provably flushed (see resumeFloorBySession).
    const frozen = frozenSeqBySession.get(sessionId);
    if (frozen !== undefined) {
      frozenSeqBySession.delete(sessionId);
      resumeFloorBySession.set(sessionId, {
        seq: frozen.seq,
        throughSeq: Math.max(rawState.lastSeqBySession[sessionId] ?? 0, frozen.seq),
      });
    }
    const lastSeq = frozen?.seq ?? rawState.lastSeqBySession[sessionId];
    // Carry the epoch the watermark was recorded in whenever we know it: an
    // epoch mismatch makes the daemon answer resync_required (a full rebuild),
    // while a bare old seq could be misread as a new-epoch-legal cursor after
    // a restart and silently skip the gap (unrecoverable deltas).
    const epoch = frozen?.epoch ?? lastKnownJournalEpoch;
    if (lastSeq !== undefined) {
      eventConn.subscribe(sessionId, epoch === undefined ? { seq: lastSeq } : { seq: lastSeq, epoch });
    } else {
      eventConn.subscribe(sessionId);
    }
    retainWsSubscription(sessionId);
  }
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
// running. This recomputes only when the session's transcript changes.
const bashCommandIndex = computed<Map<string, string>>(() => {
  const transcriptEntry = activeMainTranscriptEntry();
  const index = new Map<string, string>();
  if (transcriptEntry === null) return index;
  const commandsByToolCallId = new Map<string, string>();
  const outputs: { toolCallId: string; output: string }[] = [];
  for (const item of transcriptEntry.channel.snapshot.items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind !== 'tool') continue;
        if (frame.name === 'Bash' || frame.name === 'bash') {
          const input = frame.input as { command?: unknown } | undefined;
          if (typeof input?.command === 'string') commandsByToolCallId.set(frame.toolCallId, input.command);
        }
        // Agent-core tool results may arrive as ContentPart[] rather than a
        // plain string — flatten before the task_id scan.
        const outputLines = normalizeToolOutput(frame.output);
        if (outputLines !== undefined && outputLines.length > 0) {
          outputs.push({ toolCallId: frame.toolCallId, output: outputLines.join('\n') });
        }
      }
    }
  }
  if (commandsByToolCallId.size === 0) return index;
  for (const { toolCallId, output } of outputs) {
    const match = /task_id:\s*(\S+)/.exec(output);
    if (!match?.[1]) continue;
    const command = commandsByToolCallId.get(toolCallId);
    if (command) index.set(match[1], command);
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
  const transcriptEntry = activeMainTranscriptEntry();
  const index = new Map<string, string | string[]>();
  if (transcriptEntry === null) return index;
  for (const item of transcriptEntry.channel.snapshot.items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind !== 'tool') continue;
        const input = frame.input as { prompt?: unknown; items?: unknown } | undefined;
        const prompt = typeof input?.prompt === 'string' ? input.prompt : undefined;
        if (prompt && !index.has(frame.toolCallId)) index.set(frame.toolCallId, prompt);
        const items = input?.items;
        if (!prompt && Array.isArray(items) && !index.has(frame.toolCallId)) {
          const texts = items.filter((entry): entry is string => typeof entry === 'string');
          if (texts.length > 0) index.set(frame.toolCallId, texts);
        }
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

// Per-session persistent spawn index (agent → parent tool call / swarm
// index): the transcript's paged window only shows recent turns, but a docked
// subagent can outlive the turn that spawned it — the cache carries the link
// across pages. Cleared with the rest of the session's state.
const spawnedIndexCacheBySid = new Map<string, SpawnedIndex>();
// Last failed loadOlder time per session (ms) — the spawn-backfill retries
// with a 30s backoff instead of storming once per watcher frame.
const loadOlderFailedAtBySid = new Map<string, number>();

function spawnedIndexCacheFor(sid: string): SpawnedIndex {
  let cache = spawnedIndexCacheBySid.get(sid);
  if (cache === undefined) {
    cache = { parents: new Map(), swarmIndexes: new Map() };
    spawnedIndexCacheBySid.set(sid, cache);
  }
  return cache;
}

const activeAppTasks = computed<AppTask[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const transcriptEntry = activeMainTranscriptEntry();
  if (transcriptEntry !== null) {
    const rows = transcriptTasksToAppTasks(
      transcriptEntry.channel.snapshot,
      sid,
      spawnedIndexCacheFor(sid),
    );
    // The transcript's cold rebuild can't backfill the spawned event's model
    // fields (not persisted); the task poller's REST rows carry them for
    // background tasks, keyed by the task-store id the fold keeps as
    // backgroundTaskId.
    const restById = new Map((rawState.tasksBySession[sid] ?? []).map((task) => [task.id, task]));
    return rows
      // A BTW agent stays out of the dock until it terminates — closing the
      // panel must not resurface its still-running task as a regular subagent
      // (with a wrong cancel entry).
      .filter((task) => !sideChat.isSideChatAgent(task.agentId ?? task.id))
      .map((row) => {
        const rest =
          restById.get(row.id) ??
          (row.backgroundTaskId !== undefined ? restById.get(row.backgroundTaskId) : undefined);
        if (rest === undefined) return row;
        // The REST task-store row settles a transcript row whose agent-side
        // terminal event was missed (a disconnect window): without this the
        // dock shows the task running forever — the same fold
        // keepLiveSubagents does for the legacy merge, mirrored here. Same
        // generation guard as the transcript fold: a RESUMED agent keeps the
        // old backgroundTaskId, and a terminal REST row from that previous
        // run must not settle the new generation. An ESTIMATED (client-clock)
        // completedAt can't judge generations across hosts — a browser
        // behind the daemon would compare false forever and strand a
        // finished task as running; the run's own SERVER start stamps decide.
        const restCompletesRow =
          row.status === 'running' &&
          rest.status !== 'running' &&
          row.startedAt !== undefined &&
          (rest.completedAtEstimated === true
            ? rest.startedAt !== undefined && rest.startedAt >= row.startedAt
            : rest.completedAt !== undefined && rest.completedAt >= row.startedAt);
        // An exact id match (NOT the backgroundTaskId alias a resumed row
        // inherits) provably names the same task: the poller's larger
        // outputPreview/outputBytes backfill safely even when the transcript
        // already settled the status itself.
        const takeTerminalContent = restCompletesRow || row.id === rest.id;
        return {
          ...row,
          status: restCompletesRow ? rest.status : row.status,
          subagentPhase: restCompletesRow
            ? rest.status === 'completed'
              ? 'completed'
              : rest.status === 'cancelled'
                ? 'cancelled'
                : 'failed'
            : row.subagentPhase,
          // Terminal CONTENT fields ride the same generation guard: a previous
          // run's stamp/output must not leak onto the resumed row.
          completedAt: takeTerminalContent ? rest.completedAt ?? row.completedAt : row.completedAt,
          completedAtEstimated:
            rest.completedAt !== undefined && takeTerminalContent
              ? undefined
              : row.completedAtEstimated,
          outputPreview: takeTerminalContent ? rest.outputPreview ?? row.outputPreview : row.outputPreview,
          outputBytes: takeTerminalContent ? rest.outputBytes ?? row.outputBytes : row.outputBytes,
          model: row.model ?? rest.model,
          thinkingEffort: row.thinkingEffort ?? rest.thinkingEffort,
          // A running bash task created outside the loaded transcript window
          // has no frame to recover its command from — the REST row carries it.
          command: row.command ?? rest.command,
        };
      });
  }
  return (rawState.tasksBySession[sid] ?? []).filter((task) =>
    !sideChat.isSideChatAgent(task.agentId ?? task.id),
  );
});

const taskPoller = useTaskPoller(rawState, activeAppTasks, { api: getKimiWebApi() });

/** The MAIN agent of the active session has a turn in flight — the working
 *  indicator's authoritative half (the optimistic `inFlight` window covers the gap
 *  before the turn.started round-trips). Background agents and BTW side chats
 *  do NOT set this; the session-busy status lives on `activity`. */
const turnActive = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return false;
  const transcriptEntry = activeMainTranscriptEntry();
  if (transcriptEntry !== null) {
    return transcriptEntry.channel.snapshot.meta.activity === 'turn';
  }
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
  const transcriptEntry = activeMainTranscriptEntry();
  if (transcriptEntry !== null) {
    const snapshot = transcriptEntry.channel.snapshot;
    if (snapshot.meta.activity === 'turn') return undefined;
    // Only the LATEST turn's terminal error counts: a newer successful turn
    // already retired any older failure's story.
    const last = snapshot.items.findLast((item) => item.kind === 'turn');
    if (last?.kind !== 'turn' || last.state !== 'failed' || last.error === undefined) {
      return undefined;
    }
    // The structured error payload rides the end-appended 'error' notice
    // marker — nested at payload.event (coreEventMap noticeOp('error', …,
    // event) wraps the envelope as { level, message, event }) — recover the
    // same fields the legacy reducer's turnError fold produced (code drives
    // ChatPane's title pick, statusCode/requestId feed its diagnostics).
    const notice = snapshot.items.findLast(
      (item) =>
        item.kind === 'marker' &&
        item.marker === 'notice' &&
        (item.payload as { level?: unknown } | undefined)?.level === 'error',
    );
    const envelope =
      notice?.kind === 'marker' ? (notice.payload as Record<string, unknown> | undefined) : undefined;
    const p = (envelope?.['event'] ?? envelope) as Record<string, unknown> | undefined;
    const details = (p?.['details'] ?? {}) as Record<string, unknown>;
    return {
      code: typeof p?.['code'] === 'string' ? p['code'] : undefined,
      message: last.error,
      name: typeof p?.['name'] === 'string' ? p['name'] : undefined,
      retryable: typeof p?.['retryable'] === 'boolean' ? p['retryable'] : undefined,
      statusCode: typeof details['statusCode'] === 'number' ? details['statusCode'] : undefined,
      requestId: typeof details['requestId'] === 'string' ? details['requestId'] : undefined,
    };
  }
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
  const transcriptEntry = activeMainTranscriptEntry();
  if (transcriptEntry !== null) {
    const turns = transcriptEntry.channel.snapshot.items;
    const current = turns.findLast((item): item is Extract<typeof item, { kind: 'turn' }> => item.kind === 'turn');
    const retry = current?.state === 'running' ? current.steps.at(-1)?.retry : undefined;
    if (retry === undefined) return undefined;
    return {
      failedAttempt: retry.failedAttempt,
      nextAttempt: retry.nextAttempt,
      maxAttempts: retry.maxAttempts,
      delayMs: retry.delayMs,
      errorName: retry.errorName,
      statusCode: retry.statusCode,
    };
  }
  return rawState.turnRetryBySession[sid];
});

// Turns run through an incremental projector: unchanged turns keep their object
// identity across streaming frames (see mainTurnsProjector.ts), so the keyed
// v-for downstream only patches the live tail. The projector is stateful (it
// caches its own previous output), so a plain computed preserves the old
// synchronous pull semantics while reuse happens inside each re-evaluation.
const getFileUrlById = (fileId: string): string => getKimiWebApi().getFileUrl(fileId);
const getSessionMediaUrl = (sessionId: string, fileId: string): string =>
  getKimiWebApi().getSessionMediaUrl(sessionId, fileId);
const mainTurnsProjector = createMainTurnsProjector();
/** Extract joined text from a transcript prompt's open content envelope (the
 *  same ContentPart[] shape AppMessage.content carries). */
function transcriptPromptText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text',
    )
    .map((part) => part.text)
    .join('');
}

/** A skill bubble's echo turn: a skill_activation turn AFTER the bubble's
 *  submit-time anchor carrying the same name AND args. Anchored scoping keeps
 *  a historical same-skill turn from covering (or retiring) a fresh
 *  submission; a rewound anchor (undo/reset) means nothing covers it here. */
/** The newest server-side timestamp in a snapshot (turns' startedAt/endedAt,
 *  markers' at) — the closest daemon-domain "now" for stamping live edges. */
export function newestServerStamp(snapshot: AgentTranscriptSnapshot): string | undefined {
  for (let i = snapshot.items.length - 1; i >= 0; i--) {
    const item = snapshot.items[i]!;
    if (item.kind === 'marker') {
      const at = (item as { at?: unknown }).at;
      if (typeof at === 'string') return at;
      continue;
    }
    if (item.kind === 'turn') {
      // Steps inside the turn may carry NEWER stamps than the turn header —
      // a running turn has no endedAt, and its second+ step started later.
      let newest: string | undefined;
      const consider = (ts: string | undefined): void => {
        if (typeof ts === 'string' && (newest === undefined || ts > newest)) newest = ts;
      };
      consider(item.endedAt);
      consider(item.startedAt);
      for (const step of item.steps) {
        consider(step.endedAt);
        consider(step.startedAt);
      }
      if (newest !== undefined) return newest;
    }
  }
  return undefined;
}

/** The server-time floor for a bubble's echo reconciliation, derived from its
 *  submit-time anchor turn: the anchor is the session's tail at submit time,
 *  so anything this submission echoes was created at/after it. Both stamps
 *  are daemon-side — no cross-host clock comparison (a Web/Remote-Control
 *  client's clock may be ahead of the daemon's). */
export function anchorServerFloor(
  items: readonly TranscriptItem[],
  anchorTurnId: string | undefined,
): string | undefined {
  if (anchorTurnId === undefined) return undefined;
  const anchor = items.find((item) => item.kind === 'turn' && item.turnId === anchorTurnId);
  return anchor?.kind === 'turn' ? anchor.startedAt : undefined;
}

/** The echo floor for an optimistic bubble: the NEWER of the two submit-time
 *  anchors. The prompt anchor (exclusive — that prompt itself is history this
 *  send must not match) wins whenever its stamp is at/after the turn anchor's:
 *  a prompt created inside the tail turn (e.g. a steer) is newer than the
 *  turn's startedAt, and an inclusive turn floor would pass that same-turn
 *  same-text prompt as this send's echo. The turn anchor (inclusive — the
 *  echo is created inside/after that turn) only bounds sessions whose newest
 *  prompt predates it. A session with only blocked/aborted prompts has no
 *  turn at all; without the prompt fallback its whole history would pass. */
export function promptEchoFloor(
  items: readonly TranscriptItem[],
  metadata: { readonly [key: string]: unknown } | undefined,
): { at: string; exclusive: boolean } | undefined {
  const turnFloor = anchorServerFloor(items, metadata?.['kimiWeb.anchorTurnId'] as string | undefined);
  const promptFloor = metadata?.['kimiWeb.anchorPromptCreatedAt'];
  if (typeof promptFloor === 'string' && (turnFloor === undefined || promptFloor >= turnFloor)) {
    return { at: promptFloor, exclusive: true };
  }
  return turnFloor !== undefined ? { at: turnFloor, exclusive: false } : undefined;
}

/** An uncertain bubble's echo prompt: a non-queued prompt entity with the
 *  same text created at/after the server-time floor (strictly after it when
 *  floorExclusive — see promptEchoFloor). The floor keeps an earlier
 *  identical send from covering (or retiring) this one while its own request
 *  may still be in flight; without an anchor there is no time filter at all
 *  (a session's very first prompt has no history to exclude). */
export function promptEchoExists(
  prompts: readonly TranscriptPrompt[],
  text: string,
  floorCreatedAt: string | undefined,
  floorExclusive = false,
): boolean {
  return prompts.some(
    (prompt) =>
      prompt.status !== 'queued' &&
      (floorCreatedAt === undefined ||
        (floorExclusive ? prompt.createdAt > floorCreatedAt : prompt.createdAt >= floorCreatedAt)) &&
      transcriptPromptText(prompt.content) === text,
  );
}

/** Pair uncertain bubbles with their echo prompts ONE-TO-ONE in submission
 *  order: a lost response can be re-sent immediately (the failure cleared
 *  inFlight), so two uncertain bubbles may share text AND anchor — an
 *  existence check would let a single prompt entity cover BOTH, retiring the
 *  second while its own request may still be queued or never observed. Each
 *  prompt entity consumes at most one bubble. Attachment-only sends (empty
 *  text) get the same pairing for free. The pairing is computed fresh per
 *  watcher frame, so the caller passes the consumption it already recorded
 *  (alreadyConsumed): a prompt's binding to a retired bubble must survive
 *  the frame that retired it, or the NEXT frame pairs the same prompt with
 *  the next identical bubble. Returns bubbleId → promptId of the new pairs. */
export function uncertainEchoMatchedIds(
  bubbles: readonly {
    id: string;
    text: string;
    floor: { at: string; exclusive: boolean } | undefined;
  }[],
  prompts: readonly TranscriptPrompt[],
  alreadyConsumed?: ReadonlySet<string>,
): Map<string, string> {
  const matched = new Map<string, string>();
  const consumed = new Set<string>(alreadyConsumed ?? []);
  for (const bubble of bubbles) {
    const mate = prompts.find(
      (prompt) =>
        !consumed.has(prompt.promptId) &&
        prompt.status !== 'queued' &&
        (bubble.floor === undefined ||
          (bubble.floor.exclusive
            ? prompt.createdAt > bubble.floor.at
            : prompt.createdAt >= bubble.floor.at)) &&
        transcriptPromptText(prompt.content) === bubble.text,
    );
    if (mate !== undefined) {
      consumed.add(mate.promptId);
      matched.set(bubble.id, mate.promptId);
    }
  }
  return matched;
}

/** A hook-blocked skill activation leaves no turn — only its persisted skill
 *  marker. Attribute it to a bubble the same anchored way as the turn echo,
 *  PLUS the submit-time prompt watermark: an identical re-activation shares
 *  the anchor turn, so without the watermark the OLD activation's marker
 *  would retire the NEW uncertain bubble before its request was ever seen. */
export function skillMarkerExists(
  items: readonly TranscriptItem[],
  anchorTurnId: string | undefined,
  skillName: unknown,
  skillArgs: unknown,
  promptFloor?: string,
): boolean {
  const anchorIdx =
    anchorTurnId === undefined
      ? -1
      : items.findIndex((item) => item.kind === 'turn' && item.turnId === anchorTurnId);
  if (anchorTurnId !== undefined && anchorIdx === -1) return false;
  return items.slice(anchorIdx + 1).some((item) => {
    if (item.kind !== 'marker' || item.marker !== 'skill') return false;
    // The marker must postdate the submit-time prompt watermark (exclusive —
    // the prompt anchored at the watermark is this submit's own history).
    if (promptFloor !== undefined) {
      const at = (item as { at?: unknown }).at;
      if (typeof at !== 'string' || at <= promptFloor) return false;
    }
    const origin = (
      item.payload as { origin?: { kind?: unknown; skillName?: unknown; skillArgs?: unknown } } | undefined
    )?.origin;
    return (
      origin?.kind === 'skill_activation' &&
      origin.skillName === skillName &&
      origin.skillArgs === skillArgs
    );
  });
}

export function skillEchoTurnExists(
  items: readonly TranscriptItem[],
  anchorTurnId: string | undefined,
  skillName: unknown,
  skillArgs: unknown,
  opts?: { terminalOnly?: boolean },
): boolean {
  const anchorIdx =
    anchorTurnId === undefined
      ? -1
      : items.findIndex((item) => item.kind === 'turn' && item.turnId === anchorTurnId);
  if (anchorTurnId !== undefined && anchorIdx === -1) return false;
  return items.slice(anchorIdx + 1).some((item) => {
    if (item.kind !== 'turn') return false;
    // Settling a local fate needs the work ENDED: a running echo turn proves
    // only that it started (fine for hiding the bubble at render time). The
    // blocked MARKER alone may prove ending without a turn.
    if (opts?.terminalOnly === true && item.state === 'running') return false;
    const payload = ((item.origin as { payload?: unknown }).payload ?? item.origin) as {
      kind?: unknown;
      skillName?: unknown;
      skillArgs?: unknown;
    };
    return (
      payload.kind === 'skill_activation' &&
      payload.skillName === skillName &&
      payload.skillArgs === skillArgs
    );
  });
}

/** Pair uncertain SKILL bubbles with their echo entities ONE-TO-ONE, turn
 *  ids and marker ids sharing one consumption namespace: two identical
 *  activations lost to a missing response share anchors, and an existence
 *  check lets ONE skill turn (or marker) retire both bubbles — the second
 *  request may never have been observed. The caller persists the consumption
 *  across frames (like uncertainEchoMatchedIds' prompt twin). Returns
 *  bubbleId → entityId (turnId or markerId) of the new pairs. */
export function skillEchoMatchedIds(
  bubbles: readonly {
    id: string;
    anchorTurnId: string | undefined;
    promptFloor: string | undefined;
    skillName: unknown;
    skillArgs: unknown;
  }[],
  items: readonly TranscriptItem[],
  alreadyConsumed?: ReadonlySet<string>,
): Map<string, string> {
  const matched = new Map<string, string>();
  const consumed = new Set<string>(alreadyConsumed ?? []);
  for (const bubble of bubbles) {
    const anchorIdx =
      bubble.anchorTurnId === undefined
        ? -1
        : items.findIndex((item) => item.kind === 'turn' && item.turnId === bubble.anchorTurnId);
    // A rewound anchor (undo/reset) means nothing here is this bubble's echo.
    if (bubble.anchorTurnId !== undefined && anchorIdx === -1) continue;
    const mate = items.slice(anchorIdx + 1).find((item) => {
      if (item.kind === 'turn') {
        if (consumed.has(item.turnId)) return false;
        const payload = ((item.origin as { payload?: unknown }).payload ?? item.origin) as {
          kind?: unknown;
          skillName?: unknown;
          skillArgs?: unknown;
        };
        return (
          payload.kind === 'skill_activation' &&
          payload.skillName === bubble.skillName &&
          payload.skillArgs === bubble.skillArgs
        );
      }
      if (item.kind === 'marker' && item.marker === 'skill') {
        if (consumed.has(item.markerId)) return false;
        if (bubble.promptFloor !== undefined) {
          const at = (item as { at?: unknown }).at;
          if (typeof at !== 'string' || at <= bubble.promptFloor) return false;
        }
        const origin = (
          item.payload as
            | { origin?: { kind?: unknown; skillName?: unknown; skillArgs?: unknown } }
            | undefined
        )?.origin;
        return (
          origin?.kind === 'skill_activation' &&
          origin.skillName === bubble.skillName &&
          origin.skillArgs === bubble.skillArgs
        );
      }
      return false;
    });
    if (mate !== undefined) {
      // The find predicate only admits turns and skill markers.
      const mateId = mate.kind === 'turn' ? mate.turnId : (mate as { markerId: string }).markerId;
      consumed.add(mateId);
      matched.set(bubble.id, mateId);
    }
  }
  return matched;
}

const turns = computed<ChatTurn[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const transcriptEntry = activeMainTranscriptEntry();
  if (transcriptEntry === null) return [];
  const base = mainTurnsProjector(transcriptEntry.channel.snapshot, {
    sessionId: sid,
    getFileUrl: getFileUrlById,
    getSessionMediaUrl,
    plansByToolCallId: plansBySession[sid],
    planReviewByToolCallId: rawState.planReviewByToolCallId,
    agentCreatedAt: rawState.sessions.find((s) => s.id === sid)?.createdAt,
    pendingInteractionAtByStepId: pendingInteractionAtBySid.get(sid),
  });
  // Optimistic user bubbles (S8): pure UI state, overlaid until the
  // transcript's turn header covers the same prompt — then dropped.
  const optimistic = rawState.optimisticMessagesBySession[sid] ?? [];
  if (optimistic.length === 0) return base;
  const transcriptTurns = transcriptEntry.channel.snapshot.items.filter(
    (item) => item.kind === 'turn',
  );
  // One-to-one echo pairing for the uncertain text path: two identical
  // uncertain sends (a lost response re-sent) share text AND anchor, so an
  // existence check would let ONE prompt entity cover both bubbles — each
  // prompt entity consumes at most one, in submission order.
  const uncertainMatched = uncertainEchoMatchedIds(
    optimistic
      .filter(
        (msg) =>
          msg.metadata?.['kimiWeb.uncertain'] === true &&
          msg.metadata?.['kimiWeb.promptId'] === undefined &&
          (msg.metadata?.['origin'] as { kind?: unknown } | undefined)?.kind !==
            'skill_activation',
      )
      .map((msg) => ({
        id: msg.id,
        text: msg.content
          .filter((part) => part.type === 'text')
          .map((part) => ('text' in part ? part.text : ''))
          .join(''),
        floor: promptEchoFloor(transcriptEntry.channel.snapshot.items, msg.metadata),
      })),
    transcriptEntry.channel.snapshot.prompts,
    // A prompt bound to an already-retired bubble stays consumed across
    // frames (see consumedEchoPromptIdsBySid) — the next identical bubble
    // must not be covered by it.
    consumedEchoPromptIdsBySid.get(sid),
  );
  // The same one-to-one pairing for uncertain SKILL bubbles: one skill turn
  // (or marker) must not cover two identical activations.
  const skillMatched = skillEchoMatchedIds(
    optimistic
      .filter(
        (msg) =>
          msg.metadata?.['kimiWeb.uncertain'] === true &&
          (msg.metadata?.['origin'] as { kind?: unknown } | undefined)?.kind ===
            'skill_activation',
      )
      .map((msg) => {
        const origin = msg.metadata?.['origin'] as
          | { skillName?: unknown; skillArgs?: unknown }
          | undefined;
        return {
          id: msg.id,
          anchorTurnId: msg.metadata?.['kimiWeb.anchorTurnId'] as string | undefined,
          promptFloor: msg.metadata?.['kimiWeb.anchorPromptCreatedAt'] as string | undefined,
          skillName: origin?.skillName,
          skillArgs: origin?.skillArgs,
        };
      }),
    transcriptEntry.channel.snapshot.items,
    consumedSkillEchoIdsBySid.get(sid),
  );
  const uncovered = optimistic.filter((msg) => {
    // Identity reconciliations come FIRST — they don't depend on the anchor
    // (a forward window slide can evict the anchor turn without any undo).
    // A bubble stamped with the daemon's prompt id reconciles by IDENTITY: a
    // queued prompt keeps its bubble until its own turn starts — another
    // client's identical-text or attachment-only turn must not cover it.
    const stampedPromptId = msg.metadata?.['kimiWeb.promptId'] as string | undefined;
    if (stampedPromptId !== undefined) {
      return !transcriptEntry.channel.snapshot.prompts.some(
        (prompt) => prompt.promptId === stampedPromptId && prompt.status !== 'queued',
      );
    }
    // A skill activation's display identity is its structured origin, not the
    // text: the transcript turn's prompt is the EXPANDED skill prompt, so a
    // text comparison never covers a slash-command bubble — and the generic
    // uncertain branch below would strand it forever (a skill's `/name args`
    // text never equals the expanded prompt entity's content).
    const msgOrigin = msg.metadata?.['origin'] as
      | { kind?: unknown; skillName?: unknown; skillArgs?: unknown }
      | undefined;
    if (msgOrigin?.kind === 'skill_activation') {
      // Name AND args, anchored at submit time: another client's turn — or a
      // historical same-skill turn before the anchor — is not OUR activation's
      // echo and must not cover the local bubble. An UNCERTAIN one pairs
      // one-to-one (two identical lost activations share these anchors).
      if (msg.metadata?.['kimiWeb.uncertain'] === true) {
        return !skillMatched.has(msg.id);
      }
      const anchorIdForSkill = msg.metadata?.['kimiWeb.anchorTurnId'] as string | undefined;
      return !skillEchoTurnExists(
        transcriptEntry.channel.snapshot.items,
        anchorIdForSkill,
        msgOrigin.skillName,
        msgOrigin.skillArgs,
      );
    }
    // An uncertain bubble (submit response lost; may already be queued
    // server-side) has NO identity — never let text-matching turns cover it:
    // only the transcript's prompt entities (its own queued prompt leaving
    // the queue) may retire it, paired one-to-one (see above).
    if (msg.metadata?.['kimiWeb.uncertain'] === true) {
      return !uncertainMatched.has(msg.id);
    }
    // The anchor is stamped at SUBMIT time (kimiWeb.anchorTurnId): resolving
    // it here, on first render, could capture the turn the daemon already
    // created for this very prompt (background sessions evaluate lazily) and
    // the bubble would double-render until the turn ends.
    const anchorId = msg.metadata?.['kimiWeb.anchorTurnId'] as string | undefined;
    const anchorIdx =
      anchorId === undefined
        ? -1
        : transcriptTurns.findIndex((turn) => turn.kind === 'turn' && turn.turnId === anchorId);
    // The anchor turn was rewound (undo/reset): keep the bubble — the finish
    // path retires it, and a whole-history match could hide a fresh resend.
    if (anchorId !== undefined && anchorIdx === -1) return true;
    const candidates = transcriptTurns.slice(anchorIdx + 1);
    const text = msg.content
      .filter((part) => part.type === 'text')
      .map((part) => ('text' in part ? part.text : ''))
      .join('');
    return !candidates.some(
      (turn) =>
        turn.kind === 'turn' &&
        ((turn.prompt ?? '') === text ||
          (text === '' && (turn.attachmentIds?.length ?? 0) > 0)),
    );
  });
  if (uncovered.length === 0) return base;
  const startNo = base.filter((turn) => turn.role !== 'compaction').length + 1;
  return [
    ...base,
    ...uncovered.flatMap((msg, index) =>
      messagesToTurns([msg], [], getFileUrlById, false, {}, {}, {
        startNo: startNo + index,
        getSessionMediaUrl,
      }),
    ),
  ];
});

/** The working indicator: the main conversation has an unfinished prompt — either
 *  submitted-but-not-terminated (`inFlight`) or a main turn in flight
 *  (`turnActive`). */
const working = computed<boolean>(() => inFlight.value || turnActive.value);

// Observed times of each session's pending interactions, keyed by the RUNNING
// step they suspend. An approval/question pauses that step WITHOUT a
// step.endedAt, and an open thinking span would otherwise keep billing the
// human's wait as thinking time — the turns projector settles each suspended
// step's open span at its own stamp (two sequential interactions keep
// INDEPENDENT ceilings; a session-wide stamp would re-bill the first step).
// Written by the transcript edge watcher below; read by the turns computed
// (reactive so the settle re-renders the moment the interaction lands).
const pendingInteractionAtBySid = shallowReactive(new Map<string, ReadonlyMap<string, string>>());

// The transcript pool follows the active session; the approvals/questions
// store and the plan-review record are sourced from the transcript
// interactions of every resident session (the pool keeps them subscribed in
// the background, so badges stay live too).
{
  const host = mainTranscriptHost;
  watch(
    () => rawState.activeSessionId,
    (sid, prevSid) => {
      if (prevSid !== undefined && prevSid !== sid) host.deactivate(prevSid);
      // First-read failures retry INSIDE the pool on a capped backoff — the
      // pool owns the attempt counter so it survives the entry's eviction,
      // and this watcher only ever expresses user intent. Keeping entry
      // existence out of the watched sources also keeps the reactive graph
      // acyclic: activate() mutates pool state that nothing here observes
      // (a sync first-read failure would otherwise retrigger this watcher
      // within its own flush and loop on "Maximum recursive updates").
      if (sid) host.activate(sid);
    },
    { immediate: true },
  );
  watch(
      () =>
        [
          rawState.activeSessionId,
          ...[...host.pool.subscribedSessions].flatMap((sid) => [
            host.pool.getEntry(sid)?.version.value ?? -1,
            // A side-chat's own transcript drives the interaction merge too —
            // a side-only frame (new or resolved approval) must re-run it
            // even when no main frame ever comes.
            auxiliaryTranscripts.getEntry(
              sid,
              sideChat.sideChatTargetBySession.value[sid]?.agentId ?? '',
            )?.version.value ?? -1,
            // The agent whose DETAIL panel is open is transcript-grade too:
            // while it streams, the server suppresses its projected session
            // events on this connection, so its new/resolved interactions
            // only land on its auxiliary entry. The desired agent itself is
            // reactive (panel open/close/switch must re-run the merge).
            auxiliaryTranscripts.desiredAgentBySession.get(sid),
            auxiliaryTranscripts.getEntry(
              sid,
              auxiliaryTranscripts.desiredAgentBySession.get(sid) ?? '',
            )?.version.value ?? -1,
          ]),
        ] as const,
      () => {
        for (const sid of host.pool.subscribedSessions) {
          const entry = host.pool.getEntry(sid);
          if (entry === undefined || !entry.baselineLoaded) continue;
          // agent.status.updated is suppressed in render mode: the mode,
          // model and thinking slices ride the transcript's meta instead.
          // Fold them into the legacy per-session slices here so every
          // reader — status bar, composer, mode toggles and the prompt
          // submission path — sees one consistent fact.
          const meta = entry.channel.snapshot.meta;
          let statusMetaChanged = false;
          const planOn = meta.modes?.plan !== undefined;
          // Same shield as swarm below: while the user's plan-off profile
          // write is in flight, a stale meta must not flip the mode back on —
          // the next prompt would resubmit with plan mode still enabled.
          if (
            rawState.pendingPlanBySession[sid] === undefined &&
            (rawState.planModeBySession[sid] ?? false) !== planOn
          ) {
            rawState.planModeBySession = { ...rawState.planModeBySession, [sid]: planOn };
            statusMetaChanged = true;
          }
          const swarmOn = meta.modes?.swarm !== undefined;
          // Shielded like the thinking fold below: while the user's own
          // profile write is in flight, a stale meta (built before the write
          // landed) must not flip the optimistic toggle back — the next
          // prompt would otherwise submit with the OLD mode.
          if (
            rawState.pendingSwarmBySession[sid] === undefined &&
            (rawState.swarmModeBySession[sid] ?? false) !== swarmOn
          ) {
            rawState.swarmModeBySession = { ...rawState.swarmModeBySession, [sid]: swarmOn };
            statusMetaChanged = true;
          }
          const metaModel = meta.agent?.model;
          if (metaModel !== undefined) {
            const row = rawState.sessions.find((s) => s.id === sid);
            if (row !== undefined && row.model !== metaModel) {
              rawState.sessions = rawState.sessions.map((s) =>
                s.id === sid ? { ...s, model: metaModel } : s,
              );
              statusMetaChanged = true;
            }
          }
          const metaThinking = meta.agent?.thinkingEffort;
          if (metaThinking !== undefined) {
            // Advance the version only when the fold can actually MOVE the
            // value: an unchanged level — or one a pending pick is shielding
            // (the fold no-ops then) — must not drop an in-flight /status
            // answer that carries fresh context numbers for nothing.
            if (
              rawState.pendingThinkingBySession[sid] === undefined &&
              rawState.thinkingBySession[sid] !== metaThinking
            ) {
              statusMetaChanged = true;
            }
            foldDaemonThinkingLevel(rawState, sid, metaThinking as ThinkingLevel);
          }
          // Advance the status version AFTER the fold: a /status response
          // older than this frame must lose its race (see refreshSessionStatus).
          if (statusMetaChanged) bumpSessionStatusVersion(sid);
          // A docked subagent can outlive the turn that spawned it: when a LIVE
          // subagent row has no parent link anywhere (persistent cache AND
          // current window) and older pages exist, pull one — the spawning
          // frame rides in on the next bump and fills the cache. A failed pull
          // backs off: an unchecked retry would storm once per watcher frame.
          const snapshot = entry.channel.snapshot;
          if (snapshot.hasMoreOlder === true && !entry.channel.loadingOlder) {
            const windowParents = spawnedParentByAgentId(snapshot);
            const cache = spawnedIndexCacheFor(sid);
            const missingParent = snapshot.tasks.some(
              (task) =>
                task.kind === 'subagent' &&
                task.agentId !== undefined &&
                task.state === 'running' &&
                !cache.parents.has(task.agentId) &&
                !windowParents.has(task.agentId),
            );
            if (missingParent) {
              const failedAt = loadOlderFailedAtBySid.get(sid) ?? 0;
              if (Date.now() - failedAt > 30_000) {
                void entry.channel.loadOlder().catch(() => {
                  loadOlderFailedAtBySid.set(sid, Date.now());
                  // Schedule the retry's own wake-up: a suspended subagent
                  // (parked on an approval) emits no further ops, so no
                  // future watcher frame would ever pass the backoff gate.
                  setTimeout(() => {
                    const e = host.pool.getEntry(sid);
                    if (e !== undefined) e.version.value += 1;
                  }, 30_000);
                });
              }
            }
          }
          // goal.updated is suppressed too: the transcript's meta.goal is the
          // only live goal channel. Sync just the status lifecycle (the card's
          // detail fields stay REST-fed via refreshSessionGoal) so
          // onMainTurnEnd's goalActive predicate — which gates the unread dot
          // and the completion notification — decides on the CURRENT status,
          // not a stale 'active' from before the suppression.
          const metaGoal = meta.goal;
          const localGoal = rawState.goalBySession[sid];
          if (metaGoal === undefined || metaGoal.status === 'complete') {
            const hadGoal = localGoal !== undefined;
            if (hadGoal) delete rawState.goalBySession[sid];
            // A terminal meta invalidates ANY in-flight backfill — the shared
            // request mutex covers the non-active goal's read too (the
            // notification pending mark only exists for active goals). Bump
            // once per terminal fold: clearing the pending mark here makes a
            // re-run a no-op, and an idle goal-less session never spins the
            // version counter.
            const backfillInFlight = goalBackfillInFlight.has(sid);
            if (hadGoal || backfillInFlight) {
              rawState.goalVersionBySession[sid] =
                (rawState.goalVersionBySession[sid] ?? 0) + 1;
              goalFetchPendingBySession.delete(sid);
              goalBackfillStatusBySid.delete(sid);
            }
          } else if (localGoal !== undefined && localGoal.status !== metaGoal.status) {
            rawState.goalBySession[sid] = { ...localGoal, status: metaGoal.status };
            rawState.goalVersionBySession[sid] =
              (rawState.goalVersionBySession[sid] ?? 0) + 1;
          } else if (localGoal === undefined) {
            // First sight of a goal created elsewhere (another client) in a
            // resident session: backfill the full entry over REST. Only an
            // ACTIVE goal's backfill holds the pending mark (which
            // onMainTurnEnd reads as goal-active) — a goal that is already
            // blocked/paused at first sight must NOT suppress this turn end's
            // unread dot and completion notification. Both paths share the
            // request mutex: streaming version bumps re-enter here per frame.
            if (!goalBackfillInFlight.has(sid)) {
              startGoalBackfill(sid, metaGoal.status);
            } else if (goalBackfillStatusBySid.get(sid) !== metaGoal.status) {
              // The meta moved while the first-sight read is still in flight:
              // its response was built for the OLD status — invalidate it or
              // the card would pin the goal at a state the daemon already
              // left (a plain mutex only stops new requests, it doesn't age
              // the answer already on its way back). Recording the new status
              // also retriggers the backfill once the stale read settles.
              goalBackfillStatusBySid.set(sid, metaGoal.status);
              rawState.goalVersionBySession[sid] =
                (rawState.goalVersionBySession[sid] ?? 0) + 1;
              if (metaGoal.status === 'active') goalFetchPendingBySession.add(sid);
              else goalFetchPendingBySession.delete(sid);
            }
          }
          const approvals: AppApprovalRequest[] = [];
          const questions: AppQuestionRequest[] = [];
          const planReviews: Record<string, { plan: string; path?: string }> = {};
          for (const interaction of entry.channel.snapshot.interactions) {
            const approval = interactionToApproval(interaction, sid);
            if (approval !== undefined) approvals.push(approval);
            const question = interactionToQuestion(interaction, sid);
            if (question !== undefined) questions.push(question);
            const request = interaction.request as
              | { toolCallId?: unknown; display?: { kind?: unknown; plan?: unknown; path?: unknown } }
              | undefined;
            const display = request?.display;
            const toolCallId =
              typeof interaction.toolCallId === 'string'
                ? interaction.toolCallId
                : typeof request?.toolCallId === 'string'
                  ? request.toolCallId
                  : undefined;
            if (
              toolCallId !== undefined &&
              display?.kind === 'plan_review' &&
              typeof display.plan === 'string' &&
              display.plan.length > 0
            ) {
              planReviews[toolCallId] = {
                plan: display.plan,
                path: typeof display.path === 'string' ? display.path : undefined,
              };
            }
          }
          // A BTW side-chat agent shares this session: its interactions live
          // on its OWN transcript, and the session-level store is where the
          // badge/cards read them — a wholesale main-only replace would wipe
          // them on the next main frame while the side-chat still waits.
          // The agent whose DETAIL panel is open is in the same boat: while
          // it streams at transcript grade, the server suppresses its
          // projected session events on this connection, so its new/resolved
          // approvals and questions only ever land on its auxiliary entry.
          const auxMergeAgentIds = new Set<string>();
          const sideAgentId = sideChat.sideChatTargetBySession.value[sid]?.agentId;
          if (sideAgentId !== undefined) auxMergeAgentIds.add(sideAgentId);
          const detailAgentId = auxiliaryTranscripts.desiredAgentBySession.get(sid);
          if (detailAgentId !== undefined) auxMergeAgentIds.add(detailAgentId);
          const auxMergeEntries = [...auxMergeAgentIds]
            .map((agentId) => auxiliaryTranscripts.getEntry(sid, agentId))
            .filter(
              (auxEntry): auxEntry is NonNullable<typeof auxEntry> =>
                auxEntry?.baselineLoaded === true,
            );
          for (const auxEntry of auxMergeEntries) {
            // Notifications ride the same frame: the server suppresses these
            // agents' projected session events on this connection, so a NEW
            // pending interaction would otherwise surface as a silent card
            // only. The seen set seeds from the entry's FIRST loaded baseline
            // (its history stays silent); stale ids prune to the snapshot.
            const auxKey = `${sid}:${auxEntry.channel.agentId}`;
            let notified = auxNotifiedInteractionIdsByKey.get(auxKey);
            if (notified === undefined) {
              notified = new Set(
                auxEntry.channel.snapshot.interactions.map((interaction) => interaction.interactionId),
              );
              auxNotifiedInteractionIdsByKey.set(auxKey, notified);
            } else {
              for (const interaction of auxEntry.channel.snapshot.interactions) {
                if (interaction.state !== 'pending' || notified.has(interaction.interactionId)) {
                  continue;
                }
                notified.add(interaction.interactionId);
                const approval = interactionToApproval(interaction, sid);
                if (approval !== undefined) onApprovalRequested(sid, approval);
                const question = interactionToQuestion(interaction, sid);
                if (question !== undefined) onQuestionRequested(sid, question);
              }
              for (const id of [...notified]) {
                if (
                  !auxEntry.channel.snapshot.interactions.some(
                    (interaction) => interaction.interactionId === id,
                  )
                ) {
                  notified.delete(id);
                }
              }
            }
            const seenApprovalIds = new Set(approvals.map((a) => a.approvalId));
            const seenQuestionIds = new Set(questions.map((q) => q.questionId));
            for (const interaction of auxEntry.channel.snapshot.interactions) {
              const approval = interactionToApproval(interaction, sid);
              if (approval !== undefined && !seenApprovalIds.has(approval.approvalId)) {
                // The reducer's session-event entry (when present) carries
                // the real expiry/stamps — prefer it over the bare mapping.
                const existing = (rawState.approvalsBySession[sid] ?? []).find(
                  (a) => a.approvalId === approval.approvalId,
                );
                approvals.push(existing ?? approval);
              }
              const question = interactionToQuestion(interaction, sid);
              if (question !== undefined && !seenQuestionIds.has(question.questionId)) {
                const existing = (rawState.questionsBySession[sid] ?? []).find(
                  (q) => q.questionId === question.questionId,
                );
                questions.push(existing ?? question);
              }
            }
          }
          // Entries the MAIN snapshot knows nothing about are not its
          // business (another agent's) — keep them only while NO transcript
          // proves them resolved: the merged auxiliary transcripts are
          // authoritative for their own interactions once loaded.
          const mainInteractionIds = new Set(
            entry.channel.snapshot.interactions.map((interaction) => interaction.interactionId),
          );
          const auxResolvedIds = new Set(
            auxMergeEntries.flatMap((auxEntry) =>
              auxEntry.channel.snapshot.interactions
                .filter((interaction) => interaction.state !== 'pending')
                .map((interaction) => interaction.interactionId),
            ),
          );
          for (const existing of rawState.approvalsBySession[sid] ?? []) {
            if (mainInteractionIds.has(existing.approvalId)) continue;
            if (auxResolvedIds.has(existing.approvalId)) continue;
            if (!approvals.some((a) => a.approvalId === existing.approvalId)) {
              approvals.push(existing);
            }
          }
          for (const existing of rawState.questionsBySession[sid] ?? []) {
            if (mainInteractionIds.has(existing.questionId)) continue;
            if (auxResolvedIds.has(existing.questionId)) continue;
            if (!questions.some((q) => q.questionId === existing.questionId)) {
              questions.push(existing);
            }
          }
          approvalsStore().setSessionApprovals(sid, approvals);
          approvalsStore().setSessionQuestions(sid, questions);
          if (sid === rawState.activeSessionId) {
            applyRecordDiff(rawState.planReviewByToolCallId, planReviews);
          }
        }
      },
      { immediate: true },
    );
    // Turn-boundary and interaction edges, rebuilt from the transcript
    // entities of every resident session: the legacy session_event edges are
    // gone in render mode, so unread dots, completion/approval/question
    // notifications, queue drains, prompt-id backfill and recency bumps all
    // fire from here. A session's first baseline initializes the tracker
    // without firing — a historical load must not cry wolf.
    type EdgePrev = {
      activity: string | undefined;
      lastTurnId: string | undefined;
      lastTurnState: string | undefined;
      /** Highest turn ordinal seen so far — history prepends carry LOWER
       *  ordinals and must never count as new work. */
      maxTurnOrdinal: number;
      /** The previous frame's window-head item id — items BEFORE it on the
       *  next frame are loadOlder history, not live edges. */
      firstItemId: string | undefined;
      seenPendingInteractionIds: Set<string>;
      /** ExitPlanMode interactions already settled locally — dedupes both the
       *  seen-pending resolved edge and the same-window scan below. */
      settledPlanInteractionIds: Set<string>;
      seenNoticeIds: Set<string>;
      promptStatusById: Map<string, string>;
    };
    const edgePrevBySid = new Map<string, EdgePrev>();
    const bumpRecencyLocal = (sid: string, serverNow?: string): void => {
      // Server-domain stamps only for facts the transcript carries: comparing
      // a browser clock against the daemon's updatedAt either never bumps
      // (slow client) or pins the session in the future (fast client) across
      // hosts. The exception is a LIVE arrival (a fresh interaction frame):
      // the transcript carries no stamp for it at all, the arrival IS the
      // news, and the caller passes nothing so the browser clock reads "now".
      const now = serverNow ?? new Date().toISOString();
      rawState.sessions = rawState.sessions.map((s) =>
        s.id === sid && now > s.updatedAt ? { ...s, updatedAt: now } : s,
      );
    };
    /** Settle every resolved ExitPlanMode interaction in the snapshot once
     *  (deduped per session): the plan card's outcome is a transcript fact
     *  even when the resolved frame shared one window with its pending
     *  frame — or when the whole baseline arrived at once. Returns whether
     *  anything settled (the caller refetches /transcript/plan then). */
    const settleResolvedPlanInteractions = (
      sid: string,
      snapshot: AgentTranscriptSnapshot,
      dedupe: Set<string>,
    ): boolean => {
      let settled = false;
      for (const interaction of snapshot.interactions) {
        if (interaction.state === 'pending') continue;
        if (dedupe.has(interaction.interactionId)) continue;
        if (
          (interaction.request as { toolName?: unknown } | undefined)?.toolName !==
          'ExitPlanMode'
        ) {
          continue;
        }
        dedupe.add(interaction.interactionId);
        settled = true;
        const request = interaction.request as { toolCallId?: unknown } | undefined;
        const toolCallId =
          typeof interaction.toolCallId === 'string'
            ? interaction.toolCallId
            : typeof request?.toolCallId === 'string'
              ? request.toolCallId
              : undefined;
        const outcome = interaction.state;
        if (
          toolCallId !== undefined &&
          (outcome === 'approved' || outcome === 'rejected' || outcome === 'cancelled')
        ) {
          const response = interaction.response as
            | { selectedOption?: unknown; feedback?: unknown }
            | undefined;
          settlePlanReviewLocally(sid, toolCallId, {
            state: outcome,
            selectedOption:
              typeof response?.selectedOption === 'string' ? response.selectedOption : undefined,
            feedback: typeof response?.feedback === 'string' ? response.feedback : undefined,
          });
        }
      }
      return settled;
    };
    watch(
      () =>
        [...host.pool.subscribedSessions].map(
          (sid) => host.pool.getEntry(sid)?.version.value ?? -1,
        ),
      () => {
        // An LRU-evicted session's edge tracker must not survive its pool
        // entry — a later re-open gets a fresh baseline, not phantom edges
        // computed against the stale record.
        for (const prevSid of [...edgePrevBySid.keys()]) {
          if (!host.pool.subscribedSessions.has(prevSid)) {
            edgePrevBySid.delete(prevSid);
            pendingInteractionAtBySid.delete(prevSid);
            spawnedIndexCacheBySid.delete(prevSid);
            loadOlderFailedAtBySid.delete(prevSid);
          }
        }
        for (const sid of host.pool.subscribedSessions) {
          const entry = host.pool.getEntry(sid);
          if (entry === undefined || !entry.baselineLoaded) continue;
          const snapshot = entry.channel.snapshot;
          const turns = snapshot.items.filter((item) => item.kind === 'turn');
          const pendingInteractions = snapshot.interactions.filter(
            (interaction) => interaction.state === 'pending',
          );
          const promptStatusById = new Map(
            snapshot.prompts.map((prompt) => [prompt.promptId, prompt.status] as const),
          );
          const prev = edgePrevBySid.get(sid);
          const last = turns.at(-1);
          const lastTurnId = last?.kind === 'turn' ? last.turnId : undefined;
          const lastTurnState = last?.kind === 'turn' ? last.state : undefined;
          edgePrevBySid.set(sid, {
            activity: snapshot.meta.activity,
            lastTurnId,
            lastTurnState,
            maxTurnOrdinal: turns.reduce(
              (max, turn) => (turn.kind === 'turn' ? Math.max(max, turn.ordinal) : max),
              -1,
            ),
            firstItemId: snapshot.items[0] === undefined ? undefined : transcriptItemId(snapshot.items[0]),
            seenPendingInteractionIds: new Set(pendingInteractions.map((i) => i.interactionId)),
            // Carry the settled-plan dedupe across the per-frame record
            // replace (unlike seen-pending, it is not derivable per frame).
            settledPlanInteractionIds: prev?.settledPlanInteractionIds ?? new Set<string>(),
            seenNoticeIds: new Set(
              snapshot.items
                .filter((item) => item.kind === 'marker' && item.marker === 'notice')
                .map((item) => (item.kind === 'marker' ? item.markerId : '')),
            ),
            promptStatusById,
          });
          // Track pending-interaction stamps PER SUSPENDED STEP on every
          // frame, cold baseline included: a session reopened while parked on
          // an approval/question already carries the pending interaction, and
          // each suspended step's open thinking span settles at its own
          // observed time. Resolved stamps stay as ceilings until turn end.
          const hasNewPending = pendingInteractions.some(
            (interaction) => !prev?.seenPendingInteractionIds.has(interaction.interactionId),
          );
          if (pendingInteractions.length > 0 && hasNewPending) {
            const runningTurn = snapshot.items.findLast(
              (item) => item.kind === 'turn' && item.state === 'running',
            );
            const runningStep =
              runningTurn?.kind === 'turn'
                ? runningTurn.steps.findLast((step) => step.state === 'running')
                : undefined;
            if (runningStep !== undefined) {
              // Stamp in the DAEMON time domain: the span is measured against
              // the step's server-side startedAt, so a browser clock skewed
              // from the daemon would miscount (or negate) the thinking span.
              // The interaction entity carries no timestamp of its own — the
              // snapshot's newest server stamp is the closest "now" available.
              const next = new Map(pendingInteractionAtBySid.get(sid));
              next.set(runningStep.stepId, newestServerStamp(snapshot) ?? new Date().toISOString());
              pendingInteractionAtBySid.set(sid, next);
            }
          }
          if (prev === undefined) {
            // A baseline reached through FAILED-REST retries (the pool's
            // recoveredViaEmptyReset — the counter itself already resets in
            // the success path, so the fact rides this flag until consumed
            // here) covered a subscription window whose ops (turn ends,
            // approvals/questions, error notices) landed LIVE but unread —
            // the seconds-scale window makes them near-certainly fresh, so
            // surface the interaction and error signals now (turn-end
            // lifecycle edges still initialize silently: history can't be
            // told from news there).
            if (entry.recoveredViaEmptyReset) {
              entry.recoveredViaEmptyReset = false;
              for (const interaction of pendingInteractions) {
                // These interactions landed live-but-unread inside the
                // seconds-scale recovery window: stamp the arrival, not the
                // snapshot's newest server stamp (a long-running step's old
                // startedAt would fail the updatedAt check and never float).
                bumpRecencyLocal(sid);
                const approval = interactionToApproval(interaction, sid);
                if (approval !== undefined) onApprovalRequested(sid, approval);
                const question = interactionToQuestion(interaction, sid);
                if (question !== undefined) onQuestionRequested(sid, question);
              }
              if (sid !== rawState.activeSessionId) {
                for (const item of snapshot.items) {
                  if (item.kind !== 'marker' || item.marker !== 'notice') continue;
                  const envelope = item.payload as
                    | { level?: unknown; message?: unknown; event?: { code?: unknown } }
                    | undefined;
                  if (envelope?.level !== 'error') continue;
                  // Same envelope shape as the live edge: the raw error fields
                  // ride payload.event, not the outer { level, message } wrap.
                  pushWarning(
                    buildAgentErrorNotice(
                      (envelope.event ?? envelope) as Parameters<typeof buildAgentErrorNotice>[0],
                      t,
                    ),
                  );
                  // Register the shown state with the live branch's content
                  // key — the next select's or turn end's refreshSessionWarnings
                  // would otherwise re-toast this same persisted error.
                  workspaceState.markSessionWarningShown(
                    sid,
                    `${typeof envelope.event?.code === 'string' ? envelope.event.code : ''} ${typeof envelope.message === 'string' ? envelope.message : ''}`,
                  );
                }
              }
            }
            // A session's first baseline doubles as the open-time in-flight
            // reconcile (the retired snapshot path's handleSessionSnapshot):
            // no live turn and no running/queued prompt means any local
            // prompt state left over is stale — clear it quietly (no
            // completion side effects; finishPromptLocal's drain gate
            // suppresses the queue flush on a bare open). Never reap a
            // locally-witnessed prompt: a baseline requested before the user
            // submitted still says 'idle' while the turn is starting, and the
            // turn-end edge owns that lifecycle. The guard is a CURRENTLY
            // pending local start, not a nonzero generation: the generation
            // stays nonzero forever after the session's first submit, and
            // would permanently bar the cleanup of a leftover in-flight.
            // no live turn and no running/queued prompt means any local
            // prompt state left over is stale — but only the fate gate may
            // say so: a live submission (pending POST, skill, in-flight) is
            // judged by its OWN proof, and a fast turn whose terminal frame
            // beat the response settles here too. The queue advances only
            // when every uncertain bubble is proven as well.
            const openFate = localSubmitFate(sid, snapshot);
            if (
              snapshot.meta.activity !== 'turn' &&
              !snapshot.prompts.some(
                (prompt) => prompt.status === 'running' || prompt.status === 'queued',
              ) &&
              openFate.settle
            ) {
              workspaceState.finishPromptLocal(sid, { skipDrain: !openFate.drain });
            }
            // A baseline already carrying a terminal ExitPlanMode interaction
            // must settle it now (the branch below never runs on this first
            // frame) — a lagging /transcript/plan read must not pin the card
            // at "awaiting review" until the next unrelated frame.
            if (
              settleResolvedPlanInteractions(
                sid,
                snapshot,
                edgePrevBySid.get(sid)!.settledPlanInteractionIds,
              )
            ) {
              void refreshSessionPlans(sid);
            }
            continue;
          }

          // Turn-end edges, ENUMERATED past the tracked watermark: two turns
          // can end in one notification window (a queued prompt's turn right
          // on the previous one's heels), and settling only one would drop
          // the other's title/git/goal refreshes and completion notice
          // forever. History prepends carry LOWER ordinals (never new work).
          // A tracked turn gone from the window is a rewind ONLY when the
          // window's max ordinal also DROPPED (undo/reset rewinds the tail) —
          // a fresh page that slid FORWARD past it (more turns landed while
          // disconnected) is new work to enumerate, not an undo.
          let planRefreshNeeded = false;
          const windowMaxOrdinal = turns.reduce(
            (max, turn) => (turn.kind === 'turn' ? Math.max(max, turn.ordinal) : max),
            -1,
          );
          const prevTurnGone =
            prev.lastTurnId !== undefined &&
            prev.lastTurnId !== lastTurnId &&
            !turns.some((turn) => turn.kind === 'turn' && turn.turnId === prev.lastTurnId);
          const prevTurnRewound = prevTurnGone && windowMaxOrdinal < prev.maxTurnOrdinal;
          if (prevTurnRewound) {
            // The rewind may have deleted the turns the spawned-call cache was
            // built from: a resumed subagent's mapping would keep pointing at a
            // now-nonexistent call, and the cache holding the key would also
            // suppress the older-page backfill that could re-prove it. Drop it
            // and let the post-rewind window (plus the backfill) rebuild it.
            spawnedIndexCacheBySid.delete(sid);
          }
          const endedTurns: TranscriptTurn[] = [];
          if (!prevTurnRewound) {
            // The tracked turn's own running→terminal transition (shadowed by
            // an immediately-started successor that keeps activity at 'turn').
            const tracked =
              prev.lastTurnId === undefined
                ? undefined
                : turns.find((turn) => turn.kind === 'turn' && turn.turnId === prev.lastTurnId);
            if (
              tracked?.kind === 'turn' &&
              prev.lastTurnState === 'running' &&
              tracked.state !== 'running'
            ) {
              endedTurns.push(tracked);
            }
            for (const candidate of turns) {
              if (
                candidate.kind === 'turn' &&
                candidate.ordinal > prev.maxTurnOrdinal &&
                candidate.state !== 'running'
              ) {
                endedTurns.push(candidate);
              }
            }
          }
          const activityEdge = prev.activity === 'turn' && snapshot.meta.activity !== 'turn';
          if (endedTurns.length > 0 || activityEdge) {
            // Filter BEFORE deciding the drain slot: turns the REST baseline
            // already settled leave the batch entirely — indexing into the
            // unfiltered array would give a non-final unsettled turn the
            // drain, and its finish would reap the prompt REST just drained.
            const unsettled = endedTurns.filter(
              (turn) => settledTurnEndBySession.get(sid) !== turn.turnId,
            );
            for (const [index, endingTurn] of unsettled.entries()) {
              settledTurnEndBySession.set(sid, endingTurn.turnId);
              const aborted = endingTurn.state === 'cancelled' || endingTurn.state === 'failed';
              // Per-turn side effects (title/git/goal refreshes, notification)
              // fire for every ended turn, but the LOCAL settle and the
              // batch's ONE drain both wait for the LAST item: computing the
              // fate against an EARLIER turn with the whole final snapshot
              // would settle our prompt right there (a drain per settle would
              // also submit queued prompts concurrently), and the last item's
              // drain decision would then read an already-cleared state. The
              // settle itself stays attribution-gated: a remote client's turn
              // end must not reap our pending submission (P1).
              const isLast = index === unsettled.length - 1;
              const fate = isLast
                ? localSubmitFate(sid, snapshot)
                : { settle: false, drain: false };
              onMainTurnEnd(sid, aborted ? 'aborted' : 'idle', true, {
                drain: isLast && fate.drain,
                settleLocal: fate.settle,
              });
              bumpRecencyLocal(sid, newestServerStamp(snapshot));
            }
            // The wait is over: clear the pending-interaction ceiling so the
            // NEXT turn's thinking settles on its own stamps — but only when
            // no interaction is pending RIGHT NOW: a successor turn's fresh
            // approval in this same batch keeps its own ceiling.
            if (endedTurns.length > 0 && pendingInteractions.length === 0) {
              pendingInteractionAtBySid.delete(sid);
            }
            if (endedTurns.length === 0 && last?.kind === 'turn') {
              // The activity edge fired with no NEW terminal turn in the
              // window (a bare idle transition) — settle the tail once.
              if (settledTurnEndBySession.get(sid) !== last.turnId) {
                settledTurnEndBySession.set(sid, last.turnId);
                const aborted = last.state === 'cancelled' || last.state === 'failed';
                const fate = localSubmitFate(sid, snapshot);
                onMainTurnEnd(sid, aborted ? 'aborted' : 'idle', true, {
                  drain: fate.drain,
                  settleLocal: fate.settle,
                });
                bumpRecencyLocal(sid, newestServerStamp(snapshot));
              }
            }
            // No plan scan here: the resolved-edge loop below owns ExitPlanMode
            // settlement — a historical resolved interaction would otherwise
            // re-fetch /transcript/plan on EVERY unrelated turn end.
          } else if (lastTurnId !== prev.lastTurnId && !prevTurnRewound && last?.kind === 'turn') {
            bumpRecencyLocal(sid, newestServerStamp(snapshot));
          }

          for (const interaction of pendingInteractions) {
            if (prev.seenPendingInteractionIds.has(interaction.interactionId)) continue;
            // A NEW pending interaction is a live arrival — the interaction
            // entity carries no timestamp, so the snapshot's newest server
            // stamp is just the suspended step's old startedAt, which fails
            // the updatedAt check and never floats the session to the top.
            // Stamp the arrival itself.
            bumpRecencyLocal(sid);
            const approval = interactionToApproval(interaction, sid);
            if (approval !== undefined) onApprovalRequested(sid, approval);
            const question = interactionToQuestion(interaction, sid);
            if (question !== undefined) onQuestionRequested(sid, question);
          }

          // A fresh 'error' notice marks a turn's terminal failure. The
          // legacy raw `error` event is grade-suppressed and onMainTurnEnd
          // deliberately stays silent for aborted turns, so without this the
          // failure of a BACKGROUND session would be invisible unless the
          // user opens it (the failed-turn card covers only the active one).
          // The baseline set above keeps cold history from re-toasting, and
          // the window-head anchor keeps a loadOlder PREPEND's historical
          // notices from re-firing as live errors.
          {
            const headIdx =
              prev.firstItemId === undefined
                ? 0
                : snapshot.items.findIndex((item) => transcriptItemId(item) === prev.firstItemId);
            const liveItems = headIdx > 0 ? snapshot.items.slice(headIdx) : snapshot.items;
            for (const item of liveItems) {
              if (item.kind !== 'marker' || item.marker !== 'notice') continue;
              if (prev.seenNoticeIds.has(item.markerId)) continue;
              const payload = item.payload as
                | { level?: unknown; message?: unknown; event?: { code?: unknown } }
                | undefined;
              // Share the content key with refreshSessionWarnings: the
              // turn-end REST re-pull must not re-toast what already showed.
              const shownKey = `${typeof payload?.event?.code === 'string' ? payload.event.code : ''} ${typeof payload?.message === 'string' ? payload.message : ''}`;
              if (payload?.level === 'error') {
                // The failed-turn card covers the ACTIVE session's errors —
                // but the content key registers either way, or the turn-end
                // REST re-pull would toast the same error a second time.
                workspaceState.markSessionWarningShown(sid, shownKey);
                if (sid === rawState.activeSessionId) continue;
                // The raw error fields live at payload.event (the marker's
                // envelope only carries level/message) — passing the whole
                // payload would render just the generic title and lose the
                // HTTP status, request id and error type.
                pushWarning(
                  buildAgentErrorNotice(
                    (payload?.event ?? payload ?? {}) as Parameters<typeof buildAgentErrorNotice>[0],
                    t,
                  ),
                );
                continue;
              }
              if (payload?.level !== 'warning' && payload?.level !== 'info') continue;
              // A new warning/info notice shows live with its severity, for
              // every session: the raw `warning` event is grade-suppressed,
              // nothing renders these markers in-flow, and the REST re-reads
              // that used to surface them only fire on select / turn end.
              pushWarning({
                severity: payload.level,
                title: t('warnings.noteLabel'),
                message: typeof payload.message === 'string' ? payload.message : undefined,
              });
              workspaceState.markSessionWarningShown(sid, shownKey);
            }
          }

          // Resolved edge: an interaction leaving pending WITHOUT a turn end
          // (handled by another client, or expired) never reaches the
          // turn-end branch above, and the suppressed approvalResolved event
          // can no longer settle the plan review — settle it locally from the
          // interaction's terminal state, then let REST reconcile the detail.
          for (const prevPendingId of prev.seenPendingInteractionIds) {
            if (pendingInteractions.some((i) => i.interactionId === prevPendingId)) continue;
            const resolved = snapshot.interactions.find((i) => i.interactionId === prevPendingId);
            if (
              resolved !== undefined &&
              (resolved.request as { toolName?: unknown } | undefined)?.toolName === 'ExitPlanMode'
            ) {
              prev.settledPlanInteractionIds.add(prevPendingId);
              planRefreshNeeded = true;
              // Settle first, refresh second: a lagging or failed
              // /transcript/plan read must not leave the card "awaiting
              // review" when the outcome is already a transcript fact.
              const request = resolved.request as { toolCallId?: unknown } | undefined;
              const toolCallId =
                typeof resolved.toolCallId === 'string'
                  ? resolved.toolCallId
                  : typeof request?.toolCallId === 'string'
                    ? request.toolCallId
                    : undefined;
              const outcome = resolved.state;
              if (
                toolCallId !== undefined &&
                (outcome === 'approved' || outcome === 'rejected' || outcome === 'cancelled')
              ) {
                const response = resolved.response as
                  | { selectedOption?: unknown; feedback?: unknown }
                  | undefined;
                settlePlanReviewLocally(sid, toolCallId, {
                  state: outcome,
                  selectedOption:
                    typeof response?.selectedOption === 'string'
                      ? response.selectedOption
                      : undefined,
                  feedback:
                    typeof response?.feedback === 'string' ? response.feedback : undefined,
                });
              }
            }
          }
          // Same-window settle: an interaction whose pending AND resolved
          // frames landed in ONE notification window (e.g. a reconnect
          // replay) was never TRACKED pending, so the edge above never sees
          // it — settle any resolved ExitPlanMode interaction once, deduped
          // per session (historical ones settle once per baseline too).
          if (settleResolvedPlanInteractions(sid, snapshot, prev.settledPlanInteractionIds)) {
            planRefreshNeeded = true;
          }
          if (planRefreshNeeded) void refreshSessionPlans(sid);

          for (const prompt of snapshot.prompts) {
            if (prompt.status === 'running' || prompt.status === 'queued') continue;
            const prevStatus = prev.promptStatusById.get(prompt.promptId);
            const terminal =
              prompt.status === 'blocked' || prompt.status === 'aborted';
            // A prompt reaching a terminal state without producing a turn
            // (pre-submit block, queue cancel) never crosses the turn edges
            // above — stamp the session's activity here like the legacy
            // reducer did for these two paths. The lastTurnId guard skips the
            // bump when a turn edge already fired in the same frame. This scan
            // runs BEFORE the abort-target backfill below so OUR terminal
            // prompt still matches the locally stored id (the backfill would
            // overwrite it with another client's live prompt).
            if (
              terminal &&
              prevStatus !== prompt.status &&
              lastTurnId === prev.lastTurnId
            ) {
              // This no-turn terminal IS the session's newest server-side
              // fact: stamp recency with the prompt's own daemon stamp, not a
              // scan of the items window (which tops out at an older turn or
              // — on a fresh session — nothing, falling back to a skewed
              // browser clock).
              bumpRecencyLocal(sid, prompt.createdAt);
              // Settle ONLY by prompt identity. While the submit POST is
              // unanswered the id isn't known yet, and content attribution
              // can't tell this terminal apart from another client's
              // same-text one — reaping on a guess would clear our in-flight
              // state and drain the queue while our own prompt still starts
              // afterwards. The unanswered-submit case (a fast turn, or a
              // skill activation a pre-submit hook blocked — its response
              // never carries a prompt id) settles when the response lands,
              // via settleIfFateProven. Re-settling the same terminal frame
              // twice is already barred by the prevStatus !== prompt.status
              // transition guard above.
              if (rawState.promptIdBySession[sid] === prompt.promptId) {
                workspaceState.finishPromptLocal(sid);
              }
            }
          }

          // Retire uncertain bubbles whose own prompt has LEFT the queue (its
          // turn started): the overlay already hides them at render time, but
          // state must drop them too — hasPendingLocalWork reads this very
          // array for the resident-cap pin, and a stale entry would pin the
          // session (and its WS subscription) forever.
          const optimisticNow = rawState.optimisticMessagesBySession[sid];
          if (
            optimisticNow !== undefined &&
            optimisticNow.some((m) => m.metadata?.['kimiWeb.uncertain'] === true)
          ) {
            // Same one-to-one pairing as the render overlay: a single prompt
            // entity must not retire two identical uncertain sends. The
            // consumption is PERSISTED per session: a prompt that retired a
            // bubble stays consumed on later frames, or the next identical
            // bubble would be retired by the same prompt a frame later.
            const consumed = consumedEchoPromptIdsBySid.get(sid) ?? new Set<string>();
            for (const promptId of [...consumed]) {
              if (!snapshot.prompts.some((p) => p.promptId === promptId)) {
                consumed.delete(promptId);
              }
            }
            consumedEchoPromptIdsBySid.set(sid, consumed);
            const matched = uncertainEchoMatchedIds(
              optimisticNow
                .filter(
                  (m) =>
                    m.metadata?.['kimiWeb.uncertain'] === true &&
                    (m.metadata?.['origin'] as { kind?: unknown } | undefined)?.kind !==
                      'skill_activation',
                )
                .map((m) => ({
                  id: m.id,
                  text: m.content
                    .filter((part) => part.type === 'text')
                    .map((part) => ('text' in part ? part.text : ''))
                    .join(''),
                  floor: promptEchoFloor(snapshot.items, m.metadata),
                })),
              snapshot.prompts,
              consumed,
            );
            for (const promptId of matched.values()) consumed.add(promptId);
            // The skill twin, same persistence shape: a skill turn/marker
            // that retired an uncertain skill bubble stays consumed.
            const consumedSkill = consumedSkillEchoIdsBySid.get(sid) ?? new Set<string>();
            for (const entityId of [...consumedSkill]) {
              const stillThere = snapshot.items.some(
                (item) =>
                  (item.kind === 'turn' && item.turnId === entityId) ||
                  (item.kind === 'marker' && item.markerId === entityId),
              );
              if (!stillThere) consumedSkill.delete(entityId);
            }
            consumedSkillEchoIdsBySid.set(sid, consumedSkill);
            const skillMatched = skillEchoMatchedIds(
              optimisticNow
                .filter(
                  (m) =>
                    m.metadata?.['kimiWeb.uncertain'] === true &&
                    (m.metadata?.['origin'] as { kind?: unknown } | undefined)?.kind ===
                      'skill_activation',
                )
                .map((m) => {
                  const origin = m.metadata?.['origin'] as
                    | { skillName?: unknown; skillArgs?: unknown }
                    | undefined;
                  return {
                    id: m.id,
                    anchorTurnId: m.metadata?.['kimiWeb.anchorTurnId'] as string | undefined,
                    promptFloor: m.metadata?.['kimiWeb.anchorPromptCreatedAt'] as string | undefined,
                    skillName: origin?.skillName,
                    skillArgs: origin?.skillArgs,
                  };
                }),
              snapshot.items,
              consumedSkill,
            );
            for (const entityId of skillMatched.values()) consumedSkill.add(entityId);
            const survivors = optimisticNow.filter((m) => {
              if (m.metadata?.['kimiWeb.uncertain'] !== true) return true;
              // An uncertain SKILL bubble retires when its OWN skill turn (or
              // blocked marker) shows up, paired one-to-one like the prompts.
              const mOrigin = m.metadata?.['origin'] as
                | { kind?: unknown; skillName?: unknown; skillArgs?: unknown }
                | undefined;
              if (mOrigin?.kind === 'skill_activation') {
                return !skillMatched.has(m.id);
              }
              return !matched.has(m.id);
            });
            if (survivors.length !== optimisticNow.length) {
              const next = { ...rawState.optimisticMessagesBySession };
              if (survivors.length > 0) next[sid] = survivors;
              else delete next[sid];
              rawState.optimisticMessagesBySession = next;
            }
          }

          // The abort target is the RUNNING prompt (a queued one is only the
          // fallback when nothing runs) — never let array order overwrite it.
          // Written to its OWN field: promptIdBySession stays OUR last
          // submission's identity (terminal/optimistic reconciliation), so
          // another client's live prompt can't overwrite it here.
          const running = snapshot.prompts.find((prompt) => prompt.status === 'running');
          const fallback = running ?? snapshot.prompts.find((prompt) => prompt.status === 'queued');
          if (fallback !== undefined && rawState.abortPromptIdBySession[sid] !== fallback.promptId) {
            rawState.abortPromptIdBySession[sid] = fallback.promptId;
          } else if (fallback === undefined && rawState.abortPromptIdBySession[sid] !== undefined) {
            // No live prompt: a cached abort target is provably stale — a
            // non-attributed turn end never runs finishPromptLocal (its clear
            // path), and a later id-less turn (e.g. a skill) would watch Stop
            // try the dead id, get not-found and bail before the session-level
            // abort that should have fired.
            delete rawState.abortPromptIdBySession[sid];
          }
        }
        // A session whose local work just settled is no longer pinned past
        // the resident cap — re-trim so evictable extras don't linger with
        // their WS subscriptions (the pin has no clear callback otherwise).
        mainTranscriptHost.trimResident();
      },
      { immediate: true },
    );
}

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
  const transcriptEntry = activeMainTranscriptEntry();
  if (transcriptEntry === null) return [];
  const doc = transcriptEntry.channel.snapshot.todos.at(-1);
  return (doc?.items ?? []).map((item) => ({ title: item.title, status: item.status }));
});

/** Live compaction state of the active session (present only while running). */
const compaction = computed<CompactionStatus | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  const transcriptEntry = activeMainTranscriptEntry();
  if (transcriptEntry !== null) {
    const marker = transcriptEntry.channel.snapshot.items.findLast(
      (item): item is Extract<typeof item, { kind: 'marker' }> =>
        item.kind === 'marker' && item.marker === 'compaction',
    );
    const payload = marker?.payload as { phase?: unknown; trigger?: unknown } | undefined;
    if (marker === undefined || payload?.phase !== 'started') return null;
    return { status: 'running', trigger: payload.trigger === 'manual' ? 'manual' : 'auto' };
  }
  return rawState.compactionBySession[sid] ?? null;
});

const connection = computed<ConnectionState>(() => rawState.connection);

const loading = computed<boolean>(() => rawState.loading);
const sessionLoading = computed<boolean>(() => rawState.sessionLoading);
const loadingMoreMessages = computed<boolean>(() => {
  const transcriptEntry = activeMainTranscriptEntry();
  return transcriptEntry?.channel.loadingOlder ?? false;
});
const hasMoreMessages = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return false;
  const transcriptEntry = activeMainTranscriptEntry();
  return transcriptEntry?.channel.snapshot.hasMoreOlder === true;
});
const loadMoreMessagesError = computed<boolean>(() => {
  const transcriptEntry = activeMainTranscriptEntry();
  return transcriptEntry?.channel.loadOlderError ?? false;
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
  if (!sid) return draftModes.planMode;
  // The shielded map is the single read path: the merge watcher's meta fold
  // keeps it frame-fresh, so reading the transcript meta directly would only
  // re-open the flap windows the shields exist to close. A pending profile
  // write's optimistic value already lives here.
  return rawState.planModeBySession[sid] ?? false;
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
  if (!sid) return draftModes.swarmMode;
  // Same single read path as planMode above: the shielded map (meta-folded
  // every frame, /status-confirmed, shield-held through pending writes).
  return rawState.swarmModeBySession[sid] ?? false;
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
    attachments: q.attachments?.map((a, index) =>
      // The queued payload array IS the submit-time interleave — its index
      // is the add-order hint the queue edit reload restamps from (without
      // it the reload would collapse to media-first).
      promptAttachmentToTurnAttachment(api, a, index),
    ),
    editText: q.editText,
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
  // Lazy: workspaceState is composed below, but only invoked after creation.
  loadConfig: () => workspaceState.loadConfig(),
  checkAuth: () => workspaceState.checkAuth(),
  beginLocalTurn,
  settleLocalTurn,
  mainTranscriptTailTurnId,
  mainTranscriptTailPromptCreatedAt,
  // Invoked only at activation-answer time — after every module is composed.
  settleIfFateProven,
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
  nextOptimisticMsgId,
  lastMainUserPromptText: (sessionId: string): string | null => {
    const entry = mainTranscriptHost.pool.getEntry(sessionId);
    if (entry === undefined) return null;
    const turn = entry.channel.snapshot.items.findLast(
      (item) => item.kind === 'turn' && item.origin.kind === 'user',
    );
    return turn?.kind === 'turn' ? turn.prompt ?? null : null;
  },
  mainTranscriptTailTurnId,
  mainTranscriptTailPromptCreatedAt,
  // Invoked only at submit-answer time — after every module is composed.
  settleIfFateProven,
  getEventConn: () => eventConn,
  subscribeSessionEvents,
  refreshMainTranscript: async (sessionId: string): Promise<void> => {
    const entry = mainTranscriptHost.pool.getEntry(sessionId);
    if (entry === undefined) return;
    // undo needs a read that STARTED after the rewind: refresh() joins any
    // in-flight one whose snapshot point may PREDATE the undo and could write
    // the deleted turns back. The same holds for a pre-undo loadOlder — its
    // pre-rewind page merging after the refresh would resurrect rewound items.
    // Wait both out, then force a fresh read. The reads go through the POOL's
    // serialized path so a reset landing mid-read is buffered and lands
    // after the older page (a direct channel.refresh() would let the stale
    // page overwrite the server's newer reset).
    await entry.channel.settleOlder().catch(() => undefined);
    await mainTranscriptHost.pool.refreshSession(sessionId).catch(() => undefined);
    await mainTranscriptHost.pool.refreshSession(sessionId);
  },
  hasLoadedMessages,
  // cancelTask's agent-id → background-task-id alias lookup: transcript rows
  // carry backgroundTaskId on the row itself.
  resolveTaskRestId: (_sessionId: string, taskId: string): string | undefined =>
    activeAppTasks.value.find((task) => task.id === taskId)?.backgroundTaskId,
  whenMainTranscriptBaseline,
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

/** Is the local submission's fate PROVEN by the transcript? A session-level
 *  turn end may only settle it then. While the submit POST is unanswered,
 *  while the response-stamped prompt entity is still queued/running (or not
 *  yet observed), or while an uncertain bubble's terminal echo is missing,
 *  the turn that's ending belongs to ANOTHER client (our prompt queued
 *  behind it) — letting it settle here would clear the local in-flight,
 *  retire the bubble and drain the queue early, and the late POST response
 *  would then never record the prompt id (P1: remote turn-end reaping a
 *  local submit). The blocked/aborted instant deaths settle through the
 *  prompt-transition path instead, which is identity-attributed. */
/** Is a bubble's own work PROVEN ended by the transcript? A skill bubble by
 *  its anchored echo turn IN A TERMINAL STATE (a running one proves only the
 *  start — settling then would drain the queue mid-activation), or by its
 *  floored blocked marker; a text bubble by a non-running transcript turn
 *  after its anchor carrying the same prompt (the overlay's cover rule), or
 *  by its floored terminal prompt echo. */
function bubbleFateProven(
  m: { content: readonly { type: string; text?: string }[]; metadata?: Record<string, unknown> },
  snapshot: AgentTranscriptSnapshot,
): boolean {
  const mOrigin = m.metadata?.['origin'] as
    | { kind?: unknown; skillName?: unknown; skillArgs?: unknown }
    | undefined;
  if (mOrigin?.kind === 'skill_activation') {
    const anchorId = m.metadata?.['kimiWeb.anchorTurnId'] as string | undefined;
    return (
      skillEchoTurnExists(snapshot.items, anchorId, mOrigin.skillName, mOrigin.skillArgs, {
        terminalOnly: true,
      }) ||
      skillMarkerExists(
        snapshot.items,
        anchorId,
        mOrigin.skillName,
        mOrigin.skillArgs,
        m.metadata?.['kimiWeb.anchorPromptCreatedAt'] as string | undefined,
      )
    );
  }
  const text = m.content
    .filter((part) => part.type === 'text')
    .map((part) => ('text' in part ? part.text : ''))
    .join('');
  const anchorId = m.metadata?.['kimiWeb.anchorTurnId'] as string | undefined;
  const anchorIdx =
    anchorId === undefined
      ? -1
      : snapshot.items.findIndex((item) => item.kind === 'turn' && item.turnId === anchorId);
  // A rewound anchor (undo/reset) proves nothing about this bubble.
  if (anchorId !== undefined && anchorIdx === -1) return false;
  const turnProves = snapshot.items.slice(anchorIdx + 1).some(
    (item) =>
      item.kind === 'turn' &&
      item.state !== 'running' &&
      ((item.prompt ?? '') === text || (text === '' && (item.attachmentIds?.length ?? 0) > 0)),
  );
  if (turnProves) return true;
  const floor = promptEchoFloor(snapshot.items, m.metadata);
  return snapshot.prompts.some(
    (p) =>
      p.status !== 'queued' &&
      p.status !== 'running' &&
      (floor === undefined ||
        (floor.exclusive ? p.createdAt > floor.at : p.createdAt >= floor.at)) &&
      transcriptPromptText(p.content) === text,
  );
}

/** The local submission's fate as judged by the transcript. `settle`: the
 *  CURRENT in-flight submission (or, without one, the bare state) may be
 *  settled — its bubble and in-flight cleared. `drain`: the queue may also
 *  advance, which additionally requires every UNCERTAIN bubble's fate to be
 *  proven (a lost prompt must not be overtaken by the next queued send).
 *  Historical uncertain bubbles never gate the CURRENT submission's settle —
 *  their retirement is the survivors sweep's one-to-one business — but they
 *  do gate the drain. An UNANSWERED submit is always unproven: text or
 *  bare-attachment matching can't tell its turn apart from another client's
 *  same-content one — the response landing later is where identity-based
 *  settling happens (see settleIfFateProven). */
function localSubmitFate(
  sid: string,
  snapshot: AgentTranscriptSnapshot,
): { settle: boolean; drain: boolean } {
  const bubbles = rawState.optimisticMessagesBySession[sid] ?? [];
  const current = bubbles.findLast((m) => m.metadata?.['kimiWeb.uncertain'] !== true);
  let settle: boolean;
  const stampedId = rawState.promptIdBySession[sid];
  if (localTurnStartState(sid).pending) {
    settle = false;
  } else if (stampedId !== undefined) {
    const ours = snapshot.prompts.find((p) => p.promptId === stampedId);
    // The prompt's identity is KNOWN — its entity is the only arbiter. A
    // missing entity means the transcript hasn't caught up (queued/running
    // server-side), so stay UNPROVEN: falling back to text (or bare
    // attachment) matching would let another client's same-content turn
    // settle a submission that is not ours.
    settle = ours !== undefined && ours.status !== 'queued' && ours.status !== 'running';
  } else if (rawState.inFlightBySession[sid] === true) {
    settle = current === undefined || bubbleFateProven(current, snapshot);
  } else {
    // Nothing live to protect (the bare reconcile case).
    settle = true;
  }
  // The drain asks the ONE-TO-ONE question: has every uncertain bubble's OWN
  // echo entity arrived? Independent bubbleFateProven checks would let a
  // single prompt/skill entity "prove" two identical sends and flush the
  // queue while the second request was never observed — so this uses the
  // same persisted pairing sets as the survivors sweep.
  const uncertainTextBubbles = bubbles.filter(
    (m) =>
      m.metadata?.['kimiWeb.uncertain'] === true &&
      (m.metadata?.['origin'] as { kind?: unknown } | undefined)?.kind !== 'skill_activation',
  );
  const uncertainSkillBubbles = bubbles.filter(
    (m) =>
      m.metadata?.['kimiWeb.uncertain'] === true &&
      (m.metadata?.['origin'] as { kind?: unknown } | undefined)?.kind === 'skill_activation',
  );
  const allUncertainPaired =
    uncertainEchoMatchedIds(
      uncertainTextBubbles.map((m) => ({
        id: m.id,
        text: m.content
          .filter((part) => part.type === 'text')
          .map((part) => ('text' in part ? part.text : ''))
          .join(''),
        floor: promptEchoFloor(snapshot.items, m.metadata),
      })),
      snapshot.prompts,
      consumedEchoPromptIdsBySid.get(sid),
    ).size === uncertainTextBubbles.length &&
    skillEchoMatchedIds(
      uncertainSkillBubbles.map((m) => {
        const origin = m.metadata?.['origin'] as
          | { skillName?: unknown; skillArgs?: unknown }
          | undefined;
        return {
          id: m.id,
          anchorTurnId: m.metadata?.['kimiWeb.anchorTurnId'] as string | undefined,
          promptFloor: m.metadata?.['kimiWeb.anchorPromptCreatedAt'] as string | undefined,
          skillName: origin?.skillName,
          skillArgs: origin?.skillArgs,
        };
      }),
      snapshot.items,
      consumedSkillEchoIdsBySid.get(sid),
    ).size === uncertainSkillBubbles.length;
  const drain = settle && allUncertainPaired;
  return { settle, drain };
}

/** Called when a submission's POST response lands: the transcript may already
 *  carry the work's terminal evidence (a fast turn, a pre-submit block) whose
 *  frame was consumed while the prompt id was still unknown — no later edge
 *  re-fires for it. With the response's identity now known, settle right here
 *  if the gate proves it. */
function settleIfFateProven(sid: string): void {
  const entry = mainTranscriptHost.pool.getEntry(sid);
  if (entry === undefined || !entry.baselineLoaded) return;
  const fate = localSubmitFate(sid, entry.channel.snapshot);
  if (fate.settle) {
    workspaceState.finishPromptLocal(sid, { skipDrain: !fate.drain });
  }
}

function onMainTurnEnd(
  sid: string,
  status: 'idle' | 'aborted',
  turnWasActive: boolean,
  opts?: { drain?: boolean; settleLocal?: boolean },
): void {
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
  // turn-boundary-only — the first-baseline path (the transcript edge
  // watcher's quiet finish) must not cry wolf when opening a historical
  // session. settleLocal=false: the ending turn is not attributable to our
  // pending submission — its fate is unproven (see localSubmitFate), so
  // only the session-level side effects below run.
  if (opts?.settleLocal !== false) {
    workspaceState.finishPromptLocal(sid, {
      turnWasActive,
      // A turn's end retires EVERY confirmed bubble it absorbed (uncertain
      // ones stay — only their own prompt entity may retire them). The queue's
      // drain decision must NOT downgrade the retirement: leftover covered
      // bubbles keep hasPendingLocalWork true and pin the session's
      // transcript entry (and its WS subscription) in the LRU.
      retireOptimistic: 'all',
      skipDrain: opts?.drain === false,
    });
  }

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
  // goal.updated is in the transcript suppression set and meta.goal carries
  // no detail fields, so the goal card re-reads the REST fact at each turn
  // boundary instead of streaming live updates.
  void refreshSessionGoal(sid);
  // Warnings are otherwise pulled only at session select, and the live
  // `warning` event is grade-suppressed — re-pull at this turn-end sync point
  // so a warning persisted WHILE the user stays in the session still surfaces.
  workspaceState.refreshSessionWarnings(sid);
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
    pinnedSessionIds,
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
    loadOlderMessages: async (sessionId: string): Promise<void> => {
      // The visible window comes from the transcript channel, so it pages
      // older items itself; the error/loading facts surface via the channel's
      // loadOlderError / loadingOlder getters.
      const channel = mainTranscriptHost.pool.getEntry(sessionId)?.channel;
      if (channel?.snapshot.hasMoreOlder === true) {
        await channel.loadOlder().catch(() => undefined);
      }
    },

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
    steerQueued: workspaceState.steerQueued,
    // Side chat (BTW side-channel agent)
    sideChatVisible: sideChat.sideChatVisible,
    sideChatSessionId: sideChat.sideChatSessionId,
    sideChatTurns: sideChat.sideChatTurns,
    sideChatRunning: sideChat.sideChatRunning,
    sideChatSending: sideChat.sideChatSending,
    openSideChat: sideChat.openSideChat,
    closeSideChat: sideChat.closeSideChat,
    sendSideChatPrompt: sideChat.sendSideChatPrompt,
    setSideChatPendingDraft: sideChat.setSideChatPendingDraft,
    takeSideChatPendingDraft: sideChat.takeSideChatPendingDraft,
    saveSideChatDraft: sideChat.saveSideChatDraft,
    sideChatDraft: sideChat.sideChatDraft,
    clearSideChatDraftIfUnchanged: sideChat.clearSideChatDraftIfUnchanged,
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
    getOAuthRegion: modelProvider.getOAuthRegion,
    getUsage: modelProvider.getUsage,
    logout: workspaceState.logout,
  };
}

// Re-export types used by wired components so they can import from one place
export type { ApprovalDecision, AppModel, AppProvider };
