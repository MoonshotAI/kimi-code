
import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { v4 as uuidv4 } from 'uuid';
import type { AppSession, AppWorkspace, FsBrowseResult, ReadRequestOptions } from '@moonshot-ai/app-core/api';
import { isDaemonApiError, isDaemonNetworkError } from '@moonshot-ai/app-core/api';
import type { WorkspaceView } from '@moonshot-ai/app-core/client/types';
import { createRowMemo, errorInfo } from '@moonshot-ai/app-core/client';
import {
  buildWorkspaceRecencyKeys,
  currentActivityKeys,
  loadActiveWorkspace,
  loadHiddenWorkspaceIds,
  loadPinnedWorkspaces,
  loadWorkspaceNameOverridesById,
  loadWorkspaceOrder,
  loadWorkspaceRecencyFloor,
  loadWorkspaceSort,
  logWarn,
  mergeWorkspaces,
  migrateWorkspaceLocalOverrides,
  panelRoots,
  pruneRecencyFloor,
  pinnedWorkspaceKey,
  reconcileRecencyFloor,
  reconcileWorkspaceOrder,
  resolveLocalPath,
  safeRemove,
  saveActiveWorkspace,
  saveHiddenWorkspaceIds,
  savePinnedWorkspaces,
  saveWorkspaceNameOverridesById,
  saveWorkspaceOrder,
  saveWorkspaceRecencyFloor,
  saveWorkspaceSort,
  sortByWorkspaceOrder,
  sortWorkspacesByRecent,
  STORAGE_KEYS,
  stripSurroundingQuotes,
  workspaceRootKey,
  type PanelRoots,
  type PinnedInsertTarget,
  type SessionUrlMode,
  type WorkspaceSortMode,
} from '@moonshot-ai/app-core/lib';
import { getDeviceApi, getKimiWebApi, t } from '../client/deps';
import { track } from '../contracts';
import { sessionsStore } from './sessions';
import { pinnedOrderStore } from './pinnedOrder';
import { filesStore } from './files';
import { hostsStore } from './hosts';
import { promptStore } from './prompt';
import { warningsStore } from './warnings';
import { clientPinia } from './pinia';

export const SESSIONS_INITIAL_PAGE_SIZE = 5;

const WORKSPACE_NOT_FOUND_CODE = 40410;
const WORKSPACE_DUPLICATE_DIR_CODE = 40006;

export interface WorkspaceTrustError {
  operation: 'read' | 'write';
  message: string;
  originalError: unknown;
  code?: number;
  requestId?: string;
  status?: number;
  cause?: unknown;
}

export type WorkspaceTrustResult =
  | { status: 'success'; trusted: boolean }
  | { status: 'error'; error: WorkspaceTrustError }
  | { status: 'aborted' };

function toWorkspaceTrustError(operation: 'read' | 'write', error: unknown): WorkspaceTrustError {
  const result: WorkspaceTrustError = {
    operation,
    message: errorInfo(error).message ?? String(error),
    originalError: error,
    cause: error instanceof Error ? error.cause : undefined,
  };
  if (isDaemonApiError(error)) {
    return { ...result, code: error.code, requestId: error.requestId };
  }
  if (isDaemonNetworkError(error)) {
    return { ...result, requestId: error.requestId, status: error.status, cause: error.cause };
  }
  return result;
}

export function workspaceErrorMessage(error: unknown): string | undefined {
  if (!isDaemonApiError(error) || error.code !== WORKSPACE_DUPLICATE_DIR_CODE || !Array.isArray(error.details)) {
    return undefined;
  }
  const detail: unknown = error.details[0];
  if (typeof detail !== 'object' || detail === null || !('directory' in detail)) return undefined;
  const directory = detail.directory;
  return typeof directory === 'string' && directory.length > 0
    ? t('workspace.dialog.duplicateDir', { directory })
    : undefined;
}

export type WorkspaceLifecycleEvent =
  | { type: 'workspaceCreated'; workspace: AppWorkspace }
  | { type: 'workspaceUpdated'; workspace: AppWorkspace }
  | { type: 'workspaceDeleted'; workspaceId: string; root: string };

export interface WorkspacesHooks {
  selectSession: (sessionId: string, opts?: { skipTrack?: boolean }) => Promise<void>;
  writeSessionUrl: (sessionId: string | undefined, mode: SessionUrlMode) => void;
  setMainView: (view: 'chat' | 'sessionAdmin') => void;
  setSessionLoading: (loading: boolean) => void;
  setActiveSessionId: (id: string | undefined) => void;
  refreshWorkspaceSkills: (workspace: AppWorkspace, previousWorkspace?: AppWorkspace) => void;
}

function workspaceRootsChanged(previous: AppWorkspace | undefined, next: AppWorkspace): boolean {
  if (previous === undefined) return true;
  const previousDirs = previous.additionalDirs ?? [];
  const nextDirs = next.additionalDirs ?? [];
  return (
    previous.root !== next.root ||
    previous.hostId !== next.hostId ||
    previousDirs.length !== nextDirs.length ||
    previousDirs.some((dir, index) => dir !== nextDirs[index])
  );
}

let workspacesHooks: WorkspacesHooks | null = null;

export function setWorkspacesHooks(next: WorkspacesHooks | null): void {
  workspacesHooks = next;
}

function clearActiveSessionId(): void {
  if (workspacesHooks?.setActiveSessionId) {
    workspacesHooks.setActiveSessionId(undefined);
  } else {
    sessionsStore().setActiveSessionId(undefined);
  }
}

export interface SessionGroupsMapping {
  loaded: AppSession[];
  hasMore: Record<string, boolean>;
  cursors: Record<string, string | undefined>;
  counts: Record<string, number>;
  liveIds: string[];
}

function shortenHome(path: string, home: string | null): string {
  if (home && path.startsWith(home)) {
    const rest = path.slice(home.length);
    return rest ? `~${rest}` : '~';
  }
  const m = path.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  if (m) return `~${m[1] ?? ''}`;
  return path;
}

