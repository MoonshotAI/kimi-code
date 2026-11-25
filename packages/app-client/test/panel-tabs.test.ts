import { notifySessionDestroyed, notifyWorkspaceDestroyed } from '../src/client/deps';
import { effectScope, nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

import { destroyPanelBtwTab } from '../src/panel/panelPersistence';
import { destroyPanelSessionSnapshot, panelDraftContextKey, forkPanelBrowserTabs, usePanelTabs } from '../src/composables';
import { sideChatDrafts } from '../src/client/sideChatDrafts';
import type {
  BrowserTabPayload,
  BtwTabPayload,
  TurnDiffTabPayload,
} from '../src/panel/panelRegistry';
import type { AppTask } from '@moonshot-ai/app-core/api';
import type { ChatTurn, TurnFileChange } from '@moonshot-ai/app-core/client';

const t = (key: string) => key;

const editChange: TurnFileChange = {
  path: '/repo/src/a.ts',
  added: 3,
  removed: 1,
};

function createClient(overrides: Record<string, unknown> = {}) {
  return {
    turns: ref<ChatTurn[]>([]),
    activeAppTasks: ref<AppTask[]>([]),
    activeSessionId: ref<string | null>('session-1'),
    activeWorkspaceId: ref<string | null>(null),
    auxiliaryConversations: {
      getEntry: vi.fn(() => undefined),
      activate: vi.fn(),
      deactivate: vi.fn(),
      loadOlder: vi.fn(async () => {}),
    },
    getFileUrl: (id: string) => `file://${id}`,
    getSessionMediaUrl: (sid: string, id: string) => `media://${sid}/${id}`,
    findBashCommandForTask: () => undefined,
    findSubagentPromptForTask: () => undefined,
    loadGitStatus: vi.fn(async () => {}),
    loadFileDiff: vi.fn(async () => {}),
    clearFileDiff: vi.fn(),
    getDraftPromotion: vi.fn((): { workspaceId: string; sessionId: string } | null => null),
    startSessionAndOpenSideChat: vi.fn(async () => null),
    openSideChatOn: vi.fn(async () => ({ target: null, sent: false })),
    closeSideChat: vi.fn(),
    sideChatTargetsOfSession: vi.fn(() => []),
    ...overrides,
  };
}

function createPanel(client: ReturnType<typeof createClient>) {
  return usePanelTabs({ client: client as never, sideWidth: ref(280), t });
}

describe('usePanelTabs open policies', () => {
  it('singleton: reopening a diff tab activates the existing one', () => {
    const panel = createPanel(createClient());
    const first = panel.openTab('diff', {});
    const second = panel.openTab('diff', {});
    expect(panel.panelTabs.value).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(panel.activeTabId.value).toBe(first.id);
    expect(panel.panelVisible.value).toBe(true);
  });

  it('singleton: reopening a files tab activates the existing one', () => {
    const panel = createPanel(createClient());
    const first = panel.openFilesPanel();
    const second = panel.openFilesPanel();
    expect(panel.panelTabs.value).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(panel.activeTabId.value).toBe(first.id);
    expect(first.title).toBe('panel.tabs.files');
  });

  it('always: browser tabs keep independent page identities and live titles', () => {
    const panel = createPanel(createClient());
    const first = panel.openTab('browser', { browserId: 'browser-1' });
    const second = panel.openTab('browser', { browserId: 'browser-2' });
    expect(panel.panelTabs.value).toHaveLength(2);
    expect(second.id).not.toBe(first.id);
    expect(panel.activeTabId.value).toBe(second.id);
    panel.updateBrowserTabTitle(first.id, 'Example Domain');
    panel.updateBrowserTabFavicon(first.id, 'https://example.com/favicon.ico');
    expect(panel.panelTabs.value[0]).toMatchObject({
      title: 'Example Domain',
      payload: {
        browserId: 'browser-1',
        title: 'Example Domain',
        favicon: 'https://example.com/favicon.ico',
      },
    });
    panel.updateBrowserTabTitle(first.id, '');
    expect(panel.panelTabs.value[0]?.title).toBe('panel.tabs.browser');
  });

  it('keyed: file tabs dedup by path, re-open activates', () => {
    const panel = createPanel(createClient());
    const a = panel.openTab('file', { path: '/repo/a.ts' });
    const b = panel.openTab('file', { path: '/repo/b.ts' });
    expect(panel.panelTabs.value).toHaveLength(2);
    expect(panel.activeTabId.value).toBe(b.id);
    const again = panel.openTab('file', { path: '/repo/a.ts', line: 7 });
    expect(panel.panelTabs.value).toHaveLength(2);
    expect(again.id).toBe(a.id);
    expect(panel.activeTabId.value).toBe(a.id);
  });

  it('keyed: re-opening with fresh data refreshes the payload in place', () => {
    const panel = createPanel(createClient());
    const a = panel.openTab('file', { path: '/repo/a.ts', line: 1 });
    const again = panel.openTab('file', { path: '/repo/a.ts', line: 42 });
    expect(panel.panelTabs.value).toHaveLength(1);
    expect(again.id).toBe(a.id);
    const tab = panel.panelTabs.value[0]!;
    expect(tab).not.toBe(a);
    expect((tab.payload as { line?: number }).line).toBe(42);
  });

  it('always: btw tabs never dedup', () => {
    const panel = createPanel(createClient());
    panel.openTab('btw', { parentId: 'session-1', agentId: 'btw-1', seq: 1 });
    panel.openTab('btw', { parentId: 'session-1', agentId: 'btw-2', seq: 2 });
    expect(panel.panelTabs.value).toHaveLength(2);
    expect(panel.panelTabs.value.map((tab) => tab.title)).toEqual([
      'sideChat.title',
      'sideChat.title 2',
    ]);
  });

  it('opening a tab reveals a hidden panel', () => {
    const panel = createPanel(createClient());
    panel.openTab('diff', {});
    panel.hidePanel();
    expect(panel.panelVisible.value).toBe(false);
    panel.openTab('diff', {});
    expect(panel.panelVisible.value).toBe(true);
  });
});

describe('usePanelTabs close / hide', () => {
  it('closing the last tab hides the panel', () => {
    const panel = createPanel(createClient());
    const tab = panel.openTab('file', { path: '/repo/a.ts' });
    panel.closeTab(tab.id);
    expect(panel.panelTabs.value).toHaveLength(0);
    expect(panel.activeTabId.value).toBe(null);
    expect(panel.panelVisible.value).toBe(false);
  });

  it('moving the last tab out keeps the panel open on its empty state', () => {
    const panel = createPanel(createClient());
    const tab = panel.openTab('file', { path: '/repo/a.ts' });
    panel.closeTab(tab.id, { keepVisible: true });
    expect(panel.panelTabs.value).toHaveLength(0);
    expect(panel.activeTabId.value).toBe(null);
    expect(panel.panelVisible.value).toBe(true);
  });

  it('closing the active tab activates the tab that shifts into its slot', () => {
    const panel = createPanel(createClient());
    const a = panel.openTab('file', { path: '/a.ts' });
    const b = panel.openTab('file', { path: '/b.ts' });
    const c = panel.openTab('file', { path: '/c.ts' });
    panel.activateTab(a.id);
    panel.closeTab(a.id);
    expect(panel.activeTabId.value).toBe(b.id);
    panel.closeTab(c.id);
    expect(panel.activeTabId.value).toBe(b.id);
    expect(panel.panelVisible.value).toBe(true);
  });

  it('hidePanel keeps the tab set and the active tab, and exits focus mode', () => {
    const panel = createPanel(createClient());
    panel.openTab('file', { path: '/a.ts' });
    const b = panel.openTab('file', { path: '/b.ts' });
    panel.toggleExpanded();
    expect(panel.panelExpanded.value).toBe(true);

    expect(panel.hidePanel()).toBe(true);
    expect(panel.panelVisible.value).toBe(false);
    expect(panel.panelExpanded.value).toBe(false);
    expect(panel.panelTabs.value).toHaveLength(2);
    expect(panel.activeTabId.value).toBe(b.id);
    expect(panel.hidePanel()).toBe(false);
  });

  it('showPanel restores a hidden panel with its tab set, and shows even when empty', () => {
    const panel = createPanel(createClient());
    panel.showPanel();
    expect(panel.panelVisible.value).toBe(true);
    expect(panel.panelTabs.value).toHaveLength(0);

    panel.openTab('file', { path: '/a.ts' });
    const b = panel.openTab('file', { path: '/b.ts' });
    panel.hidePanel();
    panel.showPanel();
    expect(panel.panelVisible.value).toBe(true);
    expect(panel.activeTabId.value).toBe(b.id);
    expect(panel.panelExpanded.value).toBe(false);
  });

  it('closing a btw tab drops its side-chat fork', () => {
    const client = createClient();
    const panel = createPanel(client);
    const tab = panel.openTab('btw', { parentId: 'session-1', agentId: 'btw-1', seq: 1 });
    panel.closeTab(tab.id);
    expect(client.closeSideChat).toHaveBeenCalledWith('btw-1', 'session-1');
  });

  it('addTabInBackground appends without activating or revealing the panel', () => {
    const panel = createPanel(createClient());
    const first = panel.addTabInBackground('term', { ptyId: 'pty-1' });
    expect(panel.activeTabId.value).toBe(first.id);
    expect(panel.panelVisible.value).toBe(false);

    const file = panel.openTab('file', { path: '/a.ts' });
    const second = panel.addTabInBackground('term', { ptyId: 'pty-2' });
    expect(panel.activeTabId.value).toBe(file.id);
    expect(panel.panelTabs.value.map((tab) => tab.id)).toContain(second.id);
  });

  it('a late background land into the launcher state parks the panel hidden', () => {
    const panel = createPanel(createClient());
    panel.showPanel();
    expect(panel.panelVisible.value).toBe(true);
    const tab = panel.addTabInBackground('term', { ptyId: 'pty-1' });
    expect(panel.activeTabId.value).toBe(tab.id);
    expect(panel.panelVisible.value).toBe(false);
  });

  it('panelInteractionVersion bumps on activate/close/hide/expand, not on a background add', () => {
    const panel = createPanel(createClient());
    const v0 = panel.panelInteractionVersion.value;
    const tab = panel.addTabInBackground('file', { path: '/a.ts' });
    expect(panel.panelInteractionVersion.value).toBe(v0);
    panel.activateTab(tab.id);
    expect(panel.panelInteractionVersion.value).toBe(v0 + 1);
    panel.hidePanel();
    expect(panel.panelInteractionVersion.value).toBe(v0 + 2);
    panel.closeTab(tab.id);
    expect(panel.panelInteractionVersion.value).toBe(v0 + 3);
  });

  it('panelInteractionVersion bumps on a focus-mode toggle', () => {
    const panel = createPanel(createClient());
    panel.openTab('file', { path: '/a.ts' });
    const v0 = panel.panelInteractionVersion.value;
    panel.toggleExpanded();
    expect(panel.panelInteractionVersion.value).toBe(v0 + 1);
    panel.toggleExpanded();
    expect(panel.panelInteractionVersion.value).toBe(v0 + 2);
  });

  it('leaveChatView exits focus mode and bumps the interaction version', () => {
    const panel = createPanel(createClient());
    panel.openTab('file', { path: '/a.ts' });
    panel.toggleExpanded();
    expect(panel.panelExpanded.value).toBe(true);
    const v0 = panel.panelInteractionVersion.value;
    panel.leaveChatView();
    expect(panel.panelExpanded.value).toBe(false);
    expect(panel.panelInteractionVersion.value).toBe(v0 + 1);
    expect(panel.panelVisible.value).toBe(true);
    expect(panel.activeTab.value?.type).toBe('file');
  });

  it('showPanel restores the view and bumps the interaction version', () => {
    const panel = createPanel(createClient());
    panel.openTab('file', { path: '/a.ts' });
    panel.hidePanel();
    const v0 = panel.panelInteractionVersion.value;
    panel.showPanel();
    expect(panel.panelVisible.value).toBe(true);
    expect(panel.activeTab.value?.type).toBe('file');
    expect(panel.panelInteractionVersion.value).toBe(v0 + 1);
  });

  it('onTabRemoved releases closed tabs but preserves parked tabs', async () => {
    const removed: string[] = [];
    const client = createClient();
    const panel = usePanelTabs({
      client: client as never,
      sideWidth: ref(280),
      t,
      onTabRemoved: (tab) => removed.push(tab.id),
    });
    const file = panel.openTab('file', { path: '/a.ts' });
    const term = panel.openTab('term', { ptyId: 'pty-1' });
    panel.closeTab(term.id);
    expect(removed).toEqual([term.id]);
    client.activeSessionId.value = 'session-2';
    await nextTick();
    expect(removed).toEqual([term.id]);
    client.activeSessionId.value = 'session-1';
    await nextTick();
    expect(panel.activeTabId.value).toBe(file.id);
  });
});

describe('usePanelTabs turn-diff toggle', () => {
  it('second openTurnDiff with the same change object closes its tab', () => {
    const panel = createPanel(createClient());
    panel.openTurnDiff({ turnId: 'turn-1', change: editChange });
    expect(panel.panelTabs.value).toHaveLength(1);
    expect(panel.activeTab.value?.type).toBe('turn-diff');
    panel.openTurnDiff({ turnId: 'turn-1', change: editChange });
    expect(panel.panelTabs.value).toHaveLength(0);
    expect(panel.panelVisible.value).toBe(false);
  });

  it('same change object while the panel is hidden re-shows the tab instead of closing it', () => {
    const panel = createPanel(createClient());
    panel.openTurnDiff({ turnId: 'turn-1', change: editChange });
    panel.hidePanel();
    expect(panel.panelVisible.value).toBe(false);
    panel.openTurnDiff({ turnId: 'turn-1', change: editChange });
    expect(panel.panelTabs.value).toHaveLength(1);
    expect(panel.activeTab.value?.type).toBe('turn-diff');
    expect(panel.panelVisible.value).toBe(true);
  });

  it('same turn+path with a different change object activates the existing tab', () => {
    const panel = createPanel(createClient());
    const tab = panel.openTab('turn-diff', { turnId: 'turn-1', change: editChange });
    panel.openTab('file', { path: '/elsewhere.ts' });
    panel.openTurnDiff({ turnId: 'turn-1', change: { ...editChange } });
    expect(
      panel.panelTabs.value.filter((candidate) => candidate.type === 'turn-diff'),
    ).toHaveLength(1);
    expect(panel.activeTabId.value).toBe(tab.id);
  });

  it('same change object while another tab is active switches back instead of closing', () => {
    const panel = createPanel(createClient());
    const tab = panel.openTab('turn-diff', { turnId: 'turn-1', change: editChange });
    panel.openTab('file', { path: '/elsewhere.ts' });
    panel.openTurnDiff({ turnId: 'turn-1', change: editChange });
    expect(panel.panelTabs.value.filter((candidate) => candidate.type === 'turn-diff')).toHaveLength(1);
    expect(panel.activeTabId.value).toBe(tab.id);
  });

  it('a different turn+path replaces the single turn-diff tab in place', () => {
    const panel = createPanel(createClient());
    const tab = panel.openTab('turn-diff', { turnId: 'turn-1', change: editChange });
    const otherChange: TurnFileChange = { ...editChange, path: '/repo/src/b.ts' };
    panel.openTurnDiff({ turnId: 'turn-2', change: otherChange });
    const tabs = panel.panelTabs.value.filter((candidate) => candidate.type === 'turn-diff');
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.id).toBe(tab.id);
    expect((tabs[0]!.payload as TurnDiffTabPayload).turnId).toBe('turn-2');
    expect((tabs[0]!.payload as TurnDiffTabPayload).change).toBe(otherChange);
    expect(tabs[0]!.title).toBe('panel.tabs.turnDiff');
    expect(panel.activeTabId.value).toBe(tab.id);
  });
});

