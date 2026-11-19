// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon, type IconName } from '@moonshot-ai/app-client/icons';
import type { SessionFolderInfoRow } from '@moonshot-ai/app-client/stores';
import type { GitStatusEntry } from '@moonshot-ai/app-core/api';
import type { SessionWorktreeDisplay } from '@moonshot-ai/app-components/support';

import SessionInfoFolder from '../../src/renderer/components/chat/SessionInfoFolder.vue';
import SessionInfoPanel from '../../src/renderer/components/chat/SessionInfoPanel.vue';
import sessionInfoFolderSource from '../../src/renderer/components/chat/SessionInfoFolder.vue?raw';
import sessionInfoPanelSource from '../../src/renderer/components/chat/SessionInfoPanel.vue?raw';
import sessionInfoTabsSource from '../../src/renderer/components/chat/SessionInfoTabs.vue?raw';
import conversationPaneSource from '../../src/renderer/components/chat/ConversationPane.vue?raw';
import appSource from '../../src/renderer/App.vue?raw';
import chatHeaderSource from '../../src/renderer/components/chat/ChatHeader.vue?raw';
import chatPaneSource from '../../../../packages/app-components/src/chat/ChatPane.vue?raw';
import turnFoldSource from '../../../../packages/app-components/src/chat/TurnFold.vue?raw';
import pullRequestStateSource from '../../../../packages/app-components/src/worktree/SessionPullRequestState.vue?raw';
import sessionInfoPopoverSource from '../../../../packages/app-components/src/worktree/SessionInfoPopover.vue?raw';

const store = vi.hoisted(() => ({
  rows: vi.fn(),
  foldersForSession: vi.fn(),
  observe: vi.fn(),
  unobserve: vi.fn(),
  refresh: vi.fn(),
  refreshing: vi.fn(),
  refreshError: vi.fn(),
}));

const sessionState = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  fsHome: null as string | null,
  mergedWorkspaces: [] as Array<{ id: string; name: string }>,
  workspaceIdForSession: (session: { workspaceId?: string }) => session.workspaceId ?? '',
}));

vi.mock('@moonshot-ai/app-client/stores', () => ({
  sessionInfoStore: () => store,
  sessionsStore: () => sessionState,
  workspacesStore: () => sessionState,
}));

let app: App | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  store.rows.mockReset();
  store.foldersForSession.mockReset();
  store.observe.mockReset();
  store.unobserve.mockReset();
  store.refresh.mockReset();
  store.refreshing.mockReset().mockReturnValue(false);
  store.refreshError.mockReset().mockReturnValue(null);
  sessionState.sessions = [];
  sessionState.fsHome = null;
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
  document.querySelectorAll('[data-session-info-popover]').forEach(node => node.remove());
  delete (window as { kimiDesktop?: unknown }).kimiDesktop;
});

function readyRow(overrides: Partial<GitStatusEntry> = {}): SessionFolderInfoRow {
  return {
    path: '/repo/a',
    primary: true,
    state: {
      status: 'ready',
      value: {
        branch: 'feat/session-info',
        upstream: 'origin/feat/session-info',
        detached: false,
        ahead: 2,
        behind: 1,
        entries: { 'src/a.ts': 'M' },
        additions: 128,
        deletions: 42,
        pullRequest: { number: 1287, state: 'open', url: 'https://github.com/acme/repo/pull/1287' },
        ...overrides,
      },
    },
  };
}

function worktree(overrides: Partial<SessionWorktreeDisplay> = {}): SessionWorktreeDisplay {
  return {
    path: '/repo/a',
    branch: 'kimi/1104-b8b6',
    base: { ref: 'main', remote: false },
    missing: false,
    ...overrides,
  };
}

function worktreeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 's1',
    cwd: '/repo/a',
    worktree: {
      path: '/repo/a',
      branch: 'kimi/1104-b8b6',
      base: { ref: 'origin/main', remote: true },
      setup: { status: 'ready' },
      ...overrides,
    },
  };
}

function mount(component: unknown, props: Record<string, unknown>) {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(component as never, props);
  app.use(createKimiI18n({ locale: 'zh' }));
  app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
  app.mount(host);
  return host;
}

function popover(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-session-info-popover]');
}

async function openPopover(trigger: string): Promise<HTMLElement> {
  host!.querySelector<HTMLButtonElement>(trigger)!.click();
  await nextTick();
  await nextTick();
  const element = popover();
  if (element === null) throw new Error('Expected an open popover');
  return element;
}

