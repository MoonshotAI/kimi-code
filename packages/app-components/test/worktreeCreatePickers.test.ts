// @vitest-environment jsdom
import { createApp, h, nextTick, type App, type Component } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey, type ToastOptions } from '@moonshot-ai/app-ui';
import type { AppWorkspace, WorkspaceGitBranches, WorktreeSetupScript } from '@moonshot-ai/app-core/api';
import { onToast, resetKimiClientDeps, setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { registerWorktreeSettingsOpener } from '@moonshot-ai/app-client/composables';
import { newSessionEnvironmentStore, workspacesStore, worktreesStore } from '@moonshot-ai/app-client/stores';
import CreateEnvironmentPicker from '../src/worktree/CreateEnvironmentPicker.vue';
import CreateSourceBranchPicker from '../src/worktree/CreateSourceBranchPicker.vue';

const GB = 1024 * 1024 * 1024;

const api = {
  getWorkspaceGitBranches: vi.fn<(workspaceId: string) => Promise<WorkspaceGitBranches>>(),
  listWorktrees: vi.fn(),
  getWorktreeSetupScript: vi.fn<(workspaceId: string) => Promise<WorktreeSetupScript>>(),
  saveWorktreeSetupScript: vi.fn<(workspaceId: string, content: string) => Promise<WorktreeSetupScript>>(),
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

function workspace(id: string, extra: Partial<AppWorkspace> = {}): AppWorkspace {
  return { id, root: `/repo/${id}`, name: id, kind: 'managed', additionalDirs: [], sessionCount: 0, ...extra };
}

let app: App | null = null;
let host: HTMLDivElement;
let toasts: ToastOptions[] = [];
let stopToasts: (() => void) | undefined;

function mount(component: Component, props: Record<string, unknown>): void {
  app = createApp({ render: () => h(component, props) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

function setBranches(workspaceId: string, info: WorkspaceGitBranches): void {
  const store = newSessionEnvironmentStore();
  store.branchesByWorkspace = { ...store.branchesByWorkspace, [workspaceId]: { status: 'ready', info } };
}

function pressKey(target: EventTarget, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

const q = <T extends HTMLElement = HTMLElement>(selector: string) => host.querySelector<T>(selector);
const all = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)];

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  for (const mock of Object.values(api)) mock.mockReset();
  api.getWorkspaceGitBranches.mockResolvedValue(repo);
  api.listWorktrees.mockResolvedValue({ items: [], totalSizeBytes: 0 });
  api.getWorktreeSetupScript.mockResolvedValue({ path: '.kimi/setup.sh', exists: false });
  api.saveWorktreeSetupScript.mockImplementation(async (_id, content) => ({
    path: '.kimi/setup.sh',
    exists: content.trim().length > 0,
    content,
  }));
  setKimiClientDeps({ api: () => api as never, t: (key) => key });
  workspacesStore().workspaces = [workspace('ws1'), workspace('ws2'), workspace('remote', { hostId: 'h1' })];
  newSessionEnvironmentStore().reset();
  worktreesStore().reset();
  toasts = [];
  stopToasts = onToast((event) => {
    if (event.type === 'show' && event.options) toasts.push(event.options);
  });
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  stopToasts?.();
  resetKimiClientDeps();
  vi.unstubAllGlobals();
});

describe('CreateEnvironmentPicker', () => {
  it('starts on Local and enables Worktree once the project is known to be a Git repository', async () => {
    let resolveBranches!: (info: WorkspaceGitBranches) => void;
    api.getWorkspaceGitBranches.mockReturnValueOnce(new Promise((resolve) => { resolveBranches = resolve; }));
    mount(CreateEnvironmentPicker, { workspaceId: 'ws1' });
    await nextTick();

    expect(q('.wce-chip')?.dataset.environment).toBe('local');
    expect(q('.wce-chip-name')?.textContent).toBe('Local');

    q('.wce-chip')!.click();
    await nextTick();
    const worktreeRow = () => q('.wce-row[data-option="worktree"]')!;
    expect(q('.wce-row[data-option="local"] .wce-row-desc')?.textContent).toBe('Work directly in the project directory');
    expect(worktreeRow().getAttribute('aria-disabled')).toBe('true');
    expect(worktreeRow().querySelector('.ui-spinner')).not.toBeNull();
    expect(worktreeRow().querySelector('.wce-row-desc')?.textContent).toBe('Create an independent Worktree for this session');
    worktreeRow().click();
    expect(newSessionEnvironmentStore().preferred).toBe('local');

    resolveBranches(repo);
    await settle();
    expect(worktreeRow().getAttribute('aria-disabled')).toBe('false');
    expect(worktreeRow().querySelector('.ui-spinner')).toBeNull();

    worktreeRow().click();
    await settle();
    expect(newSessionEnvironmentStore().preferred).toBe('worktree');
    expect(q('.wce-chip')?.dataset.environment).toBe('worktree');
    expect(q('.wce-panel')).toBeNull();
  });

  it('dims Worktree for a project that is not a Git repository and falls back to Local', async () => {
    setBranches('ws1', { isRepo: false, dirty: false, remotes: [], branches: [] });
    newSessionEnvironmentStore().selectEnvironment('worktree');
    mount(CreateEnvironmentPicker, { workspaceId: 'ws1' });
    await nextTick();

    expect(q('.wce-chip-name')?.textContent).toBe('Local');
    q('.wce-chip')!.click();
    await nextTick();
    const row = q('.wce-row[data-option="worktree"]')!;
    expect(row.classList.contains('disabled')).toBe(true);
    expect(row.querySelector('.wce-row-desc')?.textContent).toBe('The current project is not a Git repository.');
    expect(q('.wce-row[data-option="local"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('keeps Worktree unavailable for a project on a remote host', async () => {
    mount(CreateEnvironmentPicker, { workspaceId: 'remote' });
    await nextTick();
    q('.wce-chip')!.click();
    await nextTick();
    const row = q('.wce-row[data-option="worktree"]')!;
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.querySelector('.ui-spinner')).toBeNull();
    expect(api.getWorkspaceGitBranches).not.toHaveBeenCalled();
  });

  it('supports arrow keys, Enter and Esc', async () => {
    setBranches('ws1', repo);
    mount(CreateEnvironmentPicker, { workspaceId: 'ws1' });
    await nextTick();
    q('.wce-chip')!.click();
    await settle();

    const panel = q('.wce-panel')!;
    expect(document.activeElement).toBe(panel);
    pressKey(panel, 'ArrowDown');
    await nextTick();
    expect(q('.wce-row[data-option="worktree"]')?.classList.contains('active')).toBe(true);
    pressKey(panel, 'Enter');
    await settle();
    expect(newSessionEnvironmentStore().preferred).toBe('worktree');
    expect(q('.wce-panel')).toBeNull();

    q('.wce-chip')!.click();
    await nextTick();
    pressKey(document.body, 'Escape');
    await nextTick();
    expect(q('.wce-panel')).toBeNull();
    expect(newSessionEnvironmentStore().preferred).toBe('worktree');
  });

  it('reminds about disk usage for 8 seconds with a Manage action after choosing Worktree', async () => {
    api.listWorktrees.mockResolvedValue({ items: [], totalSizeBytes: 5.3 * GB });
    const openSettings = vi.fn();
    registerWorktreeSettingsOpener(openSettings);
    setBranches('ws1', repo);
    mount(CreateEnvironmentPicker, { workspaceId: 'ws1' });
    await nextTick();
    q('.wce-chip')!.click();
    await nextTick();
    q('.wce-row[data-option="worktree"]')!.click();
    await vi.waitFor(() => expect(toasts).toHaveLength(1));

    expect(toasts[0]).toMatchObject({ layout: 'bar', title: 'Worktrees are using 5.3 GB ·', duration: 8000 });
    expect(toasts[0]?.actions?.[0]?.label).toBe('Manage');
    const dismiss = vi.fn();
    await toasts[0]?.actions?.[0]?.onClick({ dismiss });
    expect(dismiss).toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalled();
    expect(worktreesStore().shouldRemindDiskUsage).toBe(false);
  });
});

describe('CreateSourceBranchPicker', () => {
  async function mountOpen(info: WorkspaceGitBranches = repo): Promise<void> {
    setBranches('ws1', info);
    api.getWorkspaceGitBranches.mockResolvedValue(info);
    newSessionEnvironmentStore().selectEnvironment('worktree');
    mount(CreateSourceBranchPicker, { workspaceId: 'ws1', workspaceName: 'demo' });
    await settle();
    q('.wsb-chip')!.click();
    await settle();
  }

  it('is hidden in Local mode and shows the selected branch in Worktree mode', async () => {
    setBranches('ws1', repo);
    mount(CreateSourceBranchPicker, { workspaceId: 'ws1' });
    await nextTick();
    expect(q('.wsb')).toBeNull();

    newSessionEnvironmentStore().selectEnvironment('worktree');
    await settle();
    expect(q('.wsb-chip-name')?.textContent).toBe('main');
    expect(q('.wsb-chip .wsb-glyph')?.dataset.glyph).toBe('worktree-branch');
    expect(q('.wsb-chip .wsb-glyph')?.classList.contains('has-dot')).toBe(false);
  });

  it('opens a heading-less panel with the search focused and both groups', async () => {
    await mountOpen();

    expect(document.activeElement).toBe(q('.wsb-search-input'));
    expect(api.getWorkspaceGitBranches).toHaveBeenCalledWith('ws1');
    expect(all('.wsb-group').map((el) => el.textContent)).toEqual(['Local File Status', 'Local Branches']);
    expect(q('.wsb-row[data-row="local"] .wsb-row-name')?.textContent).toBe('main');
    expect(q('.wsb-row[data-row="local"] .wsb-row-desc')?.textContent).toBe(
      'Include local changes · Leave the original directory unchanged',
    );
    expect(all('.wsb-list .wsb-row:not([data-row="local"]) .wsb-row-name').map((el) => el.textContent)).toEqual([
      'feature/login',
      'local-only',
      'main',
    ]);
    expect(q('.wsb-row.on')?.dataset.row).toBe('main');
    expect(q('.wsb-row.on svg[data-icon="check"]')).not.toBeNull();
  });

  it('separates the branch list from the footer', async () => {
    await mountOpen();
    const separator = q('.wsb-list + [role="separator"]');
    expect(separator).not.toBeNull();
    expect(separator?.nextElementSibling?.classList.contains('wsb-foot')).toBe(true);
  });

  it('shows muted remote names only when the repository has several remotes', async () => {
    await mountOpen();
    expect(q('.wsb-row-remote')).toBeNull();
    app?.unmount();
    app = null;

    await mountOpen({
      ...repo,
      remotes: ['fork', 'origin'],
      branches: [
        ...repo.branches.slice(0, 2),
        {
          name: 'main',
          committedAt: '2026-11-16T00:00:00.000Z',
          remoteRef: 'fork/main',
          remote: 'fork',
          remoteSource: 'same_name',
        },
      ],
    });
    const remoteOf = (row: string) => q(`.wsb-row[data-row="${row}"] .wsb-row-remote`)?.textContent ?? null;
    expect(remoteOf('feature/login')).toBe('origin');
    expect(remoteOf('main')).toBe('fork');
    expect(remoteOf('local-only')).toBeNull();
    expect(q('.wsb-row[data-row="local"] .wsb-row-remote')).toBeNull();
  });

  it('omits the Local File Status group for a clean main directory', async () => {
    await mountOpen({ ...repo, dirty: false });
    expect(all('.wsb-group').map((el) => el.textContent)).toEqual(['Local Branches']);
    expect(q('.wsb-row[data-row="local"]')).toBeNull();
  });

  it('keeps the panel open after a selection and marks included local changes with a dot', async () => {
    await mountOpen();

    q('.wsb-row[data-row="feature/login"]')!.click();
    await settle();
    expect(q('.wsb-panel')).not.toBeNull();
    expect(q('.wsb-chip-name')?.textContent).toBe('feature/login');
    expect(q('.wsb-row.on')?.dataset.row).toBe('feature/login');

    q('.wsb-row[data-row="local"]')!.click();
    await settle();
    expect(q('.wsb-panel')).not.toBeNull();
    expect(q('.wsb-row.on')?.dataset.row).toBe('local');
    expect(q('.wsb-chip .wsb-glyph')?.classList.contains('has-dot')).toBe(true);
    expect(newSessionEnvironmentStore().worktreeRequest('ws1')).toMatchObject({ sourceBranch: 'main', includeLocalChanges: true });
  });

  it('filters while typing and reports no matches', async () => {
    await mountOpen();
    const input = q<HTMLInputElement>('.wsb-search-input')!;
    input.value = 'LOGIN';
    input.dispatchEvent(new Event('input'));
    await settle();
    expect(all('.wsb-row').map((el) => el.dataset.row)).toEqual(['feature/login']);

    input.value = 'nothing-here';
    input.dispatchEvent(new Event('input'));
    await settle();
    expect(all('.wsb-row')).toHaveLength(0);
    expect(q('.wsb-empty')?.textContent).toBe('No matching branches');
  });

  it('navigates with the arrow keys and selects with Enter without closing', async () => {
    await mountOpen({ ...repo, dirty: false });
    const input = q<HTMLInputElement>('.wsb-search-input')!;
    expect(q('.wsb-row.active')?.dataset.row).toBe('main');
    pressKey(input, 'ArrowUp');
    await nextTick();
    expect(q('.wsb-row.active')?.dataset.row).toBe('local-only');
    pressKey(input, 'Enter');
    await settle();
    expect(q('.wsb-chip-name')?.textContent).toBe('local-only');
    expect(q('.wsb-panel')).not.toBeNull();
  });

  it('toggles the latest remote code without closing and badges the button with a cloud', async () => {
    await mountOpen();
    const toggle = q<HTMLButtonElement>('[data-foot="remote"] .ui-switch')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    toggle.click();
    await settle();

    expect(q('.wsb-panel')).not.toBeNull();
    expect(q('[data-foot="remote"] .ui-switch')?.getAttribute('aria-checked')).toBe('true');
    expect(q('.wsb-chip .wsb-glyph')?.dataset.glyph).toBe('git-branch-cloud');
    expect(newSessionEnvironmentStore().worktreeRequest('ws1')).toMatchObject({ sourceBranch: 'main', useRemote: true });
  });

  it('replaces the toggle with a note for a branch that has no remote', async () => {
    await mountOpen();
    q('.wsb-row[data-row="local-only"]')!.click();
    await settle();
    expect(q('[data-foot="remote"]')).toBeNull();
    expect(q('[data-foot="no-remote"]')?.textContent?.trim()).toBe(
      'This branch has no remote; it will be created from the local branch.',
    );
  });

  it('closes on Esc, on an outside press and on a second click of the button', async () => {
    await mountOpen();
    pressKey(document.body, 'Escape');
    await nextTick();
    expect(q('.wsb-panel')).toBeNull();

    q('.wsb-chip')!.click();
    await settle();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await nextTick();
    expect(q('.wsb-panel')).toBeNull();

    q('.wsb-chip')!.click();
    await settle();
    q('.wsb-panel')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await nextTick();
    expect(q('.wsb-panel')).not.toBeNull();
    q('.wsb-chip')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    q('.wsb-chip')!.click();
    await nextTick();
    expect(q('.wsb-panel')).toBeNull();
  });

  it('shows the remote ref and the included changes in the hover card', async () => {
    vi.useFakeTimers();
    try {
      setBranches('ws1', repo);
      const store = newSessionEnvironmentStore();
      store.selectEnvironment('worktree');
      store.selectSource('ws1', { branch: 'main', includeLocalChanges: true });
      store.setUseRemote('ws1', true);
      mount(CreateSourceBranchPicker, { workspaceId: 'ws1' });
      await nextTick();
      q('.wsb-chip')!.dispatchEvent(new MouseEvent('mouseenter'));
      vi.advanceTimersByTime(200);
      await nextTick();
      expect(all('.wsb-hover-row').map((el) => el.textContent?.trim())).toEqual(['origin/main', 'Include local changes']);
      expect(q('.wsb-hover-main svg')?.getAttribute('data-icon')).toBe('git-branch-cloud');
      q('.wsb-chip')!.dispatchEvent(new MouseEvent('mouseleave'));
      await nextTick();
      expect(q('.wsb-hover')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('configures the initialization script from the panel', async () => {
    await mountOpen();
    const scriptRow = () => q('[data-foot="script"]')!;
    expect(scriptRow().querySelector('.wsb-link')?.textContent?.trim()).toBe('Configure');
    expect(scriptRow().querySelector('.ui-switch')).toBeNull();

    scriptRow().querySelector<HTMLButtonElement>('.wsb-link')!.click();
    await settle();
    expect(q('.wsb-panel')).toBeNull();
    const dialog = document.querySelector<HTMLElement>('.ui-dialog')!;
    expect(dialog.querySelector('.ui-dialog__title')?.textContent).toBe('Configure Initialization Script');
    expect(dialog.querySelector('.wss-project')?.textContent).toBe('demo');
    expect(dialog.querySelector('.wss-note')?.textContent).toBe(
      'Saved to .kimi/setup.sh. Once committed, team members will also use it.',
    );

    const editor = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    editor.value = 'pnpm install';
    editor.dispatchEvent(new Event('input'));
    await nextTick();
    dialog.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await settle();
    expect(api.saveWorktreeSetupScript).toHaveBeenCalledWith('ws1', 'pnpm install');
    expect(document.querySelector('.ui-dialog')).toBeNull();

    q('.wsb-chip')!.click();
    await settle();
    expect(scriptRow().querySelector('.wsb-link')?.textContent?.trim()).toBe('Edit');
    const runToggle = scriptRow().querySelector<HTMLButtonElement>('.ui-switch')!;
    expect(runToggle.getAttribute('aria-label')).toBe('Run initialization script for this session');
    expect(runToggle.getAttribute('aria-checked')).toBe('true');
    runToggle.click();
    await settle();
    expect(newSessionEnvironmentStore().runSetupScript).toBe(false);
    expect(newSessionEnvironmentStore().worktreeRequest('ws1')?.runSetupScript).toBe(false);
    expect(q('.wsb-panel')).not.toBeNull();
  });
});
