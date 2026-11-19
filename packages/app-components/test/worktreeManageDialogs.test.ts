// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { DaemonApiError, type AppWorktree, type AppWorktreeRisk, type WorktreeInspection } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { resetWorktreeManageDialogs, useWorktreeManageDialogs } from '@moonshot-ai/app-client/composables';
import { worktreesStore } from '@moonshot-ai/app-client/stores';
import ManageDialogHost from '../src/worktree/ManageDialogHost.vue';

const i18n = createKimiI18n({ locale: 'en' });

const api = {
  listWorktrees: vi.fn(),
  inspectWorktrees: vi.fn<(paths: string[]) => Promise<WorktreeInspection>>(),
  removeWorktree:
    vi.fn<(input: { path: string; deleteBranch?: boolean }) => Promise<{ removed: true; branchDeleted: boolean }>>(),
};

const dialogs = useWorktreeManageDialogs();
let app: App | undefined;
let host: HTMLDivElement;
let risks: Record<string, Partial<AppWorktreeRisk>>;

function worktree(name: string, overrides: Partial<AppWorktree> = {}): AppWorktree {
  return {
    path: `/wt/${name}`,
    name,
    repoRoot: '/repo',
    workspaceId: 'ws-1',
    workspaceName: 'kimi-code-app',
    branch: `kimi/${name}`,
    origin: 'product',
    sizeBytes: 1024 * 1024,
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

function seed(items: AppWorktree[]): void {
  const store = worktreesStore();
  store.items = items;
  store.loaded = true;
  api.listWorktrees.mockResolvedValue({ items });
}

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"]');
}

function rowTexts(): string[] {
  return [...document.body.querySelectorAll('.confirm-dialog__row')].map((row) =>
    [...row.querySelectorAll('.confirm-dialog__row-text, .confirm-dialog__row-trailing')]
      .map((part) => part.textContent?.trim())
      .join(' | '),
  );
}

function rowIcons(): (string | null)[] {
  return [...document.body.querySelectorAll('.confirm-dialog__row')].map(
    (row) => row.querySelector('[data-icon]')?.getAttribute('data-icon') ?? null,
  );
}

function listTexts(): string[] {
  return [...document.body.querySelectorAll('.manage-delete-list__item')].map((entry) =>
    [...entry.children].map((part) => part.textContent?.trim()).filter(Boolean).join(' | '),
  );
}

function button(selector: string): HTMLButtonElement {
  return document.body.querySelector<HTMLButtonElement>(selector)!;
}

async function setChecked(value: boolean): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>('.manage-delete__option input')!;
  input.checked = value;
  input.dispatchEvent(new Event('change'));
  await nextTick();
}

async function settled(): Promise<void> {
  await vi.waitFor(() => expect(worktreesStore().removalRunning).toBe(false));
  await nextTick();
  await nextTick();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  risks = {};
  for (const mock of Object.values(api)) mock.mockReset();
  api.inspectWorktrees.mockImplementation(async (paths) => ({
    items: paths.map((path) => ({
      path,
      branch: `kimi/${path.split('/').at(-1)!}`,
      uncommittedFiles: 0,
      unpushedCommits: 0,
      sessions: [],
      ...risks[path],
    })),
    errors: {},
  }));
  api.removeWorktree.mockResolvedValue({ removed: true, branchDeleted: false });
  setKimiClientDeps({
    api: () => api as never,
    t: (key, params) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params)),
  });
  worktreesStore().reset();
  resetWorktreeManageDialogs();
  app = createApp({ render: () => h(ManageDialogHost) });
  app.use(i18n);
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  resetWorktreeManageDialogs();
  worktreesStore().reset();
  resetKimiClientDeps();
  host.remove();
  document.body.innerHTML = '';
});