describe('SessionInfoFolder', () => {
  it('renders path, branch, sync, diff and PR independently and emits diff and PR clicks', async () => {
    const openPr = vi.fn();
    const openDiff = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    app = createApp({ render: () => h(SessionInfoFolder, { row: readyRow(), onOpenPr: openPr, onOpenDiff: openDiff }) });
    app.use(createKimiI18n({ locale: 'zh' }));
    app.mount(host);
    await nextTick();

    expect(host.querySelector('.sif-path')?.textContent).toBe('/repo/a');
    expect(host.textContent).toContain('feat/session-info');
    expect(host.textContent).toContain('↑2');
    expect(host.textContent).toContain('↓1');
    expect(host.textContent).toContain('+128');
    expect(host.textContent).toContain('−42');
    expect(host.textContent).toContain('PR #1287');
    expect(host.textContent).not.toContain('未推送');
    expect(host.querySelector('.sif-created')).toBeNull();

    host.querySelector<HTMLButtonElement>('.sif-diff-button')!.click();
    expect(openDiff).toHaveBeenCalledExactlyOnceWith('/repo/a');
    host.querySelector<HTMLButtonElement>('.sif-pr')!.click();
    expect(openPr).toHaveBeenCalledExactlyOnceWith('https://github.com/acme/repo/pull/1287');
  });

  it('shows the rows in the specified order for a worktree main directory', async () => {
    mount(SessionInfoFolder, { row: readyRow(), worktree: worktree() });
    await nextTick();

    const order = [...host!.querySelectorAll('.sif-body > *')].map(node => node.className.split(' ').find(name =>
      ['sif-path-line', 'sif-created', 'sif-branch-line', 'sif-row', 'sif-pr'].includes(name)));
    expect(order).toEqual(['sif-path-line', 'sif-created', 'sif-branch-line', 'sif-row', 'sif-pr']);
  });

  it('abbreviates the home directory in the path and keeps the full path as its title', async () => {
    mount(SessionInfoFolder, {
      row: { ...readyRow(), path: '/Users/me/.kimi-code/worktrees/demo' },
      home: '/Users/me',
    });
    await nextTick();

    const path = host!.querySelector<HTMLElement>('.sif-path')!;
    expect(path.textContent).toBe('~/.kimi-code/worktrees/demo');
    expect(path.getAttribute('title')).toBe('/Users/me/.kimi-code/worktrees/demo');
  });

  it('shows a clickable no-changes state instead of zero diff counts', async () => {
    const openDiff = vi.fn();
    mount(SessionInfoFolder, { row: readyRow({ additions: 0, deletions: 0, entries: {} }), onOpenDiff: openDiff });
    await nextTick();

    expect(host!.textContent).toContain('无变更');
    expect(host!.querySelector('.sif-diff')).toBeNull();
    host!.querySelector<HTMLButtonElement>('.sif-diff-button')!.click();
    expect(openDiff).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'not pushed', value: { upstream: undefined, ahead: 0, behind: 0 }, text: '未推送', sync: null },
    { name: 'ahead', value: { ahead: 3, behind: 0 }, text: null, sync: '↑3' },
    { name: 'behind', value: { ahead: 0, behind: 4 }, text: null, sync: '↓4' },
    { name: 'diverged', value: { ahead: 3, behind: 4 }, text: null, sync: '↑3↓4' },
    { name: 'in sync', value: { ahead: 0, behind: 0 }, text: null, sync: null },
  ])('shows the $name sync status after the branch name', async ({ value, text, sync }) => {
    mount(SessionInfoFolder, { row: readyRow(value) });
    await nextTick();

    expect(host!.querySelector('.sif-not-pushed')?.textContent ?? null).toBe(text);
    expect(host!.querySelector('.sif-sync')?.textContent ?? null).toBe(sync);
  });

  it('shows the short head with a warning tooltip when detached', async () => {
    mount(SessionInfoFolder, { row: readyRow({ branch: '', detached: true, head: '3f2a91c', upstream: undefined }) });
    await nextTick();

    expect(host!.querySelector('.sif-branch')?.textContent).toBe('HEAD @ 3f2a91c');
    expect(host!.querySelector('.sif-branch-line .ui-tip')).not.toBeNull();
    expect(host!.querySelector('.sif-not-pushed')).toBeNull();
    expect(sessionInfoFolderSource).toContain("t('worktreeSession.detachedTooltip')");
  });

  it('uses the app tooltip only when the branch is truncated', async () => {
    let callback!: ResizeObserverCallback;
    vi.stubGlobal('ResizeObserver', class {
      constructor(next: ResizeObserverCallback) { callback = next }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    });
    try {
      mount(SessionInfoFolder, { row: readyRow() });
      await nextTick();
      const branch = host!.querySelector<HTMLElement>('.sif-branch')!;
      expect(branch.getAttribute('title')).toBeNull();
      expect(host!.querySelector('.ui-tip')).toBeNull();

      Object.defineProperties(branch, {
        scrollWidth: { value: 240, configurable: true },
        clientWidth: { value: 100, configurable: true },
      });
      callback([], {} as ResizeObserver);
      await nextTick();
      expect(host!.querySelector('.ui-tip')).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rechecks the branch tooltip when the branch text changes', async () => {
    const row = reactive(readyRow());
    mount(SessionInfoFolder, { row });
    await nextTick();
    const branch = host!.querySelector<HTMLElement>('.sif-branch')!;
    Object.defineProperties(branch, {
      scrollWidth: { value: 240, configurable: true },
      clientWidth: { value: 100, configurable: true },
    });
    if (row.state.status !== 'ready') throw new Error('Expected ready Git state');

    row.state.value.branch = 'feat/a-very-long-branch-name-that-needs-a-tooltip';
    await nextTick();
    expect(host!.querySelector('.ui-tip')).not.toBeNull();
    row.state.value.branch = 'main';
    await nextTick();
    expect(host!.querySelector('.ui-tip')).toBeNull();
  });

  it('collapses additional folders by default and shows the same content when expanded', async () => {
    mount(SessionInfoFolder, { row: { ...readyRow(), path: '/repo/b', primary: false }, worktree: worktree() });
    await nextTick();
    const heading = host!.querySelector<HTMLButtonElement>('.sif-heading')!;

    expect(heading.getAttribute('aria-expanded')).toBe('false');
    expect(host!.querySelector('.sif-primary')).toBeNull();
    expect(host!.querySelector('.sif-body')).toBeNull();
    heading.click();
    await nextTick();
    expect(heading.getAttribute('aria-expanded')).toBe('true');
    expect(host!.querySelector('.sif-path')?.textContent).toBe('/repo/b');
    expect(host!.querySelector('.sif-branch')?.textContent).toBe('feat/session-info');
    expect(host!.querySelector('.sif-diff-button')).not.toBeNull();
    expect(host!.querySelector('.sif-pr')).not.toBeNull();
    expect(host!.querySelector('.sif-created')).toBeNull();
    heading.click();
    await nextTick();
    expect(heading.getAttribute('aria-expanded')).toBe('false');
    expect(host!.querySelector('.sif-body')).toBeNull();
  });

  it('shows placeholders while loading without fabricating Git data', async () => {
    mount(SessionInfoFolder, { row: { ...readyRow(), state: { status: 'loading' } } });
    await nextTick();

    expect(host!.querySelector('.sif-path')?.textContent).toBe('/repo/a');
    expect(host!.querySelector('.sif-branch-line .sif-placeholder')?.textContent).toBe('-');
    expect(host!.querySelector('.sif-branch')).toBeNull();
    expect(host!.querySelector('.sif-diff-button')?.textContent).toBe('-');
    expect(host!.querySelector('.sif-pr-pending .sif-placeholder')?.textContent).toBe('-');
    expect(host!.querySelector('.sif-pr')).toBeNull();
  });

  it('shows a spinner on the changes row only once the status has been loading for a while', async () => {
    vi.useFakeTimers();
    try {
      const row = reactive<SessionFolderInfoRow>({ ...readyRow(), statusLoading: true });
      mount({ render: () => h(SessionInfoFolder, { row }) }, {});
      await nextTick();

      expect(host!.querySelector('.sif-changes-loading')).toBeNull();
      await vi.advanceTimersByTimeAsync(399);
      expect(host!.querySelector('.sif-changes-loading')).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await nextTick();
      expect(host!.querySelector('.sif-diff-button .sif-changes-loading')).not.toBeNull();
      expect(host!.querySelector('.sif-diff')?.textContent).toBe('+128−42');

      row.statusLoading = false;
      await nextTick();
      expect(host!.querySelector('.sif-changes-loading')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not show the changes spinner for a status that returns quickly', async () => {
    vi.useFakeTimers();
    try {
      const row = reactive<SessionFolderInfoRow>({ ...readyRow(), statusLoading: true });
      mount({ render: () => h(SessionInfoFolder, { row }) }, {});
      await vi.advanceTimersByTimeAsync(200);
      row.statusLoading = false;
      await vi.advanceTimersByTimeAsync(1000);
      await nextTick();

      expect(host!.querySelector('.sif-changes-loading')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the PR placeholder until the pull request has been read', async () => {
    mount(SessionInfoFolder, { row: { ...readyRow({ pullRequest: null }), pullRequestLoading: true } });
    await nextTick();
    expect(host!.querySelector('.sif-pr-pending')).not.toBeNull();
  });

  it.each([
    { name: 'no pull request', value: { pullRequest: null, pullRequestStatus: 'none' as const } },
    { name: 'gh unavailable', value: { pullRequest: null, pullRequestStatus: 'unavailable' as const } },
  ])('hides the PR row for $name', async ({ value }) => {
    mount(SessionInfoFolder, { row: readyRow(value) });
    await nextTick();

    expect(host!.querySelector('.sif-pr')).toBeNull();
    expect(host!.querySelector('.sif-pr-pending')).toBeNull();
    expect(host!.querySelector('.sif-pr-failed')).toBeNull();
  });

  it.each([
    [{ status: 'error' as const }, '信息加载失败。'],
    [{ status: 'non-git' as const }, '非 Git 目录'],
  ])('renders the %s state with the name and path but no git data', async (state, label) => {
    mount(SessionInfoFolder, { row: { ...readyRow(), state } });
    await nextTick();
    expect(host!.querySelector('.sif-name')?.textContent).toBe('a');
    expect(host!.querySelector('.sif-path')?.textContent).toBe('/repo/a');
    expect(host!.textContent).toContain(label);
    expect(host!.querySelector('.sif-branch-line')).toBeNull();
    expect(host!.querySelector('.sif-diff-button')).toBeNull();
    expect(host!.querySelector('.sif-pr')).toBeNull();
  });

  it.each([
    { remote: false, icon: 'git-fork', text: '基于 main 创建', ref: 'main' },
    { remote: true, icon: 'git-fork-cloud', text: '基于 origin/main 创建', ref: 'origin/main' },
  ])('shows where the worktree was created from (remote: $remote)', async ({ remote, icon, text, ref }) => {
    mount(SessionInfoFolder, { row: readyRow(), worktree: worktree({ base: { ref, remote } }) });
    await nextTick();

    const created = host!.querySelector('.sif-created')!;
    expect(created.textContent).toBe(text);
    expect(created.querySelector('[data-worktree-icon]')?.getAttribute('data-worktree-icon')).toBe(icon);
  });

  it('marks a missing worktree: struck path, amber notice, branch kept, changes and PR hidden', async () => {
    mount(SessionInfoFolder, { row: readyRow(), worktree: worktree({ missing: true }) });
    await nextTick();

    expect(host!.querySelector('.sif-path')?.classList.contains('struck')).toBe(true);
    expect(host!.querySelector('.sif-missing')?.textContent).toBe('工作树目录不存在');
    expect(host!.querySelector('.sif-branch')?.textContent).toBe('kimi/1104-b8b6');
    expect(host!.querySelector('.sif-created')).toBeNull();
    expect(host!.querySelector('.sif-diff-button')).toBeNull();
    expect(host!.querySelector('.sif-pr')).toBeNull();
    expect(sessionInfoFolderSource).toMatch(/\.sif-missing,\s*\.sif-missing \.sif-ico\s*\{\s*color: var\(--color-warning\);/);
  });

  it('marks a directory reported missing by the store', async () => {
    mount(SessionInfoFolder, { row: { ...readyRow(), state: { status: 'missing' } }, worktree: worktree() });
    await nextTick();

    expect(host!.querySelector('.sif-path')?.classList.contains('struck')).toBe(true);
    expect(host!.querySelector('.sif-missing')?.textContent).toBe('工作树目录不存在');
    expect(host!.querySelector('.sif-diff-button')).toBeNull();
  });

  it('explains a failed change count in a popover with retry and copy', async () => {
    const retry = vi.fn();
    const writeClipboardText = vi.fn(async () => true);
    (window as { kimiDesktop?: unknown }).kimiDesktop = { writeClipboardText };
    const output = Array.from({ length: 12 }, (_, index) => `fatal: line ${index + 1}`).join('\n');
    mount(SessionInfoFolder, { row: readyRow({ statsError: output }), onRetry: retry });
    await nextTick();

    expect(host!.querySelector('.sif-diff-button')?.textContent).toBe('改动—');
    expect(host!.querySelector('.sif-diff')).toBeNull();
    expect(popover()).toBeNull();

    const element = await openPopover('.sif-stats-error');
    expect(element.querySelector('.sip-title')?.textContent).toBe('无法统计改动');
    expect(element.querySelector('.sip-body')?.textContent).toBe('统计改动时出错，暂时无法显示改动行数。');
    expect(element.querySelector('.sip-output')?.textContent).toBe(output);

    element.querySelector<HTMLButtonElement>('.sip-retry')!.click();
    expect(retry).toHaveBeenCalledOnce();
    element.querySelector<HTMLButtonElement>('.sip-copy')!.click();
    await vi.waitFor(() => expect(element.querySelector('.sip-copy')?.textContent?.trim()).toBe('已复制'));
    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith(output);
  });

  it('closes the popover on Escape and on an outside press', async () => {
    mount(SessionInfoFolder, { row: readyRow({ statsError: 'boom' }) });
    await nextTick();

    await openPopover('.sif-stats-error');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(host!.querySelector('.sif-stats-error')?.getAttribute('aria-expanded')).toBe('false');

    const element = await openPopover('.sif-stats-error');
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await nextTick();
    expect(host!.querySelector('.sif-stats-error')?.getAttribute('aria-expanded')).toBe('true');
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await nextTick();
    expect(host!.querySelector('.sif-stats-error')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('removes the warning once a retry succeeds', async () => {
    const row = reactive(readyRow({ statsError: 'boom' }));
    mount(SessionInfoFolder, { row });
    await nextTick();
    await openPopover('.sif-stats-error');
    if (row.state.status !== 'ready') throw new Error('Expected ready Git state');

    delete row.state.value.statsError;
    await nextTick();
    await nextTick();
    expect(host!.querySelector('.sif-stats-error')).toBeNull();
    expect(host!.querySelector('.sif-diff')?.textContent).toBe('+128−42');
  });

  it('explains a failed PR read in a popover', async () => {
    const retry = vi.fn();
    mount(SessionInfoFolder, {
      row: readyRow({ pullRequest: null, pullRequestStatus: 'failed', pullRequestError: 'gh pr view timed out' }),
      onRetry: retry,
    });
    await nextTick();

    expect(host!.querySelector('.sif-pr-failed')?.textContent).toBe('PR—');
    expect(host!.querySelector('.sif-pr')).toBeNull();
    const element = await openPopover('.sif-pr-error');
    expect(element.querySelector('.sip-title')?.textContent).toBe('PR 状态未更新');
    expect(element.querySelector('.sip-body')?.textContent).toBe('读取 PR 状态超时，暂时无法显示 PR。');
    expect(element.querySelector('.sip-output')?.textContent).toBe('gh pr view timed out');
    element.querySelector<HTMLButtonElement>('.sip-retry')!.click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('limits the raw output to five lines with scrolling inside', () => {
    const outputStyle = sessionInfoPopoverSource.match(/\.sip-output\s*\{([^}]*)\}/)?.[1];
    expect(outputStyle).toContain('max-height: calc(5 * var(--sip-output-line) + 2 * var(--space-2))');
    expect(outputStyle).toContain('overflow: auto');
  });
});

describe('SessionInfoPanel', () => {
  it('observes folders while mounted, preserves row order and unobserves on unmount', async () => {
    const first = readyRow();
    const second = { ...readyRow(), path: '/repo/b', primary: false };
    store.rows.mockReturnValue([first, second]);
    const folders = [{ path: '/repo/a', primary: true }, { path: '/repo/b', primary: false }];
    store.foldersForSession.mockReturnValue(folders);

    const el = mount(SessionInfoPanel, { sessionId: 's1', mode: 'floating' });
    await nextTick();

    expect(store.foldersForSession).toHaveBeenCalledWith('s1');
    expect(store.observe).toHaveBeenCalledWith('s1', folders);
    expect(el.querySelector('.session-info')?.classList.contains('is-floating')).toBe(true);
    expect([...el.querySelectorAll('[data-folder]')].map(node => node.getAttribute('data-folder'))).toEqual(['/repo/a', '/repo/b']);
    app!.unmount();
    expect(store.unobserve).toHaveBeenCalledWith('s1');
  });

  it('renders tab shortcuts below folders and forwards their actions', async () => {
    const activate = vi.fn();
    const open = vi.fn();
    const showTabs = vi.fn();
    store.rows.mockReturnValue([readyRow()]);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }]);
    const el = mount(SessionInfoPanel, {
      sessionId: 's1',
      mode: 'sidebar',
      tabs: Array.from({ length: 7 }, (_, index) => ({ id: `tab-${index + 1}`, type: 'diff', title: '改动' })),
      available: [{ type: 'term', icon: 'terminal', label: '终端', keys: [], disabled: false }],
      onActivate: activate,
      onOpen: open,
      onShowTabs: showTabs,
    });
    await nextTick();

    expect(el.querySelector('.si-folders + .sit')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('.sit-opened')!.click();
    el.querySelector<HTMLButtonElement>('.sit-available')!.click();
    el.querySelector<HTMLButtonElement>('.sit-more')!.click();
    expect(activate).toHaveBeenCalledExactlyOnceWith('tab-1');
    expect(open).toHaveBeenCalledExactlyOnceWith('term');
    expect(showTabs).toHaveBeenCalledOnce();
  });

  it.each([1, 2])('shows %s non-git folder(s) with their name, path and state', async (count) => {
    const rows = Array.from({ length: count }, (_, index) => ({
      ...readyRow(),
      path: `/repo/${index}`,
      primary: index === 0,
      state: { status: 'non-git' as const },
    }));
    store.rows.mockReturnValue(rows);
    store.foldersForSession.mockReturnValue(rows.map(row => ({ path: row.path, primary: row.primary })));
    const el = mount(SessionInfoPanel, {
      sessionId: 's1',
      mode: 'sidebar',
      tabs: [{ id: 'tab-1', type: 'file', title: 'File 1.vue' }],
      available: [{ type: 'term', icon: 'terminal', label: '终端', keys: [], disabled: false }],
    });
    await nextTick();

    expect(el.querySelectorAll('[data-folder]')).toHaveLength(count);
    expect(el.querySelector('[data-folder="/repo/0"] .sif-path')?.textContent).toBe('/repo/0');
    expect(el.querySelector('[data-folder="/repo/0"]')?.textContent).toContain('非 Git 目录');
    expect(el.querySelector('.sit-opened')?.textContent).toBe('File 1.vue');
    expect(el.querySelector('.sit-available')?.textContent).toBe('终端');
  });

  it('shows the loading placeholders after a short delay', async () => {
    vi.useFakeTimers();
    try {
      store.rows.mockReturnValue([{ ...readyRow(), state: { status: 'loading' as const } }]);
      store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }]);
      const el = mount(SessionInfoPanel, { sessionId: 's1', mode: 'sidebar' });
      await nextTick();

      expect(el.querySelector('.si-folders')).toBeNull();
      await vi.advanceTimersByTimeAsync(149);
      expect(el.querySelector('.si-folders')).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await nextTick();
      expect(el.querySelector('.si-folders')).not.toBeNull();
      expect(el.querySelector('.sif-branch-line .sif-placeholder')?.textContent).toBe('-');
      expect(el.querySelector('.sif-diff-button')?.textContent).toBe('-');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows every folder and the non-git state when Git and non-git folders are mixed', async () => {
    const nonGit = { ...readyRow(), path: '/repo/b', primary: false, state: { status: 'non-git' as const } };
    store.rows.mockReturnValue([readyRow(), nonGit]);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }, { path: '/repo/b', primary: false }]);
    const el = mount(SessionInfoPanel, { sessionId: 's1', mode: 'sidebar' });
    await nextTick();

    expect([...el.querySelectorAll('[data-folder]')].map(node => node.getAttribute('data-folder'))).toEqual(['/repo/a', '/repo/b']);
    el.querySelector<HTMLButtonElement>('[data-folder="/repo/b"] .sif-heading')!.click();
    await nextTick();
    expect(el.querySelector('[data-folder="/repo/b"]')?.textContent).toContain('非 Git 目录');
  });

  it('wires the overflow action to the right panel', () => {
    expect(conversationPaneSource).toContain('@show-tabs="emit(\'showTabs\')"');
    expect(appSource).toContain('@show-tabs="panel.showPanel"');
  });

  it('uses the sidebar width for the floating panel', () => {
    const sidebarStyle = sessionInfoPanelSource.match(/\.session-info\.is-sidebar\s*\{([^}]*)\}/)?.[1];
    const floatingStyle = sessionInfoPanelSource.match(/\.session-info\.is-floating\s*\{([^}]*)\}/)?.[1];

    expect(sidebarStyle).toContain('width: 280px');
    expect(floatingStyle).toContain('width: 280px');
  });

  it('uses primary text for folder names and section labels, and tertiary text for overflow', () => {
    const headingStyle = sessionInfoFolderSource.match(/\.sif-heading\s*\{([^}]*)\}/)?.[1];
    const nameStyle = sessionInfoFolderSource.match(/^\.sif-name\s*\{([^}]*)\}/m)?.[1];
    const labelStyle = sessionInfoTabsSource.match(/\.sit-label\s*\{([^}]*)\}/)?.[1];
    const moreStyle = sessionInfoTabsSource.match(/\.sit-more\s*\{([^}]*)\}/)?.[1];

    expect(headingStyle).toContain('color: var(--color-text)');
    expect(nameStyle).toContain('font-size: var(--text-xs)');
    expect(nameStyle).toContain('font-weight: var(--weight-medium)');
    expect(labelStyle).toContain('color: var(--color-text)');
    expect(labelStyle).toContain('font-size: var(--text-xs)');
    expect(labelStyle).toContain('font-weight: var(--weight-regular)');
    expect(moreStyle).toContain('color: var(--color-text-faint)');
  });

  it('keeps the PR status beside its number with smaller text', () => {
    const stateStyle = pullRequestStateSource.match(/\.spr-state\s*\{([^}]*)\}/)?.[1];

    expect(stateStyle).not.toContain('margin-left: auto');
    expect(stateStyle).toContain('font-size: 11px');
  });

  it.each([
    { state: 'open' as const, label: 'Open' },
    { state: 'closed' as const, label: 'Closed' },
    { state: 'merged' as const, label: 'Merged' },
    { state: 'draft' as const, label: 'Draft' },
  ])('shows the PR state $state in English under the zh locale', async ({ state, label }) => {
    const row = readyRow();
    if (row.state.status !== 'ready' || row.state.value.pullRequest === null) throw new Error('Expected a PR');
    row.state.value.pullRequest.state = state;
    store.rows.mockReturnValue([row]);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }]);
    const el = mount(SessionInfoPanel, { sessionId: 's1', mode: 'sidebar' });
    await nextTick();

    expect(el.querySelector('.sif-pr-state')?.textContent).toBe(label);
    expect(el.querySelector('.sif-pr-state')?.classList.contains(`pr-${state}`)).toBe(true);
  });

  it('uses different PR icons for open and merged states', async () => {
    const row = readyRow();
    store.rows.mockReturnValue([row]);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }]);
    const openIcon = mount(SessionInfoPanel, { sessionId: 's1', mode: 'sidebar' }).querySelector('.sif-pr svg')?.outerHTML;
    app?.unmount();
    host?.remove();

    if (row.state.status !== 'ready' || row.state.value.pullRequest === null) throw new Error('Expected a PR');
    row.state.value.pullRequest.state = 'merged';
    const mergedIcon = mount(SessionInfoPanel, { sessionId: 's1', mode: 'sidebar' }).querySelector('.sif-pr svg')?.outerHTML;

    expect(openIcon).toBeDefined();
    expect(mergedIcon).toBeDefined();
    expect(mergedIcon).not.toBe(openIcon);
  });

  it('labels the main directory even when it is the only folder', async () => {
    store.rows.mockReturnValue([readyRow()]);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }]);
    const el = mount(SessionInfoPanel, { sessionId: 's1', mode: 'sidebar' });
    await nextTick();

    expect(el.querySelector('.sif-primary')?.textContent).toBe('主目录');
  });

  it('places the main directory label between the folder name and chevron, on the main directory only', async () => {
    store.rows.mockReturnValue([readyRow(), { ...readyRow(), path: '/repo/b', primary: false }]);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }, { path: '/repo/b', primary: false }]);
    const el = mount(SessionInfoPanel, { sessionId: 's1', mode: 'sidebar' });
    await nextTick();

    const name = el.querySelector('[data-folder="/repo/a"] .sif-name');
    const badge = el.querySelector('[data-folder="/repo/a"] .sif-primary');
    expect(badge?.textContent).toBe('主目录');
    expect(name?.nextElementSibling).toBe(badge);
    expect(badge?.nextElementSibling?.classList.contains('sif-chevron')).toBe(true);
    expect(el.querySelector('[data-folder="/repo/b"] .sif-primary')).toBeNull();
    const primaryStyle = sessionInfoFolderSource.match(/\.sif-primary\s*\{([^}]*)\}/)?.[1];
    expect(primaryStyle).not.toContain('margin-left: auto');
  });

  it('shows worktree information only on the main directory of a worktree session', async () => {
    sessionState.sessions = [worktreeSession()];
    sessionState.fsHome = '/repo';
    store.rows.mockReturnValue([readyRow(), { ...readyRow(), path: '/project', primary: false }]);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }, { path: '/project', primary: false }]);
    const el = mount(SessionInfoPanel, { sessionId: 's1', mode: 'sidebar' });
    await nextTick();

    expect(el.querySelector('[data-folder="/repo/a"] .sif-path')?.textContent).toBe('~/a');
    expect(el.querySelector('[data-folder="/repo/a"] .sif-created')?.textContent).toBe('基于 origin/main 创建');
    expect(el.querySelector('[data-folder="/repo/a"] [data-worktree-icon="git-fork-cloud"]')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('[data-folder="/project"] .sif-heading')!.click();
    await nextTick();
    expect(el.querySelector('[data-folder="/project"] .sif-created')).toBeNull();
    expect(el.querySelector('[data-folder="/project"] .sif-primary')).toBeNull();
  });

  it.each([
    { name: 'before the worktree exists', worktree: { path: undefined, base: undefined, setup: { status: 'running' } } },
    { name: 'after falling back to local', worktree: { path: undefined, setup: { status: 'local' } } },
    { name: 'after creation failed', worktree: { path: undefined, setup: { status: 'failed' } } },
  ])('shows plain directory information $name', async ({ worktree: state }) => {
    sessionState.sessions = [worktreeSession(state)];
    store.rows.mockReturnValue([readyRow()]);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }]);
    const el = mount(SessionInfoPanel, { sessionId: 's1', mode: 'sidebar' });
    await nextTick();

    expect(el.querySelector('.sif-created')).toBeNull();
    expect(el.querySelector('.sif-branch')?.textContent).toBe('feat/session-info');
    expect(el.querySelector('.sif-diff-button')).not.toBeNull();
  });

  it('refreshes every directory from the main directory title row', async () => {
    store.rows.mockReturnValue([readyRow(), { ...readyRow(), path: '/repo/b', primary: false }]);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }, { path: '/repo/b', primary: false }]);
    const el = mount(SessionInfoPanel, { sessionId: 's1', mode: 'sidebar' });
    await nextTick();

    expect(el.querySelectorAll('.si-refresh')).toHaveLength(1);
    const button = el.querySelector<HTMLButtonElement>('[data-folder="/repo/a"] .sif-head .si-refresh')!;
    expect(button.classList.contains('spinning')).toBe(false);
    button.click();
    expect(store.refresh).toHaveBeenCalledExactlyOnceWith('s1');
    expect(sessionInfoPanelSource).toMatch(/\.session-info:hover \.si-refresh,\s*\.si-refresh:focus-visible,\s*\.si-refresh\.spinning \{ opacity: 1; \}/);
    expect(sessionInfoPanelSource).toContain('.si-refresh { opacity: 0;');
  });

  it('keeps the data and rotates the icon while refreshing', async () => {
    store.refreshing.mockReturnValue(true);
    store.rows.mockReturnValue([readyRow()]);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }]);
    const el = mount(SessionInfoPanel, { sessionId: 's1', mode: 'sidebar' });
    await nextTick();

    expect(el.querySelector('.si-refresh')?.classList.contains('spinning')).toBe(true);
    expect(el.querySelector('.sif-branch')?.textContent).toBe('feat/session-info');
    expect(el.querySelector('.sif-diff')?.textContent).toBe('+128−42');
  });

  it('replaces the refresh button with a warning that explains a failed refresh', async () => {
    store.refreshError.mockReturnValue({ output: 'git status timed out' });
    store.rows.mockReturnValue([readyRow()]);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }]);
    const el = mount(SessionInfoPanel, { sessionId: 's1', mode: 'sidebar' });
    await nextTick();

    expect(el.querySelector('.si-refresh')).toBeNull();
    expect(el.querySelector('.sif-branch')?.textContent).toBe('feat/session-info');
    const element = await openPopover('.si-refresh-error');
    expect(element.querySelector('.sip-title')?.textContent).toBe('状态未更新');
    expect(element.querySelector('.sip-body')?.textContent).toBe('刷新超时，以下为上次更新的数据。');
    expect(element.querySelector('.sip-output')?.textContent).toBe('git status timed out');
    element.querySelector<HTMLButtonElement>('.sip-retry')!.click();
    expect(store.refresh).toHaveBeenCalledExactlyOnceWith('s1');
  });

  it('leaves only Browser under Open In when the worktree is missing', async () => {
    sessionState.sessions = [worktreeSession({ missing: true })];
    store.rows.mockReturnValue([{ ...readyRow(), state: { status: 'missing' as const } }]);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }]);
    const el = mount(SessionInfoPanel, {
      sessionId: 's1',
      mode: 'sidebar',
      available: [
        { type: 'browser', icon: 'browser', label: '浏览器', keys: [], disabled: false },
        { type: 'term', icon: 'terminal', label: '终端', keys: [], disabled: false },
        { type: 'file', icon: 'folder', label: '文件', keys: [], disabled: false },
        { type: 'sidechat', icon: 'side-chat', label: '侧边聊天', keys: [], disabled: false },
      ],
    });
    await nextTick();

    expect(el.querySelector('.sif-missing')?.textContent).toBe('工作树目录不存在');
    expect([...el.querySelectorAll('.sit-available')].map(node => node.textContent)).toEqual(['浏览器']);
  });

  it('refreshes when a session update marks the worktree missing or restored', async () => {
    const session = reactive(worktreeSession()) as { worktree: { missing?: boolean } };
    sessionState.sessions = reactive([session]) as never;
    const rows = reactive<SessionFolderInfoRow[]>([readyRow()]);
    store.rows.mockReturnValue(rows);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }]);
    mount(SessionInfoPanel, { sessionId: 's1', mode: 'sidebar' });
    await nextTick();
    expect(store.refresh).not.toHaveBeenCalled();

    session.worktree.missing = true;
    await nextTick();
    expect(store.refresh).toHaveBeenCalledExactlyOnceWith('s1');

    rows[0]!.state = { status: 'missing' };
    session.worktree.missing = false;
    await nextTick();
    expect(store.refresh).toHaveBeenCalledTimes(2);
  });

  it('does not refresh again when the store itself detected the missing worktree', async () => {
    const session = reactive(worktreeSession()) as { worktree: { missing?: boolean } };
    sessionState.sessions = reactive([session]) as never;
    const rows = reactive<SessionFolderInfoRow[]>([readyRow()]);
    store.rows.mockReturnValue(rows);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }]);
    mount(SessionInfoPanel, { sessionId: 's1', mode: 'sidebar' });
    await nextTick();

    rows[0]!.state = { status: 'missing' };
    session.worktree.missing = true;
    await nextTick();
    expect(store.refresh).not.toHaveBeenCalled();
  });
});

