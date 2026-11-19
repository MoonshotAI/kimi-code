import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DaemonApiError,
  type AppWorktree,
  type AppWorktreeRisk,
  type WorktreeInspection,
  type WorktreeList,
} from '@moonshot-ai/app-core/api';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { ToastOptions } from '@moonshot-ai/app-ui';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { onToast } from '../src/client/toast';
import { useConfirmDialog } from '../src/composables/useConfirmDialog';
import {
  WORKTREE_RESULT_TOAST_MS,
  registerWorktreeSettingsOpener,
  resetWorktreeManageDialogs,
  useWorktreeManageDialogs,
} from '../src/composables/useWorktreeManageDialogs';
import {
  WORKTREE_SIZE_BACKFILL_DELAY_MS,
  WORKTREE_SIZE_BACKFILL_MAX_ATTEMPTS,
  worktreesStore,
} from '../src/stores/worktrees';

const i18n = createKimiI18n({ locale: 'en' });

const api = {
  listWorktrees: vi.fn<(input?: { refreshSizes?: boolean }) => Promise<WorktreeList>>(),
  inspectWorktrees: vi.fn<(paths: string[]) => Promise<WorktreeInspection>>(),
  removeWorktree:
    vi.fn<(input: { path: string; deleteBranch?: boolean }) => Promise<{ removed: true; branchDeleted: boolean }>>(),
};

const MB = 1024 * 1024;

function item(name: string, overrides: Partial<AppWorktree> = {}): AppWorktree {
  return {
    path: `/wt/${name}`,
    name,
    repoRoot: '/repo',
    workspaceId: 'ws-1',
    workspaceName: 'Repo',
    branch: `kimi/${name}`,
    origin: 'product',
    sizeBytes: 60 * MB,
    sessions: [],
    ...overrides,
  };
}

function risk(name: string, overrides: Partial<AppWorktreeRisk> = {}): AppWorktreeRisk {
  return {
    path: `/wt/${name}`,
    branch: `kimi/${name}`,
    uncommittedFiles: 0,
    unpushedCommits: 0,
    sessions: [],
    ...overrides,
  };
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

const dialogs = useWorktreeManageDialogs();
let toasts: ToastOptions[];
let offToast: () => void;
let storage: Map<string, string>;

async function loadStore(items: AppWorktree[]) {
  api.listWorktrees.mockResolvedValue({ items, totalSizeBytes: items.length * 60 * MB });
  const store = worktreesStore();
  await store.load();
  return store;
}

async function settled(): Promise<void> {
  await vi.waitFor(() => expect(worktreesStore().removalRunning).toBe(false));
  await Promise.resolve();
}

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
  });
  for (const mock of Object.values(api)) mock.mockReset();
  api.inspectWorktrees.mockImplementation(async (paths) => ({
    items: paths.map((path) => risk(path.split('/').at(-1)!)),
    errors: {},
  }));
  api.removeWorktree.mockResolvedValue({ removed: true, branchDeleted: false });
  setKimiClientDeps({
    api: () => api as never,
    t: (key, params) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params)),
  });
  worktreesStore().reset();
  resetWorktreeManageDialogs();
  toasts = [];
  offToast = onToast((event) => {
    if (event.type === 'show' && event.options !== undefined) toasts.push(event.options);
  });
});

