// apps/kimi-web/src/composables/client/useWorkspaceState.ts
// Workspace/session actions: session lifecycle, workspace CRUD, prompt
// submission + queueing, approvals/questions/tasks, mode toggles, goals,
// file/diff/git actions, auth/config, and URL<->session routing.
//
// The event reducer wiring (applyEvent, connectEventsIfNeeded, eventConn) and
// the view-model computeds stay in the facade; cross-dependencies are injected
// here as params.

import { reactive, type ComputedRef, type Ref } from 'vue';
import { getKimiWebApi } from '../../api';
import { i18n } from '../../i18n';
import { useConfirmDialog } from '../useConfirmDialog';
import { isDaemonApiError } from '../../api/errors';
import { SERVER_AUTH_UNAUTHORIZED_CODE } from '../../api/daemon/http';
import { isPlaceholderSessionUsage } from '../../api/daemon/mappers';
import type {
  AppConfig,
  AppInFlightTurn,
  AppMessage,
  AppSession,
  AppWorkspace,
  ApprovalDecision,
  ApprovalResponse,
  FsEntry,
  KimiEventConnection,
  QuestionResponse,
} from '../../api/types';
import {
  loadWorkspaceNameOverrides,
  safeRemove,
  saveWorkspaceNameOverrides,
  STORAGE_KEYS,
} from '../../lib/storage';
import { parseDiff } from '../../lib/parseDiff';
import { workspaceRootKey } from '../../lib/rootKey';
import { sessionExportTraceToJsonl, traceKeyEvent } from '../../debug/trace';
import { readSessionIdFromLocation, sessionUrl } from '../../lib/sessionRoute';
import type { SessionUrlMode } from '../../lib/sessionRoute';
import type {
  ActivityState,
  ConversationStatus,
  DiffViewLine,
  PermissionMode,
  WorkspaceView,
} from '../../types';
import type { ExtendedState, PromptAttachment } from '../useKimiWebClient';
import type { UseModelProviderState } from './useModelProviderState';
import type { UseSideChat } from './useSideChat';
import type { UseTaskPoller } from './useTaskPoller';

const MESSAGES_PAGE_SIZE = 50;
// Sessions fetched per workspace on first load — keeps the initial request
// count at (number of workspaces) and each response small. Exported so the
// sidebar can fall back to it when a workspace's first-page size is unknown.
export const SESSIONS_INITIAL_PAGE_SIZE = 5;
const PROMPT_NOT_FOUND_CODE = 40402;
const WORKSPACE_NOT_FOUND_CODE = 40410;
// Shared "already resolved" conflict (40902). The daemon reuses it for both
// approvals and questions when a second client races the resolve, so a
// duplicate submit is reported as a conflict even though the desired end
// state (resolved) is already reached. We treat it as a benign no-op.
const ALREADY_RESOLVED_CODE = 40902;
// First load polls /auth until it gives a definitive answer (see load()).
const FIRST_LOAD_AUTH_RETRY_MS = 2000;

type AuthCheckResult = 'proceed' | 'retry' | 'server-auth-required';

function isAlreadyResolvedError(err: unknown): boolean {
  return isDaemonApiError(err) && err.code === ALREADY_RESOLVED_CODE;
}

// 40904 — cancel raced the task reaching a terminal state. Like 40902 this is
// an idempotent "already in the desired end state" conflict, not a real error.
const TASK_ALREADY_FINISHED_CODE = 40904;

function isTaskAlreadyFinishedError(err: unknown): boolean {
  return isDaemonApiError(err) && err.code === TASK_ALREADY_FINISHED_CODE;
}

/**
 * Question ids with an in-flight respond/dismiss, keyed by questionId with the
 * action kind. Drives the card's loading state and guards against a duplicate
 * submit while the first request is still in flight (the server would reject
 * the second resolve with 40902). Module-level singleton — matches
 * `inFlightBySession` on rawState.
 */
const pendingQuestionActions = reactive<Record<string, 'answer' | 'dismiss'>>({});
/** Approval ids with an in-flight respond, keyed by approvalId. */
const pendingApprovalActions = reactive<Record<string, true>>({});
/** Task ids with an in-flight cancel, keyed by taskId. */
const pendingTaskCancellations = reactive<Record<string, true>>({});
/**
 * Workspace ids whose empty-session first prompt is currently being created +
 * submitted. The empty-composer path (`startSessionAndSendPrompt`) awaits
 * `createDraftSession` (addWorkspace + createSession + selectSession) before
 * the session id exists, so the per-session prompt-in-flight guard cannot
 * cover that window — a second Enter / send-button click during it
 * would otherwise fire a second concurrent POST and trip the daemon's
 * `turn.agent_busy` race. Module-level singleton — matches the other
 * `pending*Actions` guards above.
 */
const startingFirstPromptWorkspaces = reactive(new Set<string>());

/**
 * Per-session local-turn-start lifecycle, shared by EVERY entry point that
 * starts a turn locally (prompt submit/steer in this module, skill activation
 * in useModelProviderState). Two pieces of state:
 *  - generation: bumped synchronously at every local turn start, so a
 *    snapshot requested BEFORE the start can tell it predates the turn;
 *  - pending: set while the start request (POST /prompts or skill
 *    activation) has not been acknowledged by the daemon — a snapshot
 *    requested in that window cannot reflect the turn server-side either.
 * Module-level singleton — matches `inFlightBySession` on rawState.
 */
const promptGenerationBySession = new Map<string, number>();
const pendingLocalTurnStarts = new Map<string, Set<number>>();
const afterLocalTurnsSettled = new Map<string, () => void>();
let nextLocalTurnToken = 0;

/**
 * Consecutive flushQueueHead failures per queue ENTRY (not per session) —
 * keyed by entry id, falling back to its text for entries without one.
 * Keying by entry keeps a removed or reordered head from handing its
 * failure budget down to the next entry. Module-level singleton — the queue
 * itself is per-session on rawState, so a page reload resets both.
 */
const queueFlushFailures = new Map<string, { key: string; count: number }>();
const MAX_QUEUE_FLUSH_FAILURES = 3;

let queueEntryCounter = 0;
function nextQueueEntryId(): string {
  queueEntryCounter += 1;
  return `${Date.now().toString(36)}-${queueEntryCounter}`;
}

export interface LocalTurnStartState {
  generation: number;
  pending: boolean;
}

/** Snapshot of the local-turn-start state, captured BEFORE an async snapshot
 *  fetch so the caller can reject a snapshot that predates a local turn. */
export function localTurnStartState(sid: string): LocalTurnStartState {
  return {
    generation: promptGenerationBySession.get(sid) ?? 0,
    pending: (pendingLocalTurnStarts.get(sid)?.size ?? 0) > 0,
  };
}

/** Shared "a local turn just started" lifecycle: bumps the generation and
 *  marks the start request pending. Call synchronously before the first
 *  await of every local turn entry point. */
export function beginLocalTurn(sid: string): number {
  const token = ++nextLocalTurnToken;
  promptGenerationBySession.set(sid, token);
  const pending = pendingLocalTurnStarts.get(sid) ?? new Set<number>();
  pending.add(token);
  pendingLocalTurnStarts.set(sid, pending);
  return token;
}

/** The daemon acknowledged (or rejected) the turn-start request. */
export function settleLocalTurn(sid: string, token: number): void {
  const pending = pendingLocalTurnStarts.get(sid);
  if (pending === undefined) return;
  pending.delete(token);
  if (pending.size > 0) return;
  pendingLocalTurnStarts.delete(sid);
  const callback = afterLocalTurnsSettled.get(sid);
  afterLocalTurnsSettled.delete(sid);
  callback?.();
}

/** Drop lifecycle state with the rest of a forgotten session. */
export function forgetLocalTurnState(sid: string): void {
  promptGenerationBySession.delete(sid);
  pendingLocalTurnStarts.delete(sid);
  afterLocalTurnsSettled.delete(sid);
  queueFlushFailures.delete(sid);
}

/** Whether a snapshot request can still be applied without overwriting a
 *  local turn that started before or during the request. */
export function isLocalTurnSnapshotCurrent(sid: string, atRequest: LocalTurnStartState): boolean {
  return !atRequest.pending && atRequest.generation === (promptGenerationBySession.get(sid) ?? 0);
}

/** Coalesce a skipped snapshot into one retry after local turn-start requests settle. */
export function afterLocalTurnStartsSettle(sid: string, callback: () => void): void {
  if ((pendingLocalTurnStarts.get(sid)?.size ?? 0) === 0) {
    callback();
    return;
  }
  afterLocalTurnsSettled.set(sid, callback);
}

type SyncSessionResult = 'ok' | 'not-found' | 'failed';

export interface PersistSessionProfilePatch {
  model?: string;
  permissionMode?: string;
  planMode?: boolean;
  swarmMode?: boolean;
  goalObjective?: string;
  goalControl?: 'pause' | 'resume' | 'cancel';
  thinking?: string;
}

export interface UseWorkspaceStateDeps {
  taskPoller: UseTaskPoller;
  sideChat: UseSideChat;
  modelProvider: UseModelProviderState;
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
  activity: ComputedRef<ActivityState>;
  sessionsKnownEmpty: Set<string>;
  // rawState.sessions mutation funnel, owned by the facade. This module never
  // assigns rawState.sessions directly — it goes through these.
  setSessions: (next: AppSession[]) => void;
  updateSession: (id: string, update: (session: AppSession) => AppSession) => void;
  upsertSessionFront: (session: AppSession) => void;
  appendSession: (session: AppSession) => void;
  forgetSession: (id: string) => void;
  setActiveSessionId: (id: string | undefined) => void;
  /** Update one session's message list via a function of the current list. */
  updateSessionMessages: (
    sessionId: string,
    update: (messages: AppMessage[]) => AppMessage[],
  ) => void;
  nextOptimisticMsgId: () => string;
  getEventConn: () => KimiEventConnection | null;
  syncSessionFromSnapshot: (sessionId: string) => Promise<SyncSessionResult>;
  reopenSession: (sessionId: string) => Promise<SyncSessionResult>;
  hasLoadedMessages: (sessionId: string) => boolean;
  refreshSessionStatus: (sessionId: string) => Promise<void>;
  refreshSessionGoal: (sessionId: string) => Promise<void>;
  /** Persist profile fields to the daemon. Resolves false (after surfacing the
   *  failure itself) when the daemon rejected the patch — awaited callers that
   *  order strictly after the profile must NOT proceed on false. */
  persistSessionProfile: (patch: PersistSessionProfilePatch, sessionId?: string) => Promise<boolean>;
  mergedWorkspaces: ComputedRef<AppWorkspace[]>;
  /** Sidebar-facing workspaces in the user's (dragged) display order. */
  workspacesView: ComputedRef<WorkspaceView[]>;
  status: ComputedRef<ConversationStatus>;
  workspaceIdForSession: (s: { workspaceId?: string; cwd: string }) => string;
  savePermissionToStorage: (mode: PermissionMode) => void;
  /** Persist the current per-session mode maps (read off rawState). */
  savePlanModeToStorage: () => void;
  saveSwarmModeToStorage: () => void;
  saveGoalModeToStorage: () => void;
  /** Staged mode toggles for the not-yet-created draft session. */
  draftModes: { planMode: boolean; swarmMode: boolean; goalMode: boolean };
  saveUnread: (changes: Record<string, boolean>) => void;
  saveActiveWorkspaceToStorage: (id: string) => void;
  saveHiddenWorkspacesToStorage: (roots: string[]) => void;
  goalErrorMessage: (err: unknown) => string | undefined;
  resetFastMoon: () => void;
  initialized: Ref<boolean>;
  /** Diagnostic for the connecting splash, set by checkAuth on transient
   *  failures and cleared once a check gets through. */
  connectIssue: Ref<string | null>;
  selectedDiffPath: Ref<string | null>;
  fileDiffLines: Ref<DiffViewLine[]>;
  fileDiffLoading: Ref<boolean>;
}