describe('single worktree deletion dialog', () => {
  it('lists what is deleted, the risk and an unchecked branch option', async () => {
    seed([worktree('fix-login')]);
    risks['/wt/fix-login'] = { uncommittedFiles: 3, unpushedCommits: 2 };

    await dialogs.requestWorktreeDeletion(['/wt/fix-login']);
    await nextTick();

    expect(dialog()?.getAttribute('aria-label')).toBe('Delete Worktree');
    expect(rowTexts()).toEqual([
      'The Worktree directory for kimi/fix-login will be deleted.',
      '3 files are uncommitted and cannot be recovered after deletion.',
    ]);
    expect(rowIcons()).toEqual(['folder', 'alert-triangle']);
    expect(document.body.querySelector('.manage-delete-list')).toBeNull();
    const option = document.body.querySelector('.manage-delete__option')!;
    expect(option.textContent?.trim()).toBe('Also delete the local branch (remote branch retained)');
    expect(option.querySelector<HTMLInputElement>('input')!.checked).toBe(false);
    expect(button('.confirm-dialog__cancel').textContent?.trim()).toBe('Cancel');
    expect(button('.confirm-dialog__confirm').textContent?.trim()).toBe('Delete');
  });

  it('rewrites both rows when branch deletion is checked', async () => {
    seed([worktree('fix-login')]);
    risks['/wt/fix-login'] = { uncommittedFiles: 3, unpushedCommits: 2 };
    await dialogs.requestWorktreeDeletion(['/wt/fix-login']);
    await nextTick();

    await setChecked(true);

    expect(rowTexts()).toEqual([
      'The Worktree directory and local branch for kimi/fix-login will be deleted.',
      '3 files are uncommitted and 2 commits have not been pushed; these cannot be recovered after deletion.',
    ]);
  });

  it('shows the no-risk wording for a clean worktree', async () => {
    seed([worktree('api-retry')]);
    await dialogs.requestWorktreeDeletion(['/wt/api-retry']);
    await nextTick();

    expect(rowTexts()[1]).toBe('There are no uncommitted files.');
    expect(rowIcons()[1]).toBe('circle-check');
    await setChecked(true);
    expect(rowTexts()[1]).toBe('There are no uncommitted or unpushed changes.');
  });

  it('hides the branch option for a worktree without a branch', async () => {
    seed([worktree('task-3', { branch: undefined })]);
    api.inspectWorktrees.mockResolvedValueOnce({
      items: [{ path: '/wt/task-3', uncommittedFiles: 0, unpushedCommits: 0, sessions: [] }],
      errors: {},
    });
    await dialogs.requestWorktreeDeletion(['/wt/task-3']);
    await nextTick();

    expect(document.body.querySelector('.manage-delete__option')).toBeNull();
    expect(rowTexts()[0]).toBe('The Worktree directory for task-3 will be deleted.');
  });

  it('closes without deleting on Cancel', async () => {
    seed([worktree('a')]);
    await dialogs.requestWorktreeDeletion(['/wt/a']);
    await nextTick();

    button('.confirm-dialog__cancel').click();
    await nextTick();

    expect(dialog()).toBeNull();
    expect(api.removeWorktree).not.toHaveBeenCalled();
  });
});

describe('batch deletion dialog', () => {
  it('shows the grey list with risky worktrees first and the batch wording', async () => {
    seed([worktree('a'), worktree('b'), worktree('c', { workspaceId: 'ws-2', workspaceName: 'demo' })]);
    risks['/wt/b'] = {
      uncommittedFiles: 3,
      unpushedCommits: 2,
      sessions: [
        { id: 's1', title: 'One', archived: false, busy: false },
        { id: 's2', title: 'Two', archived: false, busy: false },
      ],
    };

    await dialogs.requestWorktreeDeletion(['/wt/a', '/wt/b', '/wt/c']);
    await nextTick();

    expect(dialog()?.getAttribute('aria-label')).toBe('Delete Worktrees');
    expect(rowTexts()).toEqual([
      'Worktrees to delete | 3 total',
      '2 associated sessions will no longer be able to use these directories.',
      'Contents of 1 Worktree cannot be recovered after deletion.',
    ]);
    expect(listTexts()).toEqual([
      'kimi/b | kimi-code-app | 3 uncommitted files',
      'kimi/a | kimi-code-app',
      'kimi/c | demo',
    ]);
    const list = document.body.querySelector('.manage-delete-list')!;
    expect(list.previousElementSibling?.textContent).toContain('Worktrees to delete');
    expect(list.classList.contains('is-capped')).toBe(false);
    expect(button('.confirm-dialog__confirm').textContent?.trim()).toBe('Delete 3 Worktrees');

    await setChecked(true);
    expect(rowTexts()[0]).toBe('Worktrees and local branches to delete | 3 total');
    expect(listTexts()[0]).toBe('kimi/b | kimi-code-app | 3 uncommitted files, 2 unpushed commits');
  });

  it('sets a directory name in the UI font and a branch name in mono', async () => {
    seed([worktree('a'), worktree('b', { branch: undefined })]);
    risks['/wt/b'] = { branch: undefined };

    await dialogs.requestWorktreeDeletion(['/wt/a', '/wt/b']);
    await nextTick();

    const names = [...document.body.querySelectorAll('.manage-delete-list__name')];
    expect(names.map((name) => [name.textContent, name.classList.contains('is-directory')])).toEqual([
      ['kimi/a', false],
      ['b', true],
    ]);
  });

  it('caps the list once it holds more than three worktrees', async () => {
    seed([worktree('a'), worktree('b'), worktree('c'), worktree('d')]);

    await dialogs.requestWorktreeDeletion(['/wt/a', '/wt/b', '/wt/c', '/wt/d']);
    await nextTick();

    expect(listTexts()).toHaveLength(4);
    expect(document.body.querySelector('.manage-delete-list')!.classList.contains('is-capped')).toBe(true);
  });
});

