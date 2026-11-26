import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppWorktree, WorktreeList } from '@moonshot-ai/app-core/api';
import { STORAGE_KEYS, WORKTREE_DISK_REMINDER_STEP_BYTES as GB } from '@moonshot-ai/app-core/lib';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import {
  WORKTREE_SIZE_BACKFILL_DELAY_MS,
  WORKTREE_SIZE_BACKFILL_MAX_ATTEMPTS,
  useWorktreesStore,
} from '../src/stores/worktrees';
import { appWorktree, memoryStorage, worktreeRemoveFailed } from '../src/testing/worktreeFixtures';

type Removed = { removed: true; branchDeleted: boolean };

const api = {
  listWorktrees: vi.fn<(input?: { refreshSizes?: boolean }) => Promise<WorktreeList>>(),
  inspectWorktrees: vi.fn(),
  removeWorktree: vi.fn<(input: { path: string; deleteBranch?: boolean }) => Promise<Removed>>(),
};

function item(name: string, overrides: Partial<AppWorktree> = {}): AppWorktree {
  return appWorktree(name, { sizeBytes: GB, ...overrides });
}

function list(items: AppWorktree[], totalSizeBytes?: number): WorktreeList {
  return { items, totalSizeBytes };
}

function freshStore() {
  return useWorktreesStore(createPinia());
}

async function loadedStore() {
  const store = freshStore();
  await store.load();
  return store;
}

function waitFor(check: () => void): Promise<void> {
  return vi.waitFor(check, { interval: 1 });
}

function states(store: ReturnType<typeof freshStore>): string[] {
  return store.removals.map((entry) => entry.state);
}

function running(store: ReturnType<typeof freshStore>): boolean {
  return states(store).some((state) => state === 'waiting' || state === 'deleting');
}

async function settled(store: ReturnType<typeof freshStore>): Promise<void> {
  await waitFor(() => expect(running(store)).toBe(false));
  await Promise.resolve();
}

let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', memoryStorage(storage));
  for (const mock of Object.values(api)) mock.mockReset();
  api.listWorktrees.mockResolvedValue(list([item('a'), item('b'), item('c')], 3 * GB));
  api.removeWorktree.mockResolvedValue({ removed: true, branchDeleted: false });
  setKimiClientDeps({ api: () => api as never, t: (key) => key });
});