afterEach(() => {
  offToast();
  resetWorktreeManageDialogs();
  worktreesStore().reset();
  registerWorktreeSettingsOpener(() => undefined);
  resetKimiClientDeps();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('worktree deletion from the management page', () => {
  it('refreshes the status silently before opening the confirmation', async () => {
    await loadStore([item('a', { sessions: [{ id: 's1', title: 'One', archived: false, busy: false }] }), item('b')]);
    const inspection = deferred<WorktreeInspection>();
    api.inspectWorktrees.mockReturnValueOnce(inspection.promise);

    const opening = dialogs.requestWorktreeDeletion(['/wt/a']);
    expect(dialogs.deleteDialog.value).toBeNull();
    expect(dialogs.deleteRequestPending.value).toBe(true);
    inspection.resolve({
      items: [
        risk('a', {
          uncommittedFiles: 3,
          unpushedCommits: 2,
          sessions: [
            { id: 's1', title: 'One', archived: false, busy: false },
            { id: 's2', title: 'Two', archived: true, busy: false },
          ],
        }),
      ],
      errors: {},
    });

    expect(await opening).toBe(true);
    expect(api.inspectWorktrees).toHaveBeenCalledWith(['/wt/a']);
    expect(dialogs.deleteRequestPending.value).toBe(false);
    expect(dialogs.deleteDialog.value).toEqual({
      kind: 'worktrees',
      phase: 'confirm',
      deleteBranch: false,
      targets: [
        {
          path: '/wt/a',
          name: 'a',
          branch: 'kimi/a',
          projectName: 'Repo',
          sessionCount: 2,
          risk: { uncommittedFiles: 3, unpushedCommits: 2 },
        },
      ],
    });
    expect(useConfirmDialog().isConfirmOpen.value).toBe(true);
  });

  it('marks the risk unknown when the status cannot be refreshed', async () => {
    await loadStore([item('a')]);
    api.inspectWorktrees.mockRejectedValueOnce(new Error('offline'));

    await dialogs.requestWorktreeDeletion(['/wt/a']);

    const state = dialogs.deleteDialog.value;
    expect(state?.kind === 'worktrees' && state.phase === 'confirm' ? state.targets[0]?.risk : 'none').toBeNull();
  });

  it('reloads the list instead of asking when the directory is already gone', async () => {
    await loadStore([item('a')]);
    api.inspectWorktrees.mockResolvedValueOnce({ items: [], errors: { '/wt/a': { code: 40423, msg: 'not found' } } });
    api.listWorktrees.mockClear();

    expect(await dialogs.requestWorktreeDeletion(['/wt/a'])).toBe(false);

    expect(dialogs.deleteDialog.value).toBeNull();
    expect(api.listWorktrees).toHaveBeenCalledOnce();
  });

  it('turns into a progress view, then closes with a receipt when everything is deleted', async () => {
    await loadStore([item('a'), item('b')]);
    const first = deferred<{ removed: true; branchDeleted: boolean }>();
    api.removeWorktree.mockReturnValueOnce(first.promise);
    await dialogs.requestWorktreeDeletion(['/wt/a', '/wt/b']);
    dialogs.setDeleteBranch(true);

    dialogs.confirmDeletion();

    expect(dialogs.deleteDialog.value).toMatchObject({ kind: 'worktrees', phase: 'progress' });
    expect(dialogs.deleteProgress.value).toMatchObject({ total: 2, completed: 0, running: true });
    expect(dialogs.deleteProgress.value?.items.map((entry) => [entry.name, entry.state])).toEqual([
      ['kimi/a', 'deleting'],
      ['kimi/b', 'waiting'],
    ]);
    expect(api.removeWorktree).toHaveBeenCalledWith({ path: '/wt/a', deleteBranch: true });

    first.resolve({ removed: true, branchDeleted: true });
    api.removeWorktree.mockResolvedValueOnce({ removed: true, branchDeleted: true });
    await settled();

    expect(dialogs.deleteDialog.value).toBeNull();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      layout: 'bar',
      title: '2 Worktrees and local branches deleted',
      duration: WORKTREE_RESULT_TOAST_MS,
    });
    expect(toasts[0]?.actions).toBeUndefined();
    expect(worktreesStore().removals).toEqual([]);
    expect(useConfirmDialog().isConfirmOpen.value).toBe(false);
  });

  it('never asks to delete a branch the worktree does not have', async () => {
    await loadStore([item('a', { branch: undefined })]);
    api.inspectWorktrees.mockResolvedValueOnce({ items: [risk('a', { branch: undefined })], errors: {} });
    await dialogs.requestWorktreeDeletion(['/wt/a']);
    dialogs.setDeleteBranch(true);

    dialogs.confirmDeletion();
    await settled();

    expect(api.removeWorktree).toHaveBeenCalledWith({ path: '/wt/a', deleteBranch: false });
    expect(toasts[0]?.title).toBe('Worktree a deleted; branch retained');
  });

  it('stays on a result page when some deletions fail and retries only those', async () => {
    await loadStore([item('a'), item('b'), item('c')]);
    api.removeWorktree
      .mockResolvedValueOnce({ removed: true, branchDeleted: false })
      .mockRejectedValueOnce(removeFailed('in_use', 'Directory not empty'))
      .mockResolvedValueOnce({ removed: true, branchDeleted: false });
    await dialogs.requestWorktreeDeletion(['/wt/a', '/wt/b', '/wt/c']);

    dialogs.confirmDeletion();
    await settled();

    expect(dialogs.deleteDialog.value).toMatchObject({ kind: 'worktrees', phase: 'result' });
    expect(dialogs.deleteProgress.value).toMatchObject({ total: 3, deleted: 2, failed: 1, running: false });
    expect(dialogs.deleteProgress.value?.items[0]).toMatchObject({ name: 'kimi/b', state: 'failed' });
    expect(toasts).toEqual([]);
    expect(worktreesStore().removals.map((entry) => [entry.path, entry.state, entry.reason, entry.output])).toEqual([
      ['/wt/b', 'failed', 'in_use', 'Directory not empty'],
    ]);

    api.removeWorktree.mockResolvedValueOnce({ removed: true, branchDeleted: false });
    dialogs.retryFailedDeletion();
    expect(dialogs.deleteDialog.value).toMatchObject({ kind: 'worktrees', phase: 'progress' });
    expect(dialogs.deleteProgress.value?.items.map((entry) => entry.name)).toEqual(['kimi/b']);
    await settled();

    expect(dialogs.deleteDialog.value).toBeNull();
    expect(toasts.map((entry) => entry.title)).toEqual(['Worktree kimi/b deleted; branch retained']);
    expect(worktreesStore().removals).toEqual([]);
  });

  it('keeps the failure for the management page after the result page is closed', async () => {
    await loadStore([item('a'), item('b')]);
    api.removeWorktree
      .mockResolvedValueOnce({ removed: true, branchDeleted: false })
      .mockRejectedValueOnce(removeFailed('session_busy', 'busy'));
    await dialogs.requestWorktreeDeletion(['/wt/a', '/wt/b']);
    dialogs.confirmDeletion();
    await settled();

    dialogs.closeDeleteDialog();

    expect(dialogs.deleteDialog.value).toBeNull();
    expect(toasts).toEqual([]);
    expect(worktreesStore().removalFor('/wt/b')).toMatchObject({ state: 'failed', reason: 'session_busy' });
  });

  it('reports the result in a toast when the dialog was closed while deleting', async () => {
    const opener = vi.fn();
    registerWorktreeSettingsOpener(opener);
    await loadStore([item('a'), item('b'), item('c')]);
    const first = deferred<{ removed: true; branchDeleted: boolean }>();
    api.removeWorktree
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ removed: true, branchDeleted: false })
      .mockRejectedValueOnce(removeFailed('in_use', 'Directory not empty'));
    await dialogs.requestWorktreeDeletion(['/wt/a', '/wt/b', '/wt/c']);
    dialogs.confirmDeletion();

    dialogs.closeDeleteDialog();
    expect(dialogs.deleteDialog.value).toBeNull();
    expect(worktreesStore().removalFor('/wt/a')?.state).toBe('deleting');
    expect(worktreesStore().removalFor('/wt/b')?.state).toBe('waiting');

    first.resolve({ removed: true, branchDeleted: false });
    await settled();

    expect(dialogs.deleteDialog.value).toBeNull();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      title: '2 Worktrees deleted; 1 deletion failed',
      duration: WORKTREE_RESULT_TOAST_MS,
    });
    const dismiss = vi.fn();
    void toasts[0]?.actions?.[0]?.onClick({ dismiss });
    expect(toasts[0]?.actions?.[0]?.label).toBe('Manage');
    expect(dismiss).toHaveBeenCalledOnce();
    expect(opener).toHaveBeenCalledOnce();
    expect(worktreesStore().removalFor('/wt/c')?.state).toBe('failed');
  });

  it('drops a superseded request', async () => {
    await loadStore([item('a'), item('b')]);
    const slow = deferred<WorktreeInspection>();
    api.inspectWorktrees.mockReturnValueOnce(slow.promise);

    const stale = dialogs.requestWorktreeDeletion(['/wt/a']);
    const fresh = dialogs.requestWorktreeDeletion(['/wt/b']);
    slow.resolve({ items: [risk('a')], errors: {} });

    expect(await stale).toBe(false);
    expect(await fresh).toBe(true);
    const state = dialogs.deleteDialog.value;
    expect(state?.kind === 'worktrees' && state.phase === 'confirm' ? state.targets.map((t) => t.path) : []).toEqual([
      '/wt/b',
    ]);
  });
});

