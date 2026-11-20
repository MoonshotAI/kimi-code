import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import {
  worktreeRemoveFailure,
  type AppWorktree,
  type WorktreeInspection,
  type WorktreeRemoveFailureReason,
} from '@moonshot-ai/app-core/api';
import {
  STORAGE_KEYS,
  groupWorktreesByProject,
  nextWorktreeDiskRemindedLevel,
  safeGetString,
  safeSetString,
  shouldRemindWorktreeDisk,
  type WorktreeProjectGroup,
} from '@moonshot-ai/app-core/lib';
import { getKimiWebApi } from '../client/deps';
import { clientPinia } from './pinia';
import { sessionsStore } from './sessions';

export type WorktreeRemovalState = 'waiting' | 'deleting' | 'deleted' | 'failed';

export interface WorktreeRemovalItem {
  path: string;
  name: string;
  branch?: string;
  deleteBranch: boolean;
  state: WorktreeRemovalState;
  reason?: WorktreeRemoveFailureReason;
  output?: string;
  branchDeleted?: boolean;
}

export interface WorktreeSessionRemovalFailure {
  path: string;
  sessionTitle: string;
  branch?: string;
  deleteBranch?: boolean;
  reason?: WorktreeRemoveFailureReason;
  output?: string;
}

export interface WorktreeRemovalRequest {
  path: string;
  deleteBranch?: boolean;
}

export interface WorktreeRemovalSummary {
  total: number;
  waiting: number;
  deleting: number;
  deleted: number;
  failed: number;
}

export const WORKTREE_SIZE_BACKFILL_DELAY_MS = 2000;