describe('deletion progress and result', () => {
  it('changes in place to a progress view with a background-close footer', async () => {
    seed([worktree('a'), worktree('b')]);
    const first = deferred<{ removed: true; branchDeleted: boolean }>();
    api.removeWorktree.mockReturnValueOnce(first.promise);
    await dialogs.requestWorktreeDeletion(['/wt/a', '/wt/b']);
    await nextTick();
    const panel = dialog();

    button('.confirm-dialog__confirm').click();
    await nextTick();

    expect(dialog()).toBe(panel);
    expect(rowTexts()).toEqual(['Deleting | 0 / 2']);
    expect(listTexts()).toEqual(['kimi/a | Deleting', 'kimi/b | Waiting']);
    expect(document.body.querySelector('.manage-delete__option')).toBeNull();
    expect(document.body.querySelector('.confirm-dialog__cancel')).toBeNull();
    expect(button('.confirm-dialog__confirm').textContent?.trim()).toBe('Close and continue in background');

    button('.confirm-dialog__confirm').click();
    await nextTick();
    expect(dialog()).toBeNull();
    expect(worktreesStore().removalFor('/wt/a')?.state).toBe('deleting');

    first.resolve({ removed: true, branchDeleted: false });
    await settled();
    expect(api.removeWorktree).toHaveBeenCalledTimes(2);
  });

  it('closes by itself when every deletion succeeds', async () => {
    seed([worktree('a')]);
    await dialogs.requestWorktreeDeletion(['/wt/a']);
    await nextTick();

    button('.confirm-dialog__confirm').click();
    await settled();

    expect(dialog()).toBeNull();
  });

  it('stays on the result page with the failed row first, then retries it', async () => {
    seed([worktree('a'), worktree('b'), worktree('c')]);
    api.removeWorktree
      .mockResolvedValueOnce({ removed: true, branchDeleted: false })
      .mockResolvedValueOnce({ removed: true, branchDeleted: false })
      .mockRejectedValueOnce(
        new DaemonApiError({
          code: 40937,
          msg: 'remove failed',
          requestId: 'r1',
          details: { reason: 'in_use', output: 'Directory not empty' },
        }),
      );
    await dialogs.requestWorktreeDeletion(['/wt/a', '/wt/b', '/wt/c']);
    await nextTick();

    button('.confirm-dialog__confirm').click();
    await settled();

    expect(rowTexts()).toEqual(['2 Worktrees deleted; 1 deletion failed']);
    expect(listTexts()).toEqual(['kimi/c | Deletion failed', 'kimi/a | Deleted', 'kimi/b | Deleted']);
    expect(document.body.textContent).not.toContain('Directory not empty');
    expect(button('.confirm-dialog__cancel').textContent?.trim()).toBe('Retry Failed');
    expect(button('.confirm-dialog__confirm').textContent?.trim()).toBe('Done');

    const retry = deferred<{ removed: true; branchDeleted: boolean }>();
    api.removeWorktree.mockReturnValueOnce(retry.promise);
    button('.confirm-dialog__cancel').click();
    await nextTick();
    expect(rowTexts()).toEqual(['Deleting | 0 / 1']);
    expect(listTexts()).toEqual(['kimi/c | Deleting']);

    retry.resolve({ removed: true, branchDeleted: false });
    await settled();
    expect(dialog()).toBeNull();
  });

  it('closes the result page on Done and keeps the failure for the management page', async () => {
    seed([worktree('a')]);
    api.removeWorktree.mockRejectedValueOnce(new Error('boom'));
    await dialogs.requestWorktreeDeletion(['/wt/a']);
    await nextTick();
    button('.confirm-dialog__confirm').click();
    await settled();
    expect(rowTexts()).toEqual(['Deletion of kimi/a failed']);

    button('.confirm-dialog__confirm').click();
    await nextTick();

    expect(dialog()).toBeNull();
    expect(worktreesStore().removalFor('/wt/a')).toMatchObject({ state: 'failed', output: 'boom' });
  });
});

