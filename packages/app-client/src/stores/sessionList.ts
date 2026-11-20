import { reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import {
  isPageTokenMismatchError,
  isPlaceholderSessionUsage,
} from '@moonshot-ai/app-core/api';
import type {
  AppSession,
  AppWarning,
  ReadRequestOptions,
  SessionGroup,
  SessionGroupsPage,
  SessionsPage,
} from '@moonshot-ai/app-core/api';
import { logWarn } from '@moonshot-ai/app-core/lib';
import { getKimiWebApi, t } from '../client/deps';
import { clientPinia } from './pinia';
import { configStore } from './config';
import { hostsStore } from './hosts';
import { sessionsStore } from './sessions';
import { sessionRatingStore } from './sessionRating';
import { connectionStore } from './connection';
import { permissionsStore } from './permissions';
import { sessionViewsStore } from './sessionViews';
import {
  SESSIONS_INITIAL_PAGE_SIZE,
  workspacesStore,
  type SessionGroupsMapping,
} from './workspaces';

export const SESSIONS_EXPAND_BATCH = 5;
export const FLAT_SESSIONS_PAGE_SIZE = 50;
const FLAT_LOAD_MORE_MAX_PAGES = 5;

export interface SessionListHooks {
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
  onSessionsArchivedLocally?: (ids: string[]) => Promise<void>;
  onSessionDeletedLocally?: (id: string) => Promise<void>;
  notify?: (warning: AppWarning) => void;
}

let sessionListHooks: SessionListHooks | null = null;

export function setSessionListHooks(next: SessionListHooks | null): void {
  sessionListHooks = next;
}

export interface InitialSessionsLoad {
  sessions: AppSession[];
  finishInBackground?: (options?: ReadRequestOptions) => Promise<void>;
}

export interface FiredSessionGroupPage {
  firstPage: Promise<{ page: SessionGroupsPage | undefined; error?: unknown }>;
  input: { groupPageSize: number; hasPrompt: true };
  serial: number;
  signal: AbortSignal;
}

function withFallbackSessionTitle(s: AppSession): AppSession {
  if (s.title !== '') return s;
  return { ...s, title: s.lastPrompt ?? s.id.slice(0, 12) };
}

const ARCHIVE_TOMBSTONE_CAP = 500;
const TITLE_GEN_MAX_ATTEMPTS = 3;

export const useSessionListStore = defineStore('kimi.sessionList', () => {
  const sessionsFullyLoaded = ref(false);
  const flatSessionsNextPageToken = ref<string | null>(null);
  const flatSessionsHasMore = ref(true);
  const flatSessionsLoading = ref(false);
  const flatSessionsLoadingMore = ref(false);
  const flatSessionsSeeded = ref(false);
  const doneSessions = ref<AppSession[]>([]);
  const doneSessionsNextPageToken = ref<string | null>(null);
  const doneSessionsHasMore = ref(true);
  const doneSessionsLoading = ref(false);
  const doneSessionsLoadingMore = ref(false);
  const doneSessionsSeeded = ref(false);

  watch(
    [() => workspacesStore().workspaces, () => sessionsStore().sessions, doneSessions],
    ([projects, active, archived]) => {
      if (projects.length === 0) return;
      const workspaces = workspacesStore();
      workspaces.identifySessionWorkspaces(active);
      workspaces.identifySessionWorkspaces(archived);
    },
  );

  const archivedTombstoneIds = new Set<string>();
  const archiveSerialById = new Map<string, number>();
  let archiveSerial = 0;
  function hasArchiveTombstone(id: string): boolean {
    return archivedTombstoneIds.has(id);
  }
  function addArchiveTombstone(id: string): void {
    archiveSerialById.delete(id);
    archiveSerialById.set(id, ++archiveSerial);
    if (archiveSerialById.size > ARCHIVE_TOMBSTONE_CAP) {
      const oldest = archiveSerialById.keys().next().value;
      if (oldest !== undefined) archiveSerialById.delete(oldest);
    }
    hydrationControllers.get(id)?.abort();
    hydrationControllers.delete(id);
    if (archivedTombstoneIds.has(id)) return;
    if (archivedTombstoneIds.size >= ARCHIVE_TOMBSTONE_CAP) {
      const oldest = archivedTombstoneIds.values().next().value;
      if (oldest !== undefined) archivedTombstoneIds.delete(oldest);
    }
    archivedTombstoneIds.add(id);
  }
  function clearArchiveTombstone(id: string): void {
    archivedTombstoneIds.delete(id);
  }

  const deletedTombstoneIds = reactive(new Set<string>());
  function hasDeletedTombstone(id: string): boolean {
    return deletedTombstoneIds.has(id);
  }
  function addDeletedTombstone(id: string): void {
    hydrationControllers.get(id)?.abort();
    hydrationControllers.delete(id);
    if (deletedTombstoneIds.has(id)) return;
    if (deletedTombstoneIds.size >= ARCHIVE_TOMBSTONE_CAP) {
      const oldest = deletedTombstoneIds.values().next().value;
      if (oldest !== undefined) deletedTombstoneIds.delete(oldest);
    }
    deletedTombstoneIds.add(id);
  }

  const restoredRecentlyIds = new Set<string>();
  function hasRestoredRecently(id: string): boolean {
    return restoredRecentlyIds.has(id);
  }
  function addRestoredRecently(id: string): void {
    if (restoredRecentlyIds.has(id)) return;
    if (restoredRecentlyIds.size >= ARCHIVE_TOMBSTONE_CAP) {
      const oldest = restoredRecentlyIds.values().next().value;
      if (oldest !== undefined) restoredRecentlyIds.delete(oldest);
    }
    restoredRecentlyIds.add(id);
  }

  const restoredAtBySession = new Map<string, number>();
  function restoredAt(sessionId: string): number | undefined {
    return restoredAtBySession.get(sessionId);
  }
  function markRestoredRecently(sessionId: string): void {
    if (restoredAtBySession.has(sessionId)) restoredAtBySession.delete(sessionId);
    if (restoredAtBySession.size >= ARCHIVE_TOMBSTONE_CAP) {
      const oldest = restoredAtBySession.keys().next().value;
      if (oldest !== undefined) restoredAtBySession.delete(oldest);
    }
    restoredAtBySession.set(sessionId, Date.now());
  }
  function clearRestoredRecently(id: string): void {
    restoredRecentlyIds.delete(id);
    restoredAtBySession.delete(id);
  }

  function tombstonesEmpty(): boolean {
    return archivedTombstoneIds.size === 0 && deletedTombstoneIds.size === 0;
  }

  const poolInsertsDuringLoad = new Set<string>();
  let groupedDrainSerial = 0;
  const pendingLiveHydrateIds: string[] = [];
  const archiveInFlightIds = new Set<string>();
  const archiveConfirmedIds = new Set<string>();
  const titleGenBySession = new Map<string, { attempts: number; done: boolean }>();
  let backgroundController = new AbortController();
  let groupedController: AbortController | undefined;
  const hydrationControllers = new Map<string, AbortController>();

  function backgroundReadOptions(options?: ReadRequestOptions): ReadRequestOptions & { signal: AbortSignal } {
    return {
      ...options,
      background: true,
      signal: options?.signal === undefined
        ? backgroundController.signal
        : AbortSignal.any([backgroundController.signal, options.signal]),
    };
  }

  function cancelBackgroundReads(): void {
    backgroundController.abort();
    backgroundController = new AbortController();
    groupedController?.abort();
    groupedController = undefined;
    groupedDrainSerial += 1;
    for (const controller of hydrationControllers.values()) controller.abort();
    hydrationControllers.clear();
    pendingLiveHydrateIds.length = 0;
    flatSessionsLoading.value = false;
    flatSessionsLoadingMore.value = false;
    doneSessionsLoading.value = false;
    doneSessionsLoadingMore.value = false;
  }

  async function applySessionsArchivedLocally(ids: string[], archived: boolean): Promise<void> {
    const idSet = new Set(ids);
    if (archived) {
      for (const id of ids) sessionRatingStore().endSession(id);
      for (const id of ids) addArchiveTombstone(id);
      const archivedAt = new Date().toISOString();
      const rows = sessionsStore().sessions.filter((s) => idSet.has(s.id));
      if (rows.length > 0) {
        doneSessions.value = [
          ...rows.map((s): AppSession => ({ ...s, archived: true, archivedAt })),
          ...doneSessions.value.filter((s) => !idSet.has(s.id)),
        ];
      }
      for (const id of ids) titleGenBySession.delete(id);
      await sessionListHooks?.onSessionsArchivedLocally?.(ids);
      return;
    }
    for (const id of ids) {
      clearArchiveTombstone(id);
      addRestoredRecently(id);
      markRestoredRecently(id);
    }
    const copies = doneSessions.value.filter((s) => idSet.has(s.id));
    doneSessions.value = doneSessions.value.filter((s) => !idSet.has(s.id));
    for (const copy of copies) {
      if (!sessionsStore().sessions.some((s) => s.id === copy.id)) {
        poolInsertsDuringLoad.add(copy.id);
        sessionsStore().upsertSessionSorted({ ...copy, archived: false });
      }
    }
  }

  async function archiveSession(id: string): Promise<void> {
    sessionRatingStore().endSession(id);
    try {
      const api = getKimiWebApi();
      archiveConfirmedIds.delete(id);
      archiveInFlightIds.add(id);
      const archived = sessionsStore().sessions.find((s) => s.id === id);
      const workspaceId =
        archived !== undefined ? workspacesStore().workspaceIdForSession(archived) : undefined;
      const backfillTarget =
        workspaceId !== undefined ? loadedInWorkspace(workspaceId).length : 0;
      await api.archiveSession(id);
      await applySessionsArchivedLocally([id], true);
      if (archived !== undefined && workspaceId !== undefined) {
        void backfillWorkspaceSessions(workspaceId, id, archived.updatedAt, backfillTarget);
      }
      archiveInFlightIds.delete(id);
      archiveConfirmedIds.delete(id);
    } catch (err) {
      archiveInFlightIds.delete(id);
      if (!archiveConfirmedIds.delete(id)) {
        sessionListHooks?.pushOperationFailure('archiveSession', err, { sessionId: id });
      }
    }
  }

  function noteSessionDeleted(sessionId: string): void {
    addDeletedTombstone(sessionId);
  }

  async function applySessionDeletedLocally(id: string): Promise<void> {
    sessionRatingStore().endSession(id);
    const removed = sessionsStore().sessions.find((s) => s.id === id);
    const workspaceId =
      removed !== undefined ? workspacesStore().workspaceIdForSession(removed) : undefined;
    const backfillTarget = workspaceId !== undefined ? loadedInWorkspace(workspaceId).length : 0;
    addDeletedTombstone(id);
    titleGenBySession.delete(id);
    sessionsStore().removeSession(id);
    doneSessions.value = doneSessions.value.filter((s) => s.id !== id);
    await sessionListHooks?.onSessionDeletedLocally?.(id);
    if (removed !== undefined && workspaceId !== undefined) {
      void backfillWorkspaceSessions(workspaceId, id, removed.updatedAt, backfillTarget);
    }
  }

  async function deleteSession(id: string): Promise<boolean> {
    sessionRatingStore().endSession(id);
    try {
      const api = getKimiWebApi();
      await api.deleteSession(id);
      await applySessionDeletedLocally(id);
      return true;
    } catch (err) {
      if (deletedTombstoneIds.has(id)) {
        await applySessionDeletedLocally(id);
        return true;
      }
      sessionListHooks?.pushOperationFailure('deleteSession', err, { sessionId: id });
      return false;
    }
  }

  async function applyRemoteSessionArchived(
    sessionId: string,
    workspaceId?: string,
  ): Promise<boolean> {
    if (restoredAtBySession.has(sessionId)) {
      const options = backgroundReadOptions();
      let archivedOnServer: boolean;
      try {
        archivedOnServer = (await getKimiWebApi().getSession(sessionId, options)).archived;
      } catch {
        return false;
      }
      if (options.signal.aborted || !archivedOnServer) return false;
    }
    if (archiveInFlightIds.delete(sessionId)) archiveConfirmedIds.add(sessionId);
    clearRestoredRecently(sessionId);
    addArchiveTombstone(sessionId);
    const archived = sessionsStore().sessions.find((s) => s.id === sessionId);
    if (archived === undefined && sessionsStore().activeSessionId !== sessionId) return true;
    const wsId = archived === undefined ? workspaceId : workspacesStore().workspaceIdForSession({
      ...archived, workspaceId: workspaceId ?? archived.workspaceId,
    });
    const backfillTarget = wsId !== undefined ? loadedInWorkspace(wsId).length : 0;
    await applySessionsArchivedLocally([sessionId], true);
    if (archived !== undefined && wsId !== undefined) {
      void backfillWorkspaceSessions(wsId, sessionId, archived.updatedAt, backfillTarget);
    }
    return true;
  }

  async function applyRemoteSessionRestored(sessionId: string): Promise<void> {
    if (deletedTombstoneIds.has(sessionId)) return;
    if (!archivedTombstoneIds.has(sessionId) && sessionsStore().sessions.some((s) => s.id === sessionId)) return;
    const serial = archiveSerialById.get(sessionId);
    const options = backgroundReadOptions();
    let restored: AppSession;
    try {
      restored = await getKimiWebApi().getSession(sessionId, options);
    } catch {
      if (!options.signal.aborted && archiveSerialById.get(sessionId) === serial) {
        await applySessionsArchivedLocally([sessionId], false);
      }
      return;
    }
    if (options.signal.aborted || archiveSerialById.get(sessionId) !== serial) return;
    if (restored.archived || deletedTombstoneIds.has(sessionId)) return;
    poolInsertsDuringLoad.add(restored.id);
    sessionsStore().upsertSessionSorted(restored);
    await applySessionsArchivedLocally([sessionId], false);
  }

  async function restoreSession(id: string): Promise<boolean> {
    try {
      const restored = await getKimiWebApi().restoreSession(id);
      if (deletedTombstoneIds.has(id)) return false;
      poolInsertsDuringLoad.add(restored.id);
      sessionsStore().upsertSessionSorted(restored);
      await applySessionsArchivedLocally([id], false);
      return true;
    } catch (err) {
      sessionListHooks?.pushOperationFailure('restoreSession', err, { sessionId: id });
      return false;
    }
  }

  async function loadArchivedSessions(): Promise<AppSession[]> {
    return (await getKimiWebApi().listSessions({ archived: true })).items;
  }

  function maybeGenerateSessionTitle(sid: string): void {
    const config = configStore().config;
    if (config === null || config.autoSessionTitle === false) return;
    const state = titleGenBySession.get(sid);
    if (state !== undefined && (state.done || state.attempts >= TITLE_GEN_MAX_ATTEMPTS)) return;
    titleGenBySession.set(sid, { attempts: (state?.attempts ?? 0) + 1, done: false });
    try {
      void getKimiWebApi()
        .generateSessionTitle(sid, { source: 'first_turn' })
        .then((title) => {
          if (title !== null) titleGenBySession.set(sid, { attempts: 0, done: true });
        })
        .catch(() => {});
    } catch {
      void 0;
    }
  }

  async function renameSession(id: string, title: string): Promise<void> {
    try {
      const api = getKimiWebApi();
      await api.updateSession(id, { title });
      sessionsStore().updateSession(id, (s) => ({ ...s, title }));
      if (doneSessions.value.some((s) => s.id === id)) {
        doneSessions.value = doneSessions.value.map((s) =>
          s.id === id ? { ...s, title } : s,
        );
      }
    } catch (err) {
      sessionListHooks?.pushOperationFailure('renameSession', err, { sessionId: id });
    }
  }

  async function regenerateSessionTitle(id: string): Promise<string | null> {
    const title = await getKimiWebApi().generateSessionTitle(id, {
      force: true,
      source: 'digest',
    });
    if (title === null) {
      sessionListHooks?.notify?.({ severity: 'info', title: t('sidebar.genTitleUnavailable') });
    } else if (doneSessions.value.some((s) => s.id === id)) {
      doneSessions.value = doneSessions.value.map((s) =>
        s.id === id ? { ...s, title } : s,
      );
    }
    return title;
  }

  async function listAllSessionsGlobal(): Promise<{ sessions: AppSession[]; complete: boolean }> {
    const page = await getKimiWebApi().listSessions({ hasPrompt: true });
    return {
      sessions: page.items.map(withFallbackSessionTitle),
      complete: (page.unavailableHosts?.length ?? 0) === 0,
    };
  }

  function setSessionsPreservingLiveUsage(sessions: AppSession[]): void {
    const filtered =
      archivedTombstoneIds.size === 0 && deletedTombstoneIds.size === 0
        ? sessions
        : sessions.filter(
            (s) => !archivedTombstoneIds.has(s.id) && !deletedTombstoneIds.has(s.id),
          );
    const filteredIds = new Set(filtered.map((s) => s.id));
    const concurrent = sessionsStore().sessions.filter(
      (s) =>
        poolInsertsDuringLoad.has(s.id) &&
        !filteredIds.has(s.id) &&
        !archivedTombstoneIds.has(s.id) &&
        !deletedTombstoneIds.has(s.id),
    );
    const merged =
      concurrent.length === 0
        ? filtered
        : [...filtered, ...concurrent].sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
          );
    const liveById = new Map(sessionsStore().sessions.map((s) => [s.id, s] as const));
    sessionsStore().setSessions(
      merged.map((s) => {
        const live = liveById.get(s.id);
        if (live === undefined) return s;
        if (connectionStore().sessionEventCount(s.id) > 0) return live;
        const keepUsage =
          isPlaceholderSessionUsage(s.usage) && !isPlaceholderSessionUsage(live.usage);
        const pullRequest = s.pullRequest ?? live.pullRequest;
        const model = (s.model ?? '') === '' ? live.model : s.model;
        if (!keepUsage && pullRequest === s.pullRequest && model === s.model) return s;
        return { ...s, usage: keepUsage ? live.usage : s.usage, pullRequest, model };
      }),
    );
  }

  function mergePartialSessionsWithCached(sessions: AppSession[]): AppSession[] {
    const merged = [...sessions];
    const loadedIds = new Set(merged.map((session) => session.id));
    for (const session of sessionsStore().sessions) {
      if (loadedIds.has(session.id)) continue;
      merged.push(session);
      loadedIds.add(session.id);
    }
    merged.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return merged;
  }

  function mapSessionGroups(
    groups: readonly SessionGroup[],
    complete: boolean,
  ): SessionGroupsMapping {
    const groupById = new Map(groups.map((group) => [group.workspaceId, group] as const));
    const loaded: AppSession[] = [];
    const loadedIds = new Set<string>();
    const hasMore: Record<string, boolean> = {};
    const cursors: Record<string, string | undefined> = {};
    const counts: Record<string, number> = {};
    for (const workspace of workspacesStore().workspaces) {
      const group = groupById.get(workspace.id);
      if (group === undefined) {
        hasMore[workspace.id] = !complete;
        cursors[workspace.id] = undefined;
        counts[workspace.id] = SESSIONS_INITIAL_PAGE_SIZE;
        continue;
      }
      const items = group.sessions
        .filter(
          (s) =>
            !archivedTombstoneIds.has(s.id) &&
            !deletedTombstoneIds.has(s.id) &&
            (s.lastPrompt ?? '').length > 0,
        )
        .map((s) => withFallbackSessionTitle(workspacesStore().projectSessionWorkspace(
          s.cwd ? s : { ...s, cwd: workspace.root }, group.workspaceId,
        )));
      for (const session of items) {
        if (loadedIds.has(session.id)) continue;
        loaded.push(session);
        loadedIds.add(session.id);
      }
      hasMore[workspace.id] = group.sessions.length < group.total;
      cursors[workspace.id] = items.length > 0 ? items[items.length - 1]!.id : undefined;
      counts[workspace.id] = Math.max(items.length, SESSIONS_INITIAL_PAGE_SIZE);
    }
    const liveIds: string[] = [];
    for (const group of groups) {
      for (const item of group.sessions) {
        if (
          item.busy ||
          item.pendingInteraction === 'approval' ||
          item.pendingInteraction === 'question'
        ) {
          liveIds.push(item.id);
        }
      }
    }
    loaded.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return { loaded, hasMore, cursors, counts, liveIds };
  }

  function fireFirstSessionGroupPage(options?: ReadRequestOptions, onError?: (error: unknown) => void): FiredSessionGroupPage {
    cancelBackgroundReads();
    const controller = new AbortController();
    groupedController = controller;
    const signal = options?.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.signal]);
    const input = { groupPageSize: SESSIONS_INITIAL_PAGE_SIZE, hasPrompt: true } as const;
    const serial = ++groupedDrainSerial;
    const firstPage = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return getKimiWebApi().listSessionGroups(input, { ...options, signal });
      })
      .then(
        (page): { page: SessionGroupsPage | undefined; error?: unknown } => ({ page }),
        (error: unknown): { page: SessionGroupsPage | undefined; error?: unknown } => {
          onError?.(error);
          return {
            page: undefined,
            error,
          };
        },
      );
    return { firstPage, input, serial, signal };
  }

  async function drainRemainingSessionGroups(
    firstPage: SessionGroupsPage,
    input: { groupPageSize: number; hasPrompt: true },
    serial: number,
    firstPageMapping: SessionGroupsMapping,
    options: ReadRequestOptions & { signal: AbortSignal },
  ): Promise<void> {
    const current = () => serial === groupedDrainSerial && !options.signal.aborted;
    const api = getKimiWebApi();
    const groups = [...firstPage.groups];
    let pageToken = firstPage.nextPageToken;
    while (pageToken !== null) {
      if (!current()) return;
      let next: SessionGroupsPage;
      try {
        next = await api.listSessionGroups({ ...input, pageToken }, options);
      } catch (error) {
        if (current()) sessionListHooks?.pushOperationFailure('load', error);
        return;
      }
      if (!current()) return;
      groups.push(...next.groups);
      pageToken = next.nextPageToken;
    }
    if (!current()) return;
    const mapped = mapSessionGroups(groups, true);
    const firstPageIds = new Set(firstPageMapping.loaded.map((s) => s.id));
    const currentById = new Map(sessionsStore().sessions.map((s) => [s.id, s] as const));
    const loaded = mapped.loaded
      .map((s) => firstPageIds.has(s.id) ? currentById.get(s.id) ?? s : s)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    if (sessionsFullyLoaded.value) {
      const freshIds = new Set(loaded.map((s) => s.id));
      const merged = [
        ...loaded,
        ...sessionsStore().sessions.filter((s) => !freshIds.has(s.id)),
      ];
      merged.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      setSessionsPreservingLiveUsage(merged);
      workspacesStore().clearSessionsHasMore();
    } else {
      setSessionsPreservingLiveUsage(loaded);
      workspacesStore().commitSessionGroupPagination(mapped, firstPageMapping);
    }
    const initialIds = new Set(firstPageMapping.liveIds);
    await Promise.allSettled(mapped.liveIds
      .filter((id) => !initialIds.has(id))
      .map((id) => hydrateLiveSession(id, options)));
    if (!current()) return;
    const poolById = new Map(sessionsStore().sessions.map((s) => [s.id, s] as const));
    for (const s of mapped.loaded) {
      if (initialIds.has(s.id) || archivedTombstoneIds.has(s.id) || deletedTombstoneIds.has(s.id)) continue;
      const pooled = poolById.get(s.id);
      if (pooled === undefined) continue;
    }
  }

  async function hydrateLiveSession(sessionId: string, options?: ReadRequestOptions, onError?: (error: unknown) => void): Promise<void> {
    if (archivedTombstoneIds.has(sessionId) || deletedTombstoneIds.has(sessionId)) return;
    hydrationControllers.get(sessionId)?.abort();
    const controller = new AbortController();
    hydrationControllers.set(sessionId, controller);
    const signal = AbortSignal.any([
      controller.signal,
      backgroundController.signal,
      ...(options?.signal === undefined ? [] : [options.signal]),
    ]);
    const startEventCount = connectionStore().sessionEventCount(sessionId);
    const startedRestoredAt = restoredAt(sessionId);
    try {
      signal.throwIfAborted();
      const fresh = await getKimiWebApi().getSession(sessionId, {
        background: sessionId !== sessionsStore().activeSessionId,
        ...options,
        signal,
      });
      if (signal.aborted || hydrationControllers.get(sessionId) !== controller) return;
      if (archivedTombstoneIds.has(sessionId) || deletedTombstoneIds.has(sessionId)) return;
      if (restoredAt(sessionId) !== startedRestoredAt) return;
      if (connectionStore().sessionEventCount(sessionId) !== startEventCount) return;
      sessionsStore().updateSession(sessionId, (s) => ({
        ...s,
        busy: fresh.busy,
        mainTurnActive: fresh.mainTurnActive ?? s.mainTurnActive,
        pendingInteraction: fresh.pendingInteraction ?? s.pendingInteraction,
        lastTurnReason: fresh.lastTurnReason ?? s.lastTurnReason,
      }));
    } catch (error) {
      onError?.(error);
      return;
    } finally {
      if (hydrationControllers.get(sessionId) === controller) hydrationControllers.delete(sessionId);
    }
  }

  async function loadInitialSessionsByWorkspace(
    fired: FiredSessionGroupPage,
    onError?: (error: unknown) => void,
  ): Promise<InitialSessionsLoad | undefined> {
    const current = () => fired.serial === groupedDrainSerial && !fired.signal.aborted;
    if (!current()) return undefined;
    pendingLiveHydrateIds.length = 0;
    if (workspacesStore().workspaces.length === 0) {
      const fallback = await listAllSessionsGlobal();
      if (!current()) return undefined;
      const sessions = fallback.complete ? fallback.sessions : mergePartialSessionsWithCached(fallback.sessions);
      workspacesStore().resetSessionGroupPagination();
      sessionsFullyLoaded.value = fallback.complete;
      return { sessions };
    }
    const { page: firstPage, error } = await fired.firstPage;
    if (!current()) return undefined;
    if (firstPage === undefined) {
      onError?.(error);
      sessionListHooks?.pushOperationFailure('load', error);
      return undefined;
    }
    const complete = firstPage.nextPageToken === null;
    const mapped = mapSessionGroups(firstPage.groups, complete);
    workspacesStore().commitSessionGroupPagination(mapped);
    sessionsFullyLoaded.value = false;
    pendingLiveHydrateIds.push(...mapped.liveIds);
    const followupOptions = backgroundReadOptions({ signal: fired.signal });
    return {
      sessions: mapped.loaded,
      finishInBackground: complete
        ? undefined
        : (options) => drainRemainingSessionGroups(firstPage, fired.input, fired.serial, mapped, {
          ...followupOptions,
          signal: options?.signal === undefined
            ? followupOptions.signal
            : AbortSignal.any([followupOptions.signal, options.signal]),
        }),
    };
  }

  async function loadMoreSessions(workspaceId: string): Promise<void> {
    const wsStore = workspacesStore();
    if (wsStore.sessionsLoadingMoreByWorkspace[workspaceId]) return;
    if (wsStore.sessionsHasMoreByWorkspace[workspaceId] === false) return;
    wsStore.setSessionLoadingMore(workspaceId, true);
    try {
      let beforeId = wsStore.sessionsCursorByWorkspace[workspaceId];
      let page: { items: AppSession[]; hasMore: boolean } | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        page = await getKimiWebApi().listSessions({
          workspaceId,
          pageSize: SESSIONS_EXPAND_BATCH,
          beforeId,
          hasPrompt: true,
        });
        if (wsStore.sessionsCursorByWorkspace[workspaceId] === beforeId) break;
        page = undefined;
        beforeId = wsStore.sessionsCursorByWorkspace[workspaceId];
      }
      if (page === undefined) return;
      const existing = new Set(sessionsStore().sessions.map((s) => s.id));
      const fresh = page.items
        .map((s) => wsStore.projectSessionWorkspace(s, workspaceId))
        .filter(
          (s) =>
            !existing.has(s.id) &&
            !archivedTombstoneIds.has(s.id) &&
            !deletedTombstoneIds.has(s.id),
        )
        .map(withFallbackSessionTitle);
      for (const s of fresh) poolInsertsDuringLoad.add(s.id);
      if (fresh.length > 0) sessionsStore().setSessions([...sessionsStore().sessions, ...fresh]);
      const pageTail = page.items
        .filter((s) => !archivedTombstoneIds.has(s.id) && !deletedTombstoneIds.has(s.id))
        .at(-1);
      wsStore.setSessionCursor(workspaceId, pageTail?.id ?? beforeId);
      wsStore.setSessionHasMore(workspaceId, page.hasMore);
    } catch (err) {
      sessionListHooks?.pushOperationFailure('loadMoreSessions', err);
    } finally {
      wsStore.setSessionLoadingMore(workspaceId, false);
    }
  }

  function loadedInWorkspace(workspaceId: string): AppSession[] {
    return sessionsStore().sessions.filter(
      (s) => !s.parentSessionId && workspacesStore().workspaceIdForSession(s) === workspaceId,
    );
  }

  function upsertFlatSessionsPage(
    page: SessionsPage,
    opts?: { resetFrontier?: boolean; excludePinnedWorkspaces?: boolean },
  ): number {
    const existing = new Set(sessionsStore().sessions.map((s) => s.id));
    const fresh = page.items
      .filter(
        (s) =>
          !existing.has(s.id) &&
          !archivedTombstoneIds.has(s.id) &&
          !deletedTombstoneIds.has(s.id) &&
          (s.lastPrompt ?? '').length > 0,
      )
      .map(withFallbackSessionTitle);
    for (const s of fresh) poolInsertsDuringLoad.add(s.id);
    if (fresh.length > 0) sessionsStore().setSessions([...sessionsStore().sessions, ...fresh]);
    for (const item of page.items) {
      if (existing.has(item.id) && item.pullRequest !== undefined) {
        const pr = item.pullRequest;
        sessionsStore().updateSession(item.id, (s) => (s.pullRequest === pr ? s : { ...s, pullRequest: pr }));
      }
    }
    if (page.items.length > 0) {
      const pageOldest = Math.min(...page.items.map((s) => Date.parse(s.updatedAt)));
      const frontier = sessionViewsStore().flatSessionsFrontier;
      sessionViewsStore().setFlatSessionsFrontier(
        opts?.resetFrontier === true || frontier === null
          ? pageOldest
          : Math.min(frontier, pageOldest),
      );
    }
    flatSessionsNextPageToken.value = page.nextPageToken;
    flatSessionsHasMore.value = page.hasMore;
    const visibleWorkspaceIds = new Set(workspacesStore().workspacesView.map((w) => w.id));
    const pinnedWorkspaceIds =
      opts?.excludePinnedWorkspaces === true
        ? new Set(workspacesStore().pinnedWorkspaceIds)
        : null;
    return page.items.filter((s) => {
      if (
        (s.lastPrompt ?? '').length === 0 ||
        archivedTombstoneIds.has(s.id) ||
        deletedTombstoneIds.has(s.id)
      ) {
        return false;
      }
      const wid = workspacesStore().workspaceIdForSession(s);
      if (!visibleWorkspaceIds.has(wid)) return false;
      if (pinnedWorkspaceIds?.has(wid)) return false;
      return true;
    }).length;
  }

  async function fetchFlatSessionsFirstPage(options?: ReadRequestOptions): Promise<void> {
    const requestOptions = backgroundReadOptions(options);
    requestOptions.signal.throwIfAborted();
    const page = await getKimiWebApi().listSessions({
      pageSize: FLAT_SESSIONS_PAGE_SIZE,
      include: 'git',
    }, requestOptions);
    requestOptions.signal.throwIfAborted();
    upsertFlatSessionsPage(page, { resetFrontier: true });
    flatSessionsSeeded.value = true;
  }

  async function ensureFlatSessions(): Promise<void> {
    if (flatSessionsSeeded.value || flatSessionsLoading.value) return;
    const options = backgroundReadOptions();
    flatSessionsLoading.value = true;
    try {
      await fetchFlatSessionsFirstPage(options);
    } catch (err) {
      if (!options.signal.aborted) sessionListHooks?.pushOperationFailure('ensureFlatSessions', err);
    } finally {
      if (!options.signal.aborted) flatSessionsLoading.value = false;
    }
  }

  async function loadMoreFlatSessions(opts?: {
    excludePinnedWorkspaces?: boolean;
    minUnpinnedCount?: number;
  }): Promise<void> {
    if (flatSessionsLoading.value || flatSessionsLoadingMore.value) return;
    if (!flatSessionsHasMore.value) return;
    const options = backgroundReadOptions();
    flatSessionsLoadingMore.value = true;
    try {
      if (!flatSessionsSeeded.value) {
        await fetchFlatSessionsFirstPage(options);
        if (
          opts?.excludePinnedWorkspaces !== true ||
          sessionViewsStore().unpinnedFlatSessionsAll.length >=
            (opts.minUnpinnedCount ?? FLAT_SESSIONS_PAGE_SIZE)
        ) {
          return;
        }
      }
      if (flatSessionsNextPageToken.value === null) return;
      for (let attempt = 0; attempt < FLAT_LOAD_MORE_MAX_PAGES; attempt += 1) {
        options.signal.throwIfAborted();
        const pageToken = flatSessionsNextPageToken.value;
        if (pageToken === null || !flatSessionsHasMore.value) break;
        let page: SessionsPage;
        try {
          page = await getKimiWebApi().listSessions({
            pageSize: FLAT_SESSIONS_PAGE_SIZE,
            pageToken,
            include: 'git',
          }, options);
        } catch (err) {
          options.signal.throwIfAborted();
          if (!isPageTokenMismatchError(err)) throw err;
          flatSessionsNextPageToken.value = null;
          await fetchFlatSessionsFirstPage(options);
          break;
        }
        options.signal.throwIfAborted();
        const added = upsertFlatSessionsPage(page, {
          excludePinnedWorkspaces: opts?.excludePinnedWorkspaces,
        });
        if (opts?.excludePinnedWorkspaces === true && opts.minUnpinnedCount !== undefined) {
          if (sessionViewsStore().unpinnedFlatSessionsAll.length >= opts.minUnpinnedCount) break;
        } else if (added > 0) {
          break;
        }
      }
    } catch (err) {
      if (!options.signal.aborted) sessionListHooks?.pushOperationFailure('loadMoreFlatSessions', err);
    } finally {
      if (!options.signal.aborted) flatSessionsLoadingMore.value = false;
    }
  }

  async function ensureSidebarFlatSessions(
    minUnpinnedCount = FLAT_SESSIONS_PAGE_SIZE,
  ): Promise<void> {
    await ensureFlatSessions();
    if (
      flatSessionsSeeded.value &&
      flatSessionsHasMore.value &&
      sessionViewsStore().unpinnedFlatSessionsAll.length < minUnpinnedCount
    ) {
      await loadMoreFlatSessions({
        excludePinnedWorkspaces: true,
        minUnpinnedCount,
      });
    }
  }

  async function fetchDoneSessionsFirstPage(options: ReadRequestOptions & { signal: AbortSignal }): Promise<void> {
    options.signal.throwIfAborted();
    const page = await getKimiWebApi().listSessions({
      pageSize: FLAT_SESSIONS_PAGE_SIZE,
      include: 'git',
      archived: true,
    }, options);
    options.signal.throwIfAborted();
    const seen = new Set<string>();
    const fresh = page.items
      .filter((s) => (s.lastPrompt ?? '').length > 0)
      .filter((s) => !restoredRecentlyIds.has(s.id))
      .filter((s) => !deletedTombstoneIds.has(s.id))
      .filter((s) => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return true;
      })
      .map(withFallbackSessionTitle);
    const preserved = doneSessions.value.filter(
      (s) => archivedTombstoneIds.has(s.id) && !seen.has(s.id),
    );
    doneSessions.value = [...preserved, ...fresh];
    doneSessionsNextPageToken.value = page.nextPageToken;
    doneSessionsHasMore.value = page.hasMore;
  }

  async function ensureDoneSessions(): Promise<void> {
    if (doneSessionsSeeded.value || doneSessionsLoading.value) return;
    const options = backgroundReadOptions();
    doneSessionsLoading.value = true;
    try {
      await fetchDoneSessionsFirstPage(options);
      options.signal.throwIfAborted();
      doneSessionsSeeded.value = true;
    } catch (err) {
      if (!options.signal.aborted) sessionListHooks?.pushOperationFailure('ensureDoneSessions', err);
    } finally {
      if (!options.signal.aborted) doneSessionsLoading.value = false;
    }
  }

  async function loadMoreDoneSessions(): Promise<void> {
    if (doneSessionsLoading.value || doneSessionsLoadingMore.value) return;
    if (!doneSessionsHasMore.value) return;
    const options = backgroundReadOptions();
    doneSessionsLoadingMore.value = true;
    try {
      if (!doneSessionsSeeded.value) {
        await fetchDoneSessionsFirstPage(options);
        options.signal.throwIfAborted();
        doneSessionsSeeded.value = true;
        return;
      }
      let pagesLeft = 3;
      for (;;) {
        options.signal.throwIfAborted();
        const pageToken = doneSessionsNextPageToken.value;
        if (pageToken === null) return;
        let page: SessionsPage;
        try {
          page = await getKimiWebApi().listSessions({
            pageSize: FLAT_SESSIONS_PAGE_SIZE,
            pageToken,
            include: 'git',
            archived: true,
          }, options);
        } catch (err) {
          options.signal.throwIfAborted();
          if (!isPageTokenMismatchError(err)) throw err;
          doneSessionsNextPageToken.value = null;
          await fetchDoneSessionsFirstPage(options);
          return;
        }
        options.signal.throwIfAborted();
        const existing = new Set(doneSessions.value.map((s) => s.id));
        const fresh = page.items
          .filter(
            (s) =>
              !existing.has(s.id) &&
              !restoredRecentlyIds.has(s.id) &&
              !deletedTombstoneIds.has(s.id) &&
              (s.lastPrompt ?? '').length > 0,
          )
          .map(withFallbackSessionTitle);
        if (fresh.length > 0) doneSessions.value = [...doneSessions.value, ...fresh];
        doneSessionsNextPageToken.value = page.nextPageToken;
        doneSessionsHasMore.value = page.hasMore;
        pagesLeft -= 1;
        if (fresh.length > 0 || !page.hasMore || pagesLeft <= 0) return;
      }
    } catch (err) {
      if (!options.signal.aborted) sessionListHooks?.pushOperationFailure('loadMoreDoneSessions', err);
    } finally {
      if (!options.signal.aborted) doneSessionsLoadingMore.value = false;
    }
  }

  async function loadFirstWorkspacePage(workspaceId: string): Promise<boolean> {
    const wsStore = workspacesStore();
    const initialHostId = wsStore.workspaces.find((w) => w.id === workspaceId)?.hostId;
    try {
      const page = await getKimiWebApi().listSessions({
        workspaceId,
        pageSize: SESSIONS_INITIAL_PAGE_SIZE,
        hasPrompt: true,
      });
      if (
        initialHostId !== undefined &&
        (hostsStore().unavailable(initialHostId) ||
          wsStore.workspaces.find((w) => w.id === workspaceId)?.hostId !== initialHostId)
      ) {
        return false;
      }
      const items = page.items
        .map((s) => wsStore.projectSessionWorkspace(s, workspaceId))
        .filter((s) => !archivedTombstoneIds.has(s.id) && !deletedTombstoneIds.has(s.id))
        .map(withFallbackSessionTitle);
      const existing = new Set(sessionsStore().sessions.map((s) => s.id));
      const updatedById = new Map<string, AppSession>();
      const fresh: AppSession[] = [];
      for (const s of items) {
        if (existing.has(s.id)) updatedById.set(s.id, s);
        else {
          poolInsertsDuringLoad.add(s.id);
          fresh.push(s);
        }
      }
      if (fresh.length > 0 || updatedById.size > 0) {
        sessionsStore().setSessions(
          [
            ...sessionsStore().sessions.map((s) => {
              const next = updatedById.get(s.id);
              return next === undefined ? s : { ...s, hostId: next.hostId ?? s.hostId, workspaceId: next.workspaceId ?? s.workspaceId };
            }),
            ...fresh,
          ].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
        );
      }
      wsStore.setSessionCursor(
        workspaceId,
        page.items.length > 0 ? page.items[page.items.length - 1]!.id : undefined,
      );
      wsStore.setSessionHasMore(workspaceId, page.hasMore);
      return true;
    } catch (err) {
      sessionListHooks?.pushOperationFailure('loadMoreSessions', err);
      return false;
    }
  }

  function removeHostSessions(hostIds: readonly string[], workspaceIds: readonly string[] = []): string[] {
    if (hostIds.length === 0 && workspaceIds.length === 0) return [];
    const hostSet = new Set(hostIds);
    const workspaceSet = new Set(workspaceIds);
    const matches = (s: AppSession): boolean =>
      (s.hostId !== undefined && hostSet.has(s.hostId)) ||
      (s.workspaceId !== undefined && workspaceSet.has(s.workspaceId));
    const removedIds = new Set<string>();
    const keptSessions: AppSession[] = [];
    for (const s of sessionsStore().sessions) {
      if (matches(s)) removedIds.add(s.id);
      else keptSessions.push(s);
    }
    if (keptSessions.length !== sessionsStore().sessions.length) {
      sessionsStore().setSessions(keptSessions);
    }
    const keptDone: AppSession[] = [];
    for (const s of doneSessions.value) {
      if (matches(s)) removedIds.add(s.id);
      else keptDone.push(s);
    }
    if (keptDone.length !== doneSessions.value.length) {
      doneSessions.value = keptDone;
    }
    for (const id of removedIds) {
      hydrationControllers.get(id)?.abort();
      hydrationControllers.delete(id);
    }
    if (removedIds.size > 0) {
      flatSessionsNextPageToken.value = null;
      flatSessionsSeeded.value = false;
      flatSessionsHasMore.value = true;
      doneSessionsNextPageToken.value = null;
      doneSessionsSeeded.value = false;
      doneSessionsHasMore.value = true;
    }
    return [...removedIds];
  }

  async function backfillWorkspaceSessions(
    workspaceId: string,
    archivedId: string,
    archivedUpdatedAt: string,
    target: number,
  ): Promise<void> {
    const wsStore = workspacesStore();
    if (wsStore.sessionsCursorByWorkspace[workspaceId] === archivedId) {
      const archivedMs = new Date(archivedUpdatedAt).getTime();
      let anchor: AppSession | undefined;
      for (const s of sessionsStore().sessions) {
        if (wsStore.workspaceIdForSession(s) !== workspaceId) continue;
        const ms = new Date(s.updatedAt).getTime();
        if (ms <= archivedMs) continue;
        if (anchor === undefined || ms < new Date(anchor.updatedAt).getTime()) anchor = s;
      }
      wsStore.setSessionCursor(workspaceId, anchor?.id);
    }
    let pagesLeft = 3;
    while (
      pagesLeft > 0 &&
      loadedInWorkspace(workspaceId).length < target &&
      (wsStore.sessionsHasMoreByWorkspace[workspaceId] ?? false)
    ) {
      const cursor = wsStore.sessionsCursorByWorkspace[workspaceId];
      const loadedBefore = loadedInWorkspace(workspaceId).length;
      if (cursor === undefined) {
        if (!await loadFirstWorkspacePage(workspaceId)) break;
      } else {
        await loadMoreSessions(workspaceId);
      }
      pagesLeft -= 1;
      if (
        loadedInWorkspace(workspaceId).length === loadedBefore &&
        wsStore.sessionsCursorByWorkspace[workspaceId] === cursor
      ) {
        break;
      }
    }
  }

  async function loadAllSessions(): Promise<void> {
    if (sessionsFullyLoaded.value) return;
    const result = await listAllSessionsGlobal().catch((err) => {
      logWarn('[kimi-code] loadAllSessions failed; search covers only loaded sessions', err);
      return null;
    });
    if (result === null) return;
    const sessions = result.complete ? result.sessions : mergePartialSessionsWithCached(result.sessions);
    const liveSids = new Set(sessions.map((s) => s.id));
    for (const s of sessionsStore().sessions) {
      if (s.messageCount === 0) liveSids.add(s.id);
    }
    for (const id of poolInsertsDuringLoad) liveSids.add(id);
    setSessionsPreservingLiveUsage(sessions);
    sessionsFullyLoaded.value = result.complete;
    if (!result.complete) return;
    permissionsStore().pruneSessions(liveSids);
    workspacesStore().clearSessionsHasMore();
  }

  function notePoolInsert(sessionId: string): void {
    poolInsertsDuringLoad.add(sessionId);
  }
  function clearPoolInserts(): void {
    poolInsertsDuringLoad.clear();
  }
  function takePendingLiveHydrateIds(): string[] {
    return pendingLiveHydrateIds.splice(0);
  }

  function resetSessionList(): void {
    cancelBackgroundReads();
    workspacesStore().sessionWorkspaceAliases = new Map();
    archiveSerialById.clear();
    sessionsFullyLoaded.value = false;
    flatSessionsNextPageToken.value = null;
    flatSessionsHasMore.value = true;
    flatSessionsLoading.value = false;
    flatSessionsLoadingMore.value = false;
    flatSessionsSeeded.value = false;
    doneSessions.value = [];
    doneSessionsNextPageToken.value = null;
    doneSessionsHasMore.value = true;
    doneSessionsLoading.value = false;
    doneSessionsLoadingMore.value = false;
    doneSessionsSeeded.value = false;
    archivedTombstoneIds.clear();
    deletedTombstoneIds.clear();
    restoredRecentlyIds.clear();
    restoredAtBySession.clear();
    poolInsertsDuringLoad.clear();
    pendingLiveHydrateIds.length = 0;
    archiveInFlightIds.clear();
    archiveConfirmedIds.clear();
    titleGenBySession.clear();
  }

  return {
    sessionsFullyLoaded,
    flatSessionsNextPageToken,
    flatSessionsHasMore,
    flatSessionsLoading,
    flatSessionsLoadingMore,
    flatSessionsSeeded,
    doneSessions,
    doneSessionsNextPageToken,
    doneSessionsHasMore,
    doneSessionsLoading,
    doneSessionsLoadingMore,
    doneSessionsSeeded,
    hasArchiveTombstone,
    addArchiveTombstone,
    clearArchiveTombstone,
    hasDeletedTombstone,
    addDeletedTombstone,
    hasRestoredRecently,
    addRestoredRecently,
    restoredAt,
    markRestoredRecently,
    clearRestoredRecently,
    tombstonesEmpty,
    resetSessionList,
    backgroundReadOptions,
    cancelBackgroundReads,
    listAllSessionsGlobal,
    setSessionsPreservingLiveUsage,
    fireFirstSessionGroupPage,
    loadInitialSessionsByWorkspace,
    hydrateLiveSession,
    loadMoreSessions,
    loadedInWorkspace,
    ensureFlatSessions,
    ensureSidebarFlatSessions,
    loadMoreFlatSessions,
    ensureDoneSessions,
    loadMoreDoneSessions,
    loadAllSessions,
    backfillWorkspaceSessions,
    loadFirstWorkspacePage,
    removeHostSessions,
    fetchFlatSessionsFirstPage,
    notePoolInsert,
    clearPoolInserts,
    takePendingLiveHydrateIds,
    applySessionsArchivedLocally,
    archiveSession,
    noteSessionDeleted,
    applySessionDeletedLocally,
    deleteSession,
    applyRemoteSessionArchived,
    applyRemoteSessionRestored,
    restoreSession,
    loadArchivedSessions,
    maybeGenerateSessionTitle,
    renameSession,
    regenerateSessionTitle,
  };
});

export function sessionListStore() {
  return useSessionListStore(clientPinia);
}
