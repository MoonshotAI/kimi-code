import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DaemonApiError, type AppWorktree, type WorktreeList } from '@moonshot-ai/app-core/api';
import { STORAGE_KEYS, WORKTREE_DISK_REMINDER_STEP_BYTES as GB } from '@moonshot-ai/app-core/lib';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { useWorktreesStore } from '../src/stores/worktrees';

const api = {
  listWorktrees: vi.fn<(input?: { refreshSizes?: boolean }) => Promise<WorktreeList>>(),
  inspectWorktrees: vi.fn(),
  removeWorktree: vi.fn<(input: { path: string; deleteBranch?: boolean }) => Promise<{ removed: true; branchDeleted: boolean }>>(),
};

function item(path: string, overrides: Partial<AppWorktree> = {}): AppWorktree {
  return {
    path,
    name: path.split('/').at(-1)!,
    repoRoot: '/repo',
    workspaceId: 'ws-1',
    workspaceName: 'Repo',
    branch: `kimi/${path.split('/').at(-1)!}`,
    origin: 'product',
    sizeBytes: GB,
    sessions: [],
    ...overrides,
  };
}

function list(items: AppWorktree[], totalSizeBytes?: number): WorktreeList {
  return { items, totalSizeBytes };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function removeFailed(reason: string, output: string): DaemonApiError {
  return new DaemonApiError({ code: 40937, msg: 'remove failed', requestId: 'r1', details: { reason, output } });
}

function freshStore() {
  return useWorktreesStore(createPinia());
}

async function settled(store: ReturnType<typeof freshStore>): Promise<void> {
  await vi.waitFor(() => expect(store.removalRunning).toBe(false));
  await Promise.resolve();
}

let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
  });
  for (const mock of Object.values(api)) mock.mockReset();
  api.listWorktrees.mockResolvedValue(list([item('/wt/a'), item('/wt/b'), item('/wt/c')], 3 * GB));
  api.removeWorktree.mockResolvedValue({ removed: true, branchDeleted: false });
  setKimiClientDeps({ api: () => api as never, t: (key) => key });
});

afterEach(() => {
  resetKimiClientDeps();
  vi.unstubAllGlobals();
});

describe('worktree list', () => {
  it('loads the list, groups it by project and keeps the total size', async () => {
    api.listWorktrees.mockResolvedValueOnce(
      list([item('/wt/a'), item('/wt/x', { workspaceId: undefined, workspaceName: undefined, repoRoot: '/other' }), item('/wt/b')], 3 * GB),
    );
    const store = freshStore();

    expect(await store.load()).toBe(true);

    expect(store.loaded).toBe(true);
    expect(store.totalSizeBytes).toBe(3 * GB);
    expect(store.groups.map((group) => [group.name, group.items.map((entry) => entry.path)])).toEqual([
      ['Repo', ['/wt/a', '/wt/b']],
      ['other', ['/wt/x']],
    ]);
  });

  it('asks for fresh sizes only on an explicit refresh', async () => {
    const store = freshStore();
    await store.load();
    expect(api.listWorktrees).toHaveBeenLastCalledWith(undefined);

    const pending = deferred<WorktreeList>();
    api.listWorktrees.mockReturnValueOnce(pending.promise);
    const refreshed = store.refreshSizes();
    expect(store.refreshingSizes).toBe(true);
    expect(api.listWorktrees).toHaveBeenLastCalledWith({ refreshSizes: true });
    pending.resolve(list([item('/wt/a')], 9 * GB));
    await refreshed;

    expect(store.refreshingSizes).toBe(false);
    expect(store.totalSizeBytes).toBe(9 * GB);
  });

  it('keeps the previous list and the raw error when loading fails', async () => {
    const store = freshStore();
    await store.load();
    api.listWorktrees.mockRejectedValueOnce(new Error('offline'));

    expect(await store.load()).toBe(false);

    expect(store.items).toHaveLength(3);
    expect(store.loadError).toBe('offline');
  });

  it('caches inspection results per path', async () => {
    api.inspectWorktrees.mockResolvedValueOnce({
      items: [{ path: '/wt/a', uncommittedFiles: 2, unpushedCommits: 1, sessions: [] }],
      errors: { '/wt/b': { code: 40423, msg: 'gone' } },
    });
    const store = freshStore();

    const inspection = await store.inspect(['/wt/a', '/wt/b']);

    expect(inspection?.items).toHaveLength(1);
    expect(store.risksByPath['/wt/a']).toMatchObject({ uncommittedFiles: 2, unpushedCommits: 1 });
    expect(store.riskErrorsByPath['/wt/b']).toEqual({ code: 40423, msg: 'gone' });
    expect(await store.inspect([])).toEqual({ items: [], errors: {} });
    expect(api.inspectWorktrees).toHaveBeenCalledTimes(1);
  });
});

