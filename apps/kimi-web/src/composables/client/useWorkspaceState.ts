// apps/kimi-web/src/composables/client/useWorkspaceState.ts
// Workspace/session actions: session lifecycle, workspace CRUD, prompt
// submission + queueing, approvals/questions/tasks, mode toggles, goals,
// file/diff/git actions, auth/config, and URL<->session routing.
//
// The event reducer wiring (applyEvent, connectEventsIfNeeded, eventConn) and
// the view-model computeds stay in the facade; cross-dependencies are injected
// here as params.

import { type ComputedRef, type Ref } from 'vue';
import { getKimiWebApi } from '../../api';
import { isDaemonApiError } from '../../api/errors';
import type {
  AppConfig,
  AppMessage,
  AppSession,
  AppWorkspace,
  ApprovalDecision,
  ApprovalResponse,
  FsEntry,
  KimiEventConnection,
  QuestionResponse,
} from '../../api/types';
import { safeRemove, STORAGE_KEYS } from '../../lib/storage';
import { parseDiff } from '../../lib/parseDiff';
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
const PROMPT_NOT_FOUND_CODE = 40402;

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
  inFlightPromptSessions: Set<string>;
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
  subscribeToSessionEvents: (sessionId: string) => void;
  hasLoadedMessages: (sessionId: string) => boolean;
  refreshSessionStatus: (sessionId: string) => Promise<void>;
  persistSessionProfile: (patch: PersistSessionProfilePatch) => void;
  mergedWorkspaces: ComputedRef<AppWorkspace[]>;
  /** Sidebar-facing workspaces in the user's (dragged) display order. */
  workspacesView: ComputedRef<WorkspaceView[]>;
  status: ComputedRef<ConversationStatus>;
  workspaceIdForSession: (s: { workspaceId?: string; cwd: string }) => string;
  savePermissionToStorage: (mode: PermissionMode) => void;
  savePlanModeToStorage: (v: boolean) => void;
  saveSwarmModeToStorage: (v: boolean) => void;
  saveGoalModeToStorage: (v: boolean) => void;
  saveUnread: (changes: Record<string, boolean>) => void;
  saveActiveWorkspaceToStorage: (id: string) => void;
  saveHiddenWorkspacesToStorage: (roots: string[]) => void;
  goalErrorMessage: (err: unknown) => string | undefined;
  basename: (path: string) => string;
  resetFastMoon: () => void;
  initialized: Ref<boolean>;
  selectedDiffPath: Ref<string | null>;
  fileDiffLines: Ref<DiffViewLine[]>;
  fileDiffLoading: Ref<boolean>;
}