describe('usePanelTabs agent transcript lifecycle', () => {
  it('activates on open, deactivates on switch away, reactivates on return', () => {
    const client = createClient();
    const panel = createPanel(client);

    panel.openAgentPanel('agent-1');
    const agentTab = panel.activeTab.value!;
    expect(agentTab.type).toBe('agent');
    expect(client.auxiliaryConversations.activate).toHaveBeenCalledWith('session-1', 'agent-1');

    panel.openTab('file', { path: '/a.ts' });
    expect(client.auxiliaryConversations.deactivate).toHaveBeenCalledWith('session-1', 'agent-1');

    panel.activateTab(agentTab.id);
    expect(client.auxiliaryConversations.activate).toHaveBeenLastCalledWith('session-1', 'agent-1');

    panel.hidePanel();
    expect(client.auxiliaryConversations.deactivate).toHaveBeenLastCalledWith('session-1', 'agent-1');

    const deactivateCalls = client.auxiliaryConversations.deactivate.mock.calls.length;
    panel.closeTab(agentTab.id);
    expect(client.auxiliaryConversations.deactivate.mock.calls.length).toBe(deactivateCalls);
  });

  it('closing a visible agent tab deactivates its transcript', () => {
    const client = createClient();
    const panel = createPanel(client);
    panel.openAgentPanel('agent-1');
    const agentTab = panel.activeTab.value!;
    panel.closeTab(agentTab.id);
    expect(client.auxiliaryConversations.deactivate).toHaveBeenCalledWith('session-1', 'agent-1');
  });

  it('does not activate a transcript for a bash/task-row target', () => {
    const client = createClient({
      activeAppTasks: ref([
        { id: 'task-1', kind: 'bash', status: 'running', sessionId: 'session-1' },
      ] as AppTask[]),
    });
    const panel = createPanel(client);
    panel.openAgentPanel('task-1');
    expect(panel.activeTab.value?.type).toBe('agent');
    expect(client.auxiliaryConversations.activate).not.toHaveBeenCalled();
  });

  it('prefers the tool call description as the agent tab title', () => {
    const client = createClient({
      turns: ref([
        {
          id: 'turn-1',
          role: 'assistant',
          tools: [
            {
              id: 'tool-1',
              name: 'Agent',
              arg: JSON.stringify({ description: 'Inspect files', subagent_type: 'explore' }),
              status: 'ok',
              agentId: 'agent-1',
            },
          ],
        },
      ] as unknown as ChatTurn[]),
    });
    const panel = createPanel(client);
    panel.openAgentPanel('agent-1');
    expect(panel.activeTab.value?.title).toBe('Inspect files');
  });

  it('falls back to the task row description when no tool call is in the turns', () => {
    const client = createClient({
      activeAppTasks: ref([
        {
          id: 'task-row-7',
          agentId: 'agent-7',
          kind: 'subagent',
          description: '分析 kimi-code-2 项目',
          status: 'running',
          sessionId: 'session-1',
        },
      ] as AppTask[]),
    });
    const panel = createPanel(client);
    panel.openAgentPanel('agent-7');
    expect(panel.activeTab.value?.title).toBe('分析 kimi-code-2 项目');
  });

  it('heals a generic agent tab title when the task row appears later', async () => {
    const client = createClient();
    const panel = createPanel(client);
    panel.openAgentPanel('agent-8');
    expect(panel.activeTab.value?.title).toBe('panel.tabs.agent');

    client.activeAppTasks.value = [
      {
        id: 'agent-8',
        agentId: 'agent-8',
        kind: 'subagent',
        description: 'Late named task',
        status: 'running',
        sessionId: 'session-1',
      } as unknown as AppTask,
    ];
    await nextTick();
    expect(panel.activeTab.value?.title).toBe('Late named task');
  });
});

describe('usePanelTabs diff tab', () => {
  it('opens as a list, loads git status, and resets on close', async () => {
    const client = createClient();
    const panel = createPanel(client);

    panel.openDiffDetail();
    expect(panel.activeTab.value?.type).toBe('diff');
    expect(panel.detailDiffMode.value).toBe('list');
    expect(client.loadGitStatus).toHaveBeenCalledWith('session-1');

    await panel.selectDiffFile('src/a.ts');
    expect(panel.detailDiffMode.value).toBe('detail');
    expect(panel.detailDiffPath.value).toBe('src/a.ts');
    expect(client.loadFileDiff).toHaveBeenCalledWith('src/a.ts');

    panel.openTab('file', { path: '/other.ts' });
    panel.openDiffDetail();
    expect(panel.detailDiffMode.value).toBe('detail');

    panel.closeDiffDetail();
    expect(panel.panelTabs.value.some((tab) => tab.type === 'diff')).toBe(false);
    expect(panel.detailDiffMode.value).toBe('list');
    expect(client.clearFileDiff).toHaveBeenCalled();
  });

  it('switches folder roots in the existing diff tab and scopes status and file diff requests', async () => {
    const client = createClient();
    const panel = createPanel(client);

    panel.openDiffDetail('/a');
    expect(panel.activeTab.value?.payload).toEqual({ root: '/a' });
    expect(client.loadGitStatus).toHaveBeenCalledWith('session-1', { root: '/a' });
    await panel.selectDiffFile('src/a.ts', '/a');
    expect(client.loadFileDiff).toHaveBeenCalledWith('src/a.ts', { root: '/a' });

    panel.openDiffDetail('/b');

    expect(panel.panelTabs.value.filter(tab => tab.type === 'diff')).toHaveLength(1);
    expect(panel.activeTab.value?.payload).toEqual({ root: '/b' });
    expect(panel.detailDiffMode.value).toBe('list');
    expect(client.clearFileDiff).toHaveBeenCalled();
    expect(client.loadGitStatus).toHaveBeenCalledWith('session-1', { root: '/b' });
  });
});

