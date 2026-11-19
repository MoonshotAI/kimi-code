// @vitest-environment jsdom
import { createApp, nextTick, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import { panelDraftContextKey, usePanelTabs } from '@moonshot-ai/app-client/composables';
import type { BrowserTabPayload } from '@moonshot-ai/app-client/panel';
import { showBrowserTab, openBrowserLinkTab } from '../../src/renderer/lib/browserTabVisibility';

function panel() {
  return { activeTab: ref({ id: 'review', type: 'diff' }), sessionBrowserTabs: vi.fn(() => [{ id: 'first', type: 'browser' }, { id: 'second', type: 'browser' }]), activateTab: vi.fn() };
}

it('shows the requested browser tab while an unrelated panel is selected', () => {
  const host = panel();
  showBrowserTab(host as never, 'session', 'session', 'first');
  expect(host.activateTab).toHaveBeenCalledExactlyOnceWith('first');
});

it('rejects cross-session and missing-tab requests without changing the visible panel', () => {
  const host = panel();
  expect(() => showBrowserTab(host as never, 'background', 'viewed', 'first')).toThrow('not being viewed');
  expect(() => showBrowserTab(host as never, 'session', 'session', 'missing')).toThrow('does not exist');
  expect(host.activateTab).not.toHaveBeenCalled();
});

it('keeps activate-panel behavior when no specific tab is requested', () => {
  const host = panel();
  showBrowserTab(host as never, 'session', 'session');
  expect(host.activateTab).toHaveBeenLastCalledWith('second');
  host.activeTab.value = { id: 'first', type: 'browser' };
  showBrowserTab(host as never, 'session', 'session');
  expect(host.activateTab).toHaveBeenLastCalledWith('first');
});

function linkPanel(location: 'current' | 'parked' | 'missing') {
  const target = { id: 'new-tab' };
  return {
    panelTabs: ref(location === 'current' ? [{ id: 'source-tab', type: 'browser', payload: { browserId: 'source' } }] : []),
    browserTabOwner: vi.fn(() => location === 'missing' ? null : { sessionId: location === 'current' ? 'session' : 'old-session', tabId: 'source-tab' }),
    addSessionBrowserTab: vi.fn(() => target),
    activateTab: vi.fn(),
  };
}

it.each(['current', 'parked', 'missing'] as const)('routes a popup link from a %s source next to its source tab', async (location) => {
  const host = linkPanel(location);
  const navigate = vi.fn(async () => {});
  expect(await openBrowserLinkTab(host as never, 'source', 'https://example.com/new', navigate)).toBe(location !== 'missing');
  if (location !== 'missing') expect(host.addSessionBrowserTab).toHaveBeenCalledWith(location === 'current' ? 'session' : 'old-session', { browserId: expect.any(String) }, 'source-tab');
  expect(host.activateTab).toHaveBeenCalledTimes(location === 'current' ? 1 : 0);
  expect(navigate).toHaveBeenCalledTimes(location === 'missing' ? 0 : 1);
});

it('opens a background link tab without switching to it', async () => {
  const host = linkPanel('current');
  const navigate = vi.fn(async () => {});
  expect(await openBrowserLinkTab(host as never, 'source', 'https://example.com/new', navigate, true)).toBe(true);
  expect(host.addSessionBrowserTab).toHaveBeenCalledWith('session', { browserId: expect.any(String) }, 'source-tab');
  expect(host.activateTab).not.toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledWith(expect.any(String), 'https://example.com/new');
});

function realLinkPanel(activeSessionId: string | null) {
  const client = {
    turns: ref([]),
    activeAppTasks: ref([]),
    activeSessionId: ref(activeSessionId),
    activeWorkspaceId: ref(activeSessionId === null ? 'draft-workspace' : 'workspace'),
    auxiliaryConversations: {
      getEntry: vi.fn(() => undefined),
      activate: vi.fn(),
      deactivate: vi.fn(),
      loadOlder: vi.fn(async () => {}),
    },
    getFileUrl: (id: string) => `file://${id}`,
    getSessionMediaUrl: (sessionId: string, id: string) => `media://${sessionId}/${id}`,
    findBashCommandForTask: () => undefined,
    loadGitStatus: vi.fn(async () => {}),
    loadFileDiff: vi.fn(async () => {}),
    clearFileDiff: vi.fn(),
    getDraftPromotion: () => null,
    startSessionAndOpenSideChat: vi.fn(async () => null),
    openSideChatOn: vi.fn(),
    closeSideChat: vi.fn(),
    sideChatTargetsOfSession: vi.fn(() => []),
  };
  let panel!: ReturnType<typeof usePanelTabs>;
  const app = createApp({
    setup() {
      panel = usePanelTabs({ client: client as never, sideWidth: ref(280), t: (key: string) => key });
      return () => null;
    },
  });
  app.mount(document.createElement('div'));
  return { panel, unmount: () => app.unmount() };
}

async function expectVisibleAdjacentLinkTab(activeSessionId: string | null, ownerSessionId: string, sourceId: string) {
  const { panel, unmount } = realLinkPanel(activeSessionId);
  try {
    const source = panel.openTab('browser', { browserId: sourceId } satisfies BrowserTabPayload);
    await nextTick();
    const navigate = vi.fn(async (_browserId: string, _url: string) => {});

    expect(await openBrowserLinkTab(panel, sourceId, 'https://example.com/new', navigate)).toBe(true);

    expect(navigate).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'https://example.com/new');
    const browserId = navigate.mock.calls[0]![0];
    expect(panel.panelTabs.value.map(tab => (tab.payload as BrowserTabPayload).browserId)).toEqual([sourceId, browserId]);
    expect(panel.panelTabs.value[0]?.id).toBe(source.id);
    expect(panel.activeTabId.value).toBe(panel.panelTabs.value[1]?.id);
    expect(panel.browserTabOwner(sourceId)).toEqual({ sessionId: ownerSessionId, tabId: source.id });
    expect(panel.browserTabOwner(browserId)).toEqual({ sessionId: ownerSessionId, tabId: panel.panelTabs.value[1]?.id });
    expect(panel.sessionBrowserTabs(ownerSessionId).map(tab => tab.id)).toEqual(panel.panelTabs.value.map(tab => tab.id));
    expect(panel.closeSessionBrowserTab(ownerSessionId, panel.panelTabs.value[1]!.id)).toBe(true);
    expect(panel.panelTabs.value.map(tab => (tab.payload as BrowserTabPayload).browserId)).toEqual([sourceId]);
    expect(panel.activeTabId.value).toBe(source.id);
  } finally {
    unmount();
  }
}

it('opens a visible adjacent link tab in an active draft', async () => {
  await expectVisibleAdjacentLinkTab(null, panelDraftContextKey('draft-workspace'), 'draft-source');
});

it('preserves visible link tab ownership in an active session', async () => {
  await expectVisibleAdjacentLinkTab('session-1', 'session-1', 'session-source');
});
