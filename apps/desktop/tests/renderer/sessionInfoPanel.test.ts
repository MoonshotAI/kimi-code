// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { useContextInspector } from '@moonshot-ai/app-core';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon, type IconName } from '@moonshot-ai/app-client/icons';
import { panelApiKey, type PanelApi } from '@moonshot-ai/app-client/panel';
import type { SessionContextInfoState, SessionFolderInfoRow } from '@moonshot-ai/app-client/stores';

import SessionInfoContext from '../../src/renderer/components/chat/SessionInfoContext.vue';
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

const store = vi.hoisted(() => ({
  rows: vi.fn(),
  foldersForSession: vi.fn(),
  contextState: vi.fn<(_sessionId: string) => SessionContextInfoState | undefined>(),
  observe: vi.fn(),
  observeContext: vi.fn(),
  refreshContext: vi.fn(),
  unobserve: vi.fn(),
  unobserveContext: vi.fn(),
}));

vi.mock('@moonshot-ai/app-client/stores', () => ({
  sessionInfoStore: () => store,
}));

let app: App | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  store.rows.mockReset();
  store.foldersForSession.mockReset();
  store.contextState.mockReset();
  store.observe.mockReset();
  store.observeContext.mockReset();
  store.refreshContext.mockReset();
  store.unobserve.mockReset();
  store.unobserveContext.mockReset();
  useContextInspector().setContextInspectorEnabled(false);
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