describe('usePanelTabs side chat tabs', () => {
  it('forks a new side chat and opens its tab', async () => {
    const client = createClient({
      openSideChatOn: vi.fn(async () => ({
        target: { agentId: 'btw-1', seq: 1 },
        sent: true,
      })),
    });
    const panel = createPanel(client);

    const created = await panel.openSideChatTab('hello');
    expect(created).toEqual({ sessionId: 'session-1', agentId: 'btw-1', sent: true });
    expect(client.openSideChatOn).toHaveBeenCalledWith('session-1', 'hello');
    const tab = panel.activeTab.value!;
    expect(tab.type).toBe('btw');
    expect(tab.title).toBe('sideChat.title');
    expect(tab.payload).toEqual({ parentId: 'session-1', agentId: 'btw-1', seq: 1 });
  });

  it('lands the fork in the background when the user moved on mid-open', async () => {
    let resolveFork!: (value: { target: { agentId: string; seq: number }; sent: boolean }) => void;
    const client = createClient({
      openSideChatOn: vi.fn(
        () =>
          new Promise<{ target: { agentId: string; seq: number }; sent: boolean }>((resolve) => {
            resolveFork = resolve;
          }),
      ),
    });
    const panel = createPanel(client);
    const fileTab = panel.openTab('file', { path: '/a.ts' });

    const pending = panel.openSideChatTab();
    panel.hidePanel();
    resolveFork({ target: { agentId: 'btw-1', seq: 1 }, sent: true });
    await pending;

    expect(panel.panelVisible.value).toBe(false);
    expect(panel.activeTabId.value).toBe(fileTab.id);
    expect(panel.panelTabs.value.map((tab) => tab.type)).toEqual(['file', 'btw']);
  });

  it('heals the empty composer by creating the parent session first', async () => {
    const activeSessionId = ref<string | null>(null);
    const client = createClient({
      activeSessionId,
      activeWorkspaceId: ref<string | null>('ws-1'),
      startSessionAndOpenSideChat: vi.fn(async () => {
        activeSessionId.value = 'created-1';
        return { sessionId: 'created-1', target: { agentId: 'btw-9', seq: 1 } };
      }),
      sideChatTargetsOfSession: vi.fn((sid: string) =>
        sid === 'created-1' ? [{ agentId: 'btw-9', seq: 1 }] : [],
      ),
    });
    const panel = createPanel(client);

    const created = await panel.openSideChatTab('question');
    expect(created).toEqual({ sessionId: 'created-1', agentId: 'btw-9' });
    expect(client.startSessionAndOpenSideChat).toHaveBeenCalledWith('ws-1', 'question');
    const tab = panel.activeTab.value!;
    expect(tab.type).toBe('btw');
    expect((tab.payload as BtwTabPayload).agentId).toBe('btw-9');
  });

  it('binds the tab to the fork THIS create returned, not the list tail', async () => {
    const activeSessionId = ref<string | null>(null);
    const client = createClient({
      activeSessionId,
      activeWorkspaceId: ref<string | null>('ws-1'),
      startSessionAndOpenSideChat: vi.fn(async () => {
        activeSessionId.value = 'created-1';
        return { sessionId: 'created-1', target: { agentId: 'btw-1', seq: 1 } };
      }),
      sideChatTargetsOfSession: vi.fn((sid: string) =>
        sid === 'created-1'
          ? [
              { agentId: 'btw-1', seq: 1 },
              { agentId: 'btw-2', seq: 2 },
            ]
          : [],
      ),
    });
    const panel = createPanel(client);

    await panel.openSideChatTab('question');
    const tab = panel.activeTab.value!;
    expect(tab.type).toBe('btw');
    expect((tab.payload as BtwTabPayload).agentId).toBe('btw-1');
    expect(panel.panelTabs.value).toHaveLength(1);
  });

  it('opens no tab when the fork fails (the failure is already reported)', async () => {
    const client = createClient({
      openSideChatOn: vi.fn(async () => ({ target: null, sent: false })),
    });
    const panel = createPanel(client);
    await panel.openSideChatTab();
    expect(panel.panelTabs.value).toHaveLength(0);
    expect(panel.panelVisible.value).toBe(false);
  });

  it('seeds the fork’s draft when the question provably never left', async () => {
    sideChatDrafts.clear();
    const client = createClient({
      openSideChatOn: vi.fn(async () => ({
        target: { agentId: 'btw-1', seq: 1 },
        sent: false,
      })),
    });
    const panel = createPanel(client);

    await panel.openSideChatTab('what changed?');
    expect(panel.activeTab.value?.type).toBe('btw');
    expect(sideChatDrafts.get('btw-1')).toBe('what changed?');
    sideChatDrafts.clear();
  });
});

describe('usePanelTabs session snapshots', () => {
  function createSnapshotClient() {
    return createClient({
      turns: ref([
        { id: 'c1', role: 'compaction', text: 'summary one' },
      ] as unknown as ChatTurn[]),
      sideChatTargetsOfSession: vi.fn((sid: string) =>
        sid === 'session-1' ? [{ agentId: 'btw-1', seq: 1 }] : [],
      ),
    });
  }

  it('restores every tab type on return', async () => {
    const client = createSnapshotClient();
    const panel = createPanel(client);

    panel.openCompactionPanel({ turnId: 'c1' });
    panel.openAgentPanel('agent-1');
    panel.openTab('btw', { parentId: 'session-1', agentId: 'btw-1', seq: 1 });
    panel.openTab('file', { path: '/a.ts' });
    panel.openTab('diff', {});
    panel.openFilesPanel();
    const agentTab = panel.panelTabs.value.find((tab) => tab.type === 'agent')!;
    panel.activateTab(agentTab.id);

    client.activeSessionId.value = 'session-2';
    await nextTick();
    expect(panel.panelTabs.value).toHaveLength(0);
    expect(panel.panelVisible.value).toBe(false);
    expect(client.auxiliaryConversations.deactivate).toHaveBeenCalledWith('session-1', 'agent-1');
    expect(client.clearFileDiff).toHaveBeenCalled();

    client.activeSessionId.value = 'session-1';
    await nextTick();

    expect(panel.panelTabs.value.map((tab) => tab.type)).toEqual(['compaction', 'agent', 'btw', 'file', 'diff', 'files']);
    expect(panel.activeTab.value?.type).toBe('agent');
    expect(panel.panelVisible.value).toBe(true);
    expect(client.auxiliaryConversations.activate).toHaveBeenLastCalledWith('session-1', 'agent-1');
    const btwTab = panel.panelTabs.value.find((tab) => tab.type === 'btw')!;
    expect(btwTab.title).toBe('sideChat.title');
    expect((btwTab.payload as BtwTabPayload).agentId).toBe('btw-1');
    expect(panel.compactionPanelTextOf('c1')).toBe('summary one');
  });

  it('keeps a shell task tab a shell tab after its task left the list', async () => {
    const client = createSnapshotClient();
    client.activeAppTasks.value = [
      { id: 'bash-1', kind: 'bash', description: 'Release build', status: 'completed', sessionId: 'session-1' } as unknown as AppTask,
    ];
    const panel = createPanel(client);
    panel.openAgentPanel('bash-1');

    client.activeSessionId.value = 'session-2';
    await nextTick();
    client.activeAppTasks.value = [];
    client.activeSessionId.value = 'session-1';
    await nextTick();

    expect(panel.activeTab.value?.payload).toEqual({ sessionId: 'session-1', subagentId: 'bash-1', shellTask: true });
    expect(client.auxiliaryConversations.activate).not.toHaveBeenCalled();
  });

  it('parks Browser tabs per session and restores their stable native page identities', async () => {
    const removed: string[] = [];
    const client = createSnapshotClient();
    const panel = usePanelTabs({
      client: client as never,
      sideWidth: ref(280),
      t,
      onTabRemoved: (tab) => removed.push(tab.id),
    });
    panel.openTab('browser', {
      browserId: 'browser-session-1-a',
      title: 'Example',
      favicon: 'https://example.com/favicon.ico',
    } satisfies BrowserTabPayload);
    panel.openTab('browser', {
      browserId: 'browser-session-1-b',
      title: 'Docs',
    } satisfies BrowserTabPayload);

    client.activeSessionId.value = 'session-2';
    await nextTick();
    expect(panel.panelTabs.value).toHaveLength(0);
    expect(panel.panelVisible.value).toBe(false);
    expect(removed).toEqual([]);

    panel.openTab('browser', {
      browserId: 'browser-session-2',
      title: 'Other session',
    } satisfies BrowserTabPayload);
    client.activeSessionId.value = 'session-1';
    await nextTick();

    expect(
      panel.panelTabs.value.map((tab) => (tab.payload as BrowserTabPayload).browserId),
    ).toEqual(['browser-session-1-a', 'browser-session-1-b']);
    expect(panel.activeTab.value?.payload).toMatchObject({
      browserId: 'browser-session-1-b',
      title: 'Docs',
    });
    expect(panel.panelVisible.value).toBe(true);
    expect(removed).toEqual([]);

    client.activeSessionId.value = 'session-2';
    await nextTick();
    expect(panel.panelTabs.value).toHaveLength(1);
    expect(panel.activeTab.value).not.toBeNull();
    expect((panel.activeTab.value!.payload as BrowserTabPayload).browserId).toBe(
      'browser-session-2',
    );
    expect(removed).toEqual([]);

    const restoredTabId = panel.activeTab.value!.id;
    panel.closeTab(restoredTabId);
    expect(removed).toEqual([restoredTabId]);
  });

  it('inserts link tabs after their source and earlier tabs from that source in the viewed session', () => {
    const panel = createPanel(createSnapshotClient());
    const source = panel.openTab('browser', { browserId: 'source' } satisfies BrowserTabPayload);
    panel.openTab('browser', { browserId: 'other' } satisfies BrowserTabPayload);
    const first = panel.addSessionBrowserTab('session-1', { browserId: 'first' }, source.id);
    const second = panel.addSessionBrowserTab('session-1', { browserId: 'second' }, source.id);
    panel.addSessionBrowserTab('session-1', { browserId: 'unrelated' });
    expect(panel.panelTabs.value.map(tab => (tab.payload as BrowserTabPayload).browserId)).toEqual(['source', 'first', 'second', 'other', 'unrelated']);
    expect([first.id, second.id]).not.toContain(panel.activeTab.value?.id);
  });

  it('asks the tab bar to reveal link tabs opened in the viewed session only', async () => {
    const client = createSnapshotClient();
    const panel = createPanel(client);
    const source = panel.openTab('browser', { browserId: 'source' } satisfies BrowserTabPayload);
    panel.addSessionBrowserTab('session-1', { browserId: 'agent' });
    expect(panel.revealedTabId.value).toBeNull();
    const linked = panel.addSessionBrowserTab('session-1', { browserId: 'linked' }, source.id);
    expect(panel.revealedTabId.value).toBe(linked.id);
    expect(panel.activeTabId.value).toBe(source.id);
    client.activeSessionId.value = 'session-2';
    await nextTick();
    panel.addSessionBrowserTab('session-1', { browserId: 'parked' }, source.id);
    expect(panel.revealedTabId.value).toBe(linked.id);
  });

  it('inserts link tabs after their source in a parked session and keeps its selected tab', async () => {
    const client = createSnapshotClient();
    const panel = createPanel(client);
    const source = panel.openTab('browser', { browserId: 'source' } satisfies BrowserTabPayload);
    panel.openTab('browser', { browserId: 'selected' } satisfies BrowserTabPayload);
    client.activeSessionId.value = 'session-2';
    await nextTick();
    panel.addSessionBrowserTab('session-1', { browserId: 'first' }, source.id);
    panel.addSessionBrowserTab('session-1', { browserId: 'second' }, source.id);
    client.activeSessionId.value = 'session-1';
    await nextTick();
    expect(panel.panelTabs.value.map(tab => (tab.payload as BrowserTabPayload).browserId)).toEqual(['source', 'first', 'second', 'selected']);
    expect((panel.activeTab.value!.payload as BrowserTabPayload).browserId).toBe('selected');
  });

  it('releases parked Browser tabs when their session is destroyed', async () => {
    const removed: string[] = [];
    const client = createSnapshotClient();
    const panel = usePanelTabs({
      client: client as never,
      sideWidth: ref(280),
      t,
      onTabRemoved: (tab) => {
        if (tab.type === 'browser') {
          removed.push((tab.payload as BrowserTabPayload).browserId);
        }
      },
    });
    panel.openTab('browser', { browserId: 'browser-session-1' } satisfies BrowserTabPayload);

    client.activeSessionId.value = 'session-2';
    await nextTick();
    destroyPanelSessionSnapshot('session-1');

    expect(removed).toEqual(['browser-session-1']);
    client.activeSessionId.value = 'session-1';
    await nextTick();
    expect(panel.panelTabs.value).toHaveLength(0);
  });

  it('releases live Browser tabs when the active session is destroyed before context changes', async () => {
    const removed: string[] = [];
    const client = createSnapshotClient();
    const panel = usePanelTabs({
      client: client as never,
      sideWidth: ref(280),
      t,
      onTabRemoved: (tab) => {
        if (tab.type === 'browser') {
          removed.push((tab.payload as BrowserTabPayload).browserId);
        }
      },
    });
    panel.openTab('browser', { browserId: 'browser-live' } satisfies BrowserTabPayload);

    destroyPanelSessionSnapshot('session-1');
    expect(removed).toEqual(['browser-live']);
    expect(panel.panelTabs.value).toHaveLength(0);

    client.activeSessionId.value = 'session-2';
    await nextTick();
    client.activeSessionId.value = 'session-1';
    await nextTick();
    expect(panel.panelTabs.value).toHaveLength(0);
    expect(removed).toEqual(['browser-live']);
  });

  it('closes a restored Browser tab once when its active session is destroyed', async () => {
    const removed: string[] = [];
    const client = createSnapshotClient();
    const panel = usePanelTabs({
      client: client as never,
      sideWidth: ref(280),
      t,
      onTabRemoved: (tab) => {
        if (tab.type === 'browser') {
          removed.push((tab.payload as BrowserTabPayload).browserId);
        }
      },
    });
    panel.openTab('browser', { browserId: 'browser-restored' } satisfies BrowserTabPayload);

    client.activeSessionId.value = 'session-2';
    await nextTick();
    client.activeSessionId.value = 'session-1';
    await nextTick();
    destroyPanelSessionSnapshot('session-1');

    expect(removed).toEqual(['browser-restored']);
  });

  it('caps parked Browser tabs and releases the oldest pages', async () => {
    const removed: string[] = [];
    const client = createSnapshotClient();
    const panel = usePanelTabs({
      client: client as never,
      sideWidth: ref(280),
      t,
      onTabRemoved: (tab) => {
        if (tab.type === 'browser') {
          removed.push((tab.payload as BrowserTabPayload).browserId);
        }
      },
    });

    for (let index = 0; index < 17; index += 1) {
      panel.openTab('browser', { browserId: `browser-${index}` } satisfies BrowserTabPayload);
      client.activeSessionId.value = `session-${index + 2}`;
      await nextTick();
    }

    expect(removed).toEqual(['browser-0']);
  });

  it('does not restore a btw tab whose fork is gone', async () => {
    const client = createClient();
    const panel = createPanel(client);
    panel.openTab('btw', { parentId: 'session-1', agentId: 'btw-1', seq: 1 });

    client.activeSessionId.value = 'session-2';
    await nextTick();
    client.activeSessionId.value = 'session-1';
    await nextTick();

    expect(panel.panelTabs.value).toHaveLength(0);
    expect(panel.panelVisible.value).toBe(false);
  });

  it('restores the selected file alongside other tabs', async () => {
    const client = createSnapshotClient();
    const panel = createPanel(client);
    panel.openCompactionPanel({ turnId: 'c1' });
    const fileTab = panel.openTab('file', { path: '/a.ts' });
    expect(panel.activeTabId.value).toBe(fileTab.id);

    client.activeSessionId.value = 'session-2';
    await nextTick();
    client.activeSessionId.value = 'session-1';
    await nextTick();

    expect(panel.panelTabs.value.map((tab) => tab.type)).toEqual(['compaction', 'file']);
    expect(panel.panelVisible.value).toBe(true);
    expect(panel.activeTabId.value).toBe(fileTab.id);
    expect(client.auxiliaryConversations.activate).not.toHaveBeenCalled();
  });

  it('keeps a user-hidden panel hidden across a session round trip', async () => {
    const client = createSnapshotClient();
    const panel = createPanel(client);
    panel.openCompactionPanel({ turnId: 'c1' });
    panel.hidePanel();

    client.activeSessionId.value = 'session-2';
    await nextTick();
    client.activeSessionId.value = 'session-1';
    await nextTick();

    expect(panel.panelTabs.value.map((tab) => tab.type)).toEqual(['compaction']);
    expect(panel.panelVisible.value).toBe(false);
    expect(panel.activeTab.value?.type).toBe('compaction');
  });

  it('bumps the interaction version on every context flip — round trips included', async () => {
    const client = createSnapshotClient();
    const panel = createPanel(client);
    panel.openCompactionPanel({ turnId: 'c1' });
    const v0 = panel.panelInteractionVersion.value;

    client.activeSessionId.value = 'session-2';
    await nextTick();
    expect(panel.panelInteractionVersion.value).toBe(v0 + 1);

    client.activeSessionId.value = 'session-1';
    await nextTick();
    expect(panel.panelInteractionVersion.value).toBe(v0 + 2);
  });
});