describe('Wide table session info layout', () => {
  it('yields session info and disables its toggle while a table is expanded', () => {
    const source = conversationPaneSource;
    expect(source).toContain('isWideTableLayoutActive(tocHiddenByWideTable.value, conversationHostWidth.value)');
    expect(source).toContain('sessionInfoVisible.value && !wideTableActive.value');
    expect(source).toContain('v-if="sessionInfoPanelVisible"');
    expect(source).toContain(':session-info-enabled="sessionInfoPanelVisible"');
    expect(source).toContain(':session-info-disabled="wideTableActive"');
    expect(source).toContain(':table-expanded="wideTableActive"');
  });

  it('exposes the temporary session info state', () => {
    const source = chatHeaderSource;
    expect(source).toContain(':disabled="sessionInfoDisabled"');
    expect(source).toContain("props.sessionInfoDisabled) return t('header.sessionInfoWideTable')");
  });

  it.each([
    { name: 'ChatPane', source: chatPaneSource },
    { name: 'TurnFold', source: turnFoldSource },
  ])('keeps the expanded minimum width within its maximum in $name', ({ source }) => {
    expect(source).toContain('min-width: min(100%, var(--md-table-wide-width));');
    expect(source).not.toContain('--chat-table-inline-reserve');
  });

  it('lets expanded tables and their actions escape the open fold clip boundary', () => {
    expect(turnFoldSource).toContain('.tf-body.open:has(.md-table-wide)');
    expect(turnFoldSource).toContain('.tf-body-inner:has(.md-table-wide)');
    expect(turnFoldSource).toMatch(/\.tf-body-inner:has\(\.md-table-wide\)\s*\{\s*overflow: visible;/);
  });
});