function readyRow(): SessionFolderInfoRow {
  return {
    path: '/repo/a',
    primary: true,
    state: {
      status: 'ready',
      value: {
        branch: 'feat/session-info',
        ahead: 2,
        behind: 1,
        entries: {},
        additions: 128,
        deletions: 42,
        pullRequest: { number: 1287, state: 'open', url: 'https://github.com/acme/repo/pull/1287' },
      },
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

describe('SessionInfoFolder', () => {
  it('renders branch, sync, diff and PR independently and emits diff and PR clicks', async () => {
    const openPr = vi.fn();
    const openDiff = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    app = createApp({ render: () => h(SessionInfoFolder, { row: readyRow(), onOpenPr: openPr, onOpenDiff: openDiff }) });
    app.use(createKimiI18n({ locale: 'zh' }));
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain('feat/session-info');
    expect(host.textContent).toContain('↑2');
    expect(host.textContent).toContain('↓1');
    expect(host.textContent).toContain('+128');
    expect(host.textContent).toContain('-42');
    expect(host.textContent).toContain('PR #1287');
    expect(host.textContent).not.toContain('/repo/a');

    host.querySelector<HTMLButtonElement>('.sif-diff-button')!.click();
    expect(openDiff).toHaveBeenCalledOnce();
    host.querySelector<HTMLButtonElement>('.sif-pr')!.click();
    expect(openPr).toHaveBeenCalledExactlyOnceWith('https://github.com/acme/repo/pull/1287');
  });

  it('shows a clickable no-changes state instead of zero diff counts', async () => {
    const openDiff = vi.fn();
    const row = readyRow();
    if (row.state.status !== 'ready') throw new Error('Expected a ready folder');
    row.state = { status: 'ready', value: { ...row.state.value, additions: 0, deletions: 0 } };
    mount(SessionInfoFolder, { row, onOpenDiff: openDiff });
    await nextTick();

    expect(host!.textContent).toContain('无变更');
    expect(host!.querySelector('.sif-diff')).toBeNull();
    host!.querySelector<HTMLButtonElement>('.sif-diff-button')!.click();
    expect(openDiff).toHaveBeenCalledOnce();
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

  it('collapses additional folders by default and toggles their content', async () => {
    mount(SessionInfoFolder, { row: { ...readyRow(), path: '/repo/b', primary: false } });
    await nextTick();
    const heading = host!.querySelector<HTMLButtonElement>('.sif-heading')!;

    expect(heading.getAttribute('aria-expanded')).toBe('false');
    expect(host!.querySelector('.sif-git')).toBeNull();
    heading.click();
    await nextTick();
    expect(heading.getAttribute('aria-expanded')).toBe('true');
    expect(host!.querySelector('.sif-git')).not.toBeNull();
    expect(host!.textContent).not.toContain('/repo/b');
    heading.click();
    await nextTick();
    expect(heading.getAttribute('aria-expanded')).toBe('false');
    expect(host!.querySelector('.sif-git')).toBeNull();
  });

  it('shows skeleton rows and a loading status without fabricating Git data', async () => {
    mount(SessionInfoFolder, { row: { ...readyRow(), state: { status: 'loading' } } });
    await nextTick();

    expect(host!.querySelectorAll('.sif-loading .ui-skeleton')).toHaveLength(3);
    expect(host!.querySelector('.sif-loading')?.textContent).toBe('加载中');
    expect(host!.querySelector('.sif-branch')).toBeNull();
    expect(host!.querySelector('.sif-diff-button')).toBeNull();
    expect(host!.querySelector('.sif-pr')).toBeNull();
    const skeletonStyle = sessionInfoFolderSource.match(/\.sif-skeleton :deep\(\.ui-skeleton\)\s*\{([^}]*)\}/)?.[1];
    expect(skeletonStyle).toContain('background: var(--color-surface)');
  });

  it.each([
    [{ status: 'error' as const }, '信息加载失败'],
    [{ status: 'non-git' as const }, '非 Git 目录'],
  ])('renders the %s state without fabricating git data', async (state, label) => {
    mount(SessionInfoFolder, { row: { ...readyRow(), state } });
    await nextTick();
    expect(host!.textContent).toContain(label);
    expect(host!.querySelector('.sif-diff')).toBeNull();
    expect(host!.querySelector('.sif-pr')).toBeNull();
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

  it.each([1, 2])('hides %s non-git folder(s) but keeps opened and available tabs', async (count) => {
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

    expect(el.querySelector('.si-folders')).toBeNull();
    expect(el.querySelector('.sit-opened')?.textContent).toBe('File 1.vue');
    expect(el.querySelector('.sit-available')?.textContent).toBe('终端');
  });

  it('skips loading placeholders for quickly resolved non-git folders', async () => {
    vi.useFakeTimers();
    try {
      const rows = reactive<SessionFolderInfoRow[]>([{ ...readyRow(), state: { status: 'loading' } }]);
      store.rows.mockReturnValue(rows);
      store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }]);
      const el = mount(SessionInfoPanel, {
        sessionId: 's1',
        mode: 'sidebar',
        available: [{ type: 'term', icon: 'terminal', label: '终端', keys: [], disabled: false }],
      });
      await nextTick();

      expect(el.querySelector('.si-folders')).toBeNull();
      expect(el.querySelector('.sit-available')?.textContent).toBe('终端');
      rows[0]!.state = { status: 'non-git' };
      await nextTick();
      await vi.advanceTimersByTimeAsync(150);
      expect(el.querySelector('.si-folders')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the loading skeleton after a short delay', async () => {
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
      expect(el.querySelectorAll('.sif-loading .ui-skeleton')).toHaveLength(3);
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
    const stateStyle = sessionInfoFolderSource.match(/\.sif-pr-state\s*\{([^}]*)\}/)?.[1];

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

  it('hides the primary label for a single folder', async () => {
    store.rows.mockReturnValue([readyRow()]);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }]);
    const el = mount(SessionInfoPanel, { sessionId: 's1', mode: 'sidebar' });
    await nextTick();

    expect(el.querySelector('.sif-primary')).toBeNull();
  });

  it('places the primary label between the folder name and chevron for multiple folders', async () => {
    store.rows.mockReturnValue([readyRow(), { ...readyRow(), path: '/repo/b', primary: false }]);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }, { path: '/repo/b', primary: false }]);
    const el = mount(SessionInfoPanel, { sessionId: 's1', mode: 'sidebar' });
    await nextTick();

    const name = el.querySelector('[data-folder="/repo/a"] .sif-name');
    const badge = el.querySelector('[data-folder="/repo/a"] .sif-primary');
    expect(badge?.textContent).toBe('主目录');
    expect(name?.nextElementSibling).toBe(badge);
    const badgeIndex = sessionInfoFolderSource.indexOf('<Badge v-if="row.primary && showPrimaryBadge"');
    const chevronIndex = sessionInfoFolderSource.indexOf('<Icon class="sif-chevron"');
    expect(badgeIndex).toBeGreaterThan(-1);
    expect(chevronIndex).toBeGreaterThan(badgeIndex);
    expect(el.querySelector('[data-folder="/repo/b"] .sif-primary')).toBeNull();
    const primaryStyle = sessionInfoFolderSource.match(/\.sif-primary\s*\{([^}]*)\}/)?.[1];
    expect(primaryStyle).not.toContain('margin-left: auto');
  });

  it('renders context composition, toggles collapse, and forwards compact and detail actions', async () => {
    useContextInspector().setContextInspectorEnabled(true);
    const compact = vi.fn();
    const openContext = vi.fn();
    store.rows.mockReturnValue([readyRow()]);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }]);
    store.contextState.mockReturnValue({
      status: 'ready',
      value: {
        session_id: 's1',
        agent_id: 'main',
        captured_at: 1000,
        tokens: { used: 640000, max: 1048576 },
        groups: [
          { role: 'system', count: 1, tokens: 128000 },
          { role: 'definition', count: 10, tokens: 192000 },
          { role: 'user', count: 4, tokens: 320000 },
        ],
      },
    });

    host = document.createElement('div');
    document.body.append(host);
    app = createApp(SessionInfoPanel, {
      sessionId: 's1',
      mode: 'sidebar',
      onCompact: compact,
    });
    app.use(createKimiI18n({ locale: 'zh' }));
    app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
    app.provide(panelApiKey, { openContext } as unknown as PanelApi);
    app.mount(host);
    await nextTick();

    expect(store.observeContext).toHaveBeenCalledWith('s1');
    const section = host.querySelector<HTMLElement>('.si-context')!;
    expect(section).not.toBeNull();
    expect(section.querySelector('.sic-title')?.textContent).toBe('上下文');
    expect(section.querySelector('.sic-usage')).toBeNull();
    expect(section.querySelector('.ctx-usage-headline')?.textContent).toBe('62% 已用');
    expect(section.querySelector('.ctx-usage-total')?.textContent).toBe('625k / 1M');
    const segWidths = Array.from(section.querySelectorAll<HTMLElement>('.ctx-composition-seg'))
      .map((seg) => Number.parseFloat(seg.style.width));
    expect(segWidths).toHaveLength(3);
    expect(segWidths[0]).toBeCloseTo((320000 / 1048576) * 100, 5);
    expect(segWidths[1]).toBeCloseTo((192000 / 1048576) * 100, 5);
    expect(segWidths[2]).toBeCloseTo((128000 / 1048576) * 100, 5);
    const rowText = (selector: string) => [...section.querySelectorAll(selector)].map((el) => el.textContent);
    expect(rowText('.ctx-role-name')).toEqual(['用户', '工具', '系统']);
    expect(rowText('.ctx-role-tokens')).toEqual(['~313k', '~188k', '~125k']);
    expect(rowText('.ctx-role-share')).toEqual(['30.5%', '18.3%', '12.2%']);

    vi.useFakeTimers();
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
      section.querySelectorAll<HTMLElement>('.ctx-role-name')[1]!.focus();
      await vi.advanceTimersByTimeAsync(200);
      expect(document.querySelector('[role="tooltip"]')?.textContent?.trim()).toBe('10 个工具');
    } finally {
      vi.useRealTimers();
    }

    const actionButtons = section.querySelectorAll<HTMLButtonElement>('.ctx-summary-btn');
    expect(actionButtons).toHaveLength(2);
    actionButtons[0]!.click();
    actionButtons[1]!.click();
    expect(compact).toHaveBeenCalledOnce();
    expect(openContext).toHaveBeenCalledOnce();

    const heading = section.querySelector<HTMLButtonElement>('.sic-heading')!;
    heading.click();
    await nextTick();
    expect(heading.getAttribute('aria-expanded')).toBe('false');
    expect(section.querySelector('.ctx-summary')).toBeNull();
    expect(section.querySelector('.sic-usage')?.textContent).toBe('已用 625k · 剩余 399k');

    app.unmount();
    expect(store.unobserveContext).toHaveBeenCalledWith('s1');
  });

  it('refreshes the context section when the model changes while idle', async () => {
    useContextInspector().setContextInspectorEnabled(true);
    store.rows.mockReturnValue([readyRow()]);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }]);
    const props = reactive({
      sessionId: 's1',
      mode: 'sidebar' as const,
      ctxUsed: 1000,
      ctxMax: 10000,
      modelId: 'model-a',
      running: false,
    });
    host = document.createElement('div');
    document.body.append(host);
    app = createApp({ render: () => h(SessionInfoPanel, props) });
    app.use(createKimiI18n({ locale: 'zh' }));
    app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
    app.mount(host);
    await nextTick();
    expect(store.refreshContext).not.toHaveBeenCalled();

    props.modelId = 'model-b';
    props.ctxMax = 20000;
    await nextTick();
    expect(store.refreshContext).toHaveBeenCalledExactlyOnceWith('s1');
  });

  it('skips the context section and its reads while the context inspector is off', async () => {
    store.rows.mockReturnValue([readyRow()]);
    store.foldersForSession.mockReturnValue([{ path: '/repo/a', primary: true }]);
    store.contextState.mockReturnValue({
      status: 'ready',
      value: {
        session_id: 's1',
        agent_id: 'main',
        captured_at: 1000,
        tokens: { used: 1000, max: 10000 },
        groups: [{ role: 'user', count: 1, tokens: 1000 }],
      },
    });
    const el = mount(SessionInfoPanel, {
      sessionId: 's1',
      mode: 'sidebar',
      available: [{ type: 'term', icon: 'terminal', label: '终端', keys: [], disabled: false }],
    });
    await nextTick();

    expect(el.querySelector('.si-context')).toBeNull();
    expect(el.querySelector('.si-folders + .sit')).not.toBeNull();
    expect(store.observeContext).not.toHaveBeenCalled();

    useContextInspector().setContextInspectorEnabled(true);
    await nextTick();
    expect(el.querySelector('.si-folders + .si-context + .sit')).not.toBeNull();
    expect(store.observeContext).toHaveBeenCalledWith('s1');

    useContextInspector().setContextInspectorEnabled(false);
    await nextTick();
    expect(el.querySelector('.si-context')).toBeNull();
    expect(store.unobserveContext).toHaveBeenCalledWith('s1');
  });

  it('keeps showing the last summary with a notice after a refresh fails', async () => {
    mount(SessionInfoContext, {
      canCompact: true,
      state: {
        status: 'error',
        message: 'offline',
        value: {
          session_id: 's1',
          agent_id: 'main',
          captured_at: 1000,
          tokens: { used: 1000, max: 10000 },
          groups: [{ role: 'user', count: 1, tokens: 1000 }],
        },
      },
    });
    await nextTick();
    expect(host!.querySelectorAll('.ctx-role-row')).toHaveLength(1);
    expect(host!.querySelector('.ctx-summary-stale')?.textContent?.trim()).toBe('刷新失败，显示的是上次读取的数据');
    expect(host!.querySelector('.ctx-summary-error')).toBeNull();
  });

  it('hides the view-details button when openContext is not provided', async () => {
    mount(SessionInfoContext, {
      canCompact: true,
      state: {
        status: 'ready',
        value: {
          session_id: 's1',
          agent_id: 'main',
          captured_at: 1000,
          tokens: { used: 1000, max: 10000 },
          groups: [{ role: 'user', count: 1, tokens: 1000 }],
        },
      },
    });
    await nextTick();
    const buttons = host!.querySelectorAll<HTMLButtonElement>('.ctx-summary-btn');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toContain('压缩上下文');
  });

  it('shows token counts without window shares when the context limit is unknown', async () => {
    mount(SessionInfoContext, {
      state: {
        status: 'ready',
        value: {
          session_id: 's1',
          agent_id: 'main',
          captured_at: 1000,
          tokens: { used: 3000 },
          groups: [
            { role: 'user', count: 2, tokens: 1000 },
            { role: 'tool', count: 1, tokens: 2000 },
          ],
        },
      },
    });
    await nextTick();
    expect(host!.querySelector('.ctx-usage-headline')?.textContent).toBe('已用 2.9k');
    expect(host!.querySelector('.ctx-usage-total')).toBeNull();
    expect([...host!.querySelectorAll('.ctx-role-tokens')].map((el) => el.textContent)).toEqual(['~2k', '~1000']);
    expect(host!.querySelector('.ctx-role-share')).toBeNull();
    const widths = [...host!.querySelectorAll<HTMLElement>('.ctx-composition-seg')]
      .map((seg) => Number.parseFloat(seg.style.width));
    expect(widths[0]).toBeCloseTo(200 / 3, 5);
    expect(widths[1]).toBeCloseTo(100 / 3, 5);
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