describe('usePanelTabs draft promotion', () => {
  it('carries term and Browser tabs across a draft promotion instead of reporting them removed', async () => {
    const removed: string[] = [];
    const client = createClient({
      activeSessionId: ref<string | null>(null),
      activeWorkspaceId: ref<string | null>('ws-1'),
    });
    client.getDraftPromotion.mockReturnValue({ workspaceId: 'ws-1', sessionId: 'created-1' });
    const panel = usePanelTabs({
      client: client as never,
      sideWidth: ref(280),
      t,
      onTabRemoved: (tab) => removed.push(tab.id),
    });
    const term = panel.openTab('term', { ptyId: 'pty-1' });
    const browser = panel.openTab('browser', { browserId: 'browser-1', title: 'Example' });

    client.activeSessionId.value = 'created-1';
    await nextTick();

    expect(removed).toEqual([]);
    expect(panel.panelTabs.value.map((tab) => tab.id)).toEqual([term.id, browser.id]);
    expect(panel.activeTabId.value).toBe(browser.id);
    expect(panel.panelVisible.value).toBe(true);
  });

  it('does NOT bump the interaction version on the promotion flip', async () => {
    const client = createClient({
      activeSessionId: ref<string | null>(null),
      activeWorkspaceId: ref<string | null>('ws-1'),
    });
    client.getDraftPromotion.mockReturnValue({ workspaceId: 'ws-1', sessionId: 'created-1' });
    const panel = createPanel(client);
    const v0 = panel.panelInteractionVersion.value;

    client.activeSessionId.value = 'created-1';
    await nextTick();

    expect(panel.panelInteractionVersion.value).toBe(v0);
  });

  it('parks draft terminal tabs on a plain session switch', async () => {
    const removed: string[] = [];
    const client = createClient({ activeSessionId: ref<string | null>(null) });
    const panel = usePanelTabs({
      client: client as never,
      sideWidth: ref(280),
      t,
      onTabRemoved: (tab) => removed.push(tab.id),
    });
    panel.openTab('term', { ptyId: 'pty-1' });

    client.activeSessionId.value = 'session-9';
    await nextTick();

    expect(removed).toEqual([]);
    expect(panel.panelTabs.value).toHaveLength(0);
    expect(panel.activeTabId.value).toBe(null);
    expect(panel.panelVisible.value).toBe(false);
  });

  it('does not carry when the leaving draft workspace differs from the promotion record', async () => {
    const removed: string[] = [];
    const client = createClient({
      activeSessionId: ref<string | null>(null),
      activeWorkspaceId: ref<string | null>('ws-b'),
    });
    client.getDraftPromotion.mockReturnValue({ workspaceId: 'ws-a', sessionId: 'created-1' });
    const panel = usePanelTabs({
      client: client as never,
      sideWidth: ref(280),
      t,
      onTabRemoved: (tab) => removed.push(tab.id),
    });
    panel.openTab('term', { ptyId: 'pty-b' });

    client.activeSessionId.value = 'created-1';
    await nextTick();

    expect(removed).toEqual([]);
    expect(panel.panelTabs.value).toHaveLength(0);
  });
});

describe('usePanelTabs workspace context', () => {
  it('parks tabs when the draft switches workspace', async () => {
    const removed: string[] = [];
    const client = createClient({
      activeSessionId: ref<string | null>(null),
      activeWorkspaceId: ref<string | null>('ws-a'),
    });
    const panel = usePanelTabs({
      client: client as never,
      sideWidth: ref(280),
      t,
      onTabRemoved: (tab) => removed.push(tab.id),
    });
    panel.openTab('term', { ptyId: 'pty-1' });

    client.activeWorkspaceId.value = 'ws-b';
    await nextTick();

    expect(removed).toEqual([]);
    expect(panel.panelTabs.value).toHaveLength(0);
    expect(panel.panelVisible.value).toBe(false);
  });

  it('a live session’s workspace ride-along is not a context switch', async () => {
    const removed: string[] = [];
    const client = createClient();
    const panel = usePanelTabs({
      client: client as never,
      sideWidth: ref(280),
      t,
      onTabRemoved: (tab) => removed.push(tab.id),
    });
    panel.openTab('file', { path: '/a.ts' });

    client.activeWorkspaceId.value = 'ws-1';
    await nextTick();

    expect(removed).toEqual([]);
    expect(panel.panelTabs.value).toHaveLength(1);
  });

  it('a same-tick session+workspace switch parks without releasing resources', async () => {
    const removed: string[] = [];
    const client = createClient({ activeWorkspaceId: ref<string | null>('ws-a') });
    const panel = usePanelTabs({
      client: client as never,
      sideWidth: ref(280),
      t,
      onTabRemoved: (tab) => removed.push(tab.id),
    });
    panel.openTab('file', { path: '/a.ts' });

    client.activeSessionId.value = 'session-2';
    client.activeWorkspaceId.value = 'ws-b';
    await nextTick();

    expect(removed).toEqual([]);
    expect(panel.panelTabs.value).toHaveLength(0);
  });
});

describe('usePanelTabs locale titles', () => {
  it('re-resolves the generic agent tab title on locale change (data names stay)', async () => {
    const locale = ref('en');
    const client = createClient();
    const panel = usePanelTabs({
      client: client as never,
      sideWidth: ref(280),
      t: (key: string) => `${locale.value}:${key}`,
      locale,
    });
    panel.openAgentPanel('agent-1');
    const tab = panel.activeTab.value!;
    expect(tab.title).toBe('en:panel.tabs.agent');

    locale.value = 'zh';
    await nextTick();
    expect(panel.panelTabs.value.find((candidate) => candidate.id === tab.id)?.title).toBe(
      'zh:panel.tabs.agent',
    );
  });

  it('re-resolves the inspector tab title on locale change', async () => {
    const locale = ref('en');
    const panel = usePanelTabs({
      client: createClient() as never,
      sideWidth: ref(280),
      t: (key: string) => `${locale.value}:${key}`,
      locale,
    });
    const tab = panel.openTab('inspector');
    expect(tab.title).toBe('en:panel.tabs.inspector');

    locale.value = 'zh';
    await nextTick();
    expect(panel.panelTabs.value.find((candidate) => candidate.id === tab.id)?.title).toBe(
      'zh:panel.tabs.inspector',
    );
  });
});