export function useWorkspaceState(rawState: ExtendedState, deps: UseWorkspaceStateDeps) {
  const {
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
    getEventConn,
    syncSessionFromSnapshot,
    subscribeToSessionEvents,
    hasLoadedMessages,
    refreshSessionStatus,
    persistSessionProfile,
    mergedWorkspaces,
    workspacesView,
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
    resetFastMoon,
    initialized,
    selectedDiffPath,
    fileDiffLines,
    fileDiffLoading,
  } = deps;

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
  // Sessions fetched per workspace on first load — keeps the initial request
  // count at (number of workspaces) and each response small.
  const SESSIONS_INITIAL_PAGE_SIZE = 5;
  // Sessions fetched per "load more" click within a workspace.
  const SESSIONS_LOAD_MORE_SIZE = 30;

  /** Drain every page of sessions, newest first. A single global walk (instead of
   *  per-workspace) so sessions whose cwd is not a registered workspace root are
   *  still reachable after a refresh. */
  async function listAllSessionsGlobal(): Promise<AppSession[]> {
    const api = getKimiWebApi();
    const items: AppSession[] = [];
    let beforeId: string | undefined;
    for (;;) {
      const page = await api.listSessions({ pageSize: SESSION_PAGE_SIZE, beforeId });
      items.push(...page.items);
      if (!page.hasMore || page.items.length === 0) break;
      beforeId = page.items[page.items.length - 1]!.id;
    }
    return items;
  }

  /** Fetch the first page of sessions for every known workspace concurrently.
   *  Returns the merged, recency-sorted list and seeds per-workspace hasMore. */
  async function loadInitialSessionsByWorkspace(): Promise<AppSession[]> {
    const api = getKimiWebApi();
    const workspaces = rawState.workspaces;
    if (workspaces.length === 0) {
      // /workspaces may be unavailable or empty on older / partially-failing
      // daemons while /sessions still works. Fall back to the legacy global
      // walk so history still shows and mergedWorkspaces can derive workspaces
      // from session cwds, instead of rendering a blank sidebar.
      const fallback = await listAllSessionsGlobal().catch(() => [] as AppSession[]);
      rawState.sessionsHasMoreByWorkspace = {};
      rawState.sessionsCursorByWorkspace = {};
      rawState.sessionsFullyLoaded = true;
      return fallback;
    }
    const pages = await Promise.all(
      workspaces.map((w) =>
        api
          .listSessions({ workspaceId: w.id, pageSize: SESSIONS_INITIAL_PAGE_SIZE })
          .then((page) => ({ workspaceId: w.id, page }))
          .catch(() => ({
            workspaceId: w.id,
            page: { items: [] as AppSession[], hasMore: false },
          })),
      ),
    );
    const loaded: AppSession[] = [];
    const hasMore: Record<string, boolean> = {};
    const cursors: Record<string, string | undefined> = {};
    for (const { workspaceId, page } of pages) {
      loaded.push(...page.items);
      // Trust the server's hasMore — the per-workspace session_count is only a
      // (possibly stale) label total, not an authority on whether more pages exist.
      hasMore[workspaceId] = page.hasMore;
      // Cursor = oldest session of this page (pages are newest-first). Tracked
      // separately from the loaded set so a deep-linked older session appended
      // out of band cannot shift the cursor and skip intervening sessions.
      cursors[workspaceId] =
        page.items.length > 0 ? page.items[page.items.length - 1]!.id : undefined;
    }
    rawState.sessionsHasMoreByWorkspace = hasMore;
    rawState.sessionsCursorByWorkspace = cursors;
    rawState.sessionsFullyLoaded = false;
    // Keep rawState.sessions newest-first for readers that pick sessions[0]
    // (e.g. auto-selecting the most recent session on first load).
    loaded.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
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
    const sessions = await listAllSessionsGlobal().catch(() => null);
    if (sessions === null) return;
    setSessions(sessions);
    rawState.sessionsFullyLoaded = true;
    const cleared: Record<string, boolean> = {};
    for (const w of rawState.workspaces) cleared[w.id] = false;
    rawState.sessionsHasMoreByWorkspace = cleared;
  }

  async function load(): Promise<void> {
    rawState.loading = true;
    try {
      const api = getKimiWebApi();
      // Parallel: health + meta + models
      await Promise.all([
        api.getHealth().catch(() => null),
        api.getMeta().then((m) => {
          rawState.serverVersion = m.serverVersion;
          rawState.availableOpenInApps = m.openInApps;
        }).catch(() => null),
        modelProvider.loadModels(),
      ]);

      // Check auth readiness and global config (separate calls — defensive)
      await checkAuth();
      await loadConfig();

      // Load workspaces first (registered + derived, each with a session_count),
      // then fetch only the first page of sessions per workspace. This replaces
      // the old full global walk: the sidebar now truncates by loading, not by
      // hiding already-fetched rows.
      await loadWorkspaces();
      const sessions = await loadInitialSessionsByWorkspace();
      setSessions(sessions);

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
      pushOperationFailure('load', err);
      // Do not re-throw — app stays mounted with empty sessions
    } finally {
      rawState.loading = false;
      initialized.value = true;
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
    // Re-adding a path the user previously removed should bring it back.
    if (rawState.hiddenWorkspaceRoots.includes(workspace.root)) {
      rawState.hiddenWorkspaceRoots = rawState.hiddenWorkspaceRoots.filter((r) => r !== workspace.root);
      saveHiddenWorkspacesToStorage(rawState.hiddenWorkspaceRoots);
    }
    const index = rawState.workspaces.findIndex(
      (w) => w.id === workspace.id || w.root === workspace.root,
    );
    if (index === -1) {
      rawState.workspaces = [workspace, ...rawState.workspaces];
      return;
    }
    const next = [...rawState.workspaces];
    next[index] = workspace;
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
   * Create a session in a workspace — the one-click path (no cwd typing).
   * Register/touch the workspace first when the daemon supports it; if that
   * fails, fall back to the legacy cwd-only create path.
   */
  async function createSessionInWorkspace(workspaceId: string): Promise<AppSession | undefined> {
    const ws = mergedWorkspaces.value.find((w) => w.id === workspaceId);
    if (!ws) return undefined;
    try {
      const api = getKimiWebApi();
      let workspaceIdForCreate: string | undefined;
      let cwdForCreate = ws.root;
      try {
        const registered = await api.addWorkspace({ root: ws.root });
        workspaceIdForCreate = registered.id;
        cwdForCreate = registered.root;
        upsertWorkspacePreserveOrder(registered);
      } catch {
        // Older daemons may not have /workspaces. In that mode, sending a local
        // path-like workspace id as workspace_id would fail validation, so use
        // metadata.cwd only.
      }
      const session = await api.createSession({ workspaceId: workspaceIdForCreate, cwd: cwdForCreate });
      upsertSessionFront(session);
      selectWorkspace(session.workspaceId ?? workspaceIdForCreate ?? workspaceId);
      // Locally created sessions start empty; trust that so the empty-composer
      // renders immediately instead of flashing a loading state.
      sessionsKnownEmpty.add(session.id);
      await selectSession(session.id);
      return session;
    } catch (err) {
      pushOperationFailure('createSessionInWorkspace', err);
      return undefined;
    }
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
    const ws = mergedWorkspaces.value.find((w) => w.id === workspaceId);
    if (!ws) return;
    try {
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
      // session" (createSession), here we immediately send a prompt: keeping
      // sessionLoading=true through the snapshot avoids flashing the empty-session
      // composer before the optimistic user message lands. selectSession resolves,
      // then submitPromptInternal adds the user turn synchronously (no await in
      // between), so the view goes loading → message with no empty-composer frame.
      await selectSession(session.id);
      await submitPromptInternal(session.id, text, attachments);
    } catch (err) {
      pushOperationFailure('startSessionAndSendPrompt', err);
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
      upsertWorkspacePreserveOrder(ws);
      openWorkspaceDraft(ws.id);
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
      openWorkspaceDraft(trimmed);
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
        // Re-open: resume from the tracked cursor; the daemon replays any
        // missed durable events (or answers resync_required → snapshot).
        subscribeToSessionEvents(sessionId);
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

  async function createSession(cwd: string, opts?: { title?: string; model?: string }): Promise<void> {
    try {
      const api = getKimiWebApi();
      const session = await api.createSession({ cwd, title: opts?.title, model: opts?.model });
      upsertSessionFront(session);
      // Locally created sessions start empty; trust that so the empty-composer
      // renders immediately instead of flashing a loading state.
      sessionsKnownEmpty.add(session.id);
      await selectSession(session.id);
    } catch (err) {
      pushOperationFailure('createSession', err);
    }
  }

  /** Internal: submit a prompt to a specific session, bypassing the queue check.
      Returns true when the daemon accepted the prompt. */
  async function submitPromptInternal(sid: string, text: string, attachments?: PromptAttachment[]): Promise<boolean> {
    // Mark this session as having a prompt in flight BEFORE any await, so a racing
    // sendPrompt sees it and enqueues. Cleared when activity returns to idle.
    inFlightPromptSessions.add(sid);
    rawState.sendingBySession = { ...rawState.sendingBySession, [sid]: true };
    const tempId = nextOptimisticMsgId();
    try {
      const api = getKimiWebApi();
      const content: import('../../api/types').AppMessageContent[] = [];
      if (text) content.push({ type: 'text', text });
      for (const att of attachments ?? []) {
        if (att.kind === 'video') content.push({ type: 'video', source: { kind: 'file', fileId: att.fileId } });
        else content.push({ type: 'image', source: { kind: 'file', fileId: att.fileId } });
      }
      if (content.length === 0) {
        inFlightPromptSessions.delete(sid);
        rawState.sendingBySession = { ...rawState.sendingBySession, [sid]: false };
        return false;
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

      if (rawState.goalMode && text) {
        try {
          await api.updateSession(sid, { goalObjective: text.trim() });
        } catch (err) {
          pushOperationFailure('createGoal', err, { sessionId: sid });
          inFlightPromptSessions.delete(sid);
          rawState.sendingBySession = { ...rawState.sendingBySession, [sid]: false };
          updateSessionMessages(sid, (msgs) =>
            msgs.some((m) => m.id === tempId) ? msgs.filter((m) => m.id !== tempId) : msgs,
          );
          return false;
        }
      }

      const result = await api.submitPrompt(sid, {
        content,
        model,
        thinking: rawState.thinking,
        permissionMode: rawState.permission,
        planMode: rawState.planMode,
        swarmMode: rawState.swarmMode,
      });

      if (rawState.goalMode) {
        rawState.goalMode = false;
        saveGoalModeToStorage(false);
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
      // turn.started uses it (instead of synthesizing a random one). This is what
      // makes Stop work on the real daemon: session.currentPromptId then matches
      // the prompt_id the REST :abort endpoint expects.
      getEventConn()?.bindNextPromptId(sid, result.promptId);

      // NOTE: we no longer set a local auto-title here. The daemon generates a
      // smarter title from the first prompt and announces it via
      // session.meta.updated (projected to sessionMetaUpdated). PATCHing a title
      // locally would mark the session isCustomTitle=true and SUPPRESS the
      // daemon's auto-title, so we let the daemon own it.
      return true;
    } catch (err) {
      // Submit failed — clear the in-flight flag so the next prompt isn't stuck
      // queued forever (turn.ended will never arrive), and roll back the
      // optimistic user message so the transcript doesn't show a delivered-
      // looking message the daemon never received.
      inFlightPromptSessions.delete(sid);
      rawState.sendingBySession = { ...rawState.sendingBySession, [sid]: false };
      updateSessionMessages(sid, (msgs) =>
        msgs.some((m) => m.id === tempId) ? msgs.filter((m) => m.id !== tempId) : msgs,
      );
      pushOperationFailure('sendPrompt', err, { sessionId: sid });
      return false;
    }
  }

  async function sendPrompt(text: string, attachments?: PromptAttachment[]): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;

    // If the session is not idle OR a prompt is already in flight (submitted but
    // the WS turn.started hasn't flipped activity to 'running' yet), enqueue
    // instead of submitting directly. Gating on inFlightPromptSessions closes the
    // window where two rapid prompts would both submit and race.
    if (activity.value !== 'idle' || inFlightPromptSessions.has(sid)) {
      enqueue(text, attachments);
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

    // Idle and nothing in flight — there is no turn to steer into; normal send.
    if (activity.value === 'idle' && !inFlightPromptSessions.has(sid)) {
      await submitPromptInternal(sid, merged, mergedAttachments);
      return;
    }

    // Optimistic transcript echo (the daemon emits no user-message WS event).
    const content: import('../../api/types').AppMessageContent[] = [];
    if (merged) content.push({ type: 'text', text: merged });
    for (const att of mergedAttachments) {
      if (att.kind === 'video') content.push({ type: 'video', source: { kind: 'file', fileId: att.fileId } });
      else content.push({ type: 'image', source: { kind: 'file', fileId: att.fileId } });
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
        thinking: rawState.thinking,
        permissionMode: rawState.permission,
        planMode: rawState.planMode,
        swarmMode: rawState.swarmMode,
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
      pushOperationFailure('steer', err, { sessionId: sid });
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
    rawState.queuedBySession = {
      ...rawState.queuedBySession,
      [sid]: [...current, { text, attachments }],
    };
  }

  async function abortCurrentPrompt(): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    const session = rawState.sessions.find((s) => s.id === sid);

    // 1. Authoritative id captured at submit time.
    let promptId = rawState.promptIdBySession[sid];

    // 2. Fallback to projector-derived id only when it is a real daemon prompt_id
    //    (synthetic `pr_...` ids are rejected by the daemon).
    if (promptId === undefined) {
      const candidate = session?.currentPromptId;
      if (candidate?.startsWith('prompt_')) {
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

  async function respondApproval(
    approvalId: string,
    response: { decision: ApprovalDecision; scope?: 'session'; feedback?: string; selectedLabel?: string },
  ): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
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
      const list = rawState.approvalsBySession[sid] ?? [];
      rawState.approvalsBySession = {
        ...rawState.approvalsBySession,
        [sid]: list.filter((a) => a.approvalId !== approvalId),
      };
    } catch (err) {
      pushOperationFailure('respondApproval', err, { sessionId: sid });
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
      pushOperationFailure('respondQuestion', err, { sessionId: sid });
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
      pushOperationFailure('dismissQuestion', err, { sessionId: sid });
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
      pushOperationFailure('cancelTask', err, { sessionId: sid });
    }
  }

  /** Persist and apply plan mode (pushed to the session profile + sent per-prompt). */
  function setPlanMode(on: boolean): void {
    rawState.planMode = on;
    savePlanModeToStorage(on);
    persistSessionProfile({ planMode: on });
  }

  /** Flip plan mode on/off. */
  function togglePlanMode(): void {
    setPlanMode(!rawState.planMode);
  }

  /** Persist and apply swarm mode (pushed to the session profile + sent per-prompt). */
  function setSwarmMode(on: boolean): void {
    rawState.swarmMode = on;
    saveSwarmModeToStorage(on);
    persistSessionProfile({ swarmMode: on });
  }

  /** Flip swarm mode on/off. In manual permission mode, ask before enabling. */
  function toggleSwarmMode(): void {
    const on = !rawState.swarmMode;
    if (on && rawState.permission === 'manual') {
      const ok = confirm('Enable swarm mode? The agent will run multiple sub agents in parallel.');
      if (!ok) return;
    }
    setSwarmMode(on);
  }

  /** Persist goal mode locally. Unlike plan/swarm, this is a one-shot flag consumed on send. */
  function setGoalMode(on: boolean): void {
    rawState.goalMode = on;
    saveGoalModeToStorage(on);
  }

  /** Flip goal mode on/off. */
  function toggleGoalMode(): void {
    setGoalMode(!rawState.goalMode);
  }

  /** Create a goal by sending its objective to the session profile, then submit it as a prompt. */
  async function createGoal(objective: string): Promise<void> {
    const trimmed = objective.trim();
    if (!trimmed) return;
    if (rawState.permission === 'manual') {
      const ok = confirm(`Start goal: "${trimmed}"? The agent will run autonomously toward this objective.`);
      if (!ok) return;
    }
    const sid = rawState.activeSessionId;
    if (!sid) return;
    try {
      await getKimiWebApi().updateSession(sid, { goalObjective: trimmed });
    } catch (err) {
      pushOperationFailure('createGoal', err, { sessionId: sid, message: goalErrorMessage(err) });
      return;
    }
    await sendPrompt(trimmed);
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
    persistSessionProfile({ permissionMode: mode });
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

  /** Rename a workspace — local-only until the daemon ships a workspace update API. */
  function renameWorkspace(id: string, name: string): void {
    rawState.workspaces = rawState.workspaces.map((w) =>
      w.id === id ? { ...w, name } : w,
    );
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
    } catch {
      // registry delete is optional — the sidebar hide is what the user sees.
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
    loadWorkspaces,
    loadMoreSessions,
    loadAllSessions,
    selectWorkspace,
    openWorkspace,
    upsertWorkspacePreserveOrder,
    applyWorkspaceEvent,
    clearActiveSession,
    openWorkspaceDraft,
    createSessionInWorkspace,
    startSessionAndSendPrompt,
    addWorkspaceByPath,
    browseFs,
    getFsHome,
    writeSessionUrl,
    fetchSessionIntoList,
    onSessionRoutePopState,
    bindSessionRoute,
    selectSession,
    createSession,
    submitPromptInternal,
    sendPrompt,
    steerPrompt,
    uploadImage,
    enqueue,
    unqueue,
    abortCurrentPrompt,
    respondApproval,
    respondQuestion,
    dismissQuestion,
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
  };
}

export type UseWorkspaceState = ReturnType<typeof useWorkspaceState>;
