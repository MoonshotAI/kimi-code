// @vitest-environment jsdom
import { nextTick, type Component } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToastOptions } from '@moonshot-ai/app-ui';
import type { AppWorkspace, WorkspaceGitBranches } from '@moonshot-ai/app-core/api';
import { onToast, resetKimiClientDeps, setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { registerWorktreeSettingsOpener, useNewSessionEnvironment } from '@moonshot-ai/app-client/composables';
import { workspacesStore, worktreesStore } from '@moonshot-ai/app-client/stores';
import { memoryStorage } from '@moonshot-ai/app-client/testing';
import CreateEnvironmentPicker from '../src/worktree/CreateEnvironmentPicker.vue';
import CreateSourceBranchPicker from '../src/worktree/CreateSourceBranchPicker.vue';
import { cleanup, containing, msg, pointerDown, press, render, settle, textOf, typeInto, within, type Rendered } from './helpers/dom';

const GB = 1024 * 1024 * 1024;

const api = {
  getWorkspaceGitBranches: vi.fn<(workspaceId: string) => Promise<WorkspaceGitBranches>>(),
  listWorktrees: vi.fn(),
};

const repo: WorkspaceGitBranches = {
  isRepo: true,
  headBranch: 'main',
  dirty: true,
  remotes: ['origin'],
  branches: [
    {
      name: 'feature/login',
      committedAt: '2026-11-18T00:00:00.000Z',
      remoteRef: 'origin/feature/login',
      remote: 'origin',
      remoteSource: 'upstream',
    },
    { name: 'local-only', committedAt: '2026-11-17T00:00:00.000Z' },
    {
      name: 'main',
      committedAt: '2026-11-16T00:00:00.000Z',
      remoteRef: 'origin/main',
      remote: 'origin',
      remoteSource: 'upstream',
    },
  ],
};

const notRepo: WorkspaceGitBranches = { isRepo: false, dirty: false, remotes: [], branches: [] };

function workspace(id: string, extra: Partial<AppWorkspace> = {}): AppWorkspace {
  return { id, root: `/repo/${id}`, name: id, kind: 'managed', additionalDirs: [], sessionCount: 0, ...extra };
}

let rendered: Rendered | null = null;
let toasts: ToastOptions[] = [];
let stopToasts: (() => void) | undefined;

const environment = () => useNewSessionEnvironment();
const view = () => within(rendered!.host);

function mount(component: Component, props: Record<string, unknown>): void {
  rendered = render(component, props);
}

async function loadBranches(info: WorkspaceGitBranches): Promise<void> {
  api.getWorkspaceGitBranches.mockResolvedValue(info);
  await environment().refreshBranches('ws1');
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  for (const mock of Object.values(api)) mock.mockReset();
  api.getWorkspaceGitBranches.mockResolvedValue(repo);
  api.listWorktrees.mockResolvedValue({ items: [], totalSizeBytes: 0 });
  setKimiClientDeps({ api: () => api as never, t: (key, params) => msg(key, params ?? {}) });
  workspacesStore().workspaces = [workspace('ws1'), workspace('ws2'), workspace('remote', { hostId: 'h1' })];
  environment().reset();
  worktreesStore().reset();
  toasts = [];
  stopToasts = onToast((event) => {
    if (event.type === 'show' && event.options) toasts.push(event.options);
  });
});

afterEach(() => {
  cleanup();
  rendered = null;
  stopToasts?.();
  resetKimiClientDeps();
  vi.unstubAllGlobals();
});

