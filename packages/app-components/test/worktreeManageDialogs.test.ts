// @vitest-environment jsdom
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppWorktree, AppWorktreeRisk, RemoveWorktreeResult } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { resetWorktreeManageDialogs, useWorktreeManageDialogs } from '@moonshot-ai/app-client/composables';
import { worktreesStore } from '@moonshot-ai/app-client/stores';
import {
  appWorktree,
  sessionRef,
  whenRemovalsSettled,
  worktreeManageApi,
  worktreeRemoveFailed,
  worktreeRisk,
} from '@moonshot-ai/app-client/testing';
import ManageDialogHost from '../src/worktree/ManageDialogHost.vue';
import { cleanup, msg, render, screen, textOf, within } from './helpers/dom';

const api = worktreeManageApi();
const dialogs = useWorktreeManageDialogs();
let risks: Record<string, Partial<AppWorktreeRisk>>;

function worktree(name: string, overrides: Partial<AppWorktree> = {}): AppWorktree {
  return appWorktree(name, { workspaceName: 'kimi-code-app', sizeBytes: 1024 * 1024, ...overrides });
}

function seed(items: AppWorktree[]): void {
  const store = worktreesStore();
  store.items = items;
  store.loaded = true;
  api.listWorktrees.mockResolvedValue({ items });
}

function dialog(name?: string): HTMLElement {
  return screen.getByRole('dialog', name === undefined ? {} : { name });
}

function dialogText(): string {
  return textOf(dialog());
}

function button(name: string): HTMLButtonElement {
  return within(dialog()).getByRole('button', { name }) as HTMLButtonElement;
}

function listItems(): string[] {
  return within(dialog()).queryAllByRole('listitem').map((item) => textOf(item));
}

function branchOption(): HTMLInputElement | null {
  return within(dialog()).queryByRole('checkbox') as HTMLInputElement | null;
}

function entry(name: string, state: string): unknown {
  return expect.stringMatching(new RegExp(`^${name}\\b.*${msg(state)}$`));
}

async function requestDeletion(paths: string[]): Promise<void> {
  await dialogs.requestWorktreeDeletion(paths);
  await nextTick();
}

async function settled(): Promise<void> {
  await whenRemovalsSettled(worktreesStore());
  await nextTick();
  await nextTick();
}

async function opened(): Promise<void> {
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeNull(), { interval: 1 });
}

beforeEach(() => {
  risks = {};
  for (const mock of Object.values(api)) mock.mockReset();
  api.inspectWorktrees.mockImplementation(async (paths) => ({
    items: paths.map((path) => worktreeRisk(path.split('/').at(-1)!, risks[path])),
    errors: {},
  }));
  api.removeWorktree.mockResolvedValue({ removed: true, branchDeleted: false });
  setKimiClientDeps({ api: () => api as never, t: (key, params) => msg(key, params) });
  worktreesStore().reset();
  resetWorktreeManageDialogs();
  render(ManageDialogHost);
});

afterEach(() => {
  cleanup();
  resetWorktreeManageDialogs();
  worktreesStore().reset();
  resetKimiClientDeps();
  document.body.innerHTML = '';
});

describe('single worktree deletion dialog', () => {
  it('starts with the branch kept and warns about more loss once the branch is included', async () => {
    seed([worktree('fix-login')]);
    risks['/wt/fix-login'] = { uncommittedFiles: 3, unpushedCommits: 2 };

    await requestDeletion(['/wt/fix-login']);

    expect(dialog(msg('worktreeManage.dialogTitle'))).toBeTruthy();
    expect(dialogText()).toContain(msg('worktreeManage.targetDirectory', { branch: 'kimi/fix-login' }));
    expect(dialogText()).toContain(msg('worktreeManage.filesUncommitted', { n: 3 }));
    expect(dialogText()).not.toContain(msg('worktreeManage.commitsUnpushed', { n: 2 }));
    expect(within(dialog()).queryByRole('list')).toBeNull();
    expect(button(msg('common.cancel'))).toBeTruthy();
    expect(button(msg('worktreeManage.confirmDelete'))).toBeTruthy();
    const option = within(dialog()).getByRole('checkbox', { name: msg('worktreeManage.alsoDeleteBranch') }) as HTMLInputElement;
    expect(option.checked).toBe(false);

    option.click();
    await nextTick();

    expect(dialogs.deleteDialog.value).toMatchObject({ deleteBranch: true });
    expect(dialogText()).toContain(msg('worktreeManage.targetDirectoryAndBranch', { branch: 'kimi/fix-login' }));
    expect(dialogText()).toContain(msg('worktreeManage.commitsUnpushed', { n: 2 }));
  });

  it('offers no branch option for a worktree without a branch', async () => {
    seed([worktree('task-3', { branch: undefined })]);
    risks['/wt/task-3'] = { branch: undefined };
    await requestDeletion(['/wt/task-3']);

    expect(branchOption()).toBeNull();
  });

  it('marks a directory name apart from a branch name in the list', async () => {
    seed([worktree('a'), worktree('b', { branch: undefined })]);
    risks['/wt/b'] = { branch: undefined };
    await requestDeletion(['/wt/a', '/wt/b']);

    const [branchItem, directoryItem] = within(dialog()).getAllByRole('listitem');
    expect(within(branchItem!).getByText('kimi/a').classList.contains('is-directory')).toBe(false);
    expect(within(directoryItem!).getByText('b').classList.contains('is-directory')).toBe(true);
  });

  it('closes without deleting on Cancel', async () => {
    seed([worktree('a')]);
    await requestDeletion(['/wt/a']);

    button(msg('common.cancel')).click();
    await nextTick();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.removeWorktree).not.toHaveBeenCalled();
  });
});

