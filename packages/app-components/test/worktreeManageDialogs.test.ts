// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import type { AppWorktree, AppWorktreeRisk, WorktreeInspection } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { resetWorktreeManageDialogs, useWorktreeManageDialogs } from '@moonshot-ai/app-client/composables';
import { worktreesStore } from '@moonshot-ai/app-client/stores';
import { appWorktree, worktreeRemoveFailed, worktreeRisk } from '@moonshot-ai/app-client/testing';
import ManageDialogHost from '../src/worktree/ManageDialogHost.vue';

const i18n = createKimiI18n({ locale: 'en' });

type Removed = { removed: true; branchDeleted: boolean };

const api = {
  listWorktrees: vi.fn(),
  inspectWorktrees: vi.fn<(paths: string[]) => Promise<WorktreeInspection>>(),
  removeWorktree: vi.fn<(input: { path: string; deleteBranch?: boolean }) => Promise<Removed>>(),
};

const dialogs = useWorktreeManageDialogs();
let app: App | undefined;
let host: HTMLDivElement;
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

function label(selector: string): string | undefined {
  return document.body.querySelector(selector)?.textContent?.trim();
}

function sessionRef(id: string, title: string, archived = false) {
  return { id, title, archived, busy: false };
}

async function requestDeletion(paths: string[]): Promise<void> {
  await dialogs.requestWorktreeDeletion(paths);
  await nextTick();
}

async function setChecked(value: boolean): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>('.manage-delete__option input')!;
  input.checked = value;
  input.dispatchEvent(new Event('change'));
  await nextTick();
}

function until(check: () => void): Promise<void> {
  return vi.waitFor(check, { interval: 1 });
}