export const WORKTREE_SIZE_BACKFILL_MAX_ATTEMPTS = 5;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadRemindedLevel(): number {
  const raw = Number(safeGetString(STORAGE_KEYS.worktreeDiskRemindedLevel));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export const useWorktreesStore = defineStore('kimi.worktrees', () => {
  const items = ref<AppWorktree[]>([]);
  const totalSizeBytes = ref<number | undefined>(undefined);
  const loaded = ref(false);
  const loading = ref(false);
  const refreshingSizes = ref(false);
  const loadError = ref<string | null>(null);
  const removals = ref<WorktreeRemovalItem[]>([]);
  const deletedSessionTitles = ref<Record<string, string>>({});
  const lastRemindedLevel = ref(loadRemindedLevel());
  let listSeq = 0;
  let listInFlight: Promise<boolean> | undefined;
  let pumping = false;
  let sizeBackfillTimer: ReturnType<typeof setTimeout> | undefined;
  let sizeBackfillAttempts = 0;

  const groups = computed<WorktreeProjectGroup[]>(() => groupWorktreesByProject(items.value));

  const removalSummary = computed<WorktreeRemovalSummary>(() => {
    const summary: WorktreeRemovalSummary = { total: removals.value.length, waiting: 0, deleting: 0, deleted: 0, failed: 0 };
    for (const item of removals.value) summary[item.state] += 1;
    return summary;
  });

  const removalRunning = computed<boolean>(() =>
    removals.value.some((item) => item.state === 'waiting' || item.state === 'deleting'),
  );

  const shouldRemindDiskUsage = computed<boolean>(() =>
    shouldRemindWorktreeDisk(totalSizeBytes.value, lastRemindedLevel.value),
  );

  function setRemindedLevel(level: number): void {
    if (level === lastRemindedLevel.value) return;
    lastRemindedLevel.value = level;
    safeSetString(STORAGE_KEYS.worktreeDiskRemindedLevel, String(level));
  }

  function setTotalSize(next: number | undefined): void {
    totalSizeBytes.value = next;
    setRemindedLevel(nextWorktreeDiskRemindedLevel(next, lastRemindedLevel.value, false));
  }

  function markDiskUsageReminded(): void {
    setRemindedLevel(nextWorktreeDiskRemindedLevel(totalSizeBytes.value, lastRemindedLevel.value, true));
  }

  function cancelSizeBackfill(): void {
    if (sizeBackfillTimer === undefined) return;
    clearTimeout(sizeBackfillTimer);
    sizeBackfillTimer = undefined;
  }

  function scheduleSizeBackfill(continuing: boolean): void {
    cancelSizeBackfill();
    if (!continuing) sizeBackfillAttempts = 0;
    if (!items.value.some((item) => item.sizeBytes === undefined)) return;
    if (sizeBackfillAttempts >= WORKTREE_SIZE_BACKFILL_MAX_ATTEMPTS) return;
    sizeBackfillAttempts += 1;
    sizeBackfillTimer = setTimeout(() => {
      sizeBackfillTimer = undefined;
      if (refreshingSizes.value || loading.value) return;
      void fetchList(false, true);
    }, WORKTREE_SIZE_BACKFILL_DELAY_MS);
  }

  function fetchList(refreshSizes: boolean, backfill = false): Promise<boolean> {
    const seq = ++listSeq;
    cancelSizeBackfill();
    if (refreshSizes) refreshingSizes.value = true;
    else if (!backfill) loading.value = true;
    const promise = (async () => {
      try {
        const list = await getKimiWebApi().listWorktrees(refreshSizes ? { refreshSizes: true } : undefined);
        if (seq !== listSeq) return false;
        items.value = list.items;
        setTotalSize(list.totalSizeBytes);
        loaded.value = true;
        loadError.value = null;
        scheduleSizeBackfill(backfill);
        return true;
      } catch (error) {
        if (seq === listSeq) loadError.value = errorText(error);
        return false;
      } finally {
        if (seq === listSeq) {
          loading.value = false;
          refreshingSizes.value = false;
        }
      }
    })().finally(() => {
      if (listInFlight === promise) listInFlight = undefined;
    });
    listInFlight = promise;
    return promise;
  }

  function load(): Promise<boolean> {
    return fetchList(false);
  }

  function refreshSizes(): Promise<boolean> {
    return fetchList(true);
  }

  function ensureLoaded(): Promise<boolean> {
    if (loaded.value) return Promise.resolve(true);
    return listInFlight ?? load();
  }

  async function checkDiskUsageReminder(): Promise<number | null> {
    await ensureLoaded();
    return shouldRemindDiskUsage.value ? (totalSizeBytes.value ?? null) : null;
  }

  async function inspect(paths: readonly string[]): Promise<WorktreeInspection | null> {
    if (paths.length === 0) return { items: [], errors: {} };
    try {
      return await getKimiWebApi().inspectWorktrees([...paths]);
    } catch {
      return null;
    }
  }

  function patchRemoval(path: string, patch: Partial<WorktreeRemovalItem>): void {
    removals.value = removals.value.map((item) => (item.path === path ? { ...item, ...patch } : item));
  }

  function forgetWorktree(path: string): void {
    const removed = items.value.find((item) => item.path === path);
    if (removed === undefined) return;
    items.value = items.value.filter((item) => item.path !== path);
    if (removed.sizeBytes !== undefined && totalSizeBytes.value !== undefined) {
      setTotalSize(Math.max(0, totalSizeBytes.value - removed.sizeBytes));
    }
    if (deletedSessionTitles.value[path] !== undefined) {
      const next = { ...deletedSessionTitles.value };
      delete next[path];
      deletedSessionTitles.value = next;
    }
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    let removedAny = false;
    try {
      for (;;) {
        const next = removals.value.find((item) => item.state === 'waiting');
        if (next === undefined) break;
        patchRemoval(next.path, { state: 'deleting', reason: undefined, output: undefined });
        try {
          const result = await getKimiWebApi().removeWorktree({ path: next.path, deleteBranch: next.deleteBranch });
          patchRemoval(next.path, { state: 'deleted', branchDeleted: result.branchDeleted });
          forgetWorktree(next.path);
          markSessionsMissing(next.path, result.branchDeleted);
          removedAny = true;
        } catch (error) {
          const failure = worktreeRemoveFailure(error);
          patchRemoval(next.path, {
            state: 'failed',
            reason: failure?.reason ?? 'unknown',
            output: failure?.output ?? errorText(error),
          });
        }
      }
    } finally {
      pumping = false;
    }
    if (removedAny) void load();
  }

  function enqueueRemovals(requests: readonly WorktreeRemovalRequest[]): void {
    const next = [...removals.value];
    for (const request of requests) {
      const existingIndex = next.findIndex((item) => item.path === request.path);
      const existing = existingIndex === -1 ? undefined : next[existingIndex];
      if (existing !== undefined && (existing.state === 'waiting' || existing.state === 'deleting')) continue;
      const worktree = items.value.find((item) => item.path === request.path);
      const entry: WorktreeRemovalItem = {
        path: request.path,
        name: worktree?.name ?? existing?.name ?? request.path,
        branch: worktree?.branch ?? existing?.branch,
        deleteBranch: request.deleteBranch === true,
        state: 'waiting',
      };
      if (existingIndex === -1) next.push(entry);
      else next[existingIndex] = entry;
    }
    removals.value = next;
    void pump();
  }

  function retryFailedRemovals(paths?: readonly string[]): void {
    const only = paths === undefined ? undefined : new Set(paths);
    removals.value = removals.value.map((item) =>
      item.state === 'failed' && (only === undefined || only.has(item.path))
        ? { ...item, state: 'waiting', reason: undefined, output: undefined }
        : item,
    );
    void pump();
  }

  function removalFor(path: string): WorktreeRemovalItem | undefined {
    return removals.value.find((item) => item.path === path);
  }

  function markSessionsMissing(path: string, branchDeleted: boolean): void {
    const sessions = sessionsStore();
    for (const session of sessions.sessions) {
      const worktree = session.worktree;
      if (worktree === undefined || worktree.path !== path || worktree.setup.status === 'local') continue;
      sessions.updateSession(session.id, (current) =>
        current.worktree === undefined
          ? current
          : {
              ...current,
              worktree: {
                ...current.worktree,
                missing: true,
                branchMissing: branchDeleted ? true : current.worktree.branchMissing,
              },
            },
      );
    }
  }

  function dismissRemovals(paths: readonly string[], states: readonly WorktreeRemovalState[] = ['deleted', 'failed']): void {
    const only = new Set(paths);
    const next = removals.value.filter(
      (item) =>
        !only.has(item.path) || item.state === 'waiting' || item.state === 'deleting' || !states.includes(item.state),
    );
    if (next.length !== removals.value.length) removals.value = next;
  }

  function recordSessionRemovalFailure(failure: WorktreeSessionRemovalFailure): void {
    const existing = removals.value.find((item) => item.path === failure.path);
    if (existing !== undefined && (existing.state === 'waiting' || existing.state === 'deleting')) {
      deletedSessionTitles.value = { ...deletedSessionTitles.value, [failure.path]: failure.sessionTitle };
      return;
    }
    const worktree = items.value.find((item) => item.path === failure.path);
    const entry: WorktreeRemovalItem = {
      path: failure.path,
      name: worktree?.name ?? existing?.name ?? failure.path,
      branch: failure.branch ?? worktree?.branch ?? existing?.branch,
      deleteBranch: failure.deleteBranch === true,
      state: 'failed',
      reason: failure.reason ?? 'unknown',
      output: failure.output,
    };
    removals.value = [...removals.value.filter((item) => item.path !== failure.path), entry];
    deletedSessionTitles.value = { ...deletedSessionTitles.value, [failure.path]: failure.sessionTitle };
  }

  function reset(): void {
    listSeq += 1;
    listInFlight = undefined;
    items.value = [];
    totalSizeBytes.value = undefined;
    loaded.value = false;
    loading.value = false;
    refreshingSizes.value = false;
    loadError.value = null;
    removals.value = [];
    deletedSessionTitles.value = {};
    cancelSizeBackfill();
    sizeBackfillAttempts = 0;
    lastRemindedLevel.value = 0;
  }

  return {
    items,
    totalSizeBytes,
    loaded,
    loading,
    refreshingSizes,
    loadError,
    groups,
    removals,
    deletedSessionTitles,
    removalSummary,
    removalRunning,
    lastRemindedLevel,
    shouldRemindDiskUsage,
    load,
    refreshSizes,
    ensureLoaded,
    inspect,
    enqueueRemovals,
    retryFailedRemovals,
    removalFor,
    dismissRemovals,
    recordSessionRemovalFailure,
    checkDiskUsageReminder,
    markDiskUsageReminded,
    reset,
  };
});

export function worktreesStore() {
  return useWorktreesStore(clientPinia);
}
