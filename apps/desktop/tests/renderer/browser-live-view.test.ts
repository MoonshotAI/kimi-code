import { computed, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { browserControlOutOfView, createBrowserLiveView } from '../../src/renderer/lib/browserLiveView';
import { browserFaviconSignature, createBrowserFaviconSource } from '../../src/renderer/lib/browserFavicons';

type Tab = { id: string; type: string; payload?: unknown };

function panelWith(tabs: Record<string, Tab[]>) {
  const panelVisible = ref(false);
  const activeId = ref<string | null>(null);
  const all = Object.values(tabs).flat();
  const activateTab = vi.fn((id: string) => {
    activeId.value = id;
    panelVisible.value = true;
  });
  const panel = {
    panelVisible,
    activeTab: computed(() => all.find((tab) => tab.id === activeId.value) ?? null),
    sessionBrowserTabs: (sessionId: string) => (tabs[sessionId] ?? []).filter((tab) => tab.type === 'browser'),
    activateTab,
  };
  return { panel: panel as never, panelVisible, activeId, activateTab };
}

const browserTab = (id: string, status?: 'running' | 'paused' | 'unknown'): Tab => ({
  id,
  type: 'browser',
  payload: { browserId: `browser-${id}`, ...(status ? { controlled: { leaseId: 'lease', turnId: 'turn', status } } : {}) },
});

describe('browser live view', () => {
  it('reports whether the tab the agent controls is on screen and shows it on request', () => {
    const { panel, panelVisible, activeId, activateTab } = panelWith({
      'session-a': [{ id: 'diff', type: 'diff' }, browserTab('idle'), browserTab('agent', 'running')],
      'session-b': [browserTab('other', 'running')],
    });
    const active = ref<string | null>('session-a');
    const view = createBrowserLiveView(panel, () => active.value);
    expect(view.state('session-a')).toEqual({ visible: false, tabId: 'agent' });
    expect(browserControlOutOfView(panel, active.value)).toBe(true);
    activeId.value = 'diff';
    panelVisible.value = true;
    expect(view.state('session-a')).toEqual({ visible: false, tabId: 'agent' });
    expect(browserControlOutOfView(panel, active.value)).toBe(false);
    view.show('session-a');
    expect(activateTab).toHaveBeenCalledWith('agent');
    expect(view.state('session-a')).toEqual({ visible: true, tabId: 'agent' });
    expect(view.state('session-b')).toBeNull();
    view.show('session-b');
    expect(activateTab).toHaveBeenCalledTimes(1);
    expect(browserControlOutOfView(panel, null)).toBe(false);
  });

  it('ignores sessions whose browser is idle, paused or unknown', () => {
    const { panel, activateTab } = panelWith({
      idle: [browserTab('a')],
      paused: [browserTab('b', 'paused')],
      unknown: [browserTab('c', 'unknown')],
    });
    for (const sessionId of ['idle', 'paused', 'unknown', 'missing']) {
      const view = createBrowserLiveView(panel, () => sessionId);
      expect(view.state(sessionId)).toBeNull();
      view.show(sessionId);
      expect(browserControlOutOfView(panel, sessionId)).toBe(false);
    }
    expect(activateTab).not.toHaveBeenCalled();
  });
});

describe('browser favicons', () => {
  it('maps history favicons by site, refreshing at most every half minute', async () => {
    let clock = 1_000;
    const load = vi.fn(async () => ({
      history: [
        { url: 'https://notes.example/explore/a', favicon: 'data:image/png;base64,A' },
        { url: 'https://notes.example/explore/b', favicon: 'data:image/png;base64,B' },
        { url: 'https://plain.example/', favicon: undefined },
        { url: 'not a url', favicon: 'data:image/png;base64,C' },
      ],
    }));
    const source = createBrowserFaviconSource(load, () => clock);
    expect(source.favicon('https://notes.example/other')).toBeUndefined();
    source.refresh();
    source.refresh();
    await vi.waitFor(() => expect(source.favicon('https://notes.example/other')).toBe('data:image/png;base64,A'));
    expect(source.favicon('https://plain.example/page')).toBeUndefined();
    expect(source.favicon('not a url')).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
    clock += 29_000;
    source.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    clock += 2_000;
    source.refresh();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reloads on demand when the browser reports a new icon, and retries after a failed load', async () => {
    const settle = async () => { for (let round = 0; round < 5; round++) await Promise.resolve(); };
    let clock = 1_000;
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('ipc'))
      .mockResolvedValueOnce({ history: [{ url: 'https://notes.example/', favicon: undefined }] })
      .mockResolvedValue({ history: [{ url: 'https://notes.example/', favicon: 'data:image/png;base64,A' }] });
    const source = createBrowserFaviconSource(load, () => clock);
    source.refresh();
    await settle();
    source.refresh();
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(source.favicon('https://notes.example/x')).toBeUndefined();
    source.refresh();
    expect(load).toHaveBeenCalledTimes(2);
    source.reload();
    await settle();
    expect(load).toHaveBeenCalledTimes(3);
    expect(source.favicon('https://notes.example/x')).toBe('data:image/png;base64,A');
  });

  it('runs a reload that arrives while a read is still in flight', async () => {
    const settle = async () => { for (let round = 0; round < 5; round++) await Promise.resolve(); };
    let clock = 1_000;
    let finishFirst: (value: { history: readonly { url: string; favicon?: string }[] }) => void = () => {};
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue({ history: [{ url: 'https://notes.example/', favicon: 'data:image/png;base64,A' }] });
    const source = createBrowserFaviconSource(load, () => clock);
    source.refresh();
    source.reload();
    expect(load).toHaveBeenCalledTimes(1);
    finishFirst({ history: [{ url: 'https://notes.example/', favicon: undefined }] });
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(source.favicon('https://notes.example/x')).toBe('data:image/png;base64,A'));
    source.reload();
    await settle();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('signs the icons of the open browser tabs so a late one triggers a reload', () => {
    const before = browserFaviconSignature([{ id: 'tab-1', favicon: undefined }, { id: 'tab-2', favicon: 'data:image/png;base64,AA' }]);
    expect(browserFaviconSignature([{ id: 'tab-1', favicon: undefined }, { id: 'tab-2', favicon: 'data:image/png;base64,AA' }])).toBe(before);
    expect(browserFaviconSignature([{ id: 'tab-1', favicon: 'data:image/png;base64,B' }, { id: 'tab-2', favicon: 'data:image/png;base64,AA' }])).not.toBe(before);
    expect(browserFaviconSignature([{ id: 'tab-2', favicon: 'data:image/png;base64,AA' }])).not.toBe(before);
    expect(browserFaviconSignature([])).toBe('');
    const tail = 'QmCC'.repeat(4);
    const one = `data:image/png;base64,${'A'.repeat(40)}${tail}`;
    const two = `data:image/png;base64,${'B'.repeat(40)}${tail}`;
    expect(one).toHaveLength(two.length);
    expect(one.slice(-16)).toBe(two.slice(-16));
    expect(browserFaviconSignature([{ id: 'tab-1', favicon: one }])).not.toBe(browserFaviconSignature([{ id: 'tab-1', favicon: two }]));
  });

  it('keeps the last favicons when a refresh fails', async () => {
    let clock = 0;
    const load = vi.fn()
      .mockResolvedValueOnce({ history: [{ url: 'https://notes.example/', favicon: 'data:image/png;base64,A' }] })
      .mockRejectedValueOnce(new Error('ipc'));
    const source = createBrowserFaviconSource(load, () => clock);
    source.refresh();
    await vi.waitFor(() => expect(source.favicon('https://notes.example/x')).toBe('data:image/png;base64,A'));
    clock += 60_000;
    source.refresh();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(source.favicon('https://notes.example/x')).toBe('data:image/png;base64,A');
  });
});