describe('batch deletion dialog', () => {
  it('lists risky worktrees first with their project and loss', async () => {
    seed([worktree('a'), worktree('b'), worktree('c', { workspaceId: 'ws-2', workspaceName: 'demo' })]);
    risks['/wt/b'] = { uncommittedFiles: 3, unpushedCommits: 2 };

    await requestDeletion(['/wt/a', '/wt/b', '/wt/c']);

    expect(dialog(msg('worktreeManage.dialogTitleBatch'))).toBeTruthy();
    expect(dialogText()).toContain(msg('worktreeManage.targetList'));
    expect(listItems()).toEqual([
      `kimi/b kimi-code-app ${msg('worktreeManage.shortUncommitted', { n: 3 })}`,
      'kimi/a kimi-code-app',
      'kimi/c demo',
    ]);
    expect(within(dialog()).getByRole('list').classList.contains('is-capped')).toBe(false);
    expect(button(msg('worktreeManage.confirmDeleteBatch', { n: 3 }))).toBeTruthy();
  });
});

describe('deletion progress and result', () => {
  it('turns into a progress view that can be closed while deletion continues', async () => {
    seed([worktree('a'), worktree('b')]);
    const first = Promise.withResolvers<RemoveWorktreeResult>();
    api.removeWorktree.mockReturnValueOnce(first.promise);
    await requestDeletion(['/wt/a', '/wt/b']);
    const panel = dialog();

    button(msg('worktreeManage.confirmDeleteBatch', { n: 2 })).click();
    await nextTick();

    expect(dialog()).toBe(panel);
    expect(dialogText()).toContain(`${msg('worktreeManage.progressTitle')} ${msg('worktreeManage.progressCount', { done: 0, total: 2 })}`);
    expect(listItems()).toEqual([entry('kimi/a', 'worktreeManage.stateDeleting'), entry('kimi/b', 'worktreeManage.stateWaiting')]);
    expect(branchOption()).toBeNull();
    expect(within(dialog()).queryByRole('button', { name: msg('common.cancel') })).toBeNull();
    expect(api.removeWorktree).toHaveBeenCalledWith({ path: '/wt/a', deleteBranch: false });

    button(msg('worktreeManage.continueInBackground')).click();
    await nextTick();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(worktreesStore().removalFor('/wt/a')?.state).toBe('deleting');

    first.resolve({ removed: true, branchDeleted: false });
    await settled();
    expect(api.removeWorktree).toHaveBeenCalledTimes(2);
    expect(api.removeWorktree).toHaveBeenLastCalledWith({ path: '/wt/b', deleteBranch: false });
  });

  it('stays on the result with the failure first, keeps its output out of the dialog and retries it', async () => {
    seed([worktree('a'), worktree('b'), worktree('c')]);
    api.removeWorktree
      .mockResolvedValueOnce({ removed: true, branchDeleted: false })
      .mockResolvedValueOnce({ removed: true, branchDeleted: false })
      .mockRejectedValueOnce(worktreeRemoveFailed('in_use', 'Directory not empty'));
    await requestDeletion(['/wt/a', '/wt/b', '/wt/c']);

    button(msg('worktreeManage.confirmDeleteBatch', { n: 3 })).click();
    await settled();

    expect(listItems()).toEqual([
      entry('kimi/c', 'worktreeManage.stateFailed'),
      entry('kimi/a', 'worktreeManage.stateDeleted'),
      entry('kimi/b', 'worktreeManage.stateDeleted'),
    ]);
    expect(dialogText()).not.toContain('Directory not empty');
    expect(worktreesStore().removals.map((entry) => [entry.path, entry.state, entry.reason, entry.output])).toEqual([
      ['/wt/c', 'failed', 'in_use', 'Directory not empty'],
    ]);
    expect(button(msg('worktreeManage.done'))).toBeTruthy();

    const retry = Promise.withResolvers<RemoveWorktreeResult>();
    api.removeWorktree.mockReturnValueOnce(retry.promise);
    button(msg('worktreeManage.retryFailed')).click();
    await nextTick();
    expect(api.removeWorktree).toHaveBeenLastCalledWith({ path: '/wt/c', deleteBranch: false });
    expect(dialogText()).toContain(msg('worktreeManage.progressCount', { done: 0, total: 1 }));
    expect(listItems()).toEqual([entry('kimi/c', 'worktreeManage.stateDeleting')]);

    retry.resolve({ removed: true, branchDeleted: false });
    await settled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(worktreesStore().removals).toEqual([]);
  });

  it('closes the result on Done and keeps the failure for the management page', async () => {
    seed([worktree('a')]);
    api.removeWorktree.mockRejectedValueOnce(new Error('boom'));
    await requestDeletion(['/wt/a']);
    button(msg('worktreeManage.confirmDelete')).click();
    await settled();
    expect(dialogText()).toContain(msg('worktreeManage.summarySingleFailed', { name: 'kimi/a' }));

    button(msg('worktreeManage.done')).click();
    await nextTick();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(worktreesStore().removalFor('/wt/a')).toMatchObject({ state: 'failed', output: 'boom' });
  });
});