export function useWorkspaceState(rawState: ExtendedState, deps: UseWorkspaceStateDeps) {
  const { t } = i18n.global;
  const { confirm } = useConfirmDialog();
  const {
    taskPoller,
    sideChat,
    modelProvider,
    pushOperationFailure,
    activity,
    sessionsKnownEmpty,
    setSessions,
    updateSession,
    upsertSessionFront,
    appendSession,
    forgetSession,
    setActiveSessionId,
    updateSessionMessages,
    nextOptimisticMsgId,
    getEventConn,
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
    resetFastMoon,
    initialized,
    connectIssue,
    selectedDiffPath,
    fileDiffLines,
    fileDiffLoading,
  } = deps;
  let exportInFlight = false;

  async function loadOlderMessages(sessionId: string): Promise<void> {
    if (rawState.messagesLoadingMoreBySession[sessionId]) return;
    const current = rawState.messagesBySession[sessionId];
    if (!current || current.length === 0) return;

    const beforeId = current[0]!.id;
    rawState.messagesLoadingMoreBySession = {
      ...rawState.messagesLoadingMoreBySession,
      [sessionId]: true,
    };
    rawState.messagesLoadMoreErrorBySession = {
      ...rawState.messagesLoadMoreErrorBySession,
      [sessionId]: false,
    };
    try {
      const page = await getKimiWebApi().listMessages(sessionId, {
        beforeId,
        pageSize: MESSAGES_PAGE_SIZE,
      });
      // Server returns newest-first; the UI keeps messages in chronological order.
      const older = [...page.items].reverse();
      // Live events may have appended messages while the request was in flight;
      // the updater receives the latest array so those messages are not overwritten.
      updateSessionMessages(sessionId, (latest) => [...older, ...latest]);
      rawState.messagesHasMoreBySession = {
        ...rawState.messagesHasMoreBySession,
        [sessionId]: page.hasMore,
      };
    } catch (err) {
      rawState.messagesLoadMoreErrorBySession = {
        ...rawState.messagesLoadMoreErrorBySession,
        [sessionId]: true,
      };
      pushOperationFailure('loadOlderMessages', err, { sessionId });
    } finally {
      rawState.messagesLoadingMoreBySession = {
        ...rawState.messagesLoadingMoreBySession,
        [sessionId]: false,
      };
    }
  }

  function refreshSessionSidecars(sessionId: string): void {
    void taskPoller.loadTasksForSession(sessionId);
    void loadGitStatus(sessionId);
    void refreshSessionStatus(sessionId);
    void refreshSessionGoal(sessionId);
    if (!Object.prototype.hasOwnProperty.call(modelProvider.skillsBySession.value, sessionId)) {
      void modelProvider.loadSkillsForSession(sessionId);
    }
  }

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
      // A single file's diff failing (a new/untracked/binary/deleted file the
      // daemon can't diff) is LOCAL to this pane, not a session-level fault — the
      // DiffView already shows a graceful "no diff" state when the lines are
      // empty. Surfacing it as a global "kimi server api" error toast on a routine
      // file click is disproportionate, so log it for the trace export instead.
      if (selectedDiffPath.value === path) fileDiffLines.value = [];
      console.warn('[loadFileDiff] diff unavailable for', path, err);
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

  /** Fetch auth readiness from GET /api/v1/auth. Defensive — never throws.
   *  The web bundle always ships paired with its daemon, so this endpoint is
   *  guaranteed to exist — every failure is either a credential rejection or
   *  a transient error worth retrying:
   *  - 'proceed'              — response received; rawState reflects it (ready
   *                             or not)
   *  - 'server-auth-required' — the daemon rejected our server credential
   *                             (401/40101); the ServerAuthDialog owns recovery
   *                             (it reloads once the token is entered)
   *  - 'retry'                — transient failure (network, timeout, 5xx); the
   *                             caller should retry instead of treating it as
   *                             "not signed in" */
  async function checkAuth(): Promise<AuthCheckResult> {
    try {
      const api = getKimiWebApi();
      const result = await api.getAuth();
      rawState.authReady = result.ready;
      rawState.defaultModel = result.defaultModel;
      rawState.managedProviderStatus = result.managedProvider?.status ?? null;
      connectIssue.value = null;
      return 'proceed';
    } catch (err) {
      if (
        isDaemonApiError(err) &&
        (err.code === 401 || err.code === SERVER_AUTH_UNAUTHORIZED_CODE)
      ) {
        // The ServerAuthDialog explains this one — nothing to surface.
        connectIssue.value = null;
        return 'server-auth-required';
      }
      // Surface the reason on the splash so "cannot connect" is diagnosable
      // instead of an unexplained spinner.
      connectIssue.value = (err instanceof Error ? err.message : String(err)).slice(0, 140);
      return 'retry';
    }
  }

  /** Poll /auth until the daemon gives a definitive outcome, waiting
   *  FIRST_LOAD_AUTH_RETRY_MS between transient failures. Never resolves with
   *  'retry'. Used only by the first load. */
  async function waitForFirstAuth(): Promise<AuthCheckResult> {
    let firstRetry = true;
    for (;;) {
      const result = await checkAuth();
      if (result !== 'retry') return result;
      // Keep the first quick failure silent — a single blip right after page
      // load shouldn't flash an error. Surface it from the 2nd failed attempt
      // (~2s in) onward, so a genuinely stuck connection stays diagnosable.
      if (firstRetry) {
        connectIssue.value = null;
        firstRetry = false;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, FIRST_LOAD_AUTH_RETRY_MS);
      });
    }
  }

  /** Fetch global config from GET /api/v1/config. Defensive — never throws. */
  async function loadConfig(): Promise<void> {
    try {
      const api = getKimiWebApi();
      rawState.config = await api.getConfig();
    } catch {
      // Daemon may not have this endpoint yet; leave null
    }
  }

  /** Update global config via POST /api/v1/config. */
  async function updateConfig(patch: Partial<AppConfig>): Promise<boolean> {
    try {
      const api = getKimiWebApi();
      const next = await api.setConfig(patch);
      rawState.config = next;
      rawState.defaultModel = next.defaultModel ?? null;
      return true;
    } catch (err) {
      pushOperationFailure('setConfig', err);
      return false;
    }
  }

  // Backend max page size for GET /sessions. Bigger pages mean fewer round-trips
  // when draining the full session list.
  const SESSION_PAGE_SIZE = 100;
  // Sessions fetched per "load more" click within a workspace.
  const SESSIONS_LOAD_MORE_SIZE = 30;
  // On initial load, if the oldest session of the first page is still within
  // this window, keep fetching older pages until the oldest loaded session falls
  // outside it. Avoids clipping an active workspace's history at an arbitrary
  // 5-session boundary when it has a run of recently-updated sessions.
  const SESSIONS_RECENT_WINDOW_MS = 12 * 60 * 60 * 1000;

  /** Drain every page of sessions, newest first. A single global walk (instead of
   *  per-workspace) so sessions whose cwd is not a registered workspace root are
   *  still reachable after a refresh. A later-page failure returns the pages
   *  already fetched plus the error; only a first-page failure rejects. */
  async function listAllSessionsGlobal(): Promise<{
    sessions: AppSession[];
    error?: unknown;
  }> {
    const api = getKimiWebApi();
    const items: AppSession[] = [];
    let beforeId: string | undefined;
    let continuationError: unknown;
    for (;;) {
      let page: { items: AppSession[]; hasMore: boolean };
      try {
        page = await api.listSessions({
          pageSize: SESSION_PAGE_SIZE,
          beforeId,
          excludeEmpty: true,
        });
      } catch (error) {
        if (items.length === 0) throw error;
        continuationError = error;
        break;
      }
      items.push(...page.items);
      if (!page.hasMore || page.items.length === 0) break;
      beforeId = page.items[page.items.length - 1]!.id;
    }
    return { sessions: items, error: continuationError };
  }

  /**
   * Replace the sessions list wholesale, preserving the live usage accumulated
   * from /status and the WS status stream: the list endpoint returns all-zero
   * placeholder usage for every session, and a blind replace would zero the
   * context ring until the next refresh.
   */
  function setSessionsPreservingLiveUsage(sessions: AppSession[]): void {
    const liveUsageById = new Map(rawState.sessions.map((s) => [s.id, s.usage] as const));
    setSessions(
      sessions.map((s) => {
        const live = liveUsageById.get(s.id);
        return live !== undefined &&
          isPlaceholderSessionUsage(s.usage) &&
          !isPlaceholderSessionUsage(live)
          ? { ...s, usage: live }
          : s;
      }),
    );
  }

  /** Keep fresh rows authoritative while retaining cached rows a partial list
   *  request never reached. */
  function mergePartialSessionsWithCached(sessions: AppSession[]): AppSession[] {
    const merged = [...sessions];
    const loadedIds = new Set(merged.map((session) => session.id));
    for (const session of rawState.sessions) {
      if (loadedIds.has(session.id)) continue;
      merged.push(session);
      loadedIds.add(session.id);
    }
    merged.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return merged;
  }

  /** Load the initial page of sessions for one workspace, then keep fetching
   *  older pages while the oldest loaded session is still within
   *  SESSIONS_RECENT_WINDOW_MS. Every page (including continuations) uses the
   *  small initial page size so a sparse page cannot pull in days of history at
   *  once. Continuation pages are also trimmed at the recent-window boundary,
   *  keeping only up to the first session that falls outside the window. */
  async function loadInitialSessionsForWorkspace(
    workspaceId: string,
  ): Promise<{
    workspaceId: string;
    page: { items: AppSession[]; hasMore: boolean };
    error?: unknown;
  }> {
    const api = getKimiWebApi();
    const items: AppSession[] = [];
    const now = Date.now();
    const ageOf = (s: AppSession): number => now - new Date(s.updatedAt).getTime();
    let beforeId: string | undefined;
    let hasMore = false;
    let isFirstPage = true;
    let continuationError: unknown;
    for (;;) {
      let page: { items: AppSession[]; hasMore: boolean };
      try {
        page = await api.listSessions({
          workspaceId,
          pageSize: SESSIONS_INITIAL_PAGE_SIZE,
          beforeId,
          excludeEmpty: true,
        });
      } catch (error) {
        // A failed continuation page must not discard sessions already loaded
        // from earlier pages; only a page-1 failure rejects the workspace load.
        if (isFirstPage) throw error;
        continuationError = error;
        hasMore = true;
        break;
      }
      hasMore = page.hasMore;
      if (page.items.length === 0) break;
      const oldest = page.items[page.items.length - 1]!;
      const oldestBeyondWindow = ageOf(oldest) >= SESSIONS_RECENT_WINDOW_MS;

      if (!isFirstPage && oldestBeyondWindow) {
        // This continuation page crosses the recent-window boundary. Keep only
        // up to and including the first session that falls outside the window
        // (so the oldest loaded is the first one older than the window) and
        // drop the older tail instead of loading the whole page.
        const boundaryIndex = page.items.findIndex(
          (s) => ageOf(s) >= SESSIONS_RECENT_WINDOW_MS,
        );
        const keep = boundaryIndex >= 0 ? boundaryIndex + 1 : page.items.length;
        items.push(...page.items.slice(0, keep));
        hasMore = page.hasMore || keep < page.items.length;
        break;
      }

      items.push(...page.items);
      isFirstPage = false;
      if (!page.hasMore || oldestBeyondWindow) break;
      beforeId = oldest.id;
    }
    return { workspaceId, page: { items, hasMore }, error: continuationError };
  }

  /** Fetch the first page of sessions for every known workspace concurrently.
   *  Returns the merged, recency-sorted list and seeds per-workspace hasMore.
   *  When every workspace request fails, returns undefined so the caller keeps
   *  the previously loaded sessions instead of committing a false empty list. */
  async function loadInitialSessionsByWorkspace(): Promise<AppSession[] | undefined> {
    const workspaces = rawState.workspaces;
    if (workspaces.length === 0) {
      // /workspaces may be unavailable or empty on older / partially-failing
      // daemons while /sessions still works. Fall back to the legacy global
      // walk so history still shows and mergedWorkspaces can derive workspaces
      // from session cwds, instead of rendering a blank sidebar.
      const fallback = await listAllSessionsGlobal();
      const sessions =
        fallback.error === undefined
          ? fallback.sessions
          : mergePartialSessionsWithCached(fallback.sessions);
      rawState.sessionsHasMoreByWorkspace = {};
      rawState.sessionsCursorByWorkspace = {};
      rawState.sessionsInitialCountByWorkspace = {};
      rawState.sessionsFullyLoaded = fallback.error === undefined;
      if (fallback.error !== undefined) pushOperationFailure('load', fallback.error);
      return sessions;
    }
    const results = await Promise.allSettled(
      workspaces.map((w) => loadInitialSessionsForWorkspace(w.id)),
    );
    const loaded: AppSession[] = [];
    const loadedIds = new Set<string>();
    const successfulPages = new Map<string, { items: AppSession[]; hasMore: boolean }>();
    const failedWorkspaceIds = new Set<string>();
    let firstError: unknown;
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!;
      if (result.status === 'fulfilled') {
        successfulPages.set(result.value.workspaceId, result.value.page);
        if (result.value.error !== undefined) {
          if (failedWorkspaceIds.size === 0) firstError = result.value.error;
          failedWorkspaceIds.add(result.value.workspaceId);
        }
        for (const session of result.value.page.items) {
          if (loadedIds.has(session.id)) continue;
          loaded.push(session);
          loadedIds.add(session.id);
        }
        continue;
      }
      if (failedWorkspaceIds.size === 0) firstError = result.reason;
      failedWorkspaceIds.add(workspaces[index]!.id);
    }

    // One failed workspace must not erase another workspace's successful page,
    // nor the failed workspace's last usable rows. If every request failed,
    // leave both sessions and pagination state untouched for a natural retry.
    if (successfulPages.size === 0) {
      pushOperationFailure('load', firstError);
      return undefined;
    }
    const failedWorkspaceRoots = new Set(
      workspaces
        .filter((workspace) => failedWorkspaceIds.has(workspace.id))
        .map((workspace) => workspace.root),
    );
    const registeredWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    for (const session of rawState.sessions) {
      const belongsToFailedWorkspace =
        session.workspaceId !== undefined && registeredWorkspaceIds.has(session.workspaceId)
          ? failedWorkspaceIds.has(session.workspaceId)
          : failedWorkspaceRoots.has(session.cwd) ||
            failedWorkspaceIds.has(workspaceIdForSession(session));
      if (!belongsToFailedWorkspace || loadedIds.has(session.id)) continue;
      loaded.push(session);
      loadedIds.add(session.id);
    }

    const hasMore: Record<string, boolean> = {};
    const cursors: Record<string, string | undefined> = {};
    const counts: Record<string, number> = {};
    for (const { id: workspaceId } of workspaces) {
      const page = successfulPages.get(workspaceId);
      if (page === undefined) {
        const previousHasMore = rawState.sessionsHasMoreByWorkspace[workspaceId];
        const previousCursor = rawState.sessionsCursorByWorkspace[workspaceId];
        const previousCount = rawState.sessionsInitialCountByWorkspace[workspaceId];
        if (previousHasMore !== undefined) hasMore[workspaceId] = previousHasMore;
        if (previousCursor !== undefined) cursors[workspaceId] = previousCursor;
        if (previousCount !== undefined) counts[workspaceId] = previousCount;
        continue;
      }
      // Trust the server's hasMore — the per-workspace session_count is only a
      // (possibly stale) label total, not an authority on whether more pages exist.
      hasMore[workspaceId] = page.hasMore;
      // Cursor = oldest session of this page (pages are newest-first). Tracked
      // separately from the loaded set so a deep-linked older session appended
      // out of band cannot shift the cursor and skip intervening sessions.
      cursors[workspaceId] =
        page.items.length > 0 ? page.items[page.items.length - 1]!.id : undefined;
      // Collapse target for the sidebar's in-group "show less" control: the
      // first-page capacity, floored at a full page so a workspace that was
      // empty or sparse on first paint does not hide sessions created later.
      // If the initial load pulled more than a page (recent-window
      // continuations), keep the larger count so collapse returns to what was
      // first visible.
      counts[workspaceId] = Math.max(page.items.length, SESSIONS_INITIAL_PAGE_SIZE);
    }
    rawState.sessionsHasMoreByWorkspace = hasMore;
    rawState.sessionsCursorByWorkspace = cursors;
    rawState.sessionsInitialCountByWorkspace = counts;
    rawState.sessionsFullyLoaded = false;
    // Keep rawState.sessions newest-first for readers that pick sessions[0]
    // (e.g. auto-selecting the most recent session on first load).
    loaded.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    if (failedWorkspaceIds.size > 0) pushOperationFailure('load', firstError);
    return loaded;
  }

  /** Fetch the next page of sessions for a workspace (the "load more" button). */
  async function loadMoreSessions(workspaceId: string): Promise<void> {
    if (rawState.sessionsLoadingMoreByWorkspace[workspaceId]) return;
    if (rawState.sessionsHasMoreByWorkspace[workspaceId] === false) return;
    const beforeId = rawState.sessionsCursorByWorkspace[workspaceId];
    if (beforeId === undefined) return;
    rawState.sessionsLoadingMoreByWorkspace = {
      ...rawState.sessionsLoadingMoreByWorkspace,
      [workspaceId]: true,
    };
    try {
      const page = await getKimiWebApi().listSessions({
        workspaceId,
        pageSize: SESSIONS_LOAD_MORE_SIZE,
        beforeId,
        excludeEmpty: true,
      });
      // Append de-duped against the latest list so a concurrently added/removed
      // session is respected.
      const existing = new Set(rawState.sessions.map((s) => s.id));
      const fresh = page.items.filter((s) => !existing.has(s.id));
      if (fresh.length > 0) setSessions([...rawState.sessions, ...fresh]);
      // Advance the cursor to the end of the page we just fetched.
      rawState.sessionsCursorByWorkspace = {
        ...rawState.sessionsCursorByWorkspace,
        [workspaceId]:
          page.items.length > 0 ? page.items[page.items.length - 1]!.id : beforeId,
      };
      // Trust the server's hasMore. Deriving it from the workspace session_count
      // is unsafe: archive/delete only removes the local session and leaves the
      // count stale, which would keep hasMore true and re-fetch empty pages.
      rawState.sessionsHasMoreByWorkspace = {
        ...rawState.sessionsHasMoreByWorkspace,
        [workspaceId]: page.hasMore,
      };
    } catch (err) {
      pushOperationFailure('loadMoreSessions', err);
    } finally {
      rawState.sessionsLoadingMoreByWorkspace = {
        ...rawState.sessionsLoadingMoreByWorkspace,
        [workspaceId]: false,
      };
    }
  }

  /** Drain every session via a single global walk so client-side search covers
   *  all sessions, not just the first page per workspace. Triggered lazily on
   *  first search; a no-op once the full list is loaded. */
  async function loadAllSessions(): Promise<void> {
    if (rawState.sessionsFullyLoaded) return;
    const result = await listAllSessionsGlobal().catch((err) => {
      console.warn('[kimi-web] loadAllSessions failed; search covers only loaded sessions', err);
      return null;
    });
    if (result === null) return;
    const sessions =
      result.error === undefined
        ? result.sessions
        : mergePartialSessionsWithCached(result.sessions);
    setSessionsPreservingLiveUsage(sessions);
    rawState.sessionsFullyLoaded = result.error === undefined;
    if (result.error !== undefined) return;
    const cleared: Record<string, boolean> = {};
    for (const w of rawState.workspaces) cleared[w.id] = false;
    rawState.sessionsHasMoreByWorkspace = cleared;
  }

  /**
   * Re-read GET /meta and apply the server-self fields (version, open-in
   * apps, auth bypass, backend engine). Called on first load and on every WS
   * (re)connect — the latter keeps the values truthful across backend
   * restarts and dev-proxy backend switches.
   */
  async function refreshServerMeta(): Promise<void> {
    const m = await getKimiWebApi()
      .getMeta()
      .catch(() => null);
    if (m === null) return;
    rawState.serverVersion = m.serverVersion;
    rawState.availableOpenInApps = m.openInApps;
    rawState.dangerousBypassAuth = m.dangerousBypassAuth;
    rawState.backend = m.backend;
  }

  async function load(): Promise<void> {
    const startedAt = Date.now();
    let traceStatus = 'accepted';
    traceKeyEvent('app:load:start');
    rawState.loading = true;
    // The very first load gates on /auth before anything else: a transient
    // failure there (daemon still booting, network blip, 5xx) must NOT be read
    // as "not signed in" — that bounced users to /login until a manual refresh.
    // Keep the connecting splash up and poll /auth until a definitive outcome.
    // A 401/40101 means the server wants a token: stop and let the
    // ServerAuthDialog take over (it reloads once the token is entered).
    const firstLoad = !initialized.value;
    let authResolved = true;
    try {
      if (firstLoad && (await waitForFirstAuth()) === 'server-auth-required') {
        authResolved = false;
        traceStatus = 'auth-required';
        return;
      }
      const api = getKimiWebApi();
      // Parallel: health + meta + models
      await Promise.all([
        api.getHealth().catch(() => null),
        refreshServerMeta(),
        modelProvider.loadModels(),
      ]);

      // Check auth readiness and global config (separate calls — defensive)
      if (!firstLoad) await checkAuth();
      await loadConfig();

      // Load workspaces first (registered + derived, each with a session_count),
      // then fetch only the first page of sessions per workspace. This replaces
      // the old full global walk: the sidebar now truncates by loading, not by
      // hiding already-fetched rows.
      await loadWorkspaces();
      const loadedSessions = await loadInitialSessionsByWorkspace();
      const sessions = loadedSessions ?? rawState.sessions;
      if (loadedSessions !== undefined) setSessionsPreservingLiveUsage(loadedSessions);

      // First load: pick the workspace of the most-recent session, unless the
      // user already has a persisted active workspace that still exists.
      const mostRecent = sessions[0];
      const persisted = rawState.activeWorkspaceId;
      const persistedStillExists =
        persisted !== null && mergedWorkspaces.value.some((w) => w.id === persisted);
      if (!persistedStillExists && mostRecent) {
        selectWorkspace(workspaceIdForSession(mostRecent));
      }

      // URL deep link (/sessions/<id>) takes priority over auto-select. The
      // session may live outside the loaded pages (e.g. archived) — fetch it then.
      // selectSession syncs the active workspace off the (now present) entry.
      bindSessionRoute();
      const urlSessionId =
        typeof window !== 'undefined' ? readSessionIdFromLocation(window.location) : undefined;
      if (!rawState.activeSessionId && urlSessionId !== undefined) {
        const available =
          rawState.sessions.some((s) => s.id === urlSessionId) ||
          (await fetchSessionIntoList(urlSessionId));
        if (available) {
          await selectSession(urlSessionId, { urlMode: 'replace' });
        }
      }

      // Auto-select first session if none selected (also the fallback for a dead
      // deep link — 'replace' rewrites the URL to the session actually shown).
      if (!rawState.activeSessionId && sessions.length > 0) {
        await selectSession(sessions[0]!.id, { urlMode: 'replace' });
      }
    } catch (err) {
      traceStatus = 'failed';
      pushOperationFailure('load', err);
      // Do not re-throw — app stays mounted with empty sessions
    } finally {
      rawState.loading = false;
      // Without a definitive /auth outcome the splash stays up (retry loop or
      // ServerAuthDialog is handling it) — never expose the half-loaded app.
      if (authResolved) initialized.value = true;
      traceKeyEvent('app:load:complete', {
        status: traceStatus,
        sessionId: rawState.activeSessionId,
        sessionCount: rawState.sessions.length,
        workspaceCount: rawState.workspaces.length,
        durationMs: Date.now() - startedAt,
      });
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
      rawState.workspaces = applyWorkspaceNameOverrides(list);
      rawState.fsHome = home.home || null;
      rawState.recentRoots = home.recentRoots;
    } catch {
      // Defensive — derived workspaces still work off the loaded sessions.
    }
  }

  /** Overlay locally-persisted name overrides (see renameWorkspace fallback)
   *  onto a freshly loaded workspace list, keyed by root. */
  function applyWorkspaceNameOverrides(workspaces: AppWorkspace[]): AppWorkspace[] {
    const overrides = loadWorkspaceNameOverrides();
    if (Object.keys(overrides).length === 0) return workspaces;
    return workspaces.map((w) => {
      const override = overrides[w.root];
      return override !== undefined ? { ...w, name: override } : w;
    });
  }

  /** Set the active workspace and persist it. */
  function selectWorkspace(id: string): void {
    rawState.activeWorkspaceId = id;
    saveActiveWorkspaceToStorage(id);
  }

  /** Open a workspace in the main pane: clear the active session when the
   *  workspace is empty so the centred composer is shown; otherwise activate
   *  the most recent session in that workspace. */
  function openWorkspace(id: string): void {
    selectWorkspace(id);
    const sessionsInWs = rawState.sessions.filter((s) => workspaceIdForSession(s) === id);
    if (sessionsInWs.length > 0) {
      const mostRecent = sessionsInWs[0];
      if (mostRecent && mostRecent.id !== rawState.activeSessionId) {
        // One user action (clicking the workspace) = one history entry.
        void selectSession(mostRecent.id);
      }
    } else {
      setActiveSessionId(undefined);
      writeSessionUrl(undefined, 'push');
    }
  }

  /** Upsert a workspace: preserve existing order when updating; prepend only
   *  for truly new workspaces. */
  function upsertWorkspacePreserveOrder(workspace: AppWorkspace): void {
    // A locally-renamed derived workspace may carry a saved name override; apply
    // it so a daemon upsert (e.g. registering the root on first chat) doesn't
    // clobber the name with the default basename.
    const override = loadWorkspaceNameOverrides()[workspace.root];
    const ws = override !== undefined ? { ...workspace, name: override } : workspace;
    // Re-adding a path the user previously removed should bring it back. The
    // hidden match in mergeWorkspaces is folded, so the removal must fold too
    // — otherwise hiding `C:\Foo` and re-adding `c:\foo` leaves the folded
    // entry hiding the workspace forever.
    const wsKey = workspaceRootKey(ws.root);
    if (rawState.hiddenWorkspaceRoots.some((r) => workspaceRootKey(r) === wsKey)) {
      rawState.hiddenWorkspaceRoots = rawState.hiddenWorkspaceRoots.filter(
        (r) => workspaceRootKey(r) !== wsKey,
      );
      saveHiddenWorkspacesToStorage(rawState.hiddenWorkspaceRoots);
    }
    const index = rawState.workspaces.findIndex(
      (w) => w.id === ws.id || w.root === ws.root,
    );
    if (index === -1) {
      rawState.workspaces = [ws, ...rawState.workspaces];
      return;
    }
    const next = [...rawState.workspaces];
    next[index] = ws;
    rawState.workspaces = next;
  }

  type WorkspaceLifecycleEvent =
    | { type: 'workspaceCreated'; workspace: AppWorkspace }
    | { type: 'workspaceUpdated'; workspace: AppWorkspace }
    | { type: 'workspaceDeleted'; workspaceId: string; root: string };

  /** Apply a workspace lifecycle event broadcast by the daemon (multi-client sync).
   *  Workspaces live outside the reducer in rawState, so these events are handled
   *  here instead of in reduceAppEvent. */
  function applyWorkspaceEvent(event: WorkspaceLifecycleEvent): void {
    if (event.type === 'workspaceCreated' || event.type === 'workspaceUpdated') {
      upsertWorkspacePreserveOrder(event.workspace);
      return;
    }
    // workspaceDeleted — mirror the local deleteWorkspace so a removal initiated
    // by another client stays hidden even though its surviving sessions would
    // otherwise re-derive it in mergedWorkspaces.
    const root =
      rawState.workspaces.find((w) => w.id === event.workspaceId)?.root ?? event.root;
    if (root && !rawState.hiddenWorkspaceRoots.includes(root)) {
      rawState.hiddenWorkspaceRoots = [...rawState.hiddenWorkspaceRoots, root];
      saveHiddenWorkspacesToStorage(rawState.hiddenWorkspaceRoots);
    }
    rawState.workspaces = rawState.workspaces.filter(
      (w) => w.id !== event.workspaceId && w.root !== root,
    );
    const removingActiveWorkspace =
      rawState.activeWorkspaceId === event.workspaceId || rawState.activeWorkspaceId === root;
    if (removingActiveWorkspace) {
      const nextWorkspace = workspacesView.value[0]?.id ?? null;
      rawState.activeWorkspaceId = nextWorkspace;
      if (nextWorkspace) saveActiveWorkspaceToStorage(nextWorkspace);
      else {
        try {
          safeRemove(STORAGE_KEYS.activeWorkspace);
        } catch {
          // ignore
        }
      }
      setActiveSessionId(undefined);
      rawState.sessionLoading = false;
      clearFileDiff();
      writeSessionUrl(undefined, 'replace');
    }
  }

  /** Clear the active session without creating a new one. */
  function clearActiveSession(): void {
    setActiveSessionId(undefined);
    writeSessionUrl(undefined, 'push');
  }

  /** Enter the "new session draft" state for a workspace: select it, clear the
   *  active session, and show the onboarding composer. No backend session is
   *  created until the user sends the first message. */
  function openWorkspaceDraft(workspaceId: string): void {
    selectWorkspace(workspaceId);
    clearActiveSession();
    clearFileDiff();
  }

  /**
   * Create a session in a workspace for an immediate first action — the first
   * prompt (`startSessionAndSendPrompt`) or a skill activation
   * (`startSessionAndActivateSkill`) from the empty-session composer. Returns
   * the new session id, or null if the workspace is unknown. Applies the staged
   * draft model + modes onto the new session. Throws on daemon failure so the
   * caller can surface the error via pushOperationFailure.
   */
  async function createDraftSession(workspaceId: string): Promise<string | null> {
    const ws = mergedWorkspaces.value.find((w) => w.id === workspaceId);
    if (!ws) return null;
    // Capture the draft thinking level BEFORE any await: a concurrent session
    // switch during creation re-resolves rawState.thinking for the other
    // active session, which would otherwise seed the new session with that
    // session's effort. Seeded into the new session's own entry below, the
    // first prompt/skill submits the pick and the daemon profile follows.
    const draftThinking = rawState.thinking;
    const api = getKimiWebApi();
    let workspaceIdForCreate: string | undefined;
    let cwdForCreate = ws.root;
    try {
      const registered = await api.addWorkspace({ root: ws.root });
      workspaceIdForCreate = registered.id;
      cwdForCreate = registered.root;
      upsertWorkspacePreserveOrder(registered);
    } catch {
      // Older daemons may not have /workspaces.
    }
    const draftPick = modelProvider.draftModel.value ?? undefined;
    const session = await api.createSession({
      workspaceId: workspaceIdForCreate,
      cwd: cwdForCreate,
      model: draftPick,
    });
    modelProvider.draftModel.value = null; // applied — the next draft starts from the default
    // The create echo may return model as '' (same daemon quirk as /profile);
    // keep the user's pick so the status line doesn't snap back to the default.
    const created =
      draftPick !== undefined && (!session.model || session.model.length === 0)
        ? { ...session, model: draftPick }
        : session;
    upsertSessionFront(created);
    selectWorkspace(session.workspaceId ?? workspaceIdForCreate ?? workspaceId);
    // NOTE: do NOT mark this session known-empty. Unlike "open a new empty
    // session" (createSession), here we immediately act on it: keeping
    // sessionLoading=true through the snapshot avoids flashing the empty-session
    // composer before the optimistic first turn lands. selectSession resolves,
    // then the caller adds the first turn synchronously (no await in between),
    // so the view goes loading → message with no empty-composer frame.
    await selectSession(session.id);
    // Carry any mode toggles the user staged in the empty composer into the
    // newly-created session, so the first action honors them. Write them to
    // this session's per-session maps by id (not via the activeSessionId-based
    // setters): if the user switches to another session while selectSession is
    // awaiting the snapshot, the setters would otherwise read the then-current
    // activeSessionId and pollute that session while this one loses the modes.
    const sid = session.id;
    if (draftThinking !== undefined) {
      rawState.thinkingBySession = { ...rawState.thinkingBySession, [sid]: draftThinking };
    }
    if (draftModes.planMode) {
      rawState.planModeBySession = { ...rawState.planModeBySession, [sid]: true };
      savePlanModeToStorage();
    }
    if (draftModes.swarmMode) {
      rawState.swarmModeBySession = { ...rawState.swarmModeBySession, [sid]: true };
      saveSwarmModeToStorage();
    }
    if (draftModes.goalMode) {
      rawState.goalModeBySession = { ...rawState.goalModeBySession, [sid]: true };
      saveGoalModeToStorage();
    }
    draftModes.planMode = false;
    draftModes.swarmMode = false;
    draftModes.goalMode = false;
    return sid;
  }

  /**
   * Create a session and immediately submit the first prompt.
   * This is the unified path when there is no active session (e.g. after
   * clicking "+" or in an empty workspace).
   */
  async function startSessionAndSendPrompt(
    workspaceId: string,
    text: string,
    attachments?: PromptAttachment[],
  ): Promise<void> {
    // Guard the whole "create draft session + submit first prompt" flow: the
    // session id doesn't exist until `createDraftSession` resolves, so the
    // per-session in-flight guard can't cover this window. A
    // second Enter / send-button click in that window would otherwise fire a
    // concurrent first POST for the same new session and trip the daemon's
    // `turn.agent_busy` race.
    if (startingFirstPromptWorkspaces.has(workspaceId)) return;
    startingFirstPromptWorkspaces.add(workspaceId);
    try {
      const sid = await createDraftSession(workspaceId);
      if (!sid) return;
      await submitPromptInternal(sid, text, attachments);
    } catch (err) {
      pushOperationFailure('startSessionAndSendPrompt', err);
    } finally {
      startingFirstPromptWorkspaces.delete(workspaceId);
    }
  }

  /**
   * Create a session and immediately activate a skill — the empty-composer
   * counterpart to startSessionAndSendPrompt. Without this, `/<skill>` from the
   * new-session screen silently dropped the activation (`activateSkill` needs a
   * session id). Shares createDraftSession so the model and draft modes are
   * applied identically to a prompt-started session; then persists any draft
   * plan/swarm modes here, because skill activation carries only `args`.
   */
  async function startSessionAndActivateSkill(
    workspaceId: string,
    skillName: string,
    args?: string,
  ): Promise<void> {
    // Same reentry window as startSessionAndSendPrompt (see the guard there):
    // draft-session creation selects the new session before the activation,
    // so concurrent first actions must be dropped here.
    if (startingFirstPromptWorkspaces.has(workspaceId)) return;
    startingFirstPromptWorkspaces.add(workspaceId);
    try {
      const sid = await createDraftSession(workspaceId);
      if (!sid) return;
      // Unlike a plain prompt, skill activation only carries `args`, so the
      // daemon never sees the prompt-time controls the user may have changed on
      // the draft (plan/swarm, plus permission via /auto|/yolo). Persist them
      // onto this new session's profile and await it before activating,
      // otherwise the first skill turn can start before applyAgentState and
      // run at daemon defaults while the UI shows otherwise. Thinking is NOT
      // persisted here — activateSkill resolves and persists it for this
      // session's model (gated) immediately before activating. Goal mode is a
      // one-shot flag consumed per send, not a profile field, so there is
      // nothing to persist for it.
      const planMode = rawState.planModeBySession[sid] ?? false;
      const swarmMode = rawState.swarmModeBySession[sid] ?? false;
      const promptSession = rawState.sessions.find((s) => s.id === sid);
      const model =
        (promptSession?.model && promptSession.model.length > 0
          ? promptSession.model
          : rawState.defaultModel) ?? undefined;
      // No thinking in this patch: activateSkill itself resolves and persists
      // the level for this session's model (single writer, gated) right before
      // activating — a second write here would be a redundant profile update
      // whose transient failure could false-veto a ready activation.
      const persisted = await persistSessionProfile(
        {
          model,
          planMode,
          swarmMode,
          permissionMode: rawState.permission,
        },
        sid,
      );
      // The persist surfaces its own failure; activating at a stale profile
      // effort is worse than not activating (the finally still re-arms below).
      if (!persisted) return;
      await modelProvider.activateSkill(skillName, args, sid);
    } catch (err) {
      pushOperationFailure('startSessionAndActivateSkill', err);
    } finally {
      startingFirstPromptWorkspaces.delete(workspaceId);
    }
  }

  /**
   * Create a session and open a BTW side chat under it — the empty-composer
   * counterpart to startSessionAndSendPrompt. Without this, `/btw <question>`
   * from the new-session screen silently no-ops (the panel still opens, but
   * empty), because openSideChat reads the active session id directly. The side
   * chat prompt itself carries model / thinking / permissionMode / plan / swarm
   * (see sendSideChatPromptOn), so unlike skill activation we don't need to
   * persist them onto the parent profile here.
   */
  async function startSessionAndOpenSideChat(
    workspaceId: string,
    prompt?: string,
  ): Promise<void> {
    // Same reentry window as startSessionAndSendPrompt (see the guard there).
    if (startingFirstPromptWorkspaces.has(workspaceId)) return;
    startingFirstPromptWorkspaces.add(workspaceId);
    try {
      const sid = await createDraftSession(workspaceId);
      if (!sid) return;
      await sideChat.openSideChatOn(sid, prompt);
    } catch (err) {
      pushOperationFailure('startSessionAndOpenSideChat', err);
    } finally {
      startingFirstPromptWorkspaces.delete(workspaceId);
    }
  }

  /**
   * Add a workspace by folder path, registering it with the daemon. Returns true
   * when the workspace was registered and selected; false when the daemon
   * rejected the path, so callers can keep the picker open and any pending
   * submission instead of dropping it. The caller surfaces the failure to the
   * user (e.g. an inline error in the picker).
   */
  async function addWorkspaceByPath(root: string): Promise<boolean> {
    const trimmed = root.trim();
    if (!trimmed) return false;
    const api = getKimiWebApi();
    try {
      const ws = await api.addWorkspace({ root: trimmed });
      upsertWorkspacePreserveOrder(ws);
      openWorkspaceDraft(ws.id);
      return true;
    } catch (err) {
      // The caller shows an inline error in the picker; keep the cause in the log.
      console.warn('[kimi-web] addWorkspaceByPath failed for', trimmed, err);
      return false;
    }
  }

  /**
   * Browse subdirectories under `path` (defaults to the daemon $HOME). Used by the
   * add-workspace folder browser. Defensive: returns an empty path on error so
   * the dialog can fall back to the paste-path field.
   */
  async function browseFs(path?: string): Promise<import('../../api/types').FsBrowseResult> {
    try {
      const api = getKimiWebApi();
      return await api.browseFs(path);
    } catch {
      return { path: '', parent: null, entries: [] };
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

  // ---------------------------------------------------------------------------
  // URL ↔ session binding (no router): '/' ↔ /sessions/<id>
  // urlMode semantics: 'push' = user navigation (new history entry); 'replace' =
  // programmatic/auto selection (first load, fallback after delete); 'none' =
  // popstate-driven (the URL is already correct — writing it again would loop).
  // ---------------------------------------------------------------------------

  function writeSessionUrl(sessionId: string | undefined, mode: SessionUrlMode): void {
    if (mode === 'none') return;
    if (typeof window === 'undefined' || !window.history) return;
    const target = sessionUrl(sessionId);
    if (window.location.pathname === target) return;
    try {
      if (mode === 'push') window.history.pushState(null, '', target);
      else window.history.replaceState(null, '', target);
    } catch {
      // history API unavailable (e.g. sandboxed iframe) — URL sync is best-effort
    }
  }

  /** Fetch a session that is not in the loaded list (deep link beyond the first
      page) and append it. Returns false when the daemon doesn't know it. */
  async function fetchSessionIntoList(sessionId: string): Promise<boolean> {
    try {
      const session = await getKimiWebApi().getSession(sessionId);
      if (!rawState.sessions.some((s) => s.id === session.id)) {
        // Append, not prepend: the list is recency-ordered and a deep-linked old
        // session shouldn't displace the most-recent ones at the top.
        appendSession(session);
      }
      return true;
    } catch {
      return false;
    }
  }

  function onSessionRoutePopState(): void {
    const id = readSessionIdFromLocation(window.location);
    if (id === undefined) {
      // Back/forward landed on '/' — no active session.
      setActiveSessionId(undefined);
      return;
    }
    if (id === rawState.activeSessionId) return;
    if (rawState.sessions.some((s) => s.id === id)) {
      void selectSession(id, { urlMode: 'none' });
      return;
    }
    // A history entry can point at a session that has since been deleted (or one
    // outside the loaded page): try to fetch it; on failure fall back to the most
    // recent session and FIX the URL so the bad entry doesn't stick around.
    void (async () => {
      if (await fetchSessionIntoList(id)) {
        await selectSession(id, { urlMode: 'none' });
        return;
      }
      const next = rawState.sessions[0];
      if (next) {
        await selectSession(next.id, { urlMode: 'replace' });
      } else {
        setActiveSessionId(undefined);
        writeSessionUrl(undefined, 'replace');
      }
    })();
  }

  let sessionRouteBound = false;
  function bindSessionRoute(): void {
    if (sessionRouteBound || typeof window === 'undefined') return;
    sessionRouteBound = true;
    window.addEventListener('popstate', onSessionRoutePopState);
  }

  async function selectSession(
    sessionId: string,
    opts?: { urlMode?: SessionUrlMode },
  ): Promise<void> {
    const messagesLoaded = hasLoadedMessages(sessionId);
    // Only sessions created locally in this client are trusted to be empty.
    // The daemon-reported messageCount can be stale for old sessions, so relying
    // on it causes the empty-composer to flash before the real snapshot arrives.
    // A locally created session has no history to load: show the empty composer
    // immediately by skipping the `sessionLoading` flag (no flash), while the
    // snapshot still loads in the background like any other first open.
    const knownEmpty = !messagesLoaded && sessionsKnownEmpty.has(sessionId);
    // Single-use: after this select resolves the session is no longer "known empty".
    sessionsKnownEmpty.delete(sessionId);
    try {
      // Write the URL synchronously (before any await) so rapid clicks lay down
      // history entries in click order.
      writeSessionUrl(sessionId, opts?.urlMode ?? 'push');
      rawState.sessionLoading = !messagesLoaded && !knownEmpty;
      setActiveSessionId(sessionId);
      resetFastMoon();
      // Opening a session clears its unread dot.
      if (rawState.unreadBySession[sessionId]) {
        rawState.unreadBySession = { ...rawState.unreadBySession, [sessionId]: false };
        saveUnread({ [sessionId]: false });
      }
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

      if (!messagesLoaded) {
        // First open: full snapshot → seed → subscribe(asOfSeq).
        const result = await syncSessionFromSnapshot(sessionId);
        if (result === 'not-found') return;
      } else {
        // Re-open: rebuild from a fresh snapshot rather than resuming from the
        // tracked cursor — the daemon only replays durable events, so volatile
        // streamed deltas lost to a WS hiccup would otherwise stay missing.
        const result = await reopenSession(sessionId);
        if (result === 'not-found') return;
      }

      // Refresh sidecars AFTER the snapshot settles so status/usage updates
      // aren't overwritten by syncSessionFromSnapshot.
      refreshSessionSidecars(sessionId);
    } catch (err) {
      pushOperationFailure('selectSession', err, { sessionId });
    } finally {
      if (rawState.activeSessionId === sessionId) {
        rawState.sessionLoading = false;
      }
    }
  }

  /** Internal: submit a prompt to a specific session, bypassing the queue check.
      Returns 'ok' when the daemon accepted the prompt, 'rejected' on a
      definitive refusal (structured API error — the server holds nothing, so
      re-queueing is safe), and 'uncertain' when the failure was ambiguous
      (dropped response, network error): the merged prompt may already be
      queued server-side, and callers must NOT re-queue or they'd duplicate it. */
  async function submitPromptInternal(
    sid: string,
    text: string,
    attachments?: PromptAttachment[],
  ): Promise<'ok' | 'rejected' | 'uncertain'> {
    // Mark this session as having a prompt in flight BEFORE any await, so a racing
    // sendPrompt sees it and enqueues. Cleared when the main turn ends (or the
    // prompt dies without one). beginLocalTurn also bumps the snapshot generation
    // and marks the submit pending, so a racing terminal snapshot can't clear
    // this prompt (see handleSessionSnapshot).
    const localTurnToken = beginLocalTurn(sid);
    rawState.inFlightBySession = { ...rawState.inFlightBySession, [sid]: true };
    const tempId = nextOptimisticMsgId();
    try {
      const api = getKimiWebApi();
      const content: import('../../api/types').AppMessageContent[] = [];
      if (text) content.push({ type: 'text', text });
      for (const att of attachments ?? []) {
        if (att.kind === 'video') content.push({ type: 'video', source: { kind: 'file', fileId: att.fileId } });
        else if (att.kind === 'file') {
          content.push({
            type: 'file',
            fileId: att.fileId,
            name: att.name ?? '',
            mediaType: att.mediaType || 'application/octet-stream',
            size: att.size ?? 0,
          });
        } else content.push({ type: 'image', source: { kind: 'file', fileId: att.fileId } });
      }
      if (content.length === 0) {
        rawState.inFlightBySession = { ...rawState.inFlightBySession, [sid]: false };
        return 'rejected';
      }

      // OPTIMISTICALLY add the user message to local state BEFORE awaiting the
      // submit.  The real daemon does NOT emit a user-message event over WS, so
      // without this the user's own text never appears in the transcript.
      const optimisticMsg: AppMessage = {
        id: tempId,
        sessionId: sid,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
        metadata: { 'kimiWeb.optimisticUserMessage': true },
      };
      updateSessionMessages(sid, (msgs) => [...msgs, optimisticMsg]);

      // The daemon now requires `model` + `thinking` on every prompt. Resolve the
      // model from the session (falls back to the daemon's default_model) and the
      // thinking level from the user's setting.
      const promptSession = rawState.sessions.find((s) => s.id === sid);
      const model =
        (promptSession?.model && promptSession.model.length > 0
          ? promptSession.model
          : rawState.defaultModel) ?? undefined;

      // Modes are per-session: read this session's own toggles (not the global
      // active-session value), so a prompt enqueued for a background session uses
      // that session's settings.
      const planMode = rawState.planModeBySession[sid] ?? false;
      const swarmMode = rawState.swarmModeBySession[sid] ?? false;
      const goalMode = rawState.goalModeBySession[sid] ?? false;

      if (goalMode && text) {
        try {
          await api.updateSession(sid, { goalObjective: text.trim() });
        } catch (err) {
          pushOperationFailure('createGoal', err, { sessionId: sid });
          rawState.inFlightBySession = { ...rawState.inFlightBySession, [sid]: false };
          updateSessionMessages(sid, (msgs) =>
            msgs.some((m) => m.id === tempId) ? msgs.filter((m) => m.id !== tempId) : msgs,
          );
          return 'rejected';
        }
      }

      const result = await api.submitPrompt(sid, {
        content,
        model,
        // Resolved against THIS prompt's session + model: the session's own
        // daemon-reported level when declared, else the model's stored pick or
        // catalog default — never the active-session rawState.thinking, which
        // tracks whatever session the user is looking at now: a queue drain for
        // a background session would otherwise submit the level of the session
        // the user switched to since enqueueing.
        thinking: (await modelProvider.resolveThinkingForPrompt(sid, model)) ?? rawState.thinking,
        permissionMode: rawState.permission,
        planMode,
        swarmMode,
      });

      // Goal mode is a one-shot flag: consumed by this send, then cleared.
      if (goalMode) {
        rawState.goalModeBySession = { ...rawState.goalModeBySession, [sid]: false };
        saveGoalModeToStorage();
      }

      // Authoritative prompt_id for :abort — race-free (the projector binding can
      // lose to a fast turn.started and synthesize a `pr_…` id the daemon rejects).
      rawState.promptIdBySession = { ...rawState.promptIdBySession, [sid]: result.promptId };

      // Reconcile without changing the id: ChatPane keys user turns by message id,
      // so replacing msg_opt_* with userMessageId remounts the bubble and flickers.
      // If a daemon/stub later echoes the user message, the reducer merges it into
      // this optimistic entry instead of appending a duplicate.
      updateSessionMessages(sid, (msgs) => {
        const idx = msgs.findIndex((m) => m.id === tempId);
        if (idx === -1) return msgs;
        const updated = [...msgs];
        updated[idx] = { ...updated[idx]!, promptId: updated[idx]!.promptId ?? result.promptId };
        return updated;
      });

      // Bind the real daemon prompt_id into the event projector so the upcoming
      // turn.started stamps this turn's messages with it (instead of a synthetic
      // pr_ id the daemon rejects on :abort). Stop's authoritative prompt_id
      // comes from the submit response above and the daemon's
      // event.session.status_changed — this binding is for transcript grouping.
      getEventConn()?.bindNextPromptId(sid, result.promptId);

      // NOTE: we no longer set a local auto-title here. The daemon generates a
      // smarter title from the first prompt and announces it via
      // session.meta.updated (projected to sessionMetaUpdated). PATCHing a title
      // locally would mark the session isCustomTitle=true and SUPPRESS the
      // daemon's auto-title, so we let the daemon own it.
      return 'ok';
    } catch (err) {
      // Submit failed — clear the in-flight flag so the next prompt isn't stuck
      // queued forever (turn.ended will never arrive), and roll back the
      // optimistic user message so the transcript doesn't show a delivered-
      // looking message the daemon never received. A structured API error is a
      // definitive refusal; anything else (network, truncated response) is
      // ambiguous — the prompt may already sit in the server's queue.
      rawState.inFlightBySession = { ...rawState.inFlightBySession, [sid]: false };
      updateSessionMessages(sid, (msgs) =>
        msgs.some((m) => m.id === tempId) ? msgs.filter((m) => m.id !== tempId) : msgs,
      );
      pushOperationFailure('sendPrompt', err, { sessionId: sid });
      return isDaemonApiError(err) ? 'rejected' : 'uncertain';
    } finally {
      // The daemon answered the submit (accepted or rejected) — the pending
      // window in which a snapshot can't reflect this turn is over.
      settleLocalTurn(sid, localTurnToken);
    }
  }

  async function sendPrompt(text: string, attachments?: PromptAttachment[]): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;

    // If the session is not idle OR a prompt is already in flight (submitted but
    // the WS turn.started hasn't arrived yet), enqueue instead of submitting
    // directly. The in-flight flag closes the window where two rapid prompts
    // would both submit and race.
    if (activity.value !== 'idle' || rawState.inFlightBySession[sid]) {
      enqueue(text, attachments);
      return;
    }

    // The queue should be empty by the time the session is idle, so a
    // non-empty queue means earlier prompts never made it out (e.g. a drain
    // that raced a still-busy daemon right after an abort). Preserve FIFO:
    // enqueue this prompt behind them and flush the head now — the flush
    // re-arms the in-flight flag, and each later turn end drains the next
    // entry. Submitting directly here would jump the queue AND leave the
    // stuck entries without a flush driver.
    if ((rawState.queuedBySession[sid]?.length ?? 0) > 0) {
      enqueue(text, attachments);
      flushQueueHead(sid);
      return;
    }

    await submitPromptInternal(sid, text, attachments);
  }

  /**
   * steerPrompt() — TUI ctrl+s parity: merge any locally queued prompts with the
   * live composer text and inject the result into the RUNNING turn instead of
   * waiting for it to finish. Two-step against the daemon: submit (parks the
   * prompt behind the active one) then POST /prompts:steer. Falls back to a
   * normal send when the session is idle.
   */
  async function steerPrompt(text: string, attachments?: PromptAttachment[]): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;

    // Merge queued texts (oldest first) + the live text, like the TUI does.
    const queue = rawState.queuedBySession[sid] ?? [];
    const parts: string[] = [];
    const mergedAttachments: PromptAttachment[] = [];
    for (const q of queue) {
      const trimmed = q.text.trim();
      if (trimmed) parts.push(trimmed);
      if (q.attachments?.length) mergedAttachments.push(...q.attachments);
    }
    const live = text.trim();
    if (live) parts.push(live);
    if (attachments?.length) mergedAttachments.push(...attachments);
    if (parts.length === 0 && mergedAttachments.length === 0) return;
    if (queue.length > 0) {
      rawState.queuedBySession = { ...rawState.queuedBySession, [sid]: [] };
    }
    const merged = parts.join('\n\n');

    // Put back every entry that was merged into this steer when its submit
    // fails, so the queued prompts aren't silently lost. Entries enqueued
    // while the submit was in flight stay behind them.
    const restoreQueue = (): void => {
      if (queue.length === 0) return;
      const current = rawState.queuedBySession[sid] ?? [];
      rawState.queuedBySession = { ...rawState.queuedBySession, [sid]: [...queue, ...current] };
    };

    // Idle and nothing in flight — there is no turn to steer into; normal send.
    if (activity.value === 'idle' && !rawState.inFlightBySession[sid]) {
      const outcome = await submitPromptInternal(sid, merged, mergedAttachments);
      // Same never-duplicate rule as the running-path catch below: restore
      // the merged entries only on a definitive rejection.
      if (outcome === 'rejected') restoreQueue();
      return;
    }

    // Optimistic transcript echo (the daemon emits no user-message WS event).
    const content: import('../../api/types').AppMessageContent[] = [];
    if (merged) content.push({ type: 'text', text: merged });
    for (const att of mergedAttachments) {
      if (att.kind === 'video') content.push({ type: 'video', source: { kind: 'file', fileId: att.fileId } });
      else if (att.kind === 'file') {
        content.push({
          type: 'file',
          fileId: att.fileId,
          name: att.name ?? '',
          mediaType: att.mediaType || 'application/octet-stream',
          size: att.size ?? 0,
        });
      } else content.push({ type: 'image', source: { kind: 'file', fileId: att.fileId } });
    }
    const tempId = nextOptimisticMsgId();
    const optimisticMsg: AppMessage = {
      id: tempId,
      sessionId: sid,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      metadata: { 'kimiWeb.optimisticUserMessage': true },
    };
    updateSessionMessages(sid, (msgs) => [...msgs, optimisticMsg]);

    const localTurnToken = beginLocalTurn(sid);
    try {
      const api = getKimiWebApi();
      const promptSession = rawState.sessions.find((s) => s.id === sid);
      const model =
        (promptSession?.model && promptSession.model.length > 0
          ? promptSession.model
          : rawState.defaultModel) ?? undefined;
      const result = await api.submitPrompt(sid, {
        content,
        model,
        // Resolved against this prompt's own session + model, same as a normal
        // send (see submitPromptInternal).
        thinking: (await modelProvider.resolveThinkingForPrompt(sid, model)) ?? rawState.thinking,
        permissionMode: rawState.permission,
        planMode: rawState.planModeBySession[sid] ?? false,
        swarmMode: rawState.swarmModeBySession[sid] ?? false,
      });

      // Stamp the real prompt_id onto the optimistic echo. Unlike a normal send,
      // a steered prompt IS echoed back by the daemon as a messageCreated user
      // event; matching that echo by prompt_id (instead of content) is what keeps
      // an image steer from rendering two user bubbles.
      updateSessionMessages(sid, (msgs) => {
        const idx = msgs.findIndex((m) => m.id === tempId);
        if (idx === -1) return msgs;
        const updated = [...msgs];
        updated[idx] = { ...updated[idx]!, promptId: updated[idx]!.promptId ?? result.promptId };
        return updated;
      });

      if (result.status !== 'queued') {
        // The turn ended while the user was typing — the prompt started a turn
        // of its own. Wire it up like a regular send so :abort keeps working.
        rawState.promptIdBySession = { ...rawState.promptIdBySession, [sid]: result.promptId };
        getEventConn()?.bindNextPromptId(sid, result.promptId);
        return;
      }

      try {
        await api.steerPrompts(sid, [result.promptId]);
      } catch {
        // The active turn finished between submit and steer — the daemon starts
        // the parked prompt as its own turn. Nothing to roll back.
      }
    } catch (err) {
      // Submit failed: drop the optimistic echo so the transcript doesn't show
      // a delivered-looking message the daemon never received.
      updateSessionMessages(sid, (msgs) => msgs.filter((m) => m.id !== tempId));
      // Restore the merged queue entries ONLY on a definitive daemon rejection
      // (a structured API error means nothing was accepted). On an ambiguous
      // failure — dropped response, network error — the merged prompt may
      // already be queued server-side; re-queueing the originals would
      // duplicate it (the exact ghost-send behavior this change exists to
      // prevent). The failure toast below tells the user what happened.
      if (isDaemonApiError(err)) restoreQueue();
      pushOperationFailure('steer', err, { sessionId: sid });
    } finally {
      settleLocalTurn(sid, localTurnToken);
    }
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
      pushOperationFailure('uploadImage', err);
      return null;
    }
  }

  /** Enqueue a message for the active session; flushed when activity returns to idle */
  function enqueue(text: string, attachments?: PromptAttachment[]): void {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    const current = rawState.queuedBySession[sid] ?? [];
    // The id keys the per-entry flush failure budget (removing/reordering
    // the head then resets the next entry's budget).
    const entry = { text, attachments, id: nextQueueEntryId() };
    rawState.queuedBySession = {
      ...rawState.queuedBySession,
      [sid]: [...current, entry],
    };
  }

  /**
   * Submit the head of the session's local prompt queue. On failure the
   * entry goes back at the head with NO immediate retry — the daemon that
   * just rejected it is the one we'd race against (e.g. right after an
   * abort); the next turn end or the next idle sendPrompt drives the next
   * attempt. After MAX_QUEUE_FLUSH_FAILURES consecutive failures the entry
   * is dropped instead, so one permanently rejected prompt cannot wedge the
   * queue. The budget is tracked PER ENTRY (by id), so removing or
   * reordering the head resets it for the next entry. Every failure is
   * already surfaced via pushOperationFailure.
   */
  function flushQueueHead(sid: string): void {
    const [next, ...rest] = rawState.queuedBySession[sid] ?? [];
    if (next === undefined) return;
    rawState.queuedBySession = { ...rawState.queuedBySession, [sid]: rest };
    void submitPromptInternal(sid, next.text, next.attachments).then((outcome) => {
      if (outcome === 'ok') {
        queueFlushFailures.delete(sid);
        return;
      }
      // Ambiguous failure: the daemon may have accepted the prompt and lost
      // the response — the entry is dropped (the failure was already toasted)
      // rather than re-queued and possibly submitted twice.
      if (outcome === 'uncertain') {
        queueFlushFailures.delete(sid);
        return;
      }
      // Definitively rejected below this point. If the session was forgotten
      // (e.g. archived) while the submit was pending, its queue was already
      // discarded — don't resurrect it.
      if (!rawState.sessions.some((s) => s.id === sid)) {
        queueFlushFailures.delete(sid);
        return;
      }
      // Per-entry budget: a different head (removed/reordered since) starts
      // fresh instead of inheriting the previous entry's failures.
      const key = next.id ?? next.text;
      const previous = queueFlushFailures.get(sid);
      const count = previous !== undefined && previous.key === key ? previous.count + 1 : 1;
      if (count >= MAX_QUEUE_FLUSH_FAILURES) {
        queueFlushFailures.delete(sid);
        // Advance the queue instead of stranding the entries behind the
        // dropped head: the failed submit produced no turn, so nothing else
        // will drive the next entry until the user sends again. The new head
        // carries its own budget, so a poisoned successor just goes through
        // the same retry cycle.
        if ((rawState.queuedBySession[sid]?.length ?? 0) > 0) {
          flushQueueHead(sid);
        }
        return;
      }
      queueFlushFailures.set(sid, { key, count });
      const current = rawState.queuedBySession[sid] ?? [];
      rawState.queuedBySession = {
        ...rawState.queuedBySession,
        [sid]: [next, ...current],
      };
    });
  }

  /**
   * Shared prompt-finish cleanup, used by BOTH the main-turn-ended path
   * (facade `onMainTurnEnd`) and the authoritative-snapshot path
   * (handleSessionSnapshot below). Returns whether this call actually flipped
   * an in-flight prompt to finished.
   *
   * Clears the local in-flight/prompt-id state and drains exactly ONE
   * queued message — the resubmitted prompt re-arms the in-flight flag, and
   * its own finish drains the following one. Repeat calls (e.g. a late
   * duplicate idle event) therefore cannot drain more than one message per
   * real turn end. Callers layer their own side effects (notify, sound,
   * unread) on top; the snapshot path deliberately adds none.
   *
   * The drain is GATED on this client having actually witnessed a live
   * prompt/turn: a finish with no local in-flight prompt, no locally
   * tracked active turn, and no `turnWasActive` hint must NOT submit
   * queued prompts. That is what fired stale queued messages (and their
   * old file attachments) spontaneously when a session was merely
   * re-opened after an earlier drain had failed.
   */
  function finishPromptLocal(sid: string, opts?: { turnWasActive?: boolean }): boolean {
    const wasInFlight = rawState.inFlightBySession[sid] === true;
    rawState.inFlightBySession = { ...rawState.inFlightBySession, [sid]: false };
    // Drop any cached prompt_id so a later skill activation (which has no
    // prompt_id) doesn't accidentally reuse this stale id for :abort.
    if (rawState.promptIdBySession[sid] !== undefined) {
      const nextPromptIds = { ...rawState.promptIdBySession };
      delete nextPromptIds[sid];
      rawState.promptIdBySession = nextPromptIds;
    }
    if (sid === rawState.activeSessionId) {
      resetFastMoon();
    }

    const mayDrain =
      wasInFlight || opts?.turnWasActive === true || (rawState.turnActiveBySession[sid] ?? false);
    if (mayDrain) {
      flushQueueHead(sid);
    }

    return wasInFlight;
  }

  /**
   * Snapshot-driven finish. An authoritative snapshot replaces the event
   * stream on resync (buffer overflow / epoch change / delta gap): no
   * sessionStatusChanged event arrives in that case, so without this the
   * local in-flight flag would stick forever — the moon keeps spinning and
   * the next prompt queues behind a turn that already ended.
   *
   * Unlike the WS path this adds NO completion side effects (no notification,
   * sound, or unread): opening a historical session must not cry wolf. The
   * queue drain inside finishPromptLocal is additionally gated on a locally
   * witnessed prompt/turn, so merely re-opening a session can never
   * spontaneously submit queued prompts (with their stale attachments).
   */
  function handleSessionSnapshot(
    sid: string,
    snapshot: { inFlightTurn: AppInFlightTurn | null; busy: boolean },
  ): void {
    // inFlightTurn tracks only the main agent, while busy aggregates all
    // agents and background work. Keep the local prompt alive only when both
    // facts still support a running main turn. Either terminal fact may also
    // reconcile the other tracker when a snapshot catches it stale.
    if (snapshot.inFlightTurn !== null && snapshot.busy) return;
    finishPromptLocal(sid);
  }

  async function abortCurrentPrompt(): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    const session = rawState.sessions.find((s) => s.id === sid);

    // 1. Authoritative id captured at submit time.
    let promptId = rawState.promptIdBySession[sid];

    // 2. Fallback to projector-derived id only when it is a real daemon prompt_id.
    //    The v1 daemon uses `prompt_...`, server-v2 legacy uses `msg_...`;
    //    only local synthetic `pr_...` ids are rejected by the daemon.
    if (promptId === undefined) {
      const candidate = session?.currentPromptId;
      if (candidate !== undefined && candidate.length > 0 && !candidate.startsWith('pr_')) {
        promptId = candidate;
      }
    }

    const api = getKimiWebApi();

    // 3. If we have a real id, try the per-prompt abort first. If the daemon
    //    reports the prompt is missing/already completed, clear the stale id and
    //    fall back to session-level abort for whatever is currently running.
    if (promptId !== undefined) {
      try {
        const result = await api.abortPrompt(sid, promptId);
        if (result.aborted) return;
        const nextPromptIds = { ...rawState.promptIdBySession };
        delete nextPromptIds[sid];
        rawState.promptIdBySession = nextPromptIds;
      } catch (err) {
        if (isDaemonApiError(err) && err.code === PROMPT_NOT_FOUND_CODE) {
          // Stale id — try the session-level fallback below.
          const nextPromptIds = { ...rawState.promptIdBySession };
          delete nextPromptIds[sid];
          rawState.promptIdBySession = nextPromptIds;
        } else {
          pushOperationFailure('abortCurrentPrompt', err, { sessionId: sid });
          return;
        }
      }
    }

    // 4. No real id, or the prompt id is no longer recognized: cancel whatever
    //    is running in the session (including skill activations).
    try {
      await api.abortSession(sid);
    } catch (err) {
      pushOperationFailure('abortCurrentPrompt', err, { sessionId: sid });
    }
  }

  function removePendingApproval(sid: string, approvalId: string): void {
    const list = rawState.approvalsBySession[sid] ?? [];
    rawState.approvalsBySession = {
      ...rawState.approvalsBySession,
      [sid]: list.filter((a) => a.approvalId !== approvalId),
    };
  }

  function removePendingQuestion(sid: string, questionId: string): void {
    const list = rawState.questionsBySession[sid] ?? [];
    rawState.questionsBySession = {
      ...rawState.questionsBySession,
      [sid]: list.filter((q) => q.questionId !== questionId),
    };
  }

  async function respondApproval(
    approvalId: string,
    response: { decision: ApprovalDecision; scope?: 'session'; feedback?: string; selectedLabel?: string },
  ): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    // Guard against a second click while the first respond is in flight.
    if (pendingApprovalActions[approvalId]) return;
    pendingApprovalActions[approvalId] = true;
    try {
      const api = getKimiWebApi();
      const fullResponse: ApprovalResponse = {
        decision: response.decision,
        scope: response.scope,
        feedback: response.feedback,
        selectedLabel: response.selectedLabel,
      };
      await api.respondApproval(sid, approvalId, fullResponse);
      // Remove from local approvals immediately (WS event will confirm)
      removePendingApproval(sid, approvalId);
    } catch (err) {
      if (isAlreadyResolvedError(err)) {
        // Already resolved (another client or a raced event) — that is the
        // desired end state, so drop it locally without surfacing an error.
        removePendingApproval(sid, approvalId);
      } else {
        pushOperationFailure('respondApproval', err, { sessionId: sid });
      }
    } finally {
      delete pendingApprovalActions[approvalId];
    }
  }

  async function respondQuestion(
    questionId: string,
    response: QuestionResponse,
  ): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    // Guard against a second click while the first respond is in flight.
    if (pendingQuestionActions[questionId]) return;
    pendingQuestionActions[questionId] = 'answer';
    try {
      const api = getKimiWebApi();
      await api.respondQuestion(sid, questionId, response);
      removePendingQuestion(sid, questionId);
    } catch (err) {
      if (isAlreadyResolvedError(err)) {
        // Already resolved (another client or a raced event) — that is the
        // desired end state, so drop it locally without surfacing an error.
        removePendingQuestion(sid, questionId);
      } else {
        pushOperationFailure('respondQuestion', err, { sessionId: sid });
      }
    } finally {
      delete pendingQuestionActions[questionId];
    }
  }

  async function dismissQuestion(questionId: string): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    // Guard against a second click while a respond/dismiss is in flight.
    if (pendingQuestionActions[questionId]) return;
    pendingQuestionActions[questionId] = 'dismiss';
    try {
      const api = getKimiWebApi();
      await api.dismissQuestion(sid, questionId);
      removePendingQuestion(sid, questionId);
    } catch (err) {
      if (isAlreadyResolvedError(err)) {
        removePendingQuestion(sid, questionId);
      } else {
        pushOperationFailure('dismissQuestion', err, { sessionId: sid });
      }
    } finally {
      delete pendingQuestionActions[questionId];
    }
  }

  async function cancelTask(taskId: string): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    // Guard against a second click while the first cancel is in flight.
    if (pendingTaskCancellations[taskId]) return;
    pendingTaskCancellations[taskId] = true;
    try {
      const api = getKimiWebApi();
      // A background subagent row is keyed by agent id, but REST `/tasks` only
      // knows its background-task id.
      const restTaskId = (rawState.tasksBySession[sid] ?? []).find((t) => t.id === taskId)
        ?.backgroundTaskId;
      await api.cancelTask(sid, restTaskId ?? taskId);
      // Update task status locally
      const list = rawState.tasksBySession[sid] ?? [];
      rawState.tasksBySession = {
        ...rawState.tasksBySession,
        [sid]: list.map((t) =>
          t.id === taskId ? { ...t, status: 'cancelled' as const } : t,
        ),
      };
    } catch (err) {
      if (isTaskAlreadyFinishedError(err)) {
        // Already in a terminal state — that is the desired end state for
        // "cancel", so stay silent. Don't force status to 'cancelled': the
        // task may have completed/failed, and the task event stream / poller
        // will reflect its real status.
      } else {
        pushOperationFailure('cancelTask', err, { sessionId: sid });
      }
    } finally {
      delete pendingTaskCancellations[taskId];
    }
  }

  /** Persist and apply plan mode for the active session (pushed to its profile
   *  + sent per-prompt). With no active session the toggle is staged on the
   *  draft and transferred when the first prompt creates the session. */
  function setPlanMode(on: boolean): void {
    const sid = rawState.activeSessionId;
    if (sid) {
      rawState.planModeBySession = { ...rawState.planModeBySession, [sid]: on };
      savePlanModeToStorage();
      void persistSessionProfile({ planMode: on });
    } else {
      draftModes.planMode = on;
    }
  }

  /** Flip plan mode on/off for the active session (or the draft). */
  function togglePlanMode(): void {
    const sid = rawState.activeSessionId;
    const current = sid ? (rawState.planModeBySession[sid] ?? false) : draftModes.planMode;
    setPlanMode(!current);
  }

  /** Persist and apply swarm mode for the active session (pushed to its profile
   *  + sent per-prompt). With no active session the toggle is staged on the draft. */
  function setSwarmMode(on: boolean): void {
    const sid = rawState.activeSessionId;
    if (sid) {
      rawState.swarmModeBySession = { ...rawState.swarmModeBySession, [sid]: on };
      saveSwarmModeToStorage();
      void persistSessionProfile({ swarmMode: on });
    } else {
      draftModes.swarmMode = on;
    }
  }

  /** Flip swarm mode on/off. In manual permission mode, ask before enabling. */
  async function toggleSwarmMode(): Promise<void> {
    const sid = rawState.activeSessionId;
    const current = sid ? (rawState.swarmModeBySession[sid] ?? false) : draftModes.swarmMode;
    const on = !current;
    if (on && rawState.permission === 'manual') {
      const ok = await confirm({
        title: t('workspace.swarmEnableConfirm'),
        variant: 'primary',
      });
      if (!ok) return;
    }
    setSwarmMode(on);
  }

  /** Persist goal mode for the active session. Unlike plan/swarm, this is a
   *  one-shot flag consumed on send (not pushed to the session profile). */
  function setGoalMode(on: boolean): void {
    const sid = rawState.activeSessionId;
    if (sid) {
      rawState.goalModeBySession = { ...rawState.goalModeBySession, [sid]: on };
      saveGoalModeToStorage();
    } else {
      draftModes.goalMode = on;
    }
  }

  /** Flip goal mode on/off for the active session (or the draft). */
  function toggleGoalMode(): void {
    const sid = rawState.activeSessionId;
    const current = sid ? (rawState.goalModeBySession[sid] ?? false) : draftModes.goalMode;
    setGoalMode(!current);
  }

  /** Create a goal by sending its objective to the session profile, then submit it as a prompt. */
  async function createGoal(objective: string): Promise<void> {
    const trimmed = objective.trim();
    if (!trimmed) return;
    if (rawState.permission === 'manual') {
      const ok = await confirm({
        title: t('workspace.goalStartConfirm', { objective: trimmed }),
        variant: 'primary',
      });
      if (!ok) return;
    }
    // Empty-composer heal: `/goal <objective>` from the new-session screen
    // would otherwise silently clear and run nothing. Create the session first
    // (same path as the first prompt / a new-session skill), then target it.
    let sid = rawState.activeSessionId;
    if (!sid) {
      // Use the same fallback as the client-wide computed activeWorkspaceId
      // (raw value if it exists, else the first sidebar-visible workspace). On a
      // fresh empty workspace load() never writes rawState.activeWorkspaceId
      // (there's no most-recent session to anchor it), so a raw read here would
      // be null and silently no-op even though the UI can still show a usable
      // workspace. Plain first-prompts and skill activations don't hit this
      // because App.vue passes the computed activeWorkspaceId in.
      const raw = rawState.activeWorkspaceId;
      const wsId =
        raw && workspacesView.value.some((w) => w.id === raw)
          ? raw
          : (workspacesView.value[0]?.id ?? null);
      if (!wsId) return;
      // App.vue invokes createGoal fire-and-forget, so a rejection here would
      // otherwise surface as an unhandled rejection instead of an operation
      // failure. Mirror the other draft-session paths (skill / BTW / first
      // prompt) which wrap createDraftSession.
      try {
        sid = (await createDraftSession(wsId)) ?? undefined;
      } catch (err) {
        pushOperationFailure('createGoal', err);
        return;
      }
      if (!sid) return;
    }
    try {
      await getKimiWebApi().updateSession(sid, { goalObjective: trimmed });
    } catch (err) {
      pushOperationFailure('createGoal', err, { sessionId: sid, message: goalErrorMessage(err) });
      return;
    }
    // The goal objective is set explicitly above. If goal mode was staged on the
    // draft (e.g. the user ran bare `/goal`, then `/goal <objective>`),
    // createDraftSession copied it into this session's goalModeBySession map.
    // Leaving it on would make submitPromptInternal (via sendPrompt) re-POST
    // another goalObjective — which the daemon rejects because a goal already
    // exists — and the user's objective prompt would never be submitted.
    // Clear the one-shot flag here: an explicit `/goal <objective>` has exactly
    // the same effect as the goal-mode flag's consumption.
    if (rawState.goalModeBySession[sid]) {
      rawState.goalModeBySession = { ...rawState.goalModeBySession, [sid]: false };
      saveGoalModeToStorage();
    }
    // Preserve normal send queueing semantics whenever the goal still targets the
    // active session (the overwhelmingly common case): sendPrompt enqueues when
    // another turn is running or a prompt is already in flight. Only fall back to
    // the explicit-session send when activeSessionId moved during the create
    // window above, so a concurrent session switch can't redirect the goal prompt.
    // (The new session is otherwise idle+not-in-flight, so this does not race
    // another turn.)
    if (rawState.activeSessionId === sid) {
      await sendPrompt(trimmed);
    } else {
      await submitPromptInternal(sid, trimmed);
    }
  }

  /** Send a one-shot goal control action (pause/resume/cancel). */
  function controlGoal(action: 'pause' | 'resume' | 'cancel'): void {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    void Promise.resolve(getKimiWebApi().updateSession(sid, { goalControl: action }))
      .catch((err) => {
        pushOperationFailure('controlGoal', err, { sessionId: sid, message: goalErrorMessage(err) });
      });
  }

  /** Persist and apply a new permission mode. Approval decisions are owned by
   *  the daemon (auto/yolo are resolved server-side), so any pending approvals
   *  are left for the user to answer explicitly. */
  function setPermission(mode: PermissionMode): void {
    rawState.permission = mode;
    savePermissionToStorage(mode);
    void persistSessionProfile({ permissionMode: mode });
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
      updateSession(id, (s) => ({ ...s, title }));
    } catch (err) {
      pushOperationFailure('renameSession', err, { sessionId: id });
    }
  }

  /** Rename a workspace — persists via the daemon update API, then applies
   *  locally. Derived workspaces (a cwd with sessions that was never explicitly
   *  registered) can't be renamed by the daemon yet: PATCH rejects them with
   *  404. In that case the name is persisted in localStorage (keyed by root)
   *  and overlaid onto the loaded list, so the rename still survives a refresh. */
  async function renameWorkspace(id: string, name: string): Promise<void> {
    const root = rawState.workspaces.find((w) => w.id === id)?.root;
    const applyLocal = (): void => {
      rawState.workspaces = rawState.workspaces.map((w) =>
        w.id === id ? { ...w, name } : w,
      );
    };
    try {
      await getKimiWebApi().updateWorkspace(id, { name });
      // Server accepted the rename — drop any local override for this root.
      if (root !== undefined) {
        const overrides = loadWorkspaceNameOverrides();
        if (root in overrides) {
          delete overrides[root];
          saveWorkspaceNameOverrides(overrides);
        }
      }
      applyLocal();
    } catch (err) {
      if (
        root !== undefined &&
        isDaemonApiError(err) &&
        err.code === WORKSPACE_NOT_FOUND_CODE
      ) {
        saveWorkspaceNameOverrides({ ...loadWorkspaceNameOverrides(), [root]: name });
        applyLocal();
        return;
      }
      pushOperationFailure('renameWorkspace', err);
    }
  }

  /** Delete a workspace — calls API, removes locally */
  async function deleteWorkspace(id: string): Promise<void> {
    // "Remove workspace" only hides the sidebar entry — it never deletes sessions
    // or history. The daemon DELETE is registry-only and mergedWorkspaces would
    // otherwise re-derive the workspace from any session cwd still pointing at it,
    // so it would pop right back. To make remove actually stick (even when the
    // workspace has sessions), record its ROOT in the persisted hidden set; the
    // merge then skips it. Re-adding the same path un-hides it (see addWorkspace).
    const root =
      rawState.workspaces.find((w) => w.id === id)?.root ??
      mergedWorkspaces.value.find((w) => w.id === id)?.root ??
      id; // derived workspaces use the cwd as their id
    const activeSession = rawState.activeSessionId
      ? rawState.sessions.find((s) => s.id === rawState.activeSessionId)
      : undefined;
    const removingActiveWorkspace = rawState.activeWorkspaceId === id || rawState.activeWorkspaceId === root;
    const activeSessionInRemovedWorkspace = Boolean(
      activeSession &&
        (activeSession.cwd === root ||
          activeSession.workspaceId === id ||
          workspaceIdForSession(activeSession) === id),
    );
    if (root && !rawState.hiddenWorkspaceRoots.includes(root)) {
      rawState.hiddenWorkspaceRoots = [...rawState.hiddenWorkspaceRoots, root];
      saveHiddenWorkspacesToStorage(rawState.hiddenWorkspaceRoots);
    }
    // Best-effort registry cleanup; ignore failures (the hide already took effect).
    try {
      await getKimiWebApi().deleteWorkspace(id);
    } catch (err) {
      // registry delete is optional — the sidebar hide is what the user sees.
      console.warn('[kimi-web] deleteWorkspace registry cleanup failed for', id, err);
    }
    rawState.workspaces = rawState.workspaces.filter((w) => w.id !== id && w.root !== root);
    if (removingActiveWorkspace || activeSessionInRemovedWorkspace) {
      const nextWorkspace = workspacesView.value[0]?.id ?? null;
      rawState.activeWorkspaceId = nextWorkspace;
      if (nextWorkspace) saveActiveWorkspaceToStorage(nextWorkspace);
      else {
        try { safeRemove(STORAGE_KEYS.activeWorkspace); } catch { /* ignore */ }
      }
    }
    if (removingActiveWorkspace || activeSessionInRemovedWorkspace) {
      setActiveSessionId(undefined);
      rawState.sessionLoading = false;
      clearFileDiff();
      writeSessionUrl(undefined, 'replace');
    }
  }

  /** Archive a session — calls API, persists the archive flag, removes locally, picks another active session or none */
  async function archiveSession(id: string): Promise<void> {
    try {
      const api = getKimiWebApi();
      await api.archiveSession(id);
      forgetSession(id);
      sideChat.clearSideChatForSession(id);
      const { [id]: _removedIds, ...restIds } = rawState.sideChatUserMessageIdsBySession;
      void _removedIds;
      rawState.sideChatUserMessageIdsBySession = restIds;

      // If archived session was active, pick another. 'replace' so the address
      // bar doesn't keep pointing at (and back doesn't return to) a dead session.
      if (rawState.activeSessionId === id) {
        const next = rawState.sessions[0];
        if (next) {
          await selectSession(next.id, { urlMode: 'replace' });
        } else {
          setActiveSessionId(undefined);
          writeSessionUrl(undefined, 'replace');
        }
      }
    } catch (err) {
      pushOperationFailure('archiveSession', err, { sessionId: id });
    }
  }

  /** Export the given session (default: the active one). The id is captured
   * synchronously so a later session switch cannot redirect the in-flight
   * request, and a lock prevents duplicate ZIP generation. */
  async function exportSession(targetSessionId?: string): Promise<void> {
    if (exportInFlight) return;
    const sessionId = targetSessionId ?? rawState.activeSessionId;
    if (!sessionId) {
      const message = t('commands.export.noSession');
      traceKeyEvent('export:failed', { status: 'no-session' });
      pushOperationFailure('exportSession', new Error(message), { message });
      return;
    }
    exportInFlight = true;
    const startedAt = Date.now();
    traceKeyEvent('export:start', { sessionId });
    try {
      const webLog = sessionExportTraceToJsonl();
      const { blob, fileName } = await getKimiWebApi().exportSession(sessionId, webLog);
      if (typeof document === 'undefined') throw new Error('Document is unavailable');
      const url = URL.createObjectURL(blob);
      let anchor: HTMLAnchorElement | undefined;
      try {
        anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        document.body.append(anchor);
        anchor.click();
      } finally {
        anchor?.remove();
        setTimeout(() => {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // Object URL cleanup is best-effort in restricted browser contexts.
          }
        }, 0);
      }
      traceKeyEvent('export:accepted', {
        sessionId,
        status: 'accepted',
        zipBytes: blob.size,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const failure =
        typeof error === 'object' && error !== null
          ? (error as {
              name?: unknown;
              code?: unknown;
              requestId?: unknown;
              phase?: unknown;
              status?: unknown;
            })
          : undefined;
      traceKeyEvent('export:failed', {
        sessionId,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        errorName:
          typeof failure?.name === 'string' ? failure.name : typeof error,
        errorCode: typeof failure?.code === 'number' ? failure.code : undefined,
        requestId: typeof failure?.requestId === 'string' ? failure.requestId : undefined,
        phase: typeof failure?.phase === 'string' ? failure.phase : undefined,
        httpStatus: typeof failure?.status === 'number' ? failure.status : undefined,
      });
      pushOperationFailure('exportSession', error, { sessionId });
    } finally {
      exportInFlight = false;
    }
  }

  /** Restore an archived session — calls API, then puts the returned session
   *  back at the front of the list so it reappears in the sidebar. */
  async function restoreSession(id: string): Promise<boolean> {
    try {
      const restored = await getKimiWebApi().restoreSession(id);
      upsertSessionFront(restored);
      return true;
    } catch (err) {
      pushOperationFailure('restoreSession', err, { sessionId: id });
      return false;
    }
  }

  /** List archived sessions (server-side `archived_only` filter). Kept separate
   *  from the per-workspace active list — callers (e.g. Settings) hold the page
   *  locally and do their own search/filter/sort. */
  function loadArchivedSessions(input?: { beforeId?: string; pageSize?: number }) {
    return getKimiWebApi().listSessions({
      archivedOnly: true,
      beforeId: input?.beforeId,
      pageSize: input?.pageSize ?? 50,
    });
  }

  /** Logout from the managed Kimi provider. Re-checks auth and reloads sessions. */
  async function logout(): Promise<void> {
    try {
      const api = getKimiWebApi();
      await api.logout();
      await checkAuth();
      await load();
    } catch (err) {
      pushOperationFailure('logout', err);
    }
  }

  /**
   * compact() — request history compaction via POST /sessions/{id}:compact.
   * Progress arrives asynchronously through the WS compaction.* events (running
   * notice → divider marker), so we just fire the request. An optional
   * instruction (from `/compact <text>`) steers what the summary focuses on.
   */
  function compact(instruction?: string): void {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    void getKimiWebApi()
      .compactSession(sid, instruction)
      .catch((err) => {
        pushOperationFailure('compact', err, { sessionId: sid });
      });
  }

  /**
   * forkSession() — fork the active session into a new child session via
   * POST /sessions/{id}:fork, then add it to the list and select it.
   */
  async function forkSession(sessionId?: string): Promise<void> {
    const sid = sessionId ?? rawState.activeSessionId;
    if (!sid) return;
    try {
      const forked = await getKimiWebApi().forkSession(sid);
      upsertSessionFront(forked);
      await selectSession(forked.id);
    } catch (err) {
      pushOperationFailure('fork', err, { sessionId: sid });
    }
  }

  /**
   * Undo the last `count` turns of the active session (daemon :undo), then re-sync
   * the snapshot so the local transcript matches the daemon's post-undo history.
   * Returns the text of the most-recent user message that was undone, so the UI
   * can offer "edit + resend" (load it back into the composer).
   */
  async function undo(count = 1): Promise<string | null> {
    const sid = rawState.activeSessionId;
    if (!sid) return null;
    // Capture the last user message text BEFORE the undo removes it.
    const lastUserText = (() => {
      const msgs = rawState.messagesBySession[sid] ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!;
        if (m.role !== 'user') continue;
        if (m.metadata?.['origin'] && (m.metadata['origin'] as { kind?: string }).kind !== 'user') continue;
        return m.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
      }
      return null;
    })();
    try {
      await getKimiWebApi().undoSession(sid, count);
      await syncSessionFromSnapshot(sid);
      return lastUserText;
    } catch (err) {
      pushOperationFailure('undo', err, { sessionId: sid });
      return null;
    }
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
   * Move a queued message within the active session's queue (drag-to-reorder).
   * Defensive: no-op if indices are equal, out of range, or no active session.
   */
  function reorderQueue(from: number, to: number): void {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    const current = rawState.queuedBySession[sid] ?? [];
    if (from === to) return;
    if (from < 0 || from >= current.length || to < 0 || to >= current.length) return;
    const next = [...current];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
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
    } catch (err) {
      console.warn('[kimi-web] readFileContent failed for', path, err);
      return null;
    }
  }

  // Matches the daemon's FS_READ_MAX_BYTES. Without an explicit length the
  // protocol defaults to 1MiB and silently truncates — half a PNG decodes as a
  // broken image, which is worse than falling back to the original src.
  const IMAGE_READ_MAX_BYTES = 10_485_760;

  function getFileDownloadUrl(path: string): string | null {
    const sid = rawState.activeSessionId;
    if (!sid) return null;
    return getKimiWebApi().getFileDownloadUrl(sid, path);
  }

  async function openWorkspaceFile(path: string, line?: number): Promise<boolean> {
    const sid = rawState.activeSessionId;
    if (!sid) return false;
    try {
      await getKimiWebApi().openFile(sid, { path, line });
      return true;
    } catch (err) {
      pushOperationFailure('openFile', err, { sessionId: sid });
      return false;
    }
  }

  /** Open the current workspace in an external application (Finder, Cursor, etc.). */
  async function openInApp(appId: string): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    const path = status.value.cwd || '.';
    try {
      await getKimiWebApi().openInApp(sid, appId, path);
    } catch (err) {
      pushOperationFailure('openInApp', err, { sessionId: sid });
    }
  }

  async function revealWorkspaceFile(path: string): Promise<boolean> {
    const sid = rawState.activeSessionId;
    if (!sid) return false;
    try {
      await getKimiWebApi().revealFile(sid, { path });
      return true;
    } catch (err) {
      pushOperationFailure('revealFile', err, { sessionId: sid });
      return false;
    }
  }

  /**
   * Resolve a local image path to a displayable data URL.
   * Non-local URLs (http/https/data) pass through unchanged.
   * Local paths are read via the daemon's readFile endpoint and returned as
   * data:{mime};base64,{content} URLs so they render in the browser. Absolute
   * paths are made cwd-relative first (the daemon rejects absolute paths), and
   * truncated/non-binary reads fall back to the original src.
   */
  async function resolveImageUrl(src: string): Promise<string> {
    // Pass through already-addressable URLs
    if (/^(https?:|data:|blob:)/i.test(src)) return src;
    const sid = rawState.activeSessionId;
    if (!sid) return src;

    // The daemon's path resolution only accepts session-relative paths, but the
    // model usually references images by absolute path. Strip the session cwd.
    let path = src;
    if (path.startsWith('/')) {
      const cwd = rawState.sessions.find((s) => s.id === sid)?.cwd;
      if (cwd && (path === cwd || path.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`))) {
        path = path.slice(cwd.length).replace(/^\//, '');
        if (!path) return src;
      } else {
        return src; // absolute path outside the workspace — unreadable
      }
    }

    try {
      const api = getKimiWebApi();
      const result = await api.readFile(sid, { path, length: IMAGE_READ_MAX_BYTES });
      if (!result.isBinary || result.encoding !== 'base64' || result.truncated) return src;
      return `data:${result.mime};base64,${result.content}`;
    } catch {
      return src;
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

  return {
    loadFileDiff,
    clearFileDiff,
    loadGitStatus,
    checkAuth,
    loadConfig,
    updateConfig,
    listAllSessionsGlobal,
    load,
    refreshServerMeta,
    loadWorkspaces,
    loadMoreSessions,
    loadAllSessions,
    selectWorkspace,
    openWorkspace,
    upsertWorkspacePreserveOrder,
    applyWorkspaceEvent,
    clearActiveSession,
    openWorkspaceDraft,
    startSessionAndSendPrompt,
    startSessionAndActivateSkill,
    startSessionAndOpenSideChat,
    addWorkspaceByPath,
    browseFs,
    getFsHome,
    writeSessionUrl,
    fetchSessionIntoList,
    onSessionRoutePopState,
    bindSessionRoute,
    selectSession,
    submitPromptInternal,
    finishPromptLocal,
    localTurnStartState,
    isLocalTurnSnapshotCurrent,
    afterLocalTurnStartsSettle,
    handleSessionSnapshot,
    sendPrompt,
    steerPrompt,
    uploadImage,
    enqueue,
    unqueue,
    reorderQueue,
    abortCurrentPrompt,
    respondApproval,
    respondQuestion,
    dismissQuestion,
    pendingQuestionActions,
    pendingApprovalActions,
    cancelTask,
    setPlanMode,
    togglePlanMode,
    setSwarmMode,
    toggleSwarmMode,
    setGoalMode,
    toggleGoalMode,
    createGoal,
    controlGoal,
    setPermission,
    dismissWarning,
    renameSession,
    renameWorkspace,
    deleteWorkspace,
    archiveSession,
    exportSession,
    restoreSession,
    loadArchivedSessions,
    logout,
    compact,
    forkSession,
    undo,
    listDir,
    readFileContent,
    getFileDownloadUrl,
    openWorkspaceFile,
    openInApp,
    revealWorkspaceFile,
    resolveImageUrl,
    searchFiles,
    loadOlderMessages,
    refreshSessionSidecars,
    /** True while any empty-composer first prompt is being created + submitted
     *  (the window covered by startingFirstPromptWorkspaces). Drives the
     *  empty-session "starting conversation…" loading state. Intentionally
     *  keyed by the lock set itself rather than the current activeWorkspaceId:
     *  createDraftSession can swap activeWorkspaceId to a registered id
     *  mid-flight, and a workspace-keyed read would prematurely re-enable the
     *  composer and reopen the duplicate first-submit race. */
    isStartingFirstPrompt: () => startingFirstPromptWorkspaces.size > 0,
  };
}

export type UseWorkspaceState = ReturnType<typeof useWorkspaceState>;