async function settled(): Promise<void> {
  await until(() => expect(worktreesStore().removals.some((item) => item.state === 'waiting' || item.state === 'deleting')).toBe(false));
  await nextTick();
  await nextTick();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  risks = {};
  for (const mock of Object.values(api)) mock.mockReset();
  api.inspectWorktrees.mockImplementation(async (paths) => ({
    items: paths.map((path) => worktreeRisk(path.split('/').at(-1)!, risks[path])),
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
  it('lists what is deleted with an unchecked branch option, then rewrites both rows once it is checked', async () => {
    seed([worktree('fix-login')]);
    risks['/wt/fix-login'] = { uncommittedFiles: 3, unpushedCommits: 2 };

    await requestDeletion(['/wt/fix-login']);

    expect(dialog()?.getAttribute('aria-label')).toBe('Delete Worktree');
    expect(rowTexts()).toEqual([
      'The Worktree directory for kimi/fix-login will be deleted.',
      '3 files are uncommitted and cannot be recovered after deletion.',
    ]);
    expect(rowIcons()).toEqual(['folder', 'alert-triangle']);
    expect(document.body.querySelector('.manage-delete-list')).toBeNull();
    expect(label('.manage-delete__option')).toBe('Also delete the local branch (remote branch retained)');
    expect(document.body.querySelector<HTMLInputElement>('.manage-delete__option input')?.checked).toBe(false);
    expect(label('.confirm-dialog__cancel')).toBe('Cancel');
    expect(label('.confirm-dialog__confirm')).toBe('Delete');

    await setChecked(true);

    expect(rowTexts()).toEqual([
      'The Worktree directory and local branch for kimi/fix-login will be deleted.',
      '3 files are uncommitted and 2 commits have not been pushed; these cannot be recovered after deletion.',
    ]);
  });

  it('hides the branch option for a worktree without a branch', async () => {
    seed([worktree('task-3', { branch: undefined })]);
    risks['/wt/task-3'] = { branch: undefined };
    await requestDeletion(['/wt/task-3']);

    expect(document.body.querySelector('.manage-delete__option')).toBeNull();
  });

  it('marks a directory name apart from a branch name in the list', async () => {
    seed([worktree('a'), worktree('b', { branch: undefined })]);
    risks['/wt/b'] = { branch: undefined };
    await requestDeletion(['/wt/a', '/wt/b']);

    const names = [...document.body.querySelectorAll('.manage-delete-list__name')];
    expect(names.map((name) => [name.textContent, name.classList.contains('is-directory')])).toEqual([
      ['kimi/a', false],
      ['b', true],
    ]);
  });

  it('closes without deleting on Cancel', async () => {
    seed([worktree('a')]);
    await requestDeletion(['/wt/a']);

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
      sessions: [sessionRef('s1', 'One'), sessionRef('s2', 'Two')],
    };

    await requestDeletion(['/wt/a', '/wt/b', '/wt/c']);

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
    expect(label('.confirm-dialog__confirm')).toBe('Delete 3 Worktrees');
  });
});

describe('deletion progress and result', () => {
  it('changes in place to a progress view with a background-close footer', async () => {
    seed([worktree('a'), worktree('b')]);
    const first = Promise.withResolvers<Removed>();
    api.removeWorktree.mockReturnValueOnce(first.promise);
    await requestDeletion(['/wt/a', '/wt/b']);
    const panel = dialog();

    button('.confirm-dialog__confirm').click();
    await nextTick();

    expect(dialog()).toBe(panel);
    expect(rowTexts()).toEqual(['Deleting | 0 / 2']);
    expect(listTexts()).toEqual(['kimi/a | Deleting', 'kimi/b | Waiting']);
    expect(document.body.querySelector('.manage-delete__option')).toBeNull();
    expect(document.body.querySelector('.confirm-dialog__cancel')).toBeNull();
    expect(label('.confirm-dialog__confirm')).toBe('Close and continue in background');

    button('.confirm-dialog__confirm').click();
    await nextTick();
    expect(dialog()).toBeNull();
    expect(worktreesStore().removalFor('/wt/a')?.state).toBe('deleting');

    first.resolve({ removed: true, branchDeleted: false });
    await settled();
    expect(api.removeWorktree).toHaveBeenCalledTimes(2);
  });

  it('stays on the result page with the failed row first, then retries it', async () => {
    seed([worktree('a'), worktree('b'), worktree('c')]);
    api.removeWorktree
      .mockResolvedValueOnce({ removed: true, branchDeleted: false })
      .mockResolvedValueOnce({ removed: true, branchDeleted: false })
      .mockRejectedValueOnce(worktreeRemoveFailed('in_use', 'Directory not empty'));
    await requestDeletion(['/wt/a', '/wt/b', '/wt/c']);

    button('.confirm-dialog__confirm').click();
    await settled();

    expect(listTexts()).toEqual(['kimi/c | Deletion failed', 'kimi/a | Deleted', 'kimi/b | Deleted']);
    expect(document.body.textContent).not.toContain('Directory not empty');
    expect(label('.confirm-dialog__cancel')).toBe('Retry Failed');
    expect(label('.confirm-dialog__confirm')).toBe('Done');

    const retry = Promise.withResolvers<Removed>();
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
    await requestDeletion(['/wt/a']);
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
    risks['/wt/a'] = { uncommittedFiles: 4, sessions: [sessionRef('s1', 'Fix login')] };
    const run = vi.fn(async (options: { deleteBranch: boolean }) => options);

    const pending = dialogs.requestSessionDeletion({ sessionId: 's1', title: 'Fix login', path: '/wt/a' }, run);
    await until(() => expect(dialog()).not.toBeNull());

    expect(dialog()?.getAttribute('aria-label')).toBe('Delete session');
    expect(rowIcons()).toEqual(['message', 'alert-triangle']);
    expect(label('.manage-delete__option')).toBe(
      'Also delete local branch kimi/a (remote branch retained)',
    );
    expect(label('.confirm-dialog__confirm')).toBe('Permanently delete');

    await setChecked(true);
    button('.confirm-dialog__confirm').click();

    await expect(pending).resolves.toEqual({ confirmed: true, value: { deleteBranch: true } });
    await nextTick();
    expect(dialog()).toBeNull();
  });

  it('retains the directory and offers no branch option while other sessions use it', async () => {
    risks['/wt/a'] = {
      uncommittedFiles: 4,
      sessions: [sessionRef('s1', 'Hello'), sessionRef('s2', 'Two'), sessionRef('s3', 'Three', true)],
    };
    const run = vi.fn(async (options: { deleteBranch: boolean }) => options);

    const pending = dialogs.requestSessionDeletion({ sessionId: 's1', title: 'Hello', path: '/wt/a' }, run);
    await until(() => expect(dialog()).not.toBeNull());

    expect(rowIcons()).toEqual(['message', 'folder']);
    expect(document.body.querySelector('.manage-delete__option')).toBeNull();

    button('.confirm-dialog__confirm').click();
    await expect(pending).resolves.toEqual({ confirmed: true, value: { deleteBranch: false } });
  });

  it('resolves unconfirmed when dismissed with the close button', async () => {
    const run = vi.fn(async () => true);
    const pending = dialogs.requestSessionDeletion({ sessionId: 's1', title: 'Hello', path: '/wt/a' }, run);
    await until(() => expect(dialog()).not.toBeNull());

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
    expect(label('.confirm-dialog__cancel')).toBe('Create New Project Anyway');
    expect(label('.confirm-dialog__confirm')).toBe('Switch to Existing Project');

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