describe('worktree session deletion dialog', () => {
  it('keeps the Delete Session title and resolves with the chosen branch option', async () => {
    risks['/wt/a'] = { uncommittedFiles: 4, sessions: [sessionRef('s1', 'Fix login')] };
    const run = vi.fn(async (options: { deleteBranch: boolean }) => options);

    const pending = dialogs.requestSessionDeletion({ sessionId: 's1', title: 'Fix login', path: '/wt/a' }, run);
    await opened();

    expect(dialog(msg('sidebar.deleteConfirmTitle'))).toBeTruthy();
    expect(dialogText()).toContain(msg('worktreeManage.sessionTarget', { title: 'Fix login' }));
    expect(dialogText()).toContain(msg('worktreeManage.filesUncommitted', { n: 4 }));
    within(dialog()).getByRole('checkbox', { name: msg('worktreeManage.alsoDeleteNamedBranch', { branch: 'kimi/a' }) }).click();
    await nextTick();
    button(msg('sidebar.deleteConfirmButton')).click();

    await expect(pending).resolves.toEqual({ confirmed: true, value: { deleteBranch: true } });
    expect(run).toHaveBeenCalledWith({ deleteBranch: true });
    await nextTick();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('retains the directory and offers no branch option while other sessions use it', async () => {
    risks['/wt/a'] = {
      uncommittedFiles: 4,
      sessions: [sessionRef('s1', 'Hello'), sessionRef('s2', 'Two'), sessionRef('s3', 'Three', { archived: true })],
    };
    const run = vi.fn(async (options: { deleteBranch: boolean }) => options);

    const pending = dialogs.requestSessionDeletion({ sessionId: 's1', title: 'Hello', path: '/wt/a' }, run);
    await opened();

    expect(dialogText()).toContain(msg('worktreeManage.sessionTargetShared', { title: 'Hello' }));
    expect(dialogText()).not.toContain(msg('worktreeManage.filesUncommitted', { n: 4 }));
    expect(branchOption()).toBeNull();

    button(msg('sidebar.deleteConfirmButton')).click();
    await expect(pending).resolves.toEqual({ confirmed: true, value: { deleteBranch: false } });
  });

  it('resolves unconfirmed when dismissed with the close button', async () => {
    const run = vi.fn(async () => true);
    const pending = dialogs.requestSessionDeletion({ sessionId: 's1', title: 'Hello', path: '/wt/a' }, run);
    await opened();

    button(msg('common.close')).click();

    await expect(pending).resolves.toEqual({ confirmed: false });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('existing project prompt', () => {
  const warning = () => dialog().querySelector('.confirm-dialog__row--warning');

  it('warns about sessions sharing the worktree and resolves Switch', async () => {
    const pending = dialogs.askExistingWorktreeProject({ project: 'repo', branch: 'kimi/1109-a3f2', sessionCount: 2 });
    await nextTick();

    expect(dialog(msg('worktreeManage.existingProjectTitle'))).toBeTruthy();
    expect(dialogText()).toContain(msg('worktreeManage.existingProjectBody', { project: 'repo', branch: 'kimi/1109-a3f2' }));
    expect(textOf(warning())).toBe(msg('worktreeManage.existingProjectSessions', { n: 2 }));
    expect(button(msg('worktreeManage.existingProjectCreate'))).toBeTruthy();

    button(msg('worktreeManage.existingProjectSwitch')).click();
    await expect(pending).resolves.toBe('switch');
    await nextTick();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('omits the warning when no session uses the worktree and resolves Create', async () => {
    const pending = dialogs.askExistingWorktreeProject({ project: 'repo', branch: 'feature/login', sessionCount: 0 });
    await nextTick();

    expect(dialogText()).toContain(msg('worktreeManage.existingProjectBody', { project: 'repo', branch: 'feature/login' }));
    expect(warning()).toBeNull();

    button(msg('worktreeManage.existingProjectCreate')).click();
    await expect(pending).resolves.toBe('create');
  });

  it('treats the close button as neither choice', async () => {
    const pending = dialogs.askExistingWorktreeProject({ project: 'repo', sessionCount: 0 });
    await nextTick();
    expect(dialogText()).toContain(msg('worktreeManage.existingProjectBodyNoBranch', { project: 'repo' }));

    button(msg('common.close')).click();

    await expect(pending).resolves.toBe('dismiss');
  });
});