describe('CreateEnvironmentPicker', () => {
  const chipName = (option: 'local' | 'worktree') =>
    `${msg('worktreeCreate.environment.label')}: ${msg(`worktreeCreate.environment.${option}`)}`;
  const chip = () => view().getByRole('button', { name: new RegExp(`^${msg('worktreeCreate.environment.label')}: `) });
  const menu = () => view().queryByRole('menu', { name: msg('worktreeCreate.environment.label') });
  const option = (id: 'local' | 'worktree') =>
    view().getByRole('menuitemradio', { name: new RegExp(`^${msg(`worktreeCreate.environment.${id}`)} `) });
  const checking = () => within(option('worktree')).queryByRole('status', { name: msg('worktreeCreate.environment.checking') });

  async function mountOpen(): Promise<void> {
    mount(CreateEnvironmentPicker, { workspaceId: 'ws1' });
    await nextTick();
    chip().click();
    await settle();
  }

  it('starts on Local and enables Worktree once the project is known to be a Git repository', async () => {
    const branches = Promise.withResolvers<WorkspaceGitBranches>();
    api.getWorkspaceGitBranches.mockReturnValueOnce(branches.promise);
    await mountOpen();

    expect(chip().getAttribute('aria-label')).toBe(chipName('local'));
    expect(chip().getAttribute('aria-haspopup')).toBe('menu');
    expect(chip().getAttribute('aria-expanded')).toBe('true');
    expect(option('local').getAttribute('aria-checked')).toBe('true');
    expect(option('worktree').getAttribute('aria-disabled')).toBe('true');
    expect(checking()).not.toBeNull();
    option('worktree').click();
    expect(environment().preferred).toBe('local');

    branches.resolve(repo);
    await settle();
    expect(option('worktree').getAttribute('aria-disabled')).toBe('false');
    expect(checking()).toBeNull();

    option('worktree').click();
    await settle();
    expect(environment().preferred).toBe('worktree');
    expect(menu()).toBeNull();
    expect(chip().getAttribute('aria-label')).toBe(chipName('worktree'));
    expect(chip().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(chip());
  });

  it('disables Worktree with the reason for a project that is not a Git repository and falls back to Local', async () => {
    api.getWorkspaceGitBranches.mockResolvedValue(notRepo);
    environment().selectEnvironment('worktree');
    await mountOpen();

    expect(chip().getAttribute('aria-label')).toBe(chipName('local'));
    expect(option('worktree').getAttribute('aria-disabled')).toBe('true');
    expect(textOf(option('worktree'))).toContain(msg('worktreeCreate.environment.notGitRepo'));
    expect(checking()).toBeNull();
    expect(option('local').getAttribute('aria-checked')).toBe('true');
  });

  it('rechecks on open and enables a repository that became available', async () => {
    await loadBranches(notRepo);
    const branches = Promise.withResolvers<WorkspaceGitBranches>();
    api.getWorkspaceGitBranches.mockReturnValueOnce(branches.promise);
    await mountOpen();
    expect(checking()).not.toBeNull();

    branches.resolve(repo);
    await settle();
    expect(option('worktree').getAttribute('aria-disabled')).toBe('false');
    expect(checking()).toBeNull();
  });

  it('focuses the menu and supports arrow keys, Enter and Esc', async () => {
    await mountOpen();

    expect(document.activeElement).toBe(menu());
    press(menu()!, 'ArrowDown');
    await nextTick();
    expect(option('worktree').classList.contains('active')).toBe(true);
    press(menu()!, 'Enter');
    await settle();
    expect(environment().preferred).toBe('worktree');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(chip());

    chip().click();
    await settle();
    expect(document.activeElement).toBe(menu());
    press(menu()!, 'Escape');
    await nextTick();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(chip());
    expect(environment().preferred).toBe('worktree');
  });

  it('reminds about disk usage for 8 seconds with a Manage action after choosing Worktree', async () => {
    api.listWorktrees.mockResolvedValue({ items: [], totalSizeBytes: 5.3 * GB });
    const openSettings = vi.fn();
    registerWorktreeSettingsOpener(openSettings);
    await mountOpen();
    option('worktree').click();
    await vi.waitFor(() => expect(toasts).toHaveLength(1));

    expect(toasts[0]).toMatchObject({
      layout: 'bar',
      title: msg('worktreeCreate.disk.reminder', { size: '5.3 GB' }),
      duration: 8000,
    });
    expect(toasts[0]?.actions?.map((action) => action.label)).toEqual([msg('worktreeManage.manage')]);
    const dismiss = vi.fn();
    await toasts[0]?.actions?.[0]?.onClick({ dismiss });
    expect(dismiss).toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalled();
    expect(worktreesStore().shouldRemindDiskUsage).toBe(false);
  });
});

describe('CreateSourceBranchPicker', () => {
  const chipName = (branch: string) => `${msg('worktreeCreate.branch.label')}: ${branch}`;
  const chip = () => view().getByRole('button', { name: new RegExp(`^${msg('worktreeCreate.branch.label')}: `) });
  const panel = () => view().queryByRole('dialog', { name: msg('worktreeCreate.branch.label') });
  const search = () => view().getByRole('textbox', { name: msg('worktreeCreate.branch.searchPlaceholder') }) as HTMLInputElement;
  const options = () => view().queryAllByRole('option');
  const optionNames = () => options().map((item) => textOf(item));
  const branchOption = (branch: string) => view().getByRole('option', { name: new RegExp(`^${branch}( \\w+)?$`) });
  const localChangesOption = () =>
    view().queryByRole('option', { name: containing(msg('worktreeCreate.branch.includeLocalChangesHint')) });
  const selected = () => view().getAllByRole('option').filter((item) => item.getAttribute('aria-selected') === 'true');
  const active = () => view().getAllByRole('option').find((item) => item.classList.contains('active'));
  const remoteSwitch = () => view().queryByRole('switch', { name: msg('worktreeCreate.branch.useRemote') });
  const glyph = () => chip().querySelector<HTMLElement>('[data-glyph]')!;

  async function mountOpen(info: WorkspaceGitBranches = repo): Promise<void> {
    await loadBranches(info);
    environment().selectEnvironment('worktree');
    mount(CreateSourceBranchPicker, { workspaceId: 'ws1' });
    await settle();
    chip().click();
    await settle();
  }

  it('is hidden in Local mode and names the selected branch in Worktree mode', async () => {
    await loadBranches(repo);
    mount(CreateSourceBranchPicker, { workspaceId: 'ws1' });
    await nextTick();
    expect(view().queryByRole('button')).toBeNull();

    environment().selectEnvironment('worktree');
    await settle();
    expect(chip().getAttribute('aria-label')).toBe(chipName('main'));
    expect(chip().getAttribute('aria-haspopup')).toBe('dialog');
    expect(glyph().dataset.glyph).toBe('worktree-branch');
    expect(glyph().classList.contains('has-dot')).toBe(false);
  });

  it('opens with the search focused, local changes first and branches by recency', async () => {
    await mountOpen();

    expect(panel()).not.toBeNull();
    expect(document.activeElement).toBe(search());
    expect(api.getWorkspaceGitBranches).toHaveBeenCalledWith('ws1');
    const listbox = view().getByRole('listbox');
    expect(textOf(listbox)).toContain(msg('worktreeCreate.branch.localFileStatus'));
    expect(textOf(listbox)).toContain(msg('worktreeCreate.branch.localBranches'));
    expect(optionNames()).toEqual([
      `main ${msg('worktreeCreate.branch.includeLocalChangesHint')}`,
      'feature/login',
      'local-only',
      'main',
    ]);
    expect(selected()).toEqual([branchOption('main')]);
  });

  it('names each branch remote only when the repository has several remotes', async () => {
    await mountOpen();
    expect(optionNames().slice(1)).toEqual(['feature/login', 'local-only', 'main']);
    cleanup();

    await mountOpen({
      ...repo,
      remotes: ['fork', 'origin'],
      branches: [
        ...repo.branches.slice(0, 2),
        { name: 'main', committedAt: '2026-11-16T00:00:00.000Z', remoteRef: 'fork/main', remote: 'fork', remoteSource: 'same_name' },
      ],
    });
    expect(optionNames()).toEqual([
      `main ${msg('worktreeCreate.branch.includeLocalChangesHint')}`,
      'feature/login origin',
      'local-only',
      'main fork',
    ]);
  });

  it('omits the local changes option for a clean main directory', async () => {
    await mountOpen({ ...repo, dirty: false });

    expect(textOf(view().getByRole('listbox'))).not.toContain(msg('worktreeCreate.branch.localFileStatus'));
    expect(localChangesOption()).toBeNull();
  });

  it('keeps the panel open after a selection and records included local changes', async () => {
    await mountOpen();

    branchOption('feature/login').click();
    await settle();
    expect(panel()).not.toBeNull();
    expect(chip().getAttribute('aria-label')).toBe(chipName('feature/login'));
    expect(selected()).toEqual([branchOption('feature/login')]);
    expect(environment().worktreeRequest('ws1')).toMatchObject({ sourceBranch: 'feature/login' });
    expect(environment().worktreeRequest('ws1')?.includeLocalChanges).not.toBe(true);

    localChangesOption()!.click();
    await settle();
    expect(panel()).not.toBeNull();
    expect(selected()).toEqual([localChangesOption()]);
    expect(glyph().classList.contains('has-dot')).toBe(true);
    expect(environment().worktreeRequest('ws1')).toMatchObject({ sourceBranch: 'main', includeLocalChanges: true });
  });

  it('filters case-insensitively while typing and reports no matches', async () => {
    await mountOpen();

    typeInto(search(), 'LOGIN');
    await settle();
    expect(optionNames()).toEqual(['feature/login']);

    typeInto(search(), 'nothing-here');
    await settle();
    expect(options()).toEqual([]);
    expect(view().getByText(msg('worktreeCreate.branch.empty'))).toBeTruthy();
  });

  it('moves through branches with the arrow keys and selects with Enter without closing', async () => {
    await mountOpen({ ...repo, dirty: false });

    expect(active()).toBe(branchOption('main'));
    press(search(), 'ArrowUp');
    await nextTick();
    expect(active()).toBe(branchOption('local-only'));
    press(search(), 'Enter');
    await settle();
    expect(chip().getAttribute('aria-label')).toBe(chipName('local-only'));
    expect(panel()).not.toBeNull();
  });

  it('keeps arrow-key navigation and returns focus to the search after a row or the remote switch takes focus', async () => {
    await mountOpen({ ...repo, dirty: false });
    remoteSwitch()!.focus();
    press(remoteSwitch()!, 'ArrowUp');
    await nextTick();
    expect(active()).toBe(branchOption('local-only'));
    expect(document.activeElement).toBe(search());

    const row = branchOption('local-only');
    row.focus();
    row.click();
    await settle();
    press(row, 'ArrowDown');
    await nextTick();
    expect(active()).toBe(branchOption('main'));
    expect(document.activeElement).toBe(search());
  });

  it('switches to the latest remote code without closing', async () => {
    await mountOpen();
    expect(remoteSwitch()!.getAttribute('aria-checked')).toBe('false');

    remoteSwitch()!.click();
    await settle();

    expect(panel()).not.toBeNull();
    expect(remoteSwitch()!.getAttribute('aria-checked')).toBe('true');
    expect(glyph().dataset.glyph).toBe('git-branch-cloud');
    expect(environment().worktreeRequest('ws1')).toMatchObject({ sourceBranch: 'main', useRemote: true });
  });

  it('replaces the remote switch with a note for a branch that has no remote', async () => {
    await mountOpen();

    branchOption('local-only').click();
    await settle();

    expect(remoteSwitch()).toBeNull();
    expect(view().getByText(msg('worktreeCreate.branch.noRemote'))).toBeTruthy();
  });

  it('closes on Esc, on an outside press and on a second click of the button', async () => {
    await mountOpen();
    press(document.body, 'Escape');
    await nextTick();
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(chip());

    chip().click();
    await settle();
    pointerDown(document.body);
    await nextTick();
    expect(panel()).toBeNull();

    chip().click();
    await settle();
    pointerDown(panel()!);
    await nextTick();
    expect(panel()).not.toBeNull();
    pointerDown(chip());
    chip().click();
    await nextTick();
    expect(panel()).toBeNull();
    expect(chip().getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the remote ref and the included changes in the hover card', async () => {
    await loadBranches(repo);
    vi.useFakeTimers();
    try {
      environment().selectEnvironment('worktree');
      environment().selectSource('ws1', { branch: 'main', includeLocalChanges: true });
      environment().setUseRemote('ws1', true);
      mount(CreateSourceBranchPicker, { workspaceId: 'ws1' });
      await nextTick();
      const picker = rendered!.host.querySelector('[data-worktree-source-branch]')!;
      picker.dispatchEvent(new MouseEvent('mouseenter'));
      vi.advanceTimersByTime(200);
      await nextTick();
      const tooltip = view().getByRole('tooltip');
      expect(textOf(tooltip)).toBe(`origin/main ${msg('worktreeCreate.branch.includeLocalChanges')}`);
      expect(tooltip.querySelector('[data-icon="git-branch-cloud"]')).not.toBeNull();
      picker.dispatchEvent(new MouseEvent('mouseleave'));
      await nextTick();
      expect(view().queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
