// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, reactive, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, WorkspaceGroup as WorkspaceGroupView } from '@moonshot-ai/app-core/client/types';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';

const fakes = vi.hoisted(() => ({
  views: null as unknown as {
    workspaceGroups: unknown[];
    unpinnedWorkspaceGroups: unknown[];
    pinnedWorkspaceGroups: unknown[];
    pinnedSessions: unknown[];
    pinnedEntries?: unknown[];
    pendingBySession: Record<string, { approvals: number; questions: number }>;
    unreadBySession: Record<string, boolean>;
  },
  sessions: null as unknown as { activeSessionId: string | null },
  workspaces: null as unknown as {
    activeWorkspaceId: string | null;
    workspaceSortMode: string;
    pinnedWorkspaceIds: string[];
    workspaces: Array<{ id: string }>;
  },
  client: null as unknown as Record<string, unknown>,
}));

vi.mock('@moonshot-ai/app-client/stores', () => ({
  sessionViewsStore: () => fakes.views,
  sessionsStore: () => fakes.sessions,
  workspacesStore: () => fakes.workspaces,
  hostsStore: () => ({ displayState: () => 'local', unavailable: () => false, blocked: () => false }),
}));

vi.mock('@moonshot-ai/app-client/client', () => ({
  SESSIONS_EXPAND_BATCH: 20,
  useKimiWebClient: () => fakes.client,
}));

import SessionListPanel from '../src/sidebar/SessionListPanel.vue';
import WorkspaceGroup from '../src/WorkspaceGroup.vue';

const GROUPS = 20;
const PER_GROUP = 3;

let app: App | null = null;
let host: HTMLDivElement;

function session(groupIndex: number, index: number): Session {
  return {
    id: `s-${groupIndex}-${index}`,
    title: `session ${groupIndex}-${index}`,
    time: '1m',
    busy: false,
    pendingInteraction: 'none',
    updatedAt: '2026-01-01T00:00:00.000Z',
    workspaceId: `ws-${groupIndex}`,
  } as unknown as Session;
}

function group(groupIndex: number, sessions = PER_GROUP, initialCount = 5): WorkspaceGroupView {
  return {
    workspace: {
      id: `ws-${groupIndex}`,
      name: `Workspace ${groupIndex}`,
      root: `/repo/${groupIndex}`,
      shortPath: `~/repo/${groupIndex}`,
      sessionCount: sessions,
    },
    sessions: Array.from({ length: sessions }, (_, i) => session(groupIndex, i)),
    hasMore: false,
    loadingMore: false,
    initialCount,
    pinnedCount: 0,
  } as unknown as WorkspaceGroupView;
}

function countGroupRenders(): { count: () => number; restore: () => void } {
  const component = WorkspaceGroup as unknown as { render?: (...args: unknown[]) => unknown };
  const original = component.render;
  if (typeof original !== 'function') throw new Error('WorkspaceGroup has no standalone render function');
  let count = 0;
  component.render = function (this: unknown, ...args: unknown[]) {
    count += 1;
    return original.apply(this, args);
  };
  return { count: () => count, restore: () => { component.render = original; } };
}

function headerOf(workspaceId: string): Element {
  const el = host.querySelector(`[data-ws-id="${workspaceId}"] .gh`);
  expect(el).not.toBeNull();
  return el!;
}

function rowOf(sessionId: string): Element | null {
  return host.querySelector(`[data-session-id="${sessionId}"]`);
}

async function flushFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function installTestPlugins(instance: App): App {
  instance.provide(IconResolverKey, (name: string) =>
    defineComponent({
      name: `TestIcon-${name}`,
      render: () => h('svg', { 'data-icon': name }),
    }),
  );
  instance.use(createKimiI18n({ locale: 'en' }));
  return instance;
}