describe('forking browser panel tabs', () => {
  it('copies ordered tabs and selection while preserving the source pages', async () => {
    const client = createClient();
    const removed = vi.fn();
    const panel = usePanelTabs({ client: client as never, sideWidth: ref(280), t, onTabRemoved: removed });
    const first = panel.openTab('browser', { browserId: 'browser-1', title: 'One' });
    panel.openTab('term', { ptyId: 'pty-1' });
    panel.openTab('browser', { browserId: 'browser-2', title: 'Two' });
    panel.activateTab(first.id);
    const clone = vi.fn(async (payload: { browserId: string; title?: string }) => ({ ...payload, browserId: `${payload.browserId}-copy` }));
    await forkPanelBrowserTabs('session-1', 'fork-1', clone);
    expect(panel.panelTabs.value).toHaveLength(3);
    client.activeSessionId.value = 'fork-1';
    await nextTick();
    expect(panel.panelTabs.value.map(tab => tab.payload)).toEqual([
      { browserId: 'browser-1-copy', title: 'One' },
      { browserId: 'browser-2-copy', title: 'Two' },
    ]);
    expect(panel.activeTab.value?.payload).toMatchObject({ browserId: 'browser-1-copy' });
    expect(panel.panelVisible.value).toBe(true);
    panel.closeTab(panel.activeTabId.value!);
    expect(removed.mock.calls.some(([tab]) => tab.payload.browserId === 'browser-1-copy')).toBe(true);
    client.activeSessionId.value = 'session-1';
    await nextTick();
    expect(panel.panelTabs.value.filter(tab => tab.type === 'browser').map(tab => tab.payload)).toEqual([
      { browserId: 'browser-1', title: 'One' }, { browserId: 'browser-2', title: 'Two' },
    ]);
    expect(removed.mock.calls.some(([tab]) => tab.payload.browserId === 'browser-1')).toBe(false);
  });

  it('copies a parked source and preserves a hidden panel', async () => {
    const client = createClient();
    const panel = createPanel(client);
    panel.openTab('browser', { browserId: 'source' });
    panel.hidePanel();
    client.activeSessionId.value = 'other';
    await nextTick();
    await forkPanelBrowserTabs('session-1', 'fork-1', async () => ({ browserId: 'copy' }));
    client.activeSessionId.value = 'fork-1';
    await nextTick();
    expect(panel.panelTabs.value.map(tab => tab.payload)).toEqual([{ browserId: 'copy' }]);
    expect(panel.panelVisible.value).toBe(false);
  });

  it('protects the incoming fork from the parked-page limit', async () => {
    const client = createClient();
    const panel = createPanel(client);
    for (let index = 0; index < 20; index++) panel.openTab('browser', { browserId: `source-${index}` });
    await forkPanelBrowserTabs('session-1', 'fork-1', async payload => ({ browserId: `${payload.browserId}-copy` }));
    client.activeSessionId.value = 'fork-1';
    await nextTick();
    expect(panel.panelTabs.value).toHaveLength(20);
    expect(panel.activeTab.value?.payload).toMatchObject({ browserId: 'source-19-copy' });
  });

  it('releases completed copies when another tab fails to clone', async () => {
    const client = createClient();
    const removed = vi.fn();
    const panel = usePanelTabs({ client: client as never, sideWidth: ref(280), t, onTabRemoved: removed });
    panel.openTab('browser', { browserId: 'source-1' });
    panel.openTab('browser', { browserId: 'source-2' });
    await expect(forkPanelBrowserTabs('session-1', 'fork-1', async payload => {
      if (payload.browserId === 'source-2') throw new Error('closed');
      return { browserId: 'copy-1' };
    })).rejects.toThrow('closed');
    expect(removed).toHaveBeenCalledWith(expect.objectContaining({ payload: { browserId: 'copy-1' } }));
    expect(panel.panelTabs.value).toHaveLength(2);
  });
});

describe('browser control lifetime', () => {
  it('uses a new control lease on reacquisition and preserves it during status synchronization', () => {
    const panel = createPanel(createClient());
    const tab = panel.addSessionBrowserTab('session-1', { browserId: 'first' });
    const lease = () => (panel.sessionBrowserTabs('session-1')[0]!.payload as BrowserTabPayload).controlled?.leaseId;
    panel.controlBrowserTab('session-1', tab.id, 'turn-1');
    const first = lease();
    expect(first).toEqual(expect.any(String));
    panel.syncBrowserControls(() => ({ turnId: 'turn-1', status: 'running' }));
    expect(lease()).toBe(first);
    panel.controlBrowserTab('session-1', null, '');
    panel.controlBrowserTab('session-1', tab.id, 'turn-1');
    expect(lease()).not.toBe(first);
  });

  it('releases and closes only the expected lease after same-run reacquisition', () => {
    const panel = createPanel(createClient());
    const tab = panel.addSessionBrowserTab('session-1', { browserId: 'first' });
    const lease = () => (panel.sessionBrowserTabs('session-1')[0]!.payload as BrowserTabPayload).controlled?.leaseId;
    panel.controlBrowserTab('session-1', tab.id, 'turn-1');
    const stale = lease()!;
    panel.controlBrowserTab('session-1', tab.id, 'turn-1');
    const current = lease()!;
    expect(current).not.toBe(stale);
    expect(panel.releaseBrowserTab('session-1', tab.id, stale)).toBe(false);
    expect(panel.closeSessionBrowserTab('session-1', tab.id, stale)).toBe(false);
    expect(lease()).toBe(current);
    expect(panel.releaseBrowserTab('session-1', tab.id, current)).toBe(true);
    expect(panel.sessionBrowserTabs('session-1')).toHaveLength(1);
    expect(lease()).toBeUndefined();

    panel.controlBrowserTab('session-1', tab.id, 'turn-1');
    const staleClose = lease()!;
    panel.controlBrowserTab('session-1', tab.id, 'turn-1');
    const currentClose = lease()!;
    expect(panel.closeSessionBrowserTab('session-1', tab.id, staleClose)).toBe(false);
    expect(panel.sessionBrowserTabs('session-1')).toHaveLength(1);
    expect(panel.closeSessionBrowserTab('session-1', tab.id, currentClose)).toBe(true);
    expect(panel.sessionBrowserTabs('session-1')).toEqual([]);
  });

  it('keeps run-scoped control while the main turn is idle and releases only the revoked run', () => {
    const panel = createPanel(createClient());
    const first = panel.addSessionBrowserTab('session-1', { browserId: 'first' });
    const second = panel.addSessionBrowserTab('session-1', { browserId: 'second' });
    const firstRun = { agentId: 'agent-1', generation: 2, turnId: 7 };
    const secondRun = { agentId: 'agent-2', generation: 3, turnId: 4 };
    const controlled = (id: string) => (panel.sessionBrowserTabs('session-1').find(tab => tab.id === id)!.payload as BrowserTabPayload).controlled;
    panel.controlBrowserTab('session-1', first.id, '7', { run: firstRun, profile: 'coder', description: 'Inspect docs' });
    const firstLease = controlled(first.id)?.leaseId;
    panel.syncBrowserControls(() => ({ turnId: null, status: 'idle' }));
    expect(controlled(first.id)).toMatchObject({ leaseId: firstLease, controller: { run: firstRun, profile: 'coder', description: 'Inspect docs' } });

    panel.controlBrowserTab('session-1', second.id, '4', { run: secondRun, profile: 'researcher' });
    expect(controlled(first.id)).toBeUndefined();
    expect(controlled(second.id)?.leaseId).not.toBe(firstLease);
    panel.releaseBrowserRun('session-1', firstRun);
    expect(controlled(second.id)?.controller?.run).toEqual(secondRun);
    panel.releaseBrowserRun('session-1', secondRun);
    expect(panel.sessionBrowserTabs('session-1').every(tab => !(tab.payload as BrowserTabPayload).controlled)).toBe(true);

    panel.controlBrowserTab('session-1', first.id, '8', { run: { ...firstRun, turnId: 8 } });
    expect(controlled(first.id)?.controller?.run.turnId).toBe(8);
    panel.releaseBrowserMainControl('session-1');
    expect(controlled(first.id)?.controller?.run.turnId).toBe(8);
    panel.controlBrowserTab('session-1', second.id, 'main-turn');
    panel.releaseBrowserMainControl('session-1');
    expect(controlled(second.id)).toBeUndefined();
  });

  it('keeps review selection and panel visibility while control moves and releases', () => {
    const panel = createPanel(createClient());
    const review = panel.openTab('diff', {});
    const first = panel.addSessionBrowserTab('session-1', { browserId: 'first' });
    const second = panel.addSessionBrowserTab('session-1', { browserId: 'second' });
    expect(panel.controlBrowserTab('session-1', first.id, 'turn-1')).toBe(true);
    expect(panel.activeTabId.value).toBe(review.id);
    expect(panel.panelVisible.value).toBe(true);
    panel.hidePanel();
    panel.controlBrowserTab('session-1', second.id, 'turn-1');
    expect((panel.sessionBrowserTabs('session-1')[0]!.payload as BrowserTabPayload).controlled).toBeUndefined();
    expect(panel.activeTabId.value).toBe(review.id);
    expect(panel.panelVisible.value).toBe(false);
    panel.controlBrowserTab('session-1', null, '');
    expect(panel.sessionBrowserTabs('session-1').every(tab => !(tab.payload as BrowserTabPayload).controlled)).toBe(true);
    expect(panel.sessionBrowserTabs('session-1')).toHaveLength(2);
  });

  it('preserves ownership across session switches and clears a parked control when its turn ends', async () => {
    const client = createClient();
    const panel = createPanel(client);
    const first = panel.addSessionBrowserTab('session-1', { browserId: 'first' });
    panel.controlBrowserTab('session-1', first.id, 'turn-1');
    client.activeSessionId.value = 'session-2';
    await nextTick();
    const other = panel.addSessionBrowserTab('session-2', { browserId: 'other' });
    panel.controlBrowserTab('session-2', other.id, 'turn-2');
    panel.syncBrowserControls(sid => ({ turnId: sid === 'session-1' ? 'turn-1' : 'turn-2', status: sid === 'session-1' ? 'idle' : 'running' }));
    expect((panel.sessionBrowserTabs('session-1')[0]!.payload as BrowserTabPayload).controlled).toBeUndefined();
    expect((panel.sessionBrowserTabs('session-2')[0]!.payload as BrowserTabPayload).controlled?.turnId).toBe('turn-2');
    client.activeSessionId.value = 'session-1';
    await nextTick();
    expect(panel.sessionBrowserTabs('session-1')[0]!.id).toBe(first.id);
    expect((panel.sessionBrowserTabs('session-1')[0]!.payload as BrowserTabPayload).controlled).toBeUndefined();
  });

  it('pauses and recovers within a turn but never carries control into a new turn', () => {
    const panel = createPanel(createClient());
    const tab = panel.addSessionBrowserTab('session-1', { browserId: 'first' });
    panel.controlBrowserTab('session-1', tab.id, 'turn-1');
    for (const status of ['paused', 'unknown', 'running'] as const) {
      panel.syncBrowserControls(() => ({ turnId: status === 'unknown' ? null : 'turn-1', status }));
      expect((panel.sessionBrowserTabs('session-1')[0]!.payload as BrowserTabPayload).controlled).toMatchObject({ leaseId: expect.any(String), turnId: 'turn-1', status });
    }
    panel.syncBrowserControls(() => ({ turnId: 'turn-2', status: 'running' }));
    expect((panel.sessionBrowserTabs('session-1')[0]!.payload as BrowserTabPayload).controlled).toBeUndefined();
    panel.controlBrowserTab('session-1', tab.id, 'turn-2');
    panel.closeSessionBrowserTab('session-1', tab.id);
    expect(panel.sessionBrowserTabs('session-1')).toEqual([]);
  });

  it('creates and closes background session tabs without changing the visible session', async () => {
    const client = createClient();
    const panel = createPanel(client);
    const review = panel.openTab('diff', {});
    const tab = panel.addSessionBrowserTab('session-2', { browserId: 'second' });
    panel.controlBrowserTab('session-2', tab.id, 'turn-2');
    expect(panel.activeTabId.value).toBe(review.id);
    expect(panel.panelTabs.value).toHaveLength(1);
    expect(panel.sessionBrowserTabs('session-2')[0]!.id).toBe(tab.id);
    panel.closeSessionBrowserTab('session-2', tab.id);
    expect(panel.sessionBrowserTabs('session-2')).toHaveLength(0);
  });
});