describe('worktree removal queue', () => {
  it('deletes one worktree at a time in order', async () => {
    const first = deferred<{ removed: true; branchDeleted: boolean }>();
    const second = deferred<{ removed: true; branchDeleted: boolean }>();
    api.removeWorktree.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const store = freshStore();
    await store.load();

    store.enqueueRemovals([{ path: '/wt/a', deleteBranch: true }, { path: '/wt/b' }]);

    expect(store.removals.map((entry) => [entry.path, entry.state])).toEqual([['/wt/a', 'deleting'], ['/wt/b', 'waiting']]);
    expect(store.removals[0]).toMatchObject({ name: 'a', branch: 'kimi/a', deleteBranch: true });
    expect(api.removeWorktree).toHaveBeenCalledExactlyOnceWith({ path: '/wt/a', deleteBranch: true });
    expect(store.removalRunning).toBe(true);

    first.resolve({ removed: true, branchDeleted: true });
    await vi.waitFor(() => expect(store.removalFor('/wt/b')?.state).toBe('deleting'));
    expect(store.removalFor('/wt/a')).toMatchObject({ state: 'deleted', branchDeleted: true });
    expect(api.removeWorktree).toHaveBeenLastCalledWith({ path: '/wt/b', deleteBranch: false });

    second.resolve({ removed: true, branchDeleted: false });
    await settled(store);
    expect(store.removalSummary).toEqual({ total: 2, waiting: 0, deleting: 0, deleted: 2, failed: 0 });
  });

  it('removes deleted worktrees from the list and reloads it when the queue drains', async () => {
    const store = freshStore();
    await store.load();
    api.listWorktrees.mockResolvedValueOnce(list([item('/wt/c')], GB));

    store.enqueueRemovals([{ path: '/wt/a' }, { path: '/wt/b' }]);
    await vi.waitFor(() => expect(store.removalSummary.deleted).toBe(2));
    expect(store.items.map((entry) => entry.path)).toEqual(['/wt/c']);
    expect(store.totalSizeBytes).toBe(GB);
    await vi.waitFor(() => expect(api.listWorktrees).toHaveBeenCalledTimes(2));
  });

  it('keeps the failure reason and raw output in memory and carries on with the rest', async () => {
    api.removeWorktree
      .mockRejectedValueOnce(removeFailed('in_use', 'fatal: worktree is locked'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ removed: true, branchDeleted: false });
    const store = freshStore();
    await store.load();
    api.listWorktrees.mockResolvedValueOnce(list([item('/wt/a'), item('/wt/b')], 2 * GB));

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
      .mockRejectedValueOnce(removeFailed('session_busy', 'session running'))
      .mockRejectedValueOnce(removeFailed('unknown', 'boom'));
    const store = freshStore();
    await store.load();
    store.enqueueRemovals([{ path: '/wt/a' }, { path: '/wt/b' }]);
    await settled(store);
    expect(store.removalSummary.failed).toBe(2);

    store.retryFailedRemovals(['/wt/b']);
    await settled(store);
    expect(store.removalFor('/wt/a')?.state).toBe('failed');
    expect(store.removalFor('/wt/b')).toMatchObject({ state: 'deleted', reason: undefined, output: undefined });

    store.retryFailedRemovals();
    await settled(store);
    expect(store.removalSummary).toEqual({ total: 2, waiting: 0, deleting: 0, deleted: 2, failed: 0 });
  });

  it('keeps running without any consumer and accepts more work while busy', async () => {
    const first = deferred<{ removed: true; branchDeleted: boolean }>();
    api.removeWorktree.mockReturnValueOnce(first.promise);
    const store = freshStore();
    await store.load();

    store.enqueueRemovals([{ path: '/wt/a' }]);
    store.enqueueRemovals([{ path: '/wt/a' }, { path: '/wt/b' }]);
    expect(store.removals.map((entry) => [entry.path, entry.state])).toEqual([['/wt/a', 'deleting'], ['/wt/b', 'waiting']]);

    first.resolve({ removed: true, branchDeleted: false });
    await settled(store);
    expect(api.removeWorktree).toHaveBeenCalledTimes(2);
    expect(store.removalSummary.deleted).toBe(2);
  });

  it('drops waiting items on cancel and finished items on clear', async () => {
    const first = deferred<{ removed: true; branchDeleted: boolean }>();
    api.removeWorktree.mockReturnValueOnce(first.promise);
    const store = freshStore();
    await store.load();
    store.enqueueRemovals([{ path: '/wt/a' }, { path: '/wt/b' }]);

    store.cancelWaitingRemovals();
    expect(store.removals.map((entry) => entry.path)).toEqual(['/wt/a']);
    first.resolve({ removed: true, branchDeleted: false });
    await settled(store);
    expect(api.removeWorktree).toHaveBeenCalledTimes(1);

    store.clearFinishedRemovals();
    expect(store.removals).toEqual([]);
  });
});

describe('worktree disk reminder', () => {
  it('does not remind when the total size is unknown', async () => {
    api.listWorktrees.mockResolvedValueOnce(list([item('/wt/a', { sizeBytes: undefined })]));
    const store = freshStore();

    expect(await store.checkDiskUsageReminder()).toBeNull();
    expect(store.shouldRemindDiskUsage).toBe(false);
  });

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
    const store = freshStore();
    await store.load();

    expect(store.lastRemindedLevel).toBe(0);
    expect(storage.get(STORAGE_KEYS.worktreeDiskRemindedLevel)).toBe('0');

    api.listWorktrees.mockResolvedValueOnce(list([], 5 * GB));
    await store.load();
    expect(store.shouldRemindDiskUsage).toBe(true);
  });
});