describe('worktree session deletion dialog', () => {
  it('keeps the Delete Session title and names the branch in the option', async () => {
    risks['/wt/a'] = { uncommittedFiles: 4, sessions: [{ id: 's1', title: 'Fix login', archived: false, busy: false }] };
    const run = vi.fn(async (options: { deleteBranch: boolean }) => options);

    const pending = dialogs.requestSessionDeletion({ sessionId: 's1', title: 'Fix login', path: '/wt/a' }, run);
    await vi.waitFor(() => expect(dialog()).not.toBeNull());

    expect(dialog()?.getAttribute('aria-label')).toBe('Delete session');
    expect(rowTexts()).toEqual([
      'The conversation history and Worktree directory for "Fix login" will be permanently deleted and cannot be recovered.',
      '4 files are uncommitted and cannot be recovered after deletion.',
    ]);
    expect(rowIcons()).toEqual(['message', 'alert-triangle']);
    expect(document.body.querySelector('.manage-delete__option')?.textContent?.trim()).toBe(
      'Also delete local branch kimi/a (remote branch retained)',
    );
    expect(button('.confirm-dialog__confirm').textContent?.trim()).toBe('Permanently delete');

    await setChecked(true);
    button('.confirm-dialog__confirm').click();

    await expect(pending).resolves.toEqual({ confirmed: true, value: { deleteBranch: true } });
    await nextTick();
    expect(dialog()).toBeNull();
  });

  it('retains the directory and offers no branch option while other sessions use it', async () => {
    risks['/wt/a'] = {
      uncommittedFiles: 4,
      sessions: [
        { id: 's1', title: 'Hello', archived: false, busy: false },
        { id: 's2', title: 'Two', archived: false, busy: false },
        { id: 's3', title: 'Three', archived: true, busy: false },
      ],
    };
    const run = vi.fn(async (options: { deleteBranch: boolean }) => options);

    const pending = dialogs.requestSessionDeletion({ sessionId: 's1', title: 'Hello', path: '/wt/a' }, run);
    await vi.waitFor(() => expect(dialog()).not.toBeNull());

    expect(rowTexts()).toEqual([
      'The conversation history for "Hello" will be permanently deleted and cannot be recovered.',
      'The Worktree directory will be retained because 2 other sessions are using it.',
    ]);
    expect(rowIcons()).toEqual(['message', 'folder']);
    expect(document.body.querySelector('.manage-delete__option')).toBeNull();

    button('.confirm-dialog__confirm').click();
    await expect(pending).resolves.toEqual({ confirmed: true, value: { deleteBranch: false } });
  });

  it('resolves unconfirmed when dismissed with the close button', async () => {
    const run = vi.fn(async () => true);
    const pending = dialogs.requestSessionDeletion({ sessionId: 's1', title: 'Hello', path: '/wt/a' }, run);
    await vi.waitFor(() => expect(dialog()).not.toBeNull());

    button('.ui-dialog__close').click();

    await expect(pending).resolves.toEqual({ confirmed: false });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('existing project prompt', () => {
  it('shows the worktree row, the session warning and both choices', async () => {
    const pending = dialogs.askExistingWorktreeProject({ project: 'repo', branch: 'kimi/1109-a3f2', sessionCount: 2 });
    await nextTick();

    expect(dialog()?.getAttribute('aria-label')).toBe('This directory belongs to an existing project');
    expect(rowTexts()).toEqual([
      'This directory is a worktree of repo (kimi/1109-a3f2).',
      '2 sessions are already using this worktree. Concurrent changes may overwrite one another.',
    ]);
    expect(rowIcons()).toEqual(['git-fork', 'alert-triangle']);
    expect(button('.confirm-dialog__cancel').textContent?.trim()).toBe('Create New Project Anyway');
    expect(button('.confirm-dialog__confirm').textContent?.trim()).toBe('Switch to Existing Project');

    button('.confirm-dialog__confirm').click();
    await expect(pending).resolves.toBe('switch');
    await nextTick();
    expect(dialog()).toBeNull();
  });

  it('omits the warning when no session uses the worktree', async () => {
    const pending = dialogs.askExistingWorktreeProject({ project: 'repo', branch: 'feature/login', sessionCount: 0 });
    await nextTick();

    expect(rowTexts()).toEqual(['This directory is a worktree of repo (feature/login).']);

    button('.confirm-dialog__cancel').click();
    await expect(pending).resolves.toBe('create');
  });

  it('treats the close button as neither choice', async () => {
    const pending = dialogs.askExistingWorktreeProject({ project: 'repo', sessionCount: 0 });
    await nextTick();
    expect(rowTexts()).toEqual(['This directory is a worktree of repo.']);

    button('.ui-dialog__close').click();

    await expect(pending).resolves.toBe('dismiss');
  });
});