describe('durable browser panels', () => {
  function persistence() {
    let saved: import('@moonshot-ai/app-core/client').BrowserPanelSession[] = [];
    return {
      load: vi.fn(async () => structuredClone(saved)),
      save: vi.fn(async (sessions: typeof saved) => { saved = structuredClone(sessions); }),
      onError: vi.fn(),
      snapshot: () => saved,
    };
  }

  it('restores multiple sessions and selected tabs without restoring control', async () => {
    const storage = persistence();
    const client = createClient();
    const panel = usePanelTabs({ client, sideWidth: ref(280), t, browserPersistence: storage });
    await panel.browserPersistenceReady;
    const first = panel.openTab('browser', { browserId: 'a', title: 'First' });
    panel.openTab('browser', { browserId: 'b' });
    panel.activateTab(first.id);
    panel.controlBrowserTab('session-1', first.id, 'turn-1');
    client.activeSessionId.value = 'session-2';
    await nextTick();
    panel.openTab('browser', { browserId: 'c' });
    await nextTick();
    expect(storage.snapshot()).toHaveLength(2);
    expect(JSON.stringify(storage.snapshot())).not.toContain('controlled');
    const suspended = vi.fn();
    const restoredClient = createClient();
    const restored = usePanelTabs({ client: restoredClient, sideWidth: ref(280), t, browserPersistence: storage, onBrowserSuspended: suspended });
    await restored.browserPersistenceReady;
    expect(suspended).toHaveBeenCalledTimes(3);
    expect(restored.sessionBrowserTabs('session-1').map(tab => (tab.payload as BrowserTabPayload).browserId)).toEqual(['a', 'b']);
    expect((restored.activeTab.value?.payload as BrowserTabPayload).browserId).toBe('a');
    expect(restored.panelVisible.value).toBe(true);
    restoredClient.activeSessionId.value = 'session-2';
    await nextTick();
    expect((restored.activeTab.value?.payload as BrowserTabPayload).browserId).toBe('c');
    restored.closeTab(restored.activeTabId.value!);
    await nextTick();
    expect(storage.snapshot().some(session => session.sessionId === 'session-2')).toBe(false);
  });

  function memoryPanelStorage() {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    };
  }

  const browserIdsOf = (tabs: readonly { type: string; payload?: unknown }[]) =>
    tabs.filter(tab => tab.type === 'browser').map(tab => (tab.payload as BrowserTabPayload).browserId);

  it('restores background browser tab changes that the stored panel snapshot missed', async () => {
    const durable = persistence();
    const panelStorage = memoryPanelStorage();
    const client = createClient();
    const panel = usePanelTabs({ client, sideWidth: ref(280), t, browserPersistence: durable, storage: panelStorage });
    await panel.browserPersistenceReady;
    const closed = panel.openTab('browser', { browserId: 'closed-in-background' });
    panel.openTab('file', { path: '/notes.md' });
    client.activeSessionId.value = 'session-2';
    await nextTick();
    panel.addSessionBrowserTab('session-1', { browserId: 'added-in-background' });
    panel.closeSessionBrowserTab('session-1', panel.sessionBrowserTabs('session-1').find(tab => tab.id === closed.id)!.id);
    await nextTick();
    expect(durable.snapshot().find(session => session.sessionId === 'session-1')?.tabs.map(tab => tab.browserId)).toEqual(['added-in-background']);

    const restoredClient = createClient({ activeSessionId: ref('session-2') });
    const restored = usePanelTabs({ client: restoredClient, sideWidth: ref(280), t, browserPersistence: durable, storage: panelStorage, onBrowserSuspended: vi.fn() });
    await restored.browserPersistenceReady;
    restoredClient.activeSessionId.value = 'session-1';
    await nextTick();
    expect(restored.panelTabs.value.map(tab => tab.type)).toEqual(['file', 'browser']);
    expect(browserIdsOf(restored.panelTabs.value)).toEqual(['added-in-background']);
  });

  it('does not revive browser tabs that were all closed in the background', async () => {
    const durable = persistence();
    const panelStorage = memoryPanelStorage();
    const client = createClient();
    const panel = usePanelTabs({ client, sideWidth: ref(280), t, browserPersistence: durable, storage: panelStorage });
    await panel.browserPersistenceReady;
    const closed = panel.openTab('browser', { browserId: 'only-browser' });
    panel.openTab('file', { path: '/notes.md' });
    client.activeSessionId.value = 'session-2';
    await nextTick();
    panel.closeSessionBrowserTab('session-1', closed.id);
    await nextTick();
    expect(durable.snapshot().some(session => session.sessionId === 'session-1')).toBe(false);

    const restoredClient = createClient({ activeSessionId: ref('session-2') });
    const restored = usePanelTabs({ client: restoredClient, sideWidth: ref(280), t, browserPersistence: durable, storage: panelStorage, onBrowserSuspended: vi.fn() });
    await restored.browserPersistenceReady;
    restoredClient.activeSessionId.value = 'session-1';
    await nextTick();
    expect(restored.panelTabs.value.map(tab => tab.type)).toEqual(['file']);
  });

  it('reclaims parked pages without discarding their durable tabs', async () => {
    const client = createClient();
    const storage = persistence();
    const suspended = vi.fn();
    const removed = vi.fn();
    const panel = usePanelTabs({ client, sideWidth: ref(280), t, browserPersistence: storage, onBrowserSuspended: suspended, onTabRemoved: removed });
    await panel.browserPersistenceReady;
    for (let index = 1; index <= 20; index += 1) {
      client.activeSessionId.value = `session-${index}`;
      await nextTick();
      panel.openTab('browser', { browserId: `browser-${index}` });
      await nextTick();
    }
    expect(suspended).toHaveBeenCalledTimes(3);
    expect(removed).not.toHaveBeenCalled();
    expect(storage.snapshot()).toHaveLength(20);
    client.activeSessionId.value = 'session-1';
    await nextTick();
    expect((panel.activeTab.value?.payload as BrowserTabPayload).browserId).toBe('browser-1');
    expect(storage.snapshot()).toHaveLength(20);
  });

  it('keeps draft tabs and transfers them to the promoted session', async () => {
    const client = createClient({ activeSessionId: ref(null), activeWorkspaceId: ref('workspace-1') });
    const storage = persistence();
    const panel = usePanelTabs({ client, sideWidth: ref(280), t, browserPersistence: storage });
    await panel.browserPersistenceReady;
    panel.openTab('browser', { browserId: 'draft-browser' });
    await nextTick();
    expect(storage.snapshot()[0]?.sessionId).toBe('__draft__:workspace-1');
    client.getDraftPromotion.mockReturnValue({ workspaceId: 'workspace-1', sessionId: 'promoted' });
    client.activeSessionId.value = 'promoted';
    await nextTick();
    expect(storage.snapshot()).toHaveLength(1);
    expect(storage.snapshot()[0]?.sessionId).toBe('promoted');
    expect(storage.snapshot()[0]?.tabs[0]?.browserId).toBe('draft-browser');
  });

  it('does not save an empty startup layout before hydration completes', async () => {
    let resolve!: (value: import('@moonshot-ai/app-core/client').BrowserPanelSession[]) => void;
    const save = vi.fn(async () => {});
    const panel = usePanelTabs({ client: createClient(), sideWidth: ref(280), t, browserPersistence: { load: () => new Promise(done => { resolve = done; }), save, onError: vi.fn() } });
    await nextTick();
    expect(save).not.toHaveBeenCalled();
    const created = panel.openTab('browser', { browserId: 'new-browser' });
    resolve([{ sessionId: 'session-1', tabs: [{ browserId: 'old-browser' }], activeBrowserId: 'old-browser', visible: true }]);
    await panel.browserPersistenceReady;
    await nextTick();
    expect(panel.activeTabId.value).toBe(created.id);
    expect(panel.sessionBrowserTabs('session-1').map(tab => (tab.payload as BrowserTabPayload).browserId)).toEqual(['new-browser', 'old-browser']);
    expect(save).toHaveBeenCalled();
  });
});

describe('panel expansion capability', () => {
  it('preserves expansion across browser and other tab selections', () => {
    const panel = createPanel(createClient());
    const diff = panel.openTab('diff');
    panel.toggleExpanded();
    const browser = panel.openTab('browser', { browserId: 'browser' });
    expect(panel.panelCanExpand.value).toBe(true);
    expect(panel.panelExpanded.value).toBe(true);
    panel.toggleExpanded();
    expect(panel.panelExpanded.value).toBe(false);
    panel.activateTab(diff.id);
    panel.toggleExpanded();
    panel.activateTab(browser.id);
    expect(panel.panelExpanded.value).toBe(true);
  });

  it('keeps an expanded panel when closing a tab selects the browser', () => {
    const panel = createPanel(createClient());
    panel.openTab('browser', { browserId: 'browser' });
    const diff = panel.openTab('diff');
    panel.toggleExpanded();
    panel.closeTab(diff.id);
    expect(panel.activeTab.value?.type).toBe('browser');
    expect(panel.panelExpanded.value).toBe(true);
  });
});

it('tracks loading independently for background browser tabs and preserves their favicon', () => {
  const panel = createPanel(createClient());
  const first = panel.openTab('browser', { browserId: 'first', favicon: 'https://example.com/favicon.ico' });
  const second = panel.openTab('browser', { browserId: 'second' });
  panel.updateBrowserTabLoading(first.id, true);
  expect(panel.activeTabId.value).toBe(second.id);
  expect(panel.panelTabs.value[0]?.payload).toMatchObject({ loading: true, favicon: 'https://example.com/favicon.ico' });
  expect((panel.panelTabs.value[1]?.payload as BrowserTabPayload).loading).not.toBe(true);
  panel.updateBrowserTabLoading(first.id, false);
  expect(panel.panelTabs.value[0]?.payload).toMatchObject({ loading: false, favicon: 'https://example.com/favicon.ico' });
  const previous = panel.panelTabs.value[0];
  panel.updateBrowserTabLoading(first.id, false);
  expect(panel.panelTabs.value[0]).toBe(previous);
  panel.closeTab(first.id);
  panel.updateBrowserTabLoading(first.id, true);
  expect(panel.panelTabs.value).toHaveLength(1);
});

it('places new tabs beside the context target and keeps custom names across title updates', () => {
  const panel = createPanel(createClient({ activeSessionId: ref('session-browser-menu') }));
  const first = panel.openTab('browser', { browserId: 'first', title: 'Original' });
  const second = panel.openTab('browser', { browserId: 'second' });
  const created = panel.openTab('browser', { browserId: 'created' });
  panel.moveTabAfter(created.id, first.id);
  expect(panel.panelTabs.value.map(tab => tab.id)).toEqual([first.id, created.id, second.id]);
  expect(panel.activeTabId.value).toBe(created.id);
  panel.renameBrowserTab(first.id, ' My map ');
  panel.updateBrowserTabTitle(first.id, 'Updated page title');
  expect(panel.panelTabs.value[0]?.title).toBe('My map');
  panel.renameBrowserTab(first.id, '');
  expect(panel.panelTabs.value[0]?.title).toBe('Updated page title');
});

it('persists custom browser names alongside the actual page title', async () => {
  const save = vi.fn(async (_sessions: unknown) => {});
  const panel = usePanelTabs({ client: createClient({ activeSessionId: ref('session-browser-menu-persist') }), sideWidth: ref(280), t, browserPersistence: { load: async () => [], save, onError: vi.fn() } });
  await panel.browserPersistenceReady;
  const tab = panel.openTab('browser', { browserId: 'named-tab', title: 'Page title' });
  panel.renameBrowserTab(tab.id, 'Custom title');
  await nextTick();
  expect(save.mock.calls.at(-1)?.[0]).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: 'session-browser-menu-persist', tabs: [{ browserId: 'named-tab', title: 'Page title', customTitle: 'Custom title' }] })]));
});

it('selects the adjacent remaining tab when the selected background tab closes', async () => {
  const client = createClient();
  const panel = createPanel(client);
  const first = panel.openTab('browser', { browserId: 'first' });
  const second = panel.openTab('browser', { browserId: 'second' });
  panel.activateTab(first.id);
  client.activeSessionId.value = 'session-2';
  await nextTick();
  panel.closeSessionBrowserTab('session-1', first.id);
  client.activeSessionId.value = 'session-1';
  await nextTick();
  expect((panel.activeTab.value?.payload as BrowserTabPayload).browserId).toBe((second.payload as BrowserTabPayload).browserId);
  expect(panel.panelVisible.value).toBe(true);
});