describe('worktree session deletion', () => {
  it('asks with the fresh risk and deletes with the chosen branch option', async () => {
    api.inspectWorktrees.mockResolvedValueOnce({
      items: [
        risk('a', { uncommittedFiles: 4, sessions: [{ id: 's1', title: 'Fix login', archived: false, busy: false }] }),
      ],
      errors: {},
    });
    const run = vi.fn(async (options: { deleteBranch: boolean }) => ({ deleted: true, options }));

    const pending = dialogs.requestSessionDeletion({ sessionId: 's1', title: 'Fix login', path: '/wt/a' }, run);
    await vi.waitFor(() => expect(dialogs.deleteDialog.value).not.toBeNull());

    expect(dialogs.deleteDialog.value).toEqual({
      kind: 'session',
      sessionId: 's1',
      title: 'Fix login',
      branch: 'kimi/a',
      otherSessions: 0,
      risk: { uncommittedFiles: 4, unpushedCommits: 0 },
      deleteBranch: false,
      busy: false,
    });

    dialogs.setDeleteBranch(true);
    dialogs.confirmDeletion();
    expect(dialogs.deleteDialog.value).toMatchObject({ busy: true });

    await expect(pending).resolves.toEqual({ confirmed: true, value: { deleted: true, options: { deleteBranch: true } } });
    expect(run).toHaveBeenCalledOnce();
    expect(dialogs.deleteDialog.value).toBeNull();
  });

  it('counts the other sessions and never deletes the branch while they use the directory', async () => {
    api.inspectWorktrees.mockResolvedValueOnce({
      items: [
        risk('a', {
          sessions: [
            { id: 's1', title: 'One', archived: false, busy: false },
            { id: 's2', title: 'Two', archived: false, busy: false },
            { id: 's3', title: 'Three', archived: true, busy: false },
          ],
        }),
      ],
      errors: {},
    });
    const run = vi.fn(async (options: { deleteBranch: boolean }) => options);

    const pending = dialogs.requestSessionDeletion(
      { sessionId: 's1', title: 'One', path: '/wt/a', branch: 'kimi/a' },
      run,
    );
    await vi.waitFor(() => expect(dialogs.deleteDialog.value).not.toBeNull());
    expect(dialogs.deleteDialog.value).toMatchObject({ otherSessions: 2 });

    dialogs.setDeleteBranch(true);
    dialogs.confirmDeletion();

    await expect(pending).resolves.toEqual({ confirmed: true, value: { deleteBranch: false } });
  });

  it('resolves unconfirmed when the dialog is cancelled', async () => {
    const run = vi.fn(async () => true);
    const pending = dialogs.requestSessionDeletion({ sessionId: 's1', title: 'One', path: '/wt/a' }, run);
    await vi.waitFor(() => expect(dialogs.deleteDialog.value).not.toBeNull());

    dialogs.closeDeleteDialog();

    await expect(pending).resolves.toEqual({ confirmed: false });
    expect(run).not.toHaveBeenCalled();
    expect(dialogs.deleteDialog.value).toBeNull();
  });

  it('cannot be closed while the deletion is running', async () => {
    const running = deferred<boolean>();
    const pending = dialogs.requestSessionDeletion({ sessionId: 's1', title: 'One', path: '/wt/a' }, () => running.promise);
    await vi.waitFor(() => expect(dialogs.deleteDialog.value).not.toBeNull());
    dialogs.confirmDeletion();

    dialogs.closeDeleteDialog();
    expect(dialogs.deleteDialog.value).toMatchObject({ kind: 'session', busy: true });

    running.resolve(true);
    await expect(pending).resolves.toEqual({ confirmed: true, value: true });
  });

  it('hands back to the plain dialog when the worktree directory no longer exists', async () => {
    api.inspectWorktrees.mockResolvedValueOnce({ items: [], errors: { '/wt/a': { code: 40423, msg: 'not found' } } });

    await expect(
      dialogs.requestSessionDeletion({ sessionId: 's1', title: 'One', path: '/wt/a' }, async () => true),
    ).resolves.toEqual({ confirmed: false, directoryMissing: true });
    expect(dialogs.deleteDialog.value).toBeNull();
  });
});