afterEach(() => {
  resetKimiClientDeps();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('worktree list', () => {
  it('asks for fresh sizes only on an explicit refresh', async () => {
    const store = await loadedStore();
    expect(api.listWorktrees).toHaveBeenLastCalledWith(undefined);

    const pending = Promise.withResolvers<WorktreeList>();
    api.listWorktrees.mockReturnValueOnce(pending.promise);
    const refreshed = store.refreshSizes();
    expect(store.refreshingSizes).toBe(true);
    expect(api.listWorktrees).toHaveBeenLastCalledWith({ refreshSizes: true });
    pending.resolve(list([item('a')], 9 * GB));
    await refreshed;

    expect(store.refreshingSizes).toBe(false);
    expect(store.totalSizeBytes).toBe(9 * GB);
  });

  it('keeps the previous list and the raw error when loading fails', async () => {
    const store = await loadedStore();
    api.listWorktrees.mockRejectedValueOnce(new Error('offline'));

    expect(await store.load()).toBe(false);

    expect(store.items).toHaveLength(3);
    expect(store.loadError).toBe('offline');
  });

  it('re-fetches the list while sizes are still being computed, a bounded number of times', async () => {
    vi.useFakeTimers();
    api.listWorktrees.mockResolvedValue({ items: [item('a', { sizeBytes: undefined })] });
    const store = await loadedStore();
    expect(api.listWorktrees).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(WORKTREE_SIZE_BACKFILL_DELAY_MS);
    expect(api.listWorktrees).toHaveBeenCalledTimes(2);
    expect(api.listWorktrees).toHaveBeenLastCalledWith(undefined);

    await vi.advanceTimersByTimeAsync(WORKTREE_SIZE_BACKFILL_DELAY_MS * (WORKTREE_SIZE_BACKFILL_MAX_ATTEMPTS + 3));
    expect(api.listWorktrees).toHaveBeenCalledTimes(1 + WORKTREE_SIZE_BACKFILL_MAX_ATTEMPTS);
  });

  it('stops re-fetching once every size is known', async () => {
    vi.useFakeTimers();
    api.listWorktrees
      .mockResolvedValueOnce({ items: [item('a', { sizeBytes: undefined })] })
      .mockResolvedValue({ items: [item('a')], totalSizeBytes: GB });
    const store = await loadedStore();

    await vi.advanceTimersByTimeAsync(WORKTREE_SIZE_BACKFILL_DELAY_MS * 4);

    expect(api.listWorktrees).toHaveBeenCalledTimes(2);
    expect(store.items[0]?.sizeBytes).toBe(GB);
    expect(store.totalSizeBytes).toBe(GB);
  });
});

describe('worktree removal queue', () => {
  it('deletes one worktree at a time in order', async () => {
    const first = Promise.withResolvers<Removed>();
    const second = Promise.withResolvers<Removed>();
    api.removeWorktree.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const store = await loadedStore();

    store.enqueueRemovals([{ path: '/wt/a', deleteBranch: true }, { path: '/wt/b' }]);

    expect(store.removals.map((entry) => [entry.path, entry.state])).toEqual([['/wt/a', 'deleting'], ['/wt/b', 'waiting']]);
    expect(store.removals[0]).toMatchObject({ name: 'a', branch: 'kimi/a', deleteBranch: true });
    expect(api.removeWorktree).toHaveBeenCalledExactlyOnceWith({ path: '/wt/a', deleteBranch: true });

    first.resolve({ removed: true, branchDeleted: true });
    await waitFor(() => expect(store.removalFor('/wt/b')?.state).toBe('deleting'));
    expect(store.removalFor('/wt/a')).toMatchObject({ state: 'deleted', branchDeleted: true });
    expect(api.removeWorktree).toHaveBeenLastCalledWith({ path: '/wt/b', deleteBranch: false });

    second.resolve({ removed: true, branchDeleted: false });
    await settled(store);
    expect(states(store)).toEqual(['deleted', 'deleted']);
  });

  it('removes deleted worktrees from the list and reloads it when the queue drains', async () => {
    const store = await loadedStore();
    api.listWorktrees.mockResolvedValueOnce(list([item('c')], GB));

    store.enqueueRemovals([{ path: '/wt/a' }, { path: '/wt/b' }]);
    await waitFor(() => expect(states(store)).toEqual(['deleted', 'deleted']));
    expect(store.items.map((entry) => entry.path)).toEqual(['/wt/c']);
    expect(store.totalSizeBytes).toBe(GB);
    await waitFor(() => expect(api.listWorktrees).toHaveBeenCalledTimes(2));
  });

  it('keeps the failure reason and raw output in memory and carries on with the rest', async () => {
    api.removeWorktree
      .mockRejectedValueOnce(worktreeRemoveFailed('in_use', 'fatal: worktree is locked'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ removed: true, branchDeleted: false });
    const store = await loadedStore();
    api.listWorktrees.mockResolvedValueOnce(list([item('a'), item('b')], 2 * GB));

    store.enqueueRemovals([{ path: '/wt/a' }, { path: '/wt/b' }, { path: '/wt/c' }]);
    await settled(store);

    expect(store.removalFor('/wt/a')).toMatchObject({ state: 'failed', reason: 'in_use', output: 'fatal: worktree is locked' });
    expect(store.removalFor('/wt/b')).toMatchObject({ state: 'failed', reason: 'unknown', output: 'network down' });
    expect(store.removalFor('/wt/c')).toMatchObject({ state: 'deleted' });
    expect(store.items.map((entry) => entry.path)).toEqual(['/wt/a', '/wt/b']);
    expect([...storage.keys()]).toEqual([]);
  });

  it('retries failed removals, all of them or only the chosen ones', async () => {
    api.removeWorktree
      .mockRejectedValueOnce(worktreeRemoveFailed('session_busy', 'session running'))
      .mockRejectedValueOnce(worktreeRemoveFailed('unknown', 'boom'));
    const store = await loadedStore();
    store.enqueueRemovals([{ path: '/wt/a' }, { path: '/wt/b' }]);
    await settled(store);
    expect(states(store)).toEqual(['failed', 'failed']);

    store.retryFailedRemovals(['/wt/b']);
    await settled(store);
    expect(store.removalFor('/wt/a')?.state).toBe('failed');
    expect(store.removalFor('/wt/b')).toMatchObject({ state: 'deleted', reason: undefined, output: undefined });

    store.retryFailedRemovals();
    await settled(store);
    expect(states(store)).toEqual(['deleted', 'deleted']);
  });

  it('keeps running without any consumer and accepts more work while busy', async () => {
    const first = Promise.withResolvers<Removed>();
    api.removeWorktree.mockReturnValueOnce(first.promise);
    const store = await loadedStore();

    store.enqueueRemovals([{ path: '/wt/a' }]);
    store.enqueueRemovals([{ path: '/wt/a' }, { path: '/wt/b' }]);
    expect(store.removals.map((entry) => [entry.path, entry.state])).toEqual([['/wt/a', 'deleting'], ['/wt/b', 'waiting']]);

    first.resolve({ removed: true, branchDeleted: false });
    await settled(store);
    expect(api.removeWorktree).toHaveBeenCalledTimes(2);
    expect(states(store)).toEqual(['deleted', 'deleted']);
  });

  it('keeps a failed session removal with the session name for this run', async () => {
    const store = await loadedStore();

    store.recordSessionRemovalFailure({
      path: '/wt/a',
      sessionTitle: 'Hello',
      reason: 'in_use',
      output: 'Directory not empty',
    });

    expect(store.removalFor('/wt/a')).toMatchObject({
      name: 'a',
      branch: 'kimi/a',
      state: 'failed',
      reason: 'in_use',
      output: 'Directory not empty',
    });
    expect(store.deletedSessionTitles).toEqual({ '/wt/a': 'Hello' });

    store.dismissRemovals(['/wt/a'], ['failed']);
    expect(store.removals).toEqual([]);
    expect(store.deletedSessionTitles).toEqual({ '/wt/a': 'Hello' });

    store.enqueueRemovals([{ path: '/wt/a' }]);
    await settled(store);
    expect(store.deletedSessionTitles).toEqual({});
  });

  it('only dismisses finished removals in the requested states', async () => {
    const store = await loadedStore();
    const slow = Promise.withResolvers<Removed>();
    api.removeWorktree
      .mockRejectedValueOnce(worktreeRemoveFailed('in_use', 'busy'))
      .mockReturnValueOnce(slow.promise);
    store.enqueueRemovals([{ path: '/wt/a' }, { path: '/wt/b' }, { path: '/wt/c' }]);
    await waitFor(() => expect(store.removalFor('/wt/b')?.state).toBe('deleting'));

    store.dismissRemovals(['/wt/a', '/wt/b', '/wt/c'], ['deleted']);
    expect(store.removals.map((entry) => entry.state)).toEqual(['failed', 'deleting', 'waiting']);

    store.dismissRemovals(['/wt/a', '/wt/b', '/wt/c']);
    expect(store.removals.map((entry) => entry.state)).toEqual(['deleting', 'waiting']);

    slow.resolve({ removed: true, branchDeleted: false });
    await settled(store);
  });
});

describe('worktree disk reminder', () => {
  it('reminds once at the threshold and persists the reminded level', async () => {
    api.listWorktrees.mockResolvedValueOnce(list([], 5.4 * GB));
    const store = freshStore();

    expect(await store.checkDiskUsageReminder()).toBe(5.4 * GB);
    expect(api.listWorktrees).toHaveBeenCalledTimes(1);
    store.markDiskUsageReminded();

    expect(store.shouldRemindDiskUsage).toBe(false);
    expect(await store.checkDiskUsageReminder()).toBeNull();
    expect(storage.get(STORAGE_KEYS.worktreeDiskRemindedLevel)).toBe('5');
  });

  it('reminds again for each additional gigabyte, also after a restart', async () => {
    storage.set(STORAGE_KEYS.worktreeDiskRemindedLevel, '5');
    api.listWorktrees.mockResolvedValueOnce(list([], 5.9 * GB));
    const store = freshStore();
    expect(await store.checkDiskUsageReminder()).toBeNull();

    api.listWorktrees.mockResolvedValueOnce(list([], 6.1 * GB));
    await store.load();
    expect(store.shouldRemindDiskUsage).toBe(true);
    store.markDiskUsageReminded();
    expect(storage.get(STORAGE_KEYS.worktreeDiskRemindedLevel)).toBe('6');
  });

  it('resets once usage drops below the threshold', async () => {
    storage.set(STORAGE_KEYS.worktreeDiskRemindedLevel, '7');
    api.listWorktrees.mockResolvedValueOnce(list([], 4 * GB));
    const store = await loadedStore();

    expect(store.lastRemindedLevel).toBe(0);
    expect(storage.get(STORAGE_KEYS.worktreeDiskRemindedLevel)).toBe('0');

    api.listWorktrees.mockResolvedValueOnce(list([], 5 * GB));
    await store.load();
    expect(store.shouldRemindDiskUsage).toBe(true);
  });
});