it('keeps a side chat created after a session switch out of the current panel', async () => {
  let finish!: (value: { target: { agentId: string; seq: number }; sent: boolean }) => void;
  const client = createClient({ sideChatTargetsOfSession: () => [{ agentId: 'btw-late', seq: 1 }], openSideChatOn: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
  const panel = createPanel(client);
  const opening = panel.openSideChatTab();
  client.activeSessionId.value = 'session-2';
  await nextTick();
  finish({ target: { agentId: 'btw-late', seq: 1 }, sent: true });
  await opening;
  expect(panel.panelTabs.value).toEqual([]);
  client.activeSessionId.value = 'session-1';
  await nextTick();
  expect(panel.panelTabs.value.some(tab => tab.type === 'btw')).toBe(true);
});

it('persists new panels after loading saved panels fails', async () => {
  const storage = { load: vi.fn(async () => { throw new Error('read failed'); }), save: vi.fn(async () => {}), onError: vi.fn() };
  const panel = usePanelTabs({ client: createClient(), sideWidth: ref(280), t, browserPersistence: storage });
  await panel.browserPersistenceReady;
  panel.openTab('browser', { browserId: 'recovered' });
  await nextTick();
  expect(storage.save).toHaveBeenLastCalledWith([expect.objectContaining({ tabs: [expect.objectContaining({ browserId: 'recovered' })] })]);
});

it('destroys the active workspace draft and ignores its late persisted layout', async () => {
  const client = createClient();
  client.activeSessionId.value = null;
  client.activeWorkspaceId.value = 'workspace-1';
  let finish!: (sessions: import('@moonshot-ai/app-core/client').BrowserPanelSession[]) => void;
  const storage = { load: () => new Promise<import('@moonshot-ai/app-core/client').BrowserPanelSession[]>(resolve => { finish = resolve; }), save: vi.fn(async () => {}), onError: vi.fn() };
  const removed = vi.fn();
  const panel = usePanelTabs({ client, sideWidth: ref(280), t, onTabRemoved: removed, browserPersistence: storage });
  panel.openTab('browser', { browserId: 'draft-current' });
  destroyPanelSessionSnapshot(panelDraftContextKey('workspace-1'));
  expect(panel.panelTabs.value).toEqual([]);
  finish([{ sessionId: panelDraftContextKey('workspace-1'), tabs: [{ browserId: 'draft-saved' }], activeBrowserId: 'draft-saved', visible: true }]);
  await panel.browserPersistenceReady;
  await nextTick();
  expect(panel.panelTabs.value).toEqual([]);
  expect(removed).toHaveBeenCalledTimes(2);
  expect(storage.save).toHaveBeenLastCalledWith([]);
});

it('reclaims idle tabs in a parked session while keeping its controlled tab alive', async () => {
  const client = createClient();
  const suspended = vi.fn();
  const panel = usePanelTabs({ client, sideWidth: ref(280), t, onBrowserSuspended: suspended });
  const controlled = panel.openTab('browser', { browserId: 'controlled' });
  for (let i = 0; i < 20; i++) panel.openTab('browser', { browserId: `idle-${i}` });
  panel.controlBrowserTab('session-1', controlled.id, 'turn-1');
  client.activeSessionId.value = 'session-2';
  await nextTick();
  expect(suspended).toHaveBeenCalledTimes(5);
  expect(suspended.mock.calls.every(([tab]) => tab.payload.browserId !== 'controlled')).toBe(true);
  expect(panel.sessionBrowserTabs('session-1')).toHaveLength(21);
});

it('does not reveal forked browsers when the source panel selected a non-browser tab', async () => {
  const client = createClient();
  const panel = createPanel(client);
  panel.openTab('browser', { browserId: 'source-browser' });
  panel.openTab('diff', {});
  await forkPanelBrowserTabs('session-1', 'fork-hidden', async () => ({ browserId: 'cloned-browser' }));
  client.activeSessionId.value = 'fork-hidden';
  await nextTick();
  expect(panel.sessionBrowserTabs('fork-hidden')).toHaveLength(1);
  expect(panel.panelVisible.value).toBe(false);
});
describe('panel tab context actions', () => {
  it('closes tabs relative to the clicked tab and releases each resource once', () => {
    const removed = vi.fn();
    const panel = usePanelTabs({ client: createClient(), sideWidth: ref(280), t, onTabRemoved: removed });
    const a = panel.openTab('file', { path: '/a' });
    const b = panel.openTab('term', { ptyId: 'term' });
    const c = panel.openTab('diff', {});
    panel.closeTabsToRight(b.id);
    expect(panel.panelTabs.value.map(tab => tab.id)).toEqual([a.id, b.id]);
    expect(removed).toHaveBeenCalledWith(c);
    panel.closeOtherTabs('missing');
    expect(panel.panelTabs.value).toHaveLength(2);
    panel.closeOtherTabs(b.id);
    expect(panel.activeTabId.value).toBe(b.id);
    panel.closeAllTabs();
    expect(panel.panelVisible.value).toBe(false);
    expect(removed).toHaveBeenCalledTimes(3);
  });
});


describe('panel tab persistence', () => {
  function memoryStorage() {
    const values = new Map<string, string>();
    return { values, get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); } };
  }

  it('restores mixed browser and terminal ordering alongside native browser persistence', async () => {
    const storage = memoryStorage();
    let saved: import('@moonshot-ai/app-core/client').BrowserPanelSession[] = [];
    const native = { load: async () => structuredClone(saved), save: async (value: typeof saved) => { saved = structuredClone(value); }, onError: vi.fn() };
    const scope = effectScope();
    const panel = scope.run(() => usePanelTabs({ client: createClient(), sideWidth: ref(280), t, storage, browserPersistence: native }))!;
    await panel.browserPersistenceReady;
    panel.openTab('file', { path: '/before' });
    const browser = panel.openTab('browser', { browserId: 'saved-browser', customTitle: 'Named', controlled: { turnId: 'old', status: 'running', leaseId: 'old' } });
    panel.openTab('term', { ptyId: 'old-process', cwd: '/work' });
    panel.openTab('btw', { parentId: 'session-1', agentId: 'side-saved', seq: 1 });
    panel.activateTab(browser.id);
    await nextTick();
    scope.stop();
    const restoredScope = effectScope();
    const targets: Array<{ agentId: string; seq: number }> = [];
    const restoredClient = createClient({ sideChatTargetsOfSession: () => targets });
    restoredClient.activeSessionId.value = 'other';
    const restored = restoredScope.run(() => usePanelTabs({ client: { ...restoredClient, restoreSideChatTarget: (_sid, target) => { targets.push(target); } }, sideWidth: ref(280), t, storage, browserPersistence: native }))!;
    await restored.browserPersistenceReady;
    restoredClient.activeSessionId.value = 'session-1';
    await nextTick();
    expect(restored.panelTabs.value.map(tab => tab.type)).toEqual(['file', 'browser', 'term', 'btw']);
    expect(restored.activeTab.value?.payload).toEqual({ browserId: 'saved-browser', customTitle: 'Named' });
    expect(restored.panelTabs.value[2]?.payload).toEqual({ cwd: '/work' });
    expect(restored.panelVisible.value).toBe(true);
    expect(native.onError).not.toHaveBeenCalled();
    restoredScope.stop();
  });

  it('removes persisted workspace snapshots even when its sessions were never loaded', async () => {
    const storage = memoryStorage();
    const client = createClient();
    client.activeWorkspaceId.value = 'deleted-workspace';
    const firstScope = effectScope();
    const first = firstScope.run(() => usePanelTabs({ client, sideWidth: ref(280), t, storage }))!;
    first.openTab('diff', {});
    await nextTick();
    firstScope.stop();
    expect(JSON.parse(storage.values.get('kimi-web.panel-tabs.v1:session-1')!).workspaceId).toBe('deleted-workspace');
    const secondClient = createClient();
    secondClient.activeSessionId.value = 'unrelated-session';
    secondClient.activeWorkspaceId.value = 'other-workspace';
    const secondScope = effectScope();
    const second = secondScope.run(() => usePanelTabs({ client: secondClient, sideWidth: ref(280), t, storage }))!;
    second.openTab('diff', {});
    await nextTick();
    notifyWorkspaceDestroyed('deleted-workspace', '/deleted', []);
    expect(storage.values.has('kimi-web.panel-tabs.v1:session-1')).toBe(false);
    expect(storage.values.has('kimi-web.panel-tabs.v1:unrelated-session')).toBe(true);
    secondScope.stop();
  });

  it('cleans destroyed contexts and does not recreate them on switch or disposal', async () => {
    const storage = memoryStorage();
    const scope = effectScope();
    const client = createClient();
    const panel = scope.run(() => usePanelTabs({ client, sideWidth: ref(280), t, storage }))!;
    panel.openTab('diff', {});
    await nextTick();
    notifySessionDestroyed('session-1');
    client.activeSessionId.value = null;
    client.activeWorkspaceId.value = 'workspace-1';
    await nextTick();
    expect(storage.values.size).toBe(0);
    panel.openTab('diff', {});
    await nextTick();
    expect(storage.values.size).toBe(1);
    notifyWorkspaceDestroyed('workspace-1', '/repo', ['session-1']);
    await nextTick();
    scope.stop();
    expect(storage.values.size).toBe(0);
    expect(panel.panelTabs.value).toHaveLength(0);
  });

  it('persists new tabs after an archived context is restored and reentered', async () => {
    const storage = memoryStorage();
    const scope = effectScope();
    const client = createClient();
    const panel = scope.run(() => usePanelTabs({ client, sideWidth: ref(280), t, storage }))!;
    panel.openTab('diff', {});
    await nextTick();
    notifySessionDestroyed('session-1');
    client.activeSessionId.value = 'session-2';
    await nextTick();
    client.activeSessionId.value = 'session-1';
    await nextTick();
    panel.openTab('file', { path: '/restored.md' });
    await nextTick();
    client.activeSessionId.value = 'session-2';
    await nextTick();
    client.activeSessionId.value = 'session-1';
    await nextTick();
    expect(panel.panelTabs.value[0]?.payload).toEqual({ path: '/restored.md' });
    scope.stop();
    expect(storage.values.get('kimi-web.panel-tabs.v1:session-1')).toContain('/restored.md');
  });

  it('restores an empty visible launcher on session switches and recreation', async () => {
    const storage = memoryStorage();
    const scope = effectScope();
    const client = createClient();
    const panel = scope.run(() => usePanelTabs({ client, sideWidth: ref(280), t, storage }))!;
    panel.panelVisible.value = true;
    await nextTick();
    client.activeSessionId.value = 'session-2';
    await nextTick();
    client.activeSessionId.value = 'session-1';
    await nextTick();
    expect(panel.panelTabs.value).toHaveLength(0);
    expect(panel.panelVisible.value).toBe(true);
    scope.stop();
    const restoredScope = effectScope();
    const restored = restoredScope.run(() => usePanelTabs({ client: createClient(), sideWidth: ref(280), t, storage }))!;
    expect(restored.panelTabs.value).toHaveLength(0);
    expect(restored.panelVisible.value).toBe(true);
    restoredScope.stop();
  });

  it('restores all descriptors after recreation without reviving stale terminal handles', async () => {
    const storage = memoryStorage();
    const scope = effectScope();
    const first = scope.run(() => usePanelTabs({ client: createClient(), sideWidth: ref(280), t, storage }))!;
    first.openTab('file', { path: '/a', content: 'saved preview' });
    first.openTab('term', { ptyId: 'old-process', title: 'zsh', cwd: '/repo' });
    first.openTab('compaction', { turnId: 'c1', text: 'summary' });
    first.openTab('turn-diff', { turnId: 'turn-1', sessionId: 'session-1', change: editChange });
    first.openTab('btw', { parentId: 'session-1', agentId: 'side-1', seq: 2 });
    first.openTab('diff', {});
    first.toggleExpanded();
    await nextTick();
    scope.stop();
    const client = createClient();
    const targets: Array<{ agentId: string; seq: number }> = [];
    client.sideChatTargetsOfSession.mockImplementation(() => targets as never);
    const restore = vi.fn((_sid: string, target: { agentId: string; seq: number }) => { targets.push(target); });
    const restored = usePanelTabs({ client: { ...client, restoreSideChatTarget: restore }, sideWidth: ref(280), t, storage });
    expect(restored.panelTabs.value.map(tab => tab.type)).toEqual(['file', 'term', 'compaction', 'turn-diff', 'btw', 'diff']);
    expect(restored.panelTabs.value[1]?.payload).toEqual({ title: 'zsh', cwd: '/repo' });
    expect(restored.compactionPanelTextOf('c1')).toBe('summary');
    expect(restored.activeTab.value?.type).toBe('diff');
    expect(restored.panelExpanded.value).toBe(true);
    expect(restore).toHaveBeenCalledWith('session-1', { agentId: 'side-1', seq: 2 });
    restored.closeAllTabs();
    await nextTick();
    expect(storage.values.size).toBe(0);
  });

  it('persists separate sessions and draft workspaces, including a hidden selected tab', async () => {
    const storage = memoryStorage();
    const scope = effectScope();
    const client = createClient();
    const panel = scope.run(() => usePanelTabs({ client, sideWidth: ref(280), t, storage }))!;
    panel.openTab('file', { path: '/one' });
    panel.hidePanel();
    client.activeSessionId.value = 'session-2';
    await nextTick();
    panel.openTab('file', { path: '/two' });
    client.activeSessionId.value = null;
    client.activeWorkspaceId.value = 'workspace';
    await nextTick();
    panel.openTab('term', { title: 'draft terminal' });
    await nextTick();
    scope.stop();
    const nextClient = createClient();
    const next = usePanelTabs({ client: nextClient, sideWidth: ref(280), t, storage });
    expect(next.activeTab.value?.payload).toEqual({ path: '/one' });
    expect(next.panelVisible.value).toBe(false);
    nextClient.activeSessionId.value = 'session-2';
    await nextTick();
    expect(next.activeTab.value?.payload).toEqual({ path: '/two' });
    nextClient.activeSessionId.value = null;
    nextClient.activeWorkspaceId.value = 'workspace';
    await nextTick();
    expect(next.activeTab.value?.type).toBe('term');
  });

  it('ignores corrupt or unsupported descriptors while retaining valid tabs', () => {
    const storage = memoryStorage();
    storage.setItem('kimi-web.panel-tabs.v1:session-1', JSON.stringify({
      tabs: [{ type: 'future', payload: {} }, { type: 'file', payload: {} }, { type: 'file', payload: { path: '/valid' } }],
      activeIndex: 2, visible: true,
    }));
    const panel = usePanelTabs({ client: createClient(), sideWidth: ref(280), t, storage });
    expect(panel.panelTabs.value).toHaveLength(1);
    expect(panel.activeTab.value?.payload).toEqual({ path: '/valid' });
    expect(panel.panelVisible.value).toBe(true);
  });

  it('purges persisted btw tab when closed before its session is hydrated', async () => {
    const storage = memoryStorage();
    storage.setItem('kimi-web.panel-tabs.v1:session-2', JSON.stringify({
      tabs: [{ type: 'btw', payload: { parentId: 'session-2', agentId: 'btw-closed', seq: 1 } }],
      activeIndex: 0,
      visible: true,
      expanded: false,
    }));
    const client = createClient();
    const restore = vi.fn();
    const scope = effectScope();
    const panel = scope.run(() => usePanelTabs({
      client: { ...client, restoreSideChatTarget: restore },
      sideWidth: ref(280),
      t,
      storage,
    }))!;

    expect(destroyPanelBtwTab('session-2', 'btw-closed')).toBe(true);
    expect(destroyPanelBtwTab('session-2', 'ordinary-subagent')).toBe(false);

    client.activeSessionId.value = 'session-2';
    await nextTick();

    expect(restore).not.toHaveBeenCalled();
    expect(panel.panelTabs.value).toEqual([]);
    expect(panel.panelVisible.value).toBe(false);
    scope.stop();
  });
});