function applyWorkspaceNameOverrides(workspaces: AppWorkspace[]): AppWorkspace[] {
  const overrides = loadWorkspaceNameOverridesById();
  if (Object.keys(overrides).length === 0) return workspaces;
  return workspaces.map((w) => {
    const override = overrides[w.id];
    return override !== undefined ? { ...w, name: override } : w;
  });
}

export const useWorkspacesStore = defineStore('kimi.workspaces', () => {
  const workspaces = ref<AppWorkspace[]>([]);
  const storedActiveWorkspaceId = ref<string | null>(loadActiveWorkspace());
  const fsHome = ref<string | null>(null);
  const recentRoots = ref<string[]>([]);
  const hiddenWorkspaceIds = ref<string[]>(loadHiddenWorkspaceIds());
  const workspaceOrder = ref<string[]>(loadWorkspaceOrder());
  const pinnedWorkspaceIds = ref<string[]>(loadPinnedWorkspaces());
  const workspaceSortMode = ref<WorkspaceSortMode>(loadWorkspaceSort());
  const workspaceRecencyFloor = ref<Record<string, number>>(loadWorkspaceRecencyFloor());
  const sessionsHasMoreByWorkspace = ref<Record<string, boolean>>({});
  const sessionsLoadingMoreByWorkspace = ref<Record<string, boolean>>({});
  const sessionsCursorByWorkspace = ref<Record<string, string | undefined>>({});
  const sessionsInitialCountByWorkspace = ref<Record<string, number>>({});
  const trustByWorkspaceId = ref<Record<string, boolean>>({});
  const trustErrorByWorkspaceId = ref<Record<string, WorkspaceTrustError>>({});
  const trustLoadingByWorkspaceId = ref<Record<string, boolean>>({});
  const trustInflight = new Map<string, { signal?: AbortSignal; promise: Promise<WorkspaceTrustResult> }>();
  const trustErrorNotificationSignatures = new Map<string, Set<string>>();
  let createAttempt: { fingerprint: string; idempotencyKey: string } | undefined;

  function trustErrorSignature(error: WorkspaceTrustError): string {
    const cause = errorInfo(error.cause);
    return [error.operation, error.code, error.status, error.message, cause.name, cause.message].join('\0');
  }

  function setTrustError(workspaceId: string, error: WorkspaceTrustError | undefined): void {
    if (error !== undefined) {
      trustErrorByWorkspaceId.value = { ...trustErrorByWorkspaceId.value, [workspaceId]: error };
      const signature = trustErrorSignature(error);
      const notified = trustErrorNotificationSignatures.get(workspaceId);
      if (activeWorkspaceId.value !== workspaceId || notified?.has(signature) === true) return;
      warningsStore().pushOperationFailure(
        error.operation === 'read' ? 'ensureWorkspaceTrust' : 'trustWorkspace',
        error.originalError,
        {
          title: t(error.operation === 'read'
            ? 'workspace.trust.readFailedTitle'
            : 'workspace.trust.writeFailedTitle'),
          message: error.message,
        },
      );
      if (notified === undefined) {
        trustErrorNotificationSignatures.set(workspaceId, new Set([signature]));
      } else {
        notified.add(signature);
      }
      return;
    }
    trustErrorNotificationSignatures.delete(workspaceId);
    if (!Object.prototype.hasOwnProperty.call(trustErrorByWorkspaceId.value, workspaceId)) return;
    const next = { ...trustErrorByWorkspaceId.value };
    delete next[workspaceId];
    trustErrorByWorkspaceId.value = next;
  }

  function setTrustLoading(workspaceId: string, loading: boolean): void {
    trustLoadingByWorkspaceId.value = { ...trustLoadingByWorkspaceId.value, [workspaceId]: loading };
  }

  const workspaceIdByRoot = computed(() => {
    const map = new Map<string, string>();
    for (const w of workspaces.value) {
      const key = workspaceRootKey(w.root);
      if (!map.has(key)) map.set(key, w.id);
    }
    return map;
  });

  function workspaceIdForSession(s: { workspaceId?: string; cwd: string }): string {
    return s.workspaceId ?? workspaceIdByRoot.value.get(workspaceRootKey(s.cwd)) ?? s.cwd;
  }

  function sessionBelongsToWorkspace(
    session: { workspaceId?: string; cwd?: string },
    workspaceId: string,
  ): boolean {
    return (
      session.workspaceId === workspaceId ||
      (session.workspaceId === undefined &&
        session.cwd !== undefined &&
        workspaceIdForSession({ cwd: session.cwd }) === workspaceId)
    );
  }

  const mergedWorkspaces = computed<AppWorkspace[]>(() =>
    mergeWorkspaces({
      workspaces: workspaces.value,
      sessions: sessionsStore().sessions,
      hiddenWorkspaceIds: hiddenWorkspaceIds.value,
      sessionsHasMoreByWorkspace: sessionsHasMoreByWorkspace.value,
    }),
  );

  const workspaceRecencyKeys = computed<ReadonlyMap<string, number>>(() =>
    buildWorkspaceRecencyKeys(mergedWorkspaces.value, workspaceRecencyFloor.value),
  );

  const workspaceViewRows = createRowMemo<WorkspaceView>((view) => view.id);

  const workspacesView = computed<WorkspaceView[]>(() => {
    const views = mergedWorkspaces.value.map((w) => ({
      id: w.id,
      name: w.name,
      root: w.root,
      hostId: w.hostId,
      shortPath: w.hostId === undefined ? shortenHome(w.root, fsHome.value) : w.root,
      additionalDirs: w.additionalDirs,
      sessionCount: w.sessionCount,
    }));
    if (workspaceSortMode.value === 'recent') {
      return workspaceViewRows(sortWorkspacesByRecent(views, workspaceRecencyKeys.value));
    }
    return workspaceViewRows(sortByWorkspaceOrder(views, workspaceOrder.value));
  });

  const workspaceById = computed<ReadonlyMap<string, WorkspaceView>>(
    () => new Map(workspacesView.value.map((w) => [w.id, w])),
  );

  const visibleWorkspaceIds = computed<ReadonlySet<string>>(
    () => new Set(workspacesView.value.filter((w) => !hostsStore().unavailable(w.hostId)).map((w) => w.id)),
  );

  const activeWorkspaceId = computed<string | null>(() => {
    const id = storedActiveWorkspaceId.value;
    if (id && visibleWorkspaceIds.value.has(id)) return id;
    return workspacesView.value.find((w) => !hostsStore().unavailable(w.hostId))?.id ?? null;
  });

  const visibleWorkspace = computed<WorkspaceView | null>(() => {
    const id = activeWorkspaceId.value;
    return id ? workspaceById.value.get(id) ?? null : null;
  });

  const isLocalWorkspace = computed<boolean>(() => visibleWorkspace.value?.hostId === undefined);

  function sessionPanelRoots(session: AppSession): PanelRoots {
    const id = workspaceIdForSession(session);
    return panelRoots(session, workspaces.value.find((w) => w.id === id));
  }

  const activePanelRoots = computed<PanelRoots>(() => {
    const sessionId = sessionsStore().activeSessionId;
    const session = sessionId === undefined ? undefined : sessionsStore().sessions.find((s) => s.id === sessionId);
    return session === undefined ? panelRoots(undefined, visibleWorkspace.value ?? undefined) : sessionPanelRoots(session);
  });

  const activePanelRoot = computed<string>(() => activePanelRoots.value.root);

  function clearWorkspaceTrustState(workspaceIds: readonly string[], clearCached = false): void {
    let trustChanged = false;
    const nextTrust = clearCached ? { ...trustByWorkspaceId.value } : undefined;
    for (const id of workspaceIds) {
      trustInflight.delete(id);
      setTrustError(id, undefined);
      if (trustLoadingByWorkspaceId.value[id] === true) setTrustLoading(id, false);
      if (nextTrust !== undefined && Object.prototype.hasOwnProperty.call(nextTrust, id)) {
        delete nextTrust[id];
        trustChanged = true;
      }
    }
    if (nextTrust !== undefined && trustChanged) trustByWorkspaceId.value = nextTrust;
  }

  function clearWorkspacePaginationState(workspaceIds: readonly string[]): void {
    const stale = new Set(workspaceIds);
    const omit = <T>(record: Record<string, T>): Record<string, T> | undefined => {
      let changed = false;
      const next = { ...record };
      for (const id of stale) {
        if (!Object.prototype.hasOwnProperty.call(next, id)) continue;
        delete next[id];
        changed = true;
      }
      return changed ? next : undefined;
    };
    const nextHasMore = omit(sessionsHasMoreByWorkspace.value);
    if (nextHasMore !== undefined) sessionsHasMoreByWorkspace.value = nextHasMore;
    const nextLoadingMore = omit(sessionsLoadingMoreByWorkspace.value);
    if (nextLoadingMore !== undefined) sessionsLoadingMoreByWorkspace.value = nextLoadingMore;
    const nextCursors = omit(sessionsCursorByWorkspace.value);
    if (nextCursors !== undefined) sessionsCursorByWorkspace.value = nextCursors;
    const nextCounts = omit(sessionsInitialCountByWorkspace.value);
    if (nextCounts !== undefined) sessionsInitialCountByWorkspace.value = nextCounts;
  }

  function inspectHostSelection(
    hostSet: ReadonlySet<string>,
    affectedWorkspaceIds: ReadonlySet<string>,
  ): { sessionAffected: boolean; workspaceAffected: boolean } {
    const activeSid = sessionsStore().activeSessionId;
    const activeSession = activeSid ? sessionsStore().sessions.find((s) => s.id === activeSid) : undefined;
    const sessionWsId =
      activeSession?.workspaceId ??
      (activeSession?.cwd !== undefined ? workspaceIdForSession(activeSession) : undefined);
    const sessionHostId =
      activeSession?.hostId ??
      (sessionWsId ? mergedWorkspaces.value.find((w) => w.id === sessionWsId)?.hostId : undefined);
    const storedId = storedActiveWorkspaceId.value;
    const storedHostId = storedId ? workspaceById.value.get(storedId)?.hostId : undefined;
    return {
      sessionAffected:
        (sessionHostId !== undefined && hostSet.has(sessionHostId)) ||
        (sessionWsId !== undefined && affectedWorkspaceIds.has(sessionWsId)),
      workspaceAffected:
        (storedHostId !== undefined && hostSet.has(storedHostId)) ||
        (storedId !== null && affectedWorkspaceIds.has(storedId)),
    };
  }

  function applyHostSelectionExit(
    selection: { sessionAffected: boolean; workspaceAffected: boolean },
    excludedWorkspaceIds?: ReadonlySet<string>,
  ): void {
    if (selection.workspaceAffected) migrateActiveWorkspaceAfterRemoval(excludedWorkspaceIds);
    if ((selection.sessionAffected || selection.workspaceAffected) && sessionsStore().activeSessionId !== undefined) {
      clearActiveSessionId();
      workspacesHooks?.setSessionLoading(false);
      filesStore().clearFileDiff();
      workspacesHooks?.writeSessionUrl(undefined, 'replace');
    }
  }

  function handleUnavailableHosts(hostIds: readonly string[]): void {
    if (hostIds.length === 0) return;
    const hostSet = new Set(hostIds);
    const affected = mergedWorkspaces.value
      .filter((w) => w.hostId !== undefined && hostSet.has(w.hostId))
      .map((w) => w.id);
    const affectedSet = new Set(affected);
    const selection = inspectHostSelection(hostSet, affectedSet);
    clearWorkspaceTrustState(affected);
    applyHostSelectionExit(selection, affectedSet);
  }

  function removeHostWorkspaces(hostIds: readonly string[]): string[] {
    if (hostIds.length === 0) return [];
    const hostSet = new Set(hostIds);
    const affected = mergedWorkspaces.value
      .filter((w) => w.hostId !== undefined && hostSet.has(w.hostId))
      .map((w) => w.id);
    const affectedSet = new Set(affected);
    const selection = inspectHostSelection(hostSet, affectedSet);
    workspaces.value = workspaces.value.filter((w) => w.hostId === undefined || !hostSet.has(w.hostId));
    clearWorkspaceTrustState(affected, true);
    clearWorkspacePaginationState(affected);
    applyHostSelectionExit(selection, affectedSet);
    return affected;
  }

  watch(
    () => sessionsStore().sessions,
    (sessions) => {
      const current = currentActivityKeys(sessions, workspaceIdForSession);
      const { next, changed } = reconcileRecencyFloor(workspaceRecencyFloor.value, current);
      if (!changed) return;
      workspaceRecencyFloor.value = next;
      saveWorkspaceRecencyFloor(next);
    },
  );

  const requestedWorkspaceIds = new Set<string>();

  async function listUnseenWorkspaces(sessions: readonly Pick<AppSession, 'workspaceId'>[]): Promise<void> {
    const seen = new Set([...workspaces.value.map((w) => w.id), ...requestedWorkspaceIds]);
    const unseen = sessions.flatMap(({ workspaceId: id }) => (id === undefined || seen.has(id) ? [] : [id]));
    if (unseen.length === 0) return;
    for (const id of unseen) requestedWorkspaceIds.add(id);
    const requestedAt = removalClock;
    try {
      const list = await getKimiWebApi().listWorkspaces();
      for (const { id } of list) requestedWorkspaceIds.delete(id);
      showRelistedWorkspaces(list, requestedAt);
      const known = new Set([...workspaces.value.map((w) => w.id), ...hiddenWorkspaceIds.value]);
      const added = list.filter((w) => !known.has(w.id));
      if (added.length > 0) workspaces.value = [...applyWorkspaceNameOverrides(added), ...workspaces.value];
    } catch (err) {
      for (const id of unseen) requestedWorkspaceIds.delete(id);
      logWarn('[kimi-code] listing the projects of unseen sessions failed', err);
    }
  }

  watch(
    () => sessionsStore().sessions,
    (sessions, previous) => {
      const known = new Set(previous.map((s) => s.id));
      void listUnseenWorkspaces(sessions.filter((s) => !known.has(s.id)));
    },
  );

  function selectWorkspace(id: string): void {
    storedActiveWorkspaceId.value = id;
    saveActiveWorkspace(id);
  }

  function setWorkspaceSortMode(mode: WorkspaceSortMode): void {
    if (workspaceSortMode.value === mode) return;
    workspaceSortMode.value = mode;
    saveWorkspaceSort(mode);
  }

  function reorderWorkspaces(ids: string[]): void {
    workspaceOrder.value = ids;
    saveWorkspaceOrder(ids);
  }

  function pinWorkspace(id: string, target?: PinnedInsertTarget): void {
    if (!target && pinnedWorkspaceIds.value.includes(id)) return;
    if (!pinnedWorkspaceIds.value.includes(id)) {
      pinnedWorkspaceIds.value = [...pinnedWorkspaceIds.value, id];
      savePinnedWorkspaces(pinnedWorkspaceIds.value);
    }
    pinnedOrderStore().placeKey(pinnedWorkspaceKey(id), target);
  }

  function unpinWorkspace(id: string): void {
    pinnedOrderStore().removeKeys([pinnedWorkspaceKey(id)]);
    if (!pinnedWorkspaceIds.value.includes(id)) return;
    pinnedWorkspaceIds.value = pinnedWorkspaceIds.value.filter((existing) => existing !== id);
    savePinnedWorkspaces(pinnedWorkspaceIds.value);
  }

  function togglePinWorkspace(id: string): void {
    if (pinnedWorkspaceIds.value.includes(id)) unpinWorkspace(id);
    else pinWorkspace(id);
  }

  function reconcileOrder(currentIds: string[]): void {
    const next = reconcileWorkspaceOrder(currentIds, workspaceOrder.value, workspaceRecencyKeys.value);
    if (next !== null) {
      workspaceOrder.value = next;
      saveWorkspaceOrder(next);
    }
    const { next: prunedFloor, changed: floorChanged } = pruneRecencyFloor(
      workspaceRecencyFloor.value,
      new Set(currentIds),
    );
    if (floorChanged) {
      workspaceRecencyFloor.value = prunedFloor;
      saveWorkspaceRecencyFloor(prunedFloor);
    }
  }

  async function loadWorkspaces(
    trace?: <T>(step: 'list' | 'home', request: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    const requestedAt = removalClock;
    try {
      const api = getKimiWebApi();
      const [list, home] = await Promise.all([
        (trace?.('list', () => api.listWorkspaces()) ?? api.listWorkspaces()).catch(() => undefined),
        (trace?.('home', () => api.getFsHome()) ?? api.getFsHome()).catch(() => ({ home: '', recentRoots: [] })),
      ]);
      if (list === undefined) {
        workspaces.value = [];
      } else {
        showRelistedWorkspaces(list, requestedAt);
        const migrated = migrateWorkspaceLocalOverrides(list);
        if (migrated !== null) hiddenWorkspaceIds.value = migrated.hiddenWorkspaceIds;
        workspaces.value = applyWorkspaceNameOverrides(list);
        void listUnseenWorkspaces(sessionsStore().sessions);
      }
      fsHome.value = home.home || null;
      recentRoots.value = home.recentRoots;
    } catch {}
  }

  function upsertWorkspacePreserveOrder(workspace: AppWorkspace): void {
    const override = loadWorkspaceNameOverridesById()[workspace.id];
    const ws = override !== undefined ? { ...workspace, name: override } : workspace;
    if (hiddenWorkspaceIds.value.includes(ws.id)) {
      hiddenWorkspaceIds.value = hiddenWorkspaceIds.value.filter((id) => id !== ws.id);
      saveHiddenWorkspaceIds(hiddenWorkspaceIds.value);
    }
    const index = workspaces.value.findIndex((w) => w.id === ws.id);
    if (index === -1) {
      workspaces.value = [ws, ...workspaces.value];
      return;
    }
    const next = [...workspaces.value];
    next[index] = ws;
    workspaces.value = next;
  }

  function hideWorkspace(id: string): void {
    unpinWorkspace(id);
    requestedWorkspaceIds.delete(id);
    if (id && !hiddenWorkspaceIds.value.includes(id)) {
      hiddenWorkspaceIds.value = [...hiddenWorkspaceIds.value, id];
      saveHiddenWorkspaceIds(hiddenWorkspaceIds.value);
    }
  }

  const removalSettledAt = new Map<string, number>();
  let removalClock = 0;

  function settleRemoval(id: string): void {
    removalClock += 1;
    removalSettledAt.set(id, removalClock);
  }

  function showRelistedWorkspaces(list: readonly AppWorkspace[], requestedAt: number): void {
    const relisted = new Set(
      list
        .filter((w) => w.kind === 'implicit' && (removalSettledAt.get(w.id) ?? 0) <= requestedAt)
        .map((w) => w.id),
    );
    const hidden = hiddenWorkspaceIds.value.filter((id) => !relisted.has(id));
    if (hidden.length === hiddenWorkspaceIds.value.length) return;
    hiddenWorkspaceIds.value = hidden;
    saveHiddenWorkspaceIds(hidden);
  }

  function removeWorkspaceEntries(id: string, _root?: string): void {
    unpinWorkspace(id);
    workspaces.value = workspaces.value.filter((w) => w.id !== id);
    trustInflight.delete(id);
    if (Object.prototype.hasOwnProperty.call(trustByWorkspaceId.value, id)) {
      const next = { ...trustByWorkspaceId.value };
      delete next[id];
      trustByWorkspaceId.value = next;
    }
    setTrustError(id, undefined);
    setTrustLoading(id, false);
  }

  function migrateActiveWorkspaceAfterRemoval(excludedIds?: ReadonlySet<string>): void {
    const nextWorkspace =
      workspacesView.value.find(
        (w) => !excludedIds?.has(w.id) && !hostsStore().unavailable(w.hostId),
      )?.id ?? null;
    storedActiveWorkspaceId.value = nextWorkspace;
    if (nextWorkspace) saveActiveWorkspace(nextWorkspace);
    else safeRemove(STORAGE_KEYS.activeWorkspace);
  }

  function applyWorkspaceRename(id: string, name: string): void {
    workspaces.value = workspaces.value.map((w) => (w.id === id ? { ...w, name } : w));
  }

  function commitSessionGroupPagination(
    mapped: SessionGroupsMapping,
    prior?: SessionGroupsMapping,
  ): void {
    if (prior === undefined) {
      sessionsHasMoreByWorkspace.value = mapped.hasMore;
      sessionsCursorByWorkspace.value = mapped.cursors;
      sessionsInitialCountByWorkspace.value = mapped.counts;
      return;
    }
    const hasMore = { ...sessionsHasMoreByWorkspace.value };
    const cursors = { ...sessionsCursorByWorkspace.value };
    const counts = { ...sessionsInitialCountByWorkspace.value };
    for (const workspace of workspaces.value) {
      if (sessionsCursorByWorkspace.value[workspace.id] !== prior.cursors[workspace.id]) {
        continue;
      }
      hasMore[workspace.id] = mapped.hasMore[workspace.id] ?? false;
      cursors[workspace.id] = mapped.cursors[workspace.id];
      counts[workspace.id] = mapped.counts[workspace.id] ?? SESSIONS_INITIAL_PAGE_SIZE;
    }
    sessionsHasMoreByWorkspace.value = hasMore;
    sessionsCursorByWorkspace.value = cursors;
    sessionsInitialCountByWorkspace.value = counts;
  }

  function resetSessionGroupPagination(): void {
    sessionsHasMoreByWorkspace.value = {};
    sessionsCursorByWorkspace.value = {};
    sessionsInitialCountByWorkspace.value = {};
  }

  function clearSessionsHasMore(): void {
    const cleared: Record<string, boolean> = {};
    for (const w of workspaces.value) cleared[w.id] = false;
    sessionsHasMoreByWorkspace.value = cleared;
  }

  function setSessionHasMore(workspaceId: string, hasMore: boolean): void {
    sessionsHasMoreByWorkspace.value[workspaceId] = hasMore;
  }

  function setSessionLoadingMore(workspaceId: string, loading: boolean): void {
    sessionsLoadingMoreByWorkspace.value[workspaceId] = loading;
  }

  function setSessionCursor(workspaceId: string, cursor: string | undefined): void {
    sessionsCursorByWorkspace.value[workspaceId] = cursor;
  }

  function openWorkspace(id: string): void {
    workspacesHooks?.setMainView('chat');
    selectWorkspace(id);
    const sessionsInWs = sessionsStore().sessions.filter(
      (s) => workspaceIdForSession(s) === id,
    );
    if (sessionsInWs.length > 0) {
      const mostRecent = sessionsInWs[0];
      if (mostRecent && mostRecent.id !== sessionsStore().activeSessionId) {
        void workspacesHooks?.selectSession(mostRecent.id, { skipTrack: true });
      }
    } else {
      clearActiveSessionId();
      workspacesHooks?.writeSessionUrl(undefined, 'push');
    }
  }

  function applyWorkspaceEvent(event: WorkspaceLifecycleEvent): void {
    if (event.type === 'workspaceCreated' || event.type === 'workspaceUpdated') {
      upsertWorkspacePreserveOrder(event.workspace);
      return;
    }
    const root =
      workspaces.value.find((w) => w.id === event.workspaceId)?.root ?? event.root;
    hideWorkspace(event.workspaceId);
    settleRemoval(event.workspaceId);
    removeWorkspaceEntries(event.workspaceId);
    const removingActiveWorkspace =
      storedActiveWorkspaceId.value === event.workspaceId || storedActiveWorkspaceId.value === root;
    if (removingActiveWorkspace) {
      migrateActiveWorkspaceAfterRemoval();
      clearActiveSessionId();
      workspacesHooks?.setSessionLoading(false);
      filesStore().clearFileDiff();
      workspacesHooks?.writeSessionUrl(undefined, 'replace');
    }
  }

  function clearActiveSession(): void {
    clearActiveSessionId();
    workspacesHooks?.setSessionLoading(false);
    workspacesHooks?.setMainView('chat');
    workspacesHooks?.writeSessionUrl(undefined, 'push');
  }

  function openWorkspaceDraft(
    workspaceId: string,
    opts?: { entry?: 'newChat' | 'workspace' },
  ): boolean {
    if (hostsStore().blocked(mergedWorkspaces.value.find((workspace) => workspace.id === workspaceId)?.hostId)) return false;
    if (opts?.entry !== undefined) promptStore().setDraftEntry(opts.entry);
    selectWorkspace(workspaceId);
    clearActiveSession();
    filesStore().clearFileDiff();
    return true;
  }

  function openNewSessionDraft(): boolean {
    const wsId = activeWorkspaceId.value;
    if (wsId && openWorkspaceDraft(wsId, { entry: 'newChat' })) return true;
    const fallback = workspacesView.value.find((workspace) => !hostsStore().blocked(workspace.hostId));
    if (fallback) return openWorkspaceDraft(fallback.id, { entry: 'newChat' });
    if (wsId) return false;
    clearActiveSession();
    return true;
  }

  function defaultCreateHostId(): string | undefined {
    const currentHostId = visibleWorkspace.value?.hostId;
    const usable = hostsStore().hosts.filter((host) => !hostsStore().blocked(host.id));
    if (currentHostId !== undefined && usable.some((host) => host.id === currentHostId)) return currentHostId;
    if (workspacesView.value.length === 0 && usable.length === 1 && usable[0]?.status === 'ready') {
      return usable[0].id;
    }
    return undefined;
  }

  function removeWorkspaceMessage(id: string, tr: (key: string, params?: Record<string, unknown>) => string): string {
    const workspace = mergedWorkspaces.value.find((w) => w.id === id);
    const name = workspaceById.value.get(id)?.name ?? id;
    const hostId = workspace?.hostId;
    if (hostId !== undefined) {
      const device = hostsStore().hostLabel(hostId, tr);
      return tr(
        hostsStore().unavailable(hostId)
          ? 'workspace.removeWorkspaceConfirmHostOffline'
          : 'workspace.removeWorkspaceConfirmHost',
        { name, device },
      );
    }
    return tr(workspace?.kind === 'managed' ? 'workspace.removeWorkspaceConfirmProject' : 'workspace.removeWorkspaceConfirmDir', { name });
  }

  function openMostRecentWorkspaceByRoot(root: string, newChat = false): AppWorkspace | undefined {
    const rootKey = workspaceRootKey(root);
    const candidates = mergedWorkspaces.value.filter(
      (workspace) => workspace.hostId === undefined && workspaceRootKey(workspace.root) === rootKey,
    );
    const existing = sortWorkspacesByRecent(candidates, workspaceRecencyKeys.value)[0];
    if (existing === undefined) return undefined;
    if (newChat) openWorkspaceDraft(existing.id, { entry: 'newChat' });
    else openWorkspace(existing.id);
    return existing;
  }

  async function addWorkspaceByPath(root: string): Promise<boolean> {
    const trimmed = stripSurroundingQuotes(root);
    if (!trimmed) return false;
    const fingerprint = JSON.stringify({ paths: [trimmed], name: null });
    const attempt =
      createAttempt?.fingerprint === fingerprint
        ? createAttempt
        : { fingerprint, idempotencyKey: uuidv4() };
    createAttempt = attempt;
    const api = getKimiWebApi();
    try {
      const ws = await api.addWorkspace({ root: trimmed, idempotencyKey: attempt.idempotencyKey });
      upsertWorkspacePreserveOrder(ws);
      openWorkspaceDraft(ws.id, { entry: 'workspace' });
      createAttempt = undefined;
      return true;
    } catch (err) {
      logWarn('[kimi-code] addWorkspaceByPath failed for', trimmed, err);
      return false;
    }
  }

  async function browseFs(path: string | undefined, signal?: AbortSignal, hostId?: string): Promise<FsBrowseResult> {
    if (hostId !== undefined) return getDeviceApi(hostId).browseFs(path, signal);
    return getDeviceApi(undefined).browseFs(path, signal).catch(() => ({ path: '', parent: null, entries: [] }));
  }

  async function searchFs(root: string, query: string, signal: AbortSignal, hostId?: string): Promise<{ path: string; label: string }[]> {
    const result = await getDeviceApi(hostId).suggestFilesAtRoots([root], { query, limit: 150, showHidden: true }, { signal });
    return result.items
      .filter((item) => item.kind === 'directory')
      .map((item) => ({ path: resolveLocalPath(root, item.path), label: item.path }));
  }

  async function getFsHome(hostId?: string): Promise<{ home: string; recentRoots: string[] }> {
    try {
      return await getDeviceApi(hostId).getFsHome();
    } catch {
      return { home: '', recentRoots: [] };
    }
  }

  async function mkdirFs(path: string, hostId?: string): Promise<{ path: string }> {
    return getDeviceApi(hostId).mkdirFs(path);
  }

  function resetCreateWorkspaceAttempt(): void {
    createAttempt = undefined;
  }

  async function createWorkspace(input: {
    paths: string[];
    name?: string;
    hostId?: string;
  }): Promise<AppWorkspace | undefined> {
    const [root, ...additionalDirs] = input.paths;
    if (root === undefined) return undefined;
    const fingerprint = JSON.stringify({ paths: input.paths, name: input.name ?? null, hostId: input.hostId ?? null });
    const attempt =
      createAttempt?.fingerprint === fingerprint
        ? createAttempt
        : { fingerprint, idempotencyKey: uuidv4() };
    createAttempt = attempt;
    try {
      const ws = await getKimiWebApi().addWorkspace({
        root,
        name: input.name,
        additionalDirs: additionalDirs.length > 0 ? additionalDirs : undefined,
        idempotencyKey: attempt.idempotencyKey,
        hostId: input.hostId,
      });
      upsertWorkspacePreserveOrder(ws);
      track('workspace_created', { roots_count: 1 + ws.additionalDirs.length });
      openWorkspaceDraft(ws.id, { entry: 'workspace' });
      createAttempt = undefined;
      return ws;
    } catch (err) {
      warningsStore().pushOperationFailure('createWorkspace', err, { message: workspaceErrorMessage(err) });
      return undefined;
    }
  }

  async function saveWorkspace(input: {
    id: string;
    name?: string;
    additionalDirs?: string[];
    primary?: string;
    projectConfigDirs?: string[];
  }): Promise<boolean> {
    const current = workspaces.value.find((w) => w.id === input.id);
    const primary = input.primary;
    if (primary !== undefined && current !== undefined && primary !== current.root) {
      if (!current.additionalDirs.includes(primary)) {
        const added = await saveWorkspace({
          id: input.id,
          additionalDirs: [...current.additionalDirs, primary],
          projectConfigDirs: input.projectConfigDirs,
        });
        if (!added) return false;
      }
      const promoted = await setWorkspacePrimary({ id: input.id, path: primary });
      if (!promoted) return false;
    }
    const registered = workspaces.value.some((w) => w.id === input.id);
    const patch: { name?: string; additionalDirs?: string[] } = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.additionalDirs !== undefined) patch.additionalDirs = input.additionalDirs;
    const previousWorkspace = workspaces.value.find((w) => w.id === input.id);
    const previousDirs = new Set(previousWorkspace?.additionalDirs ?? []);
    const projectConfigDirs = new Set(input.projectConfigDirs ?? []);
    try {
      const ws = await getKimiWebApi().updateWorkspace(input.id, patch);
      const overrides = loadWorkspaceNameOverridesById();
      if (input.id in overrides) {
        delete overrides[input.id];
        saveWorkspaceNameOverridesById(overrides);
      }
      upsertWorkspacePreserveOrder(ws);
      if (input.additionalDirs !== undefined) {
        const nextDirs = new Set(ws.additionalDirs);
        for (const dir of nextDirs) {
          if (!previousDirs.has(dir)) {
            track('workspace_dir_added', {
              source: projectConfigDirs.has(dir) ? 'project-config' : 'registry',
            });
          }
        }
        for (const dir of previousDirs) {
          if (!nextDirs.has(dir)) track('workspace_dir_removed', { source: 'registry' });
        }
      }
      if (input.additionalDirs !== undefined && workspaceRootsChanged(previousWorkspace, ws)) {
        workspacesHooks?.refreshWorkspaceSkills(ws, previousWorkspace);
      }
      return true;
    } catch (err) {
      if (
        input.additionalDirs === undefined &&
        input.name !== undefined &&
        registered &&
        isDaemonApiError(err) &&
        err.code === WORKSPACE_NOT_FOUND_CODE
      ) {
        saveWorkspaceNameOverridesById({
          ...loadWorkspaceNameOverridesById(),
          [input.id]: input.name,
        });
        applyWorkspaceRename(input.id, input.name);
        return true;
      }
      warningsStore().pushOperationFailure('saveWorkspace', err, { message: workspaceErrorMessage(err) });
      return false;
    }
  }

  async function setWorkspacePrimary(input: { id: string; path: string }): Promise<boolean> {
    const previousWorkspace = workspaces.value.find((w) => w.id === input.id);
    try {
      const ws = await getKimiWebApi().setWorkspacePrimary(input.id, input.path);
      upsertWorkspacePreserveOrder(ws);
      if (workspaceRootsChanged(previousWorkspace, ws)) {
        workspacesHooks?.refreshWorkspaceSkills(ws, previousWorkspace);
      }
      return true;
    } catch (err) {
      warningsStore().pushOperationFailure('setWorkspacePrimary', err);
      return false;
    }
  }

  async function fetchWorkspaceProjectConfigDirs(root: string, hostId?: string): Promise<string[] | undefined> {
    try {
      return await getDeviceApi(hostId).getWorkspaceProjectConfigDirs(root);
    } catch (err) {
      logWarn('[kimi-code] getWorkspaceProjectConfigDirs failed for', root, err);
      return undefined;
    }
  }

  async function renameWorkspace(id: string, name: string): Promise<void> {
    await saveWorkspace({ id, name });
  }

  async function deleteWorkspace(id: string): Promise<void> {
    const workspace =
      workspaces.value.find((w) => w.id === id) ??
      mergedWorkspaces.value.find((w) => w.id === id);
    const root = workspace?.root ?? id;
    const kind = workspace?.kind === 'managed' ? 'wm' : 'wd';
    const activeSession = sessionsStore().activeSessionId
      ? sessionsStore().sessions.find((s) => s.id === sessionsStore().activeSessionId)
      : undefined;
    const removingActiveWorkspace =
      storedActiveWorkspaceId.value === id || storedActiveWorkspaceId.value === root;
    const activeSessionInRemovedWorkspace = Boolean(
      activeSession && sessionBelongsToWorkspace(activeSession, id),
    );
    hideWorkspace(id);
    removalSettledAt.set(id, Number.POSITIVE_INFINITY);
    let removed = false;
    try {
      await getKimiWebApi().deleteWorkspace(id);
      removed = true;
      settleRemoval(id);
    } catch (err) {
      logWarn('[kimi-code] deleteWorkspace registry cleanup failed for', id, err);
    }
    removeWorkspaceEntries(id);
    if (removed) {
      track('workspace_removed', {
        workspace_count: workspacesView.value.length,
        kind,
      });
    }
    if (removingActiveWorkspace || activeSessionInRemovedWorkspace) {
      migrateActiveWorkspaceAfterRemoval();
    }
    if (removingActiveWorkspace || activeSessionInRemovedWorkspace) {
      clearActiveSessionId();
      workspacesHooks?.setSessionLoading(false);
      filesStore().clearFileDiff();
      workspacesHooks?.writeSessionUrl(undefined, 'replace');
    }
  }

  function ensureWorkspaceTrust(workspaceId: string, options?: ReadRequestOptions): Promise<WorkspaceTrustResult> {
    if (
      options?.signal?.aborted ||
      hostsStore().blocked(mergedWorkspaces.value.find((w) => w.id === workspaceId)?.hostId)
    ) {
      return Promise.resolve({ status: 'aborted' });
    }
    const trusted = trustByWorkspaceId.value[workspaceId];
    if (trusted !== undefined) return Promise.resolve({ status: 'success', trusted });
    const existing = trustInflight.get(workspaceId);
    if (existing && !existing.signal?.aborted && (!existing.signal || existing.signal === options?.signal)) {
      return existing.promise;
    }
    const request: { signal?: AbortSignal; promise: Promise<WorkspaceTrustResult> } = {
      signal: options?.signal,
      promise: Promise.resolve<WorkspaceTrustResult>({ status: 'aborted' }),
    };
    trustInflight.set(workspaceId, request);
    setTrustLoading(workspaceId, true);
    request.promise = (async (): Promise<WorkspaceTrustResult> => {
      try {
        const api = getKimiWebApi();
        const { trusted } = options === undefined
          ? await api.getWorkspaceTrust(workspaceId)
          : await api.getWorkspaceTrust(workspaceId, options);
        if (request.signal?.aborted || trustInflight.get(workspaceId) !== request) {
          return { status: 'aborted' };
        }
        trustByWorkspaceId.value = { ...trustByWorkspaceId.value, [workspaceId]: trusted };
        setTrustError(workspaceId, undefined);
        return { status: 'success', trusted };
      } catch (error) {
        const cancelled = request.signal?.aborted === true ||
          (error instanceof Error && error.name === 'AbortError');
        if (cancelled || trustInflight.get(workspaceId) !== request) return { status: 'aborted' };
        const failure = toWorkspaceTrustError('read', error);
        setTrustError(workspaceId, failure);
        return { status: 'error', error: failure };
      } finally {
        if (trustInflight.get(workspaceId) === request) {
          trustInflight.delete(workspaceId);
          setTrustLoading(workspaceId, false);
        }
      }
    })();
    return request.promise;
  }

  async function trustWorkspace(workspaceId: string): Promise<WorkspaceTrustResult> {
    try {
      const { trusted } = await getKimiWebApi().trustWorkspace(workspaceId);
      trustInflight.delete(workspaceId);
      setTrustLoading(workspaceId, false);
      trustByWorkspaceId.value = { ...trustByWorkspaceId.value, [workspaceId]: trusted };
      setTrustError(workspaceId, undefined);
      return { status: 'success', trusted };
    } catch (error) {
      const failure = toWorkspaceTrustError('write', error);
      setTrustError(workspaceId, failure);
      return { status: 'error', error: failure };
    }
  }

  return {
    workspaces,
    storedActiveWorkspaceId,
    fsHome,
    recentRoots,
    hiddenWorkspaceIds,
    workspaceOrder,
    pinnedWorkspaceIds,
    workspaceSortMode,
    workspaceRecencyFloor,
    sessionsHasMoreByWorkspace,
    sessionsLoadingMoreByWorkspace,
    sessionsCursorByWorkspace,
    sessionsInitialCountByWorkspace,
    workspaceIdByRoot,
    workspaceIdForSession,
    sessionBelongsToWorkspace,
    mergedWorkspaces,
    workspaceRecencyKeys,
    workspacesView,
    workspaceById,
    visibleWorkspaceIds,
    activeWorkspaceId,
    visibleWorkspace,
    isLocalWorkspace,
    sessionPanelRoots,
    activePanelRoots,
    activePanelRoot,
    selectWorkspace,
    setWorkspaceSortMode,
    reorderWorkspaces,
    pinWorkspace,
    unpinWorkspace,
    togglePinWorkspace,
    reconcileOrder,
    loadWorkspaces,
    listUnseenWorkspaces,
    upsertWorkspacePreserveOrder,
    hideWorkspace,
    removeWorkspaceEntries,
    handleUnavailableHosts,
    removeHostWorkspaces,
    migrateActiveWorkspaceAfterRemoval,
    applyWorkspaceRename,
    commitSessionGroupPagination,
    resetSessionGroupPagination,
    clearSessionsHasMore,
    setSessionHasMore,
    setSessionLoadingMore,
    setSessionCursor,
    openWorkspace,
    applyWorkspaceEvent,
    clearActiveSession,
    openWorkspaceDraft,
    openNewSessionDraft,
    defaultCreateHostId,
    removeWorkspaceMessage,
    openMostRecentWorkspaceByRoot,
    addWorkspaceByPath,
    browseFs,
    searchFs,
    getFsHome,
    mkdirFs,
    createWorkspace,
    resetCreateWorkspaceAttempt,
    saveWorkspace,
    setWorkspacePrimary,
    fetchWorkspaceProjectConfigDirs,
    renameWorkspace,
    deleteWorkspace,
    trustByWorkspaceId,
    trustErrorByWorkspaceId,
    trustLoadingByWorkspaceId,
    ensureWorkspaceTrust,
    trustWorkspace,
  };
});

export function workspacesStore() {
  return useWorkspacesStore(clientPinia);
}