describe('existing project prompt', () => {
  it('resolves with the chosen answer and closes', async () => {
    const pending = dialogs.askExistingWorktreeProject({ project: 'Repo', branch: 'kimi/a', sessionCount: 2 });
    expect(dialogs.projectPrompt.value).toEqual({ project: 'Repo', branch: 'kimi/a', sessionCount: 2 });
    expect(useConfirmDialog().isConfirmOpen.value).toBe(true);

    dialogs.answerExistingWorktreeProject('switch');

    await expect(pending).resolves.toBe('switch');
    expect(dialogs.projectPrompt.value).toBeNull();
    expect(useConfirmDialog().isConfirmOpen.value).toBe(false);
  });

  it('dismisses an unanswered prompt when another one replaces it', async () => {
    const first = dialogs.askExistingWorktreeProject({ project: 'One', sessionCount: 0 });
    const second = dialogs.askExistingWorktreeProject({ project: 'Two', sessionCount: 0 });

    await expect(first).resolves.toBe('dismiss');
    expect(dialogs.projectPrompt.value).toMatchObject({ project: 'Two' });
    dialogs.answerExistingWorktreeProject('create');
    await expect(second).resolves.toBe('create');
  });
});

describe('worktrees store additions', () => {
  it('keeps a failed session removal with the session name for this run', async () => {
    const store = await loadStore([item('a')]);

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
    await settled();
    expect(store.deletedSessionTitles).toEqual({});
  });

  it('only dismisses finished removals in the requested states', async () => {
    const store = await loadStore([item('a'), item('b'), item('c')]);
    const slow = deferred<{ removed: true; branchDeleted: boolean }>();
    api.removeWorktree
      .mockRejectedValueOnce(removeFailed('in_use', 'busy'))
      .mockReturnValueOnce(slow.promise);
    store.enqueueRemovals([{ path: '/wt/a' }, { path: '/wt/b' }, { path: '/wt/c' }]);
    await vi.waitFor(() => expect(store.removalFor('/wt/b')?.state).toBe('deleting'));

    store.dismissRemovals(['/wt/a', '/wt/b', '/wt/c'], ['deleted']);
    expect(store.removals.map((entry) => entry.state)).toEqual(['failed', 'deleting', 'waiting']);

    store.dismissRemovals(['/wt/a', '/wt/b', '/wt/c']);
    expect(store.removals.map((entry) => entry.state)).toEqual(['deleting', 'waiting']);

    slow.resolve({ removed: true, branchDeleted: false });
    await settled();
  });

  it('re-fetches the list while sizes are still being computed, a bounded number of times', async () => {
    vi.useFakeTimers();
    api.listWorktrees.mockResolvedValue({ items: [item('a', { sizeBytes: undefined })] });
    const store = worktreesStore();
    await store.load();
    expect(api.listWorktrees).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(WORKTREE_SIZE_BACKFILL_DELAY_MS);
    expect(api.listWorktrees).toHaveBeenCalledTimes(2);
    expect(api.listWorktrees).toHaveBeenLastCalledWith(undefined);
    expect(store.loading).toBe(false);

    await vi.advanceTimersByTimeAsync(WORKTREE_SIZE_BACKFILL_DELAY_MS * (WORKTREE_SIZE_BACKFILL_MAX_ATTEMPTS + 3));
    expect(api.listWorktrees).toHaveBeenCalledTimes(1 + WORKTREE_SIZE_BACKFILL_MAX_ATTEMPTS);
  });

  it('stops re-fetching once every size is known', async () => {
    vi.useFakeTimers();
    api.listWorktrees
      .mockResolvedValueOnce({ items: [item('a', { sizeBytes: undefined })] })
      .mockResolvedValue({ items: [item('a')], totalSizeBytes: 60 * MB });
    const store = worktreesStore();
    await store.load();

    await vi.advanceTimersByTimeAsync(WORKTREE_SIZE_BACKFILL_DELAY_MS * 4);

    expect(api.listWorktrees).toHaveBeenCalledTimes(2);
    expect(store.items[0]?.sizeBytes).toBe(60 * MB);
    expect(store.totalSizeBytes).toBe(60 * MB);
  });
});