it('reorders tabs without changing selection and persists the resulting order', async () => {
  const values = new Map<string, string>();
  const storage = { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
  const panel = usePanelTabs({ client: createClient(), sideWidth: ref(280), t, storage });
  const a = panel.openTab('file', { path: '/a' });
  panel.openTab('file', { path: '/b' });
  const c = panel.openTab('file', { path: '/c' });
  panel.moveTab(a.id, 2);
  expect(panel.panelTabs.value.map(tab => tab.title)).toEqual(['b', 'c', 'a']);
  expect(panel.activeTabId.value).toBe(c.id);
  panel.moveTab('missing', 0);
  panel.moveTab(c.id, Number.NaN);
  panel.moveTab(a.id, 99);
  await nextTick();
  const restored = usePanelTabs({ client: createClient(), sideWidth: ref(280), t, storage });
  expect(restored.panelTabs.value.map(tab => tab.title)).toEqual(['b', 'c', 'a']);
  expect(restored.activeTab.value?.title).toBe('c');
});


it('keeps runtime tab presentation independent from selection and saved descriptors', async () => {
  const values = new Map<string, string>();
  const storage = { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
  const client = createClient();
  const panel = usePanelTabs({ client, sideWidth: ref(280), t, storage });
  const file = panel.openTab('file', { path: '/a' });
  const selected = panel.openTab('diff', {});
  const presentation = { title: 'Dynamic title', favicon: 'https://example.com/icon.png', status: { icon: 'pause', label: 'Paused' } };
  panel.updateTabPresentation(file.id, presentation);
  expect(panel.activeTabId.value).toBe(selected.id);
  client.activeSessionId.value = 'session-2';
  await nextTick();
  client.activeSessionId.value = 'session-1';
  await nextTick();
  expect(panel.panelTabs.value[0]?.presentation).toEqual(presentation);
  expect([...values.values()].join('')).not.toContain('Paused');
  panel.updateTabPresentation(file.id, undefined);
  expect(panel.panelTabs.value[0]?.presentation).toBeUndefined();
});


it('cycles panel tabs in both directions with wraparound and leaves hidden panels alone', () => {
  const panel = createPanel(createClient());
  expect(panel.cycleTab(1)).toBe(false);
  const a = panel.openTab('file', { path: '/a' });
  expect(panel.cycleTab(1)).toBe(false);
  const b = panel.openTab('file', { path: '/b' });
  expect(panel.cycleTab(1)).toBe(true);
  expect(panel.activeTabId.value).toBe(a.id);
  expect(panel.cycleTab(-1)).toBe(true);
  expect(panel.activeTabId.value).toBe(b.id);
  panel.hidePanel();
  expect(panel.cycleTab(1)).toBe(false);
  expect(panel.activeTabId.value).toBe(b.id);
});


it('keeps a missing summary empty in storage until its history is loaded', () => {
  const client = createClient();
  const panel = createPanel(client);
  panel.openTab('compaction', { turnId: 'summary' });
  expect(panel.compactionPanelTextOf('summary')).toBeNull();
  panel.openCompactionPanel({ turnId: 'summary' });
  expect((panel.activeTab.value?.payload as { text?: string }).text).toBeUndefined();
  client.turns.value = [{ id: 'summary', role: 'compaction', text: 'Loaded summary' } as ChatTurn];
  expect(panel.compactionPanelTextOf('summary')).toBe('Loaded summary');
});

it('toggles the sidebar closed when clicking an already active compaction summary and switches otherwise', () => {
  const client = createClient();
  client.turns.value = [
    { id: 'c1', role: 'compaction', text: 'Summary 1' } as ChatTurn,
    { id: 'c2', role: 'compaction', text: 'Summary 2' } as ChatTurn,
  ];
  const panel = createPanel(client);

  expect(panel.isCompactionPanelOpen('c1')).toBe(false);
  panel.openCompactionPanel({ turnId: 'c1' });
  expect(panel.panelVisible.value).toBe(true);
  expect(panel.isCompactionPanelOpen('c1')).toBe(true);

  panel.openCompactionPanel({ turnId: 'c2' });
  expect(panel.panelVisible.value).toBe(true);
  expect(panel.isCompactionPanelOpen('c1')).toBe(false);
  expect(panel.isCompactionPanelOpen('c2')).toBe(true);

  panel.openTab('file', { path: '/a.ts' });
  expect(panel.isCompactionPanelOpen('c2')).toBe(false);
  panel.openCompactionPanel({ turnId: 'c2' });
  expect(panel.panelVisible.value).toBe(true);
  expect(panel.isCompactionPanelOpen('c2')).toBe(true);

  panel.openCompactionPanel({ turnId: 'c2' });
  expect(panel.panelVisible.value).toBe(false);
  expect(panel.isCompactionPanelOpen('c2')).toBe(false);
});

it('releases active and background context resources once on destruction', async () => {
  const scope = effectScope();
  const client = createClient();
  const removed = vi.fn();
  const panel = scope.run(() => usePanelTabs({ client, sideWidth: ref(280), t, onTabRemoved: removed }))!;
  const first = panel.openTab('term', { ptyId: 'one' });
  await nextTick();
  client.activeSessionId.value = 'session-2';
  await nextTick();
  const second = panel.openTab('term', { ptyId: 'two' });
  await nextTick();
  notifySessionDestroyed('session-1');
  expect(removed.mock.calls.map(([tab]) => tab.id)).toEqual([first.id]);
  notifySessionDestroyed('session-2');
  notifySessionDestroyed('session-2');
  expect(removed.mock.calls.map(([tab]) => tab.id)).toEqual([first.id, second.id]);
  expect(panel.panelTabs.value).toHaveLength(0);
  scope.stop();
});

it('keeps the panel visible when its selected fork is gone but another tab survives', async () => {
  const scope = effectScope();
  const client = createClient();
  const panel = scope.run(() => createPanel(client))!;
  panel.openTab('file', { path: '/keep.md' });
  panel.openTab('btw', { parentId: 'session-1', agentId: 'gone', seq: 1 });
  client.activeSessionId.value = 'session-2';
  await nextTick();
  client.activeSessionId.value = 'session-1';
  await nextTick();
  expect(panel.panelTabs.value.map(tab => tab.type)).toEqual(['file']);
  expect(panel.activeTabId.value).toBe(panel.panelTabs.value[0]?.id);
  expect(panel.panelVisible.value).toBe(true);
  scope.stop();
});

it('keeps a background agent session within the parked-page budget while it creates tabs', async () => {
  const client = createClient();
  const suspended = vi.fn();
  const panel = usePanelTabs({ client, sideWidth: ref(280), t, onBrowserSuspended: suspended });
  client.activeSessionId.value = 'session-2';
  await nextTick();
  for (let i = 0; i < 20; i++) {
    const tab = panel.addSessionBrowserTab('session-1', { browserId: `agent-${i}` });
    panel.controlBrowserTab('session-1', tab.id, 'turn-1');
  }
  expect(suspended.mock.calls.map(([tab]) => tab.payload.browserId)).toEqual(['agent-0', 'agent-1', 'agent-2', 'agent-3']);
  expect(panel.sessionBrowserTabs('session-1')).toHaveLength(20);
});

it('reclaims parked pages that were kept alive only by control once that control ends', async () => {
  const client = createClient();
  const suspended = vi.fn();
  const panel = usePanelTabs({ client, sideWidth: ref(280), t, onBrowserSuspended: suspended });
  client.activeSessionId.value = 'visible';
  await nextTick();
  for (let i = 0; i < 17; i++) {
    const tab = panel.addSessionBrowserTab(`agent-${i}`, { browserId: `page-${i}` });
    panel.controlBrowserTab(`agent-${i}`, tab.id, 'turn-1');
  }
  expect(suspended).not.toHaveBeenCalled();
  panel.syncBrowserControls((sessionId) => sessionId === 'agent-0' ? { turnId: null, status: 'idle' } : { turnId: 'turn-1', status: 'running' });
  expect(suspended).toHaveBeenCalledOnce();
  expect(suspended.mock.calls[0]![0].payload.browserId).toBe('page-0');
});