let renders: ReturnType<typeof countGroupRenders>;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  const workspaceGroups = Array.from({ length: GROUPS }, (_, i) => group(i));
  fakes.views = reactive({
    workspaceGroups,
    unpinnedWorkspaceGroups: workspaceGroups,
    pinnedWorkspaceGroups: [],
    pinnedSessions: [],
    pendingBySession: {},
    unreadBySession: {},
  });
  fakes.sessions = reactive({ activeSessionId: 's-0-0' });
  fakes.workspaces = reactive({
    activeWorkspaceId: 'ws-0',
    workspaceSortMode: 'recent',
    pinnedWorkspaceIds: [],
    workspaces: Array.from({ length: GROUPS }, (_, i) => ({ id: `ws-${i}` })),
  });
  fakes.client = {
    flatSessions: ref([]),
    flatSessionsHasMore: ref(false),
    flatSessionsLoadingMore: ref(false),
    doneSessions: ref([]),
    doneSessionsHasMore: ref(false),
    doneSessionsLoadingMore: ref(false),
    initialized: ref(false),
    ensureFlatSessions: vi.fn(),
    ensureDoneSessions: vi.fn(),
    togglePinWorkspace: vi.fn(),
    pinWorkspace: vi.fn(),
    pinSession: vi.fn(),
    reorderPinned: vi.fn(),
  };
  renders = countGroupRenders();
  app = installTestPlugins(createApp(SessionListPanel, { statusTab: 'open', canEditWorkspace: true }));
  app.mount(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  renders.restore();
  host.remove();
});

describe('SessionListPanel re-render scope', () => {
  it('renders every workspace group', () => {
    expect(host.querySelectorAll('[data-ws-id]')).toHaveLength(GROUPS);
    expect(rowOf('s-0-0')?.classList.contains('on')).toBe(true);
  });

  it('keeps the workspace root tooltip when hover cards are disabled', async () => {
    fakes.views.workspaceGroups = [group(0)];
    fakes.views.unpinnedWorkspaceGroups = fakes.views.workspaceGroups;
    await nextTick();
    const name = headerOf('ws-0').querySelector('.gh-name');
    expect(name?.parentElement?.classList.contains('ui-tip')).toBe(true);
  });

  it('uses the workspace hover card without the legacy tooltip when enabled', async () => {
    app?.unmount();
    fakes.views.workspaceGroups = [group(0)];
    fakes.views.unpinnedWorkspaceGroups = fakes.views.workspaceGroups;
    app = createApp(SessionListPanel, { statusTab: 'open', canEditWorkspace: true, workspaceHoverEnabled: true });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await nextTick();
    const name = headerOf('ws-0').querySelector('.gh-name');
    expect(name?.parentElement?.classList.contains('ui-tip')).toBe(false);
  });

  it.each([
    { scenario: 'registered', registered: true, expected: true },
    { scenario: 'derived', registered: false, expected: false },
  ])('shows the edit action for $scenario workspaces', async ({ registered, expected }) => {
    fakes.views.workspaceGroups = [group(0)];
    fakes.views.unpinnedWorkspaceGroups = fakes.views.workspaceGroups;
    fakes.workspaces.workspaces = registered ? [{ id: 'ws-0' }] : [];
    await nextTick();
    headerOf('ws-0').querySelector<HTMLButtonElement>('.gh-more')!.click();
    await vi.waitFor(() => expect(host.querySelector('.workspace-menu')).not.toBeNull());

    const editItem = [...host.querySelectorAll<HTMLButtonElement>('.workspace-menu [role="menuitem"]')].find(
      (item) => item.textContent?.includes('Edit project'),
    );
    expect(editItem !== undefined).toBe(expected);
  });

  it('uses the project title in grouped view and the session title in flat view', async () => {
    const title = () => host.querySelector('.side-section-title')?.textContent?.trim();
    expect(title()).toBe('Projects');

    host.querySelector<HTMLButtonElement>('.side-section-view')!.click();
    await vi.waitFor(() => expect(host.querySelector('.view-menu')).not.toBeNull());
    const flatItem = [...host.querySelectorAll<HTMLButtonElement>('.view-menu [role="menuitem"]')].find(
      (item) => item.textContent?.includes('Flat list'),
    );
    expect(flatItem).not.toBeUndefined();
    flatItem!.click();
    await nextTick();

    expect(title()).toBe('sessions');
  });

  it('shows pinned workspaces in the pinned section with working group actions', async () => {
    app?.unmount();
    const pinned = group(0);
    const other = group(1);
    fakes.views.workspaceGroups = [pinned, other];
    fakes.views.unpinnedWorkspaceGroups = [other];
    fakes.views.pinnedWorkspaceGroups = [pinned];
    fakes.workspaces.pinnedWorkspaceIds = ['ws-0'];
    const createInWorkspace = vi.fn();
    app = createApp(SessionListPanel, {
      statusTab: 'open',
      canEditWorkspace: true,
      onCreateInWorkspace: createInWorkspace,
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await nextTick();

    const pinnedRoot = host.querySelector('.pinned');
    const pinnedHeader = pinnedRoot?.querySelector('[data-ws-id="ws-0"] .gh');
    expect(pinnedRoot).not.toBeNull();
    expect(pinnedHeader).not.toBeNull();
    expect(host.querySelector('.sessions [data-ws-id="ws-0"]')).toBeNull();
    expect(host.querySelector('.sessions [data-ws-id="ws-1"]')).not.toBeNull();
    expect(pinnedRoot?.querySelector('[data-session-id="s-0-0"]')).not.toBeNull();
    expect(pinnedRoot?.querySelector('.pinned-resize')).not.toBeNull();
    const groupHeader = pinnedRoot!.querySelector<HTMLElement>('.gh')!;
    const firstSession = pinnedRoot!.querySelector<HTMLElement>('.se')!;
    vi.spyOn(groupHeader, 'getBoundingClientRect').mockReturnValue({ height: 32 } as DOMRect);
    vi.spyOn(firstSession, 'getBoundingClientRect').mockReturnValue({ height: 50 } as DOMRect);
    fakes.sessions.activeSessionId = 's-0-1';
    await nextTick();
    expect(pinnedRoot!.querySelector('.pinned-resize')!.getAttribute('aria-valuemin')).toBe('82');

    pinnedHeader!.querySelector<HTMLButtonElement>('.gh-add')!.click();
    expect(createInWorkspace).toHaveBeenCalledExactlyOnceWith('ws-0');

    (pinnedHeader as HTMLElement).click();
    await nextTick();
    expect(pinnedRoot?.querySelector('.group-sessions')?.classList.contains('collapsed')).toBe(true);
    expect(pinnedRoot?.querySelector('.pinned-resize')).toBeNull();

    pinnedHeader!.querySelector<HTMLButtonElement>('.gh-more')!.click();
    await vi.waitFor(() => expect(host.querySelector('.workspace-menu')).not.toBeNull());
    const unpinItem = [...host.querySelectorAll<HTMLButtonElement>('.workspace-menu [role="menuitem"]')].find(
      (item) => item.textContent?.trim() === 'Unpin',
    );
    expect(unpinItem).not.toBeUndefined();
    unpinItem!.click();
    expect(fakes.client.togglePinWorkspace).toHaveBeenCalledExactlyOnceWith('ws-0');

    headerOf('ws-1').querySelector<HTMLButtonElement>('.gh-more')!.click();
    await vi.waitFor(() => expect(host.querySelector('.workspace-menu')).not.toBeNull());
    const pinItem = [...host.querySelectorAll<HTMLButtonElement>('.workspace-menu [role="menuitem"]')].find(
      (item) => item.textContent?.trim() === 'Pin',
    );
    expect(pinItem).not.toBeUndefined();
    pinItem!.click();
    expect(fakes.client.togglePinWorkspace).toHaveBeenCalledWith('ws-1');
  });

  it('returns to Open before locating a session in a pinned workspace', async () => {
    app?.unmount();
    const pinned = group(0);
    fakes.views.workspaceGroups = [pinned];
    fakes.views.unpinnedWorkspaceGroups = [];
    fakes.views.pinnedWorkspaceGroups = [pinned];
    fakes.workspaces.pinnedWorkspaceIds = ['ws-0'];
    const updateStatusTab = vi.fn();
    app = createApp(SessionListPanel, { statusTab: 'done', 'onUpdate:statusTab': updateStatusTab });
    app.use(createKimiI18n({ locale: 'en' }));
    const panel = app.mount(host) as unknown as { locateSession: (id: string) => void };

    panel.locateSession('s-0-0');
    await nextTick();
    expect(updateStatusTab).toHaveBeenCalledExactlyOnceWith('open');
  });

  it('filters pinned workspace sessions only from the desktop flat list', async () => {
    const pinned = group(0);
    const other = group(1);
    fakes.views.workspaceGroups = [pinned, other];
    fakes.views.unpinnedWorkspaceGroups = [other];
    fakes.views.pinnedWorkspaceGroups = [pinned];
    fakes.workspaces.pinnedWorkspaceIds = ['ws-0'];
    fakes.client.flatSessions = ref([session(0, 0), session(1, 0)]);
    await nextTick();

    host.querySelector<HTMLButtonElement>('.side-section-view')!.click();
    await vi.waitFor(() => expect(host.querySelector('.view-menu')).not.toBeNull());
    [...host.querySelectorAll<HTMLButtonElement>('.view-menu [role="menuitem"]')]
      .find((item) => item.textContent?.includes('Flat list'))!
      .click();
    await nextTick();

    expect(host.querySelector('.pinned [data-session-id="s-0-0"]')).not.toBeNull();
    const flatRows = [...host.querySelectorAll('.sessions .se')];
    expect(flatRows).toHaveLength(1);
    expect(flatRows[0]?.textContent).toContain('session 1-0');
    expect(flatRows[0]?.textContent).not.toContain('session 0-0');
  });

  it('re-renders only the groups that lose or gain the active session', async () => {
    await nextTick();
    const before = renders.count();
    fakes.sessions.activeSessionId = 's-7-1';
    await nextTick();
    expect(renders.count() - before).toBe(2);
    expect(rowOf('s-0-0')?.classList.contains('on')).toBe(false);
    expect(rowOf('s-7-1')?.classList.contains('on')).toBe(true);
  });

  it('keeps an active session beyond the visible head listed in its group', async () => {
    fakes.views.workspaceGroups = [group(0, 6, 2), group(1)];
    fakes.views.unpinnedWorkspaceGroups = fakes.views.workspaceGroups;
    fakes.sessions.activeSessionId = 's-0-5';
    await nextTick();
    expect(rowOf('s-0-4')).toBeNull();
    expect(rowOf('s-0-5')?.classList.contains('on')).toBe(true);
  });

  it('re-renders only the group whose approval badges change', async () => {
    await nextTick();
    const before = renders.count();
    fakes.views.pendingBySession = { 's-5-0': { approvals: 1, questions: 0 } };
    await nextTick();
    expect(renders.count() - before).toBe(1);
    expect(rowOf('s-5-0')?.classList.contains('has-badge')).toBe(true);

    const settled = renders.count();
    fakes.views.pendingBySession = { 's-5-0': { approvals: 1, questions: 0 } };
    await nextTick();
    expect(renders.count()).toBe(settled);

    fakes.views.pendingBySession = {};
    await nextTick();
    expect(renders.count() - settled).toBe(1);
    expect(rowOf('s-5-0')?.classList.contains('has-badge')).toBe(false);
  });

  it('re-renders only the group whose unread state changes', async () => {
    await nextTick();
    const before = renders.count();
    fakes.views.unreadBySession = { 's-9-2': true };
    await nextTick();
    expect(renders.count() - before).toBe(1);

    const settled = renders.count();
    fakes.views.unreadBySession = { 's-9-2': true, 's-11-0': false };
    await nextTick();
    expect(renders.count() - settled).toBe(1);
  });

  it('batches scroll-state layout reads after re-renders into the next frame', async () => {
    const list = host.querySelector<HTMLElement>('.sessions')!;
    await flushFrame();
    let reads = 0;
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => {
        reads += 1;
        return 5000;
      },
    });
    fakes.sessions.activeSessionId = 's-2-0';
    await nextTick();
    expect(reads).toBe(0);
    await flushFrame();
    const readsPerPass = reads;
    expect(readsPerPass).toBeGreaterThan(0);

    fakes.sessions.activeSessionId = 's-4-0';
    await nextTick();
    fakes.sessions.activeSessionId = 's-6-0';
    await nextTick();
    fakes.views.unreadBySession = { 's-8-0': true };
    await nextTick();
    expect(reads).toBe(readsPerPass);
    await flushFrame();
    expect(reads).toBe(readsPerPass * 2);
  });

  it('renders standalone pinned sessions as compact single-line rows by default, with interleaved order and drag reordering', async () => {
    app?.unmount();
    const pinnedGroup = group(0, 1);
    const otherGroup = group(1, 1);
    const pinnedSingle: Session = {
      ...session(1, 1),
      pinned: true,
      workspaceName: 'Workspace 1',
      cwdLabel: '1',
      pullRequest: { number: 1279, state: 'open', url: 'https://example.com/pr/1279' },
    };
    fakes.views.workspaceGroups = [pinnedGroup, otherGroup];
    fakes.views.unpinnedWorkspaceGroups = [otherGroup];
    fakes.views.pinnedWorkspaceGroups = [pinnedGroup];
    fakes.views.pinnedSessions = [pinnedSingle];
    fakes.views.pinnedEntries = [
      { key: `session:${pinnedSingle.id}`, kind: 'session', session: pinnedSingle },
      { key: 'ws:ws-0', kind: 'workspace', group: pinnedGroup },
    ];
    fakes.workspaces.pinnedWorkspaceIds = ['ws-0'];

    app = installTestPlugins(
      createApp(SessionListPanel, { statusTab: 'open', canEditWorkspace: true }),
    );
    const panel = app.mount(host) as unknown as { getSiblingOrder: () => string[] };
    await nextTick();

    const pinnedEntriesDom = [...host.querySelectorAll('.pinned .pinned-rows > [data-pin-key]')];
    expect(pinnedEntriesDom.map((el) => el.getAttribute('data-pin-key'))).toEqual([
      `session:${pinnedSingle.id}`,
      'ws:ws-0',
    ]);
    expect(panel.getSiblingOrder().slice(0, 2)).toEqual([pinnedSingle.id, 's-0-0']);

    const compactRow = host.querySelector(`.pinned [data-session-id="${pinnedSingle.id}"]`)!;
    expect(compactRow.classList.contains('compact-pinned')).toBe(true);
    expect(compactRow.classList.contains('has-sub')).toBe(false);
    expect(compactRow.classList.contains('flat')).toBe(false);
    expect(compactRow.querySelector('.lead .lead-icon')?.getAttribute('data-icon')).toBe('message');
    expect(compactRow.querySelector('.sub')).toBeNull();
    expect(compactRow.querySelector('.compact-pr')?.textContent).toContain('#1279');

    const pinRowWrapper = compactRow.closest<HTMLElement>('.pin-row')!;
    const pinWsWrapper = host.querySelector<HTMLElement>('.pinned .pin-workspace')!;
    vi.spyOn(pinWsWrapper, 'getBoundingClientRect').mockReturnValue({
      top: 40,
      height: 60,
    } as DOMRect);

    const dataTransfer = {
      types: ['text/plain'],
      effectAllowed: '',
      dropEffect: '',
      setData: vi.fn(),
      getData: vi.fn(() => ''),
    };
    pinRowWrapper.dispatchEvent(
      Object.assign(new Event('dragstart', { bubbles: true, cancelable: true }), { dataTransfer }),
    );
    pinWsWrapper.dispatchEvent(
      Object.assign(new Event('dragover', { bubbles: true, cancelable: true }), {
        dataTransfer,
        clientY: 85,
      }),
    );
    await nextTick();
    expect(pinWsWrapper.classList.contains('drop-after')).toBe(true);

    pinWsWrapper.dispatchEvent(
      Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
        dataTransfer,
        clientY: 85,
      }),
    );
    expect(fakes.client.reorderPinned).toHaveBeenCalledExactlyOnceWith(
      `session:${pinnedSingle.id}`,
      'ws:ws-0',
      'after',
    );
  });

  it('switches pinned sessions between compact and project-subtitle display via header options and blank-area context menu', async () => {
    app?.unmount();
    const pinnedGroup = group(0, 1);
    const otherGroup = group(1, 1);
    const pinnedSingle: Session = {
      ...session(1, 1),
      pinned: true,
      workspaceName: 'Workspace 1',
      cwdLabel: '1',
      pullRequest: { number: 1279, state: 'open', url: 'https://example.com/pr/1279' },
    };
    fakes.views.workspaceGroups = [pinnedGroup, otherGroup];
    fakes.views.unpinnedWorkspaceGroups = [otherGroup];
    fakes.views.pinnedWorkspaceGroups = [pinnedGroup];
    fakes.views.pinnedSessions = [pinnedSingle];
    fakes.views.pinnedEntries = [
      { key: `session:${pinnedSingle.id}`, kind: 'session', session: pinnedSingle },
      { key: 'ws:ws-0', kind: 'workspace', group: pinnedGroup },
    ];
    fakes.workspaces.pinnedWorkspaceIds = ['ws-0'];

    app = installTestPlugins(
      createApp(SessionListPanel, { statusTab: 'open', canEditWorkspace: true }),
    );
    app.mount(host);
    await nextTick();

    const pinnedRoot = host.querySelector('.pinned')!;
    const pinnedRow = () => host.querySelector(`.pinned [data-session-id="${pinnedSingle.id}"]`)!;
    const openPinnedMenu = () => document.body.querySelector('.pinned-menu:not(.menu-pop-leave-active)');

    const pinnedHeading = pinnedRoot.querySelector<HTMLElement>('.pinned-heading')!;
    expect(pinnedHeading.firstElementChild?.classList.contains('pinned-title')).toBe(true);
    expect(pinnedHeading.lastElementChild?.classList.contains('pinned-toggle')).toBe(true);
    expect(pinnedHeading.querySelector('.ui-tip')).toBeNull();
    const pinnedActionButtons = [...pinnedRoot.querySelectorAll('.pinned-actions button')];
    expect(pinnedActionButtons.map((btn) => btn.classList.contains('pinned-options'))).toEqual([true]);

    const sectionHeading = host.querySelector<HTMLElement>('.side-section-heading')!;
    expect(sectionHeading.firstElementChild?.classList.contains('side-section-title')).toBe(true);
    expect(sectionHeading.lastElementChild?.classList.contains('side-section-fold')).toBe(true);
    expect(sectionHeading.querySelector('.ui-tip')).toBeNull();
    const sectionActionButtons = [...host.querySelectorAll<HTMLButtonElement>('.side-section-actions button')];
    expect(sectionActionButtons.map((btn) => btn.getAttribute('aria-label'))).toEqual([
      'Collapse all projects',
      'New Project',
      'List options',
    ]);
    expect(sectionActionButtons.at(-1)?.classList.contains('side-section-view')).toBe(true);

    const pinnedRowsNode = pinnedRoot.querySelector('.pinned-rows')!;
    const pinnedFold = pinnedRoot.querySelector('.pinned-fold')!;
    pinnedHeading.querySelector<HTMLElement>('.pinned-title')!.click();
    await nextTick();
    expect(pinnedFold.classList.contains('collapsed')).toBe(true);
    expect(pinnedFold.hasAttribute('inert')).toBe(true);
    expect(pinnedRoot.querySelector('.pinned-rows')).toBe(pinnedRowsNode);
    expect(pinnedHeading.querySelector('.pinned-toggle')?.classList.contains('pinned-toggle--on')).toBe(true);
    pinnedHeading.querySelector<HTMLButtonElement>('.pinned-toggle')!.click();
    await nextTick();
    expect(pinnedFold.classList.contains('collapsed')).toBe(false);
    expect(pinnedFold.hasAttribute('inert')).toBe(false);
    expect(pinnedRoot.querySelector('.pinned-rows')).toBe(pinnedRowsNode);

    const sessionsListNode = host.querySelector('.sessions')!;
    const wsNodeBefore = host.querySelector('.sessions [data-ws-id]')!;
    sectionHeading.querySelector<HTMLElement>('.side-section-title')!.click();
    await nextTick();
    expect(localStorage.getItem('kimi-web.sessions-section-collapsed')).toBe('true');
    expect(sessionsListNode.classList.contains('sessions--collapsed')).toBe(true);
    expect(sessionsListNode.hasAttribute('inert')).toBe(true);
    expect(host.querySelector('.sessions [data-ws-id]')).toBe(wsNodeBefore);
    expect(sectionHeading.querySelector('.side-section-fold')?.classList.contains('side-section-fold--on')).toBe(true);
    sectionHeading.querySelector<HTMLButtonElement>('.side-section-fold')!.click();
    await nextTick();
    expect(localStorage.getItem('kimi-web.sessions-section-collapsed')).toBe('false');
    expect(sessionsListNode.classList.contains('sessions--collapsed')).toBe(false);
    expect(sessionsListNode.hasAttribute('inert')).toBe(false);
    expect(host.querySelector('.sessions [data-ws-id]')).toBe(wsNodeBefore);

    expect(pinnedRoot.classList.contains('pinned--workspace')).toBe(false);
    expect(pinnedRow().querySelector('.sub')).toBeNull();
    expect(pinnedRow().querySelector('.compact-pr')?.textContent).toContain('#1279');

    pinnedRow().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    await nextTick();
    expect(openPinnedMenu()).toBeNull();

    pinnedRoot.querySelector('.pin-workspace .gh')!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 60 }),
    );
    await nextTick();
    expect(openPinnedMenu()).toBeNull();

    pinnedRoot.querySelector<HTMLButtonElement>('.pinned-options')!.click();
    await vi.waitFor(() => expect(openPinnedMenu()).not.toBeNull());
    const menuItems = [...openPinnedMenu()!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    const initialCompactItem = menuItems.find((item) => item.textContent?.includes('Compact'));
    const showProjectItem = menuItems.find((item) => item.textContent?.includes('Show project'));
    expect(initialCompactItem?.getAttribute('aria-checked')).toBe('true');
    expect(showProjectItem?.getAttribute('aria-checked')).toBe('false');
    showProjectItem!.click();
    await nextTick();

    expect(localStorage.getItem('kimi-web.pinned-session-display-mode')).toBe('workspace');
    expect(pinnedRoot.classList.contains('pinned--workspace')).toBe(true);
    expect(pinnedRow().classList.contains('has-sub')).toBe(true);
    expect(pinnedRow().querySelector('.sub.sub--pinned .sub-text')?.textContent).toBe('Workspace 1');
    expect(pinnedRow().querySelector('.sub .sub-icon')).toBeNull();
    expect(pinnedRow().querySelector('.sub .pr')?.textContent).toContain('#1279');
    expect(pinnedRow().querySelector('.compact-pr')).toBeNull();
    expect(openPinnedMenu()).toBeNull();

    const pinRowWrapper = pinnedRow().closest<HTMLElement>('.pin-row')!;
    const pinWsWrapper = pinnedRoot.querySelector<HTMLElement>('.pin-workspace')!;
    const wsHeader = pinWsWrapper.querySelector<HTMLElement>('.gh')!;
    pinWsWrapper.style.paddingTop = '6px';
    vi.spyOn(pinRowWrapper, 'getBoundingClientRect').mockReturnValue({ height: 45 } as DOMRect);
    vi.spyOn(wsHeader, 'getBoundingClientRect').mockReturnValue({ height: 32 } as DOMRect);
    fakes.views.pinnedWorkspaceGroups = [group(0, 3)];
    fakes.views.pinnedEntries = [
      { key: `session:${pinnedSingle.id}`, kind: 'session', session: pinnedSingle },
      { key: 'ws:ws-0', kind: 'workspace', group: fakes.views.pinnedWorkspaceGroups[0] },
    ];
    await nextTick();
    expect(pinnedRoot.querySelector('.pinned-resize')?.getAttribute('aria-valuemin')).toBe('83');

    pinnedRoot.querySelector('.pinned-label')!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 20 }),
    );
    await vi.waitFor(() => expect(openPinnedMenu()).not.toBeNull());
    expect(pinnedRoot.querySelector('.pinned-options')?.classList.contains('open')).toBe(false);
    const reopenedItems = [...openPinnedMenu()!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    const compactItem = reopenedItems.find((item) => item.textContent?.includes('Compact'));
    const checkedProjectItem = reopenedItems.find((item) => item.textContent?.includes('Show project'));
    expect(compactItem?.getAttribute('aria-checked')).toBe('false');
    expect(checkedProjectItem?.getAttribute('aria-checked')).toBe('true');
    compactItem!.click();
    await nextTick();

    expect(localStorage.getItem('kimi-web.pinned-session-display-mode')).toBe('compact');
    expect(pinnedRoot.classList.contains('pinned--workspace')).toBe(false);
    expect(pinnedRow().querySelector('.sub')).toBeNull();
    expect(pinnedRow().querySelector('.compact-pr')?.textContent).toContain('#1279');
    expect(openPinnedMenu()).toBeNull();

    pinnedRoot.querySelector('.pinned-rows')!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 90 }),
    );
    await vi.waitFor(() => expect(openPinnedMenu()).not.toBeNull());
  });

  it('collapses and expands pinned and project sections with zero WorkspaceGroup re-renders and clean scroll/reveal state', async () => {
    app?.unmount();
    const pinnedGroup = group(0, 3);
    const unpinnedGroups = Array.from({ length: GROUPS }, (_, i) => group(i + 1, PER_GROUP));
    const pinnedSingle = session(1, 99);
    fakes.workspaces.pinnedWorkspaceIds = ['ws-0'];
    fakes.views.pinnedWorkspaceGroups = [pinnedGroup];
    fakes.views.pinnedSessions = [pinnedSingle];
    fakes.views.pinnedEntries = [
      { key: `session:${pinnedSingle.id}`, kind: 'session', session: pinnedSingle },
      { key: 'ws:ws-0', kind: 'workspace', group: pinnedGroup },
    ];
    fakes.views.unpinnedWorkspaceGroups = unpinnedGroups;
    fakes.views.workspaceGroups = [pinnedGroup, ...unpinnedGroups];

    let panelRef: {
      expandGroupIfCollapsed: (wsId: string | null, sessionId?: string) => void;
      sessionsCanScrollDown: boolean;
    } | null = null;
    const statusTab = ref<'open' | 'done' | 'workspaces'>('open');
    const emittedStatusTabs: string[] = [];
    app = installTestPlugins(
      createApp(
        defineComponent({
          setup() {
            const el = ref<typeof panelRef>(null);
            panelRef = new Proxy({} as NonNullable<typeof panelRef>, {
              get(_, key) {
                return (el.value as Record<PropertyKey, unknown> | null)?.[key];
              },
            });
            return () =>
              h(SessionListPanel, {
                ref: el,
                statusTab: statusTab.value,
                'onUpdate:statusTab': (tab: 'open' | 'done' | 'workspaces') => emittedStatusTabs.push(tab),
              });
          },
        }),
      ),
    );
    app.mount(host);
    await nextTick();

    const sessionsEl = host.querySelector<HTMLElement>('.sessions')!;
    Object.defineProperty(sessionsEl, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(sessionsEl, 'scrollHeight', { value: 800, configurable: true });
    sessionsEl.scrollTop = 120;
    sessionsEl.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(host.querySelector('.sessions-head')?.classList.contains('sessions-head--scrolled')).toBe(true);
    expect(panelRef!.sessionsCanScrollDown).toBe(true);

    const beforeToggleRenders = renders.count();
    host.querySelector<HTMLElement>('.pinned-title')!.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>('.pinned-toggle')!.click();
    await nextTick();

    host.querySelector<HTMLElement>('.side-section-title')!.click();
    await nextTick();
    expect(host.querySelector('.sessions-head')?.classList.contains('sessions-head--scrolled')).toBe(false);
    expect(panelRef!.sessionsCanScrollDown).toBe(false);
    expect(sessionsEl.scrollTop).toBe(120);

    host.querySelector<HTMLButtonElement>('.side-section-fold')!.click();
    await nextTick();
    expect(host.querySelector('.sessions-head')?.classList.contains('sessions-head--scrolled')).toBe(true);
    expect(panelRef!.sessionsCanScrollDown).toBe(true);
    expect(sessionsEl.scrollTop).toBe(120);

    expect(renders.count() - beforeToggleRenders).toBe(0);

    host.querySelector<HTMLElement>('.pinned-title')!.click();
    host.querySelector<HTMLElement>('.side-section-title')!.click();
    await nextTick();
    expect(host.querySelector('.pinned-fold')?.classList.contains('collapsed')).toBe(true);
    expect(sessionsEl.classList.contains('sessions--collapsed')).toBe(true);

    panelRef!.expandGroupIfCollapsed(null, pinnedSingle.id);
    await nextTick();
    expect(host.querySelector('.pinned-fold')?.classList.contains('collapsed')).toBe(false);
    expect(sessionsEl.classList.contains('sessions--collapsed')).toBe(true);

    panelRef!.expandGroupIfCollapsed(null, 'flat-unpinned-session');
    await nextTick();
    expect(sessionsEl.classList.contains('sessions--collapsed')).toBe(false);

    statusTab.value = 'done';
    await nextTick();
    host.querySelector<HTMLElement>('.side-section-title')!.click();
    await nextTick();
    expect(sessionsEl.classList.contains('sessions--collapsed')).toBe(true);
    panelRef!.expandGroupIfCollapsed('ws-0', 'done-session-in-pinned-ws');
    await nextTick();
    expect(sessionsEl.classList.contains('sessions--collapsed')).toBe(false);
    expect(emittedStatusTabs).toEqual([]);
  });
});
