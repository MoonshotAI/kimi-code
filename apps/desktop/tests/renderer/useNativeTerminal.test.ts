import { describe, expect, it, vi } from 'vitest';

import {
  canUseNativeTerminal,
  createNativeTerminalStore,
  MAX_TERMINAL_SESSIONS,
  type NativeTerminalBridge,
} from '../../src/renderer/composables/useNativeTerminal';

type OutputListener = (id: string, data: string) => void;
type ExitListener = (id: string, exitCode: number | null) => void;

function makeBridge(overrides: Partial<NativeTerminalBridge> = {}) {
  let seq = 0;
  const outputListeners = new Set<OutputListener>();
  const exitListeners = new Set<ExitListener>();
  const bridge: NativeTerminalBridge = {
    createNativeTerminal: vi.fn(async (opts?: { cwd?: string }) => {
      seq += 1;
      return { id: `t${seq}`, shell: 'zsh', cwd: opts?.cwd ?? '/home/u' };
    }),
    nativeTerminalInput: vi.fn(),
    nativeTerminalResize: vi.fn(),
    closeNativeTerminal: vi.fn(),
    onNativeTerminalOutput: (cb) => {
      outputListeners.add(cb);
      return () => outputListeners.delete(cb);
    },
    onNativeTerminalExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    ...overrides,
  };
  return {
    bridge,
    emitOutput: (id: string, data: string) => {
      for (const cb of outputListeners) cb(id, data);
    },
    emitExit: (id: string, exitCode: number | null) => {
      for (const cb of exitListeners) cb(id, exitCode);
    },
  };
}

function makeDeferredBridge() {
  const resolvers: Array<(info: { id: string; shell: string; cwd: string }) => void> = [];
  const made = makeBridge({
    createNativeTerminal: vi.fn(
      () =>
        new Promise<{ id: string; shell: string; cwd: string }>((resolve) => {
          resolvers.push(resolve);
        }),
    ),
  });
  return { ...made, resolvers };
}

describe('canUseNativeTerminal', () => {
  it('requires the bridge and its terminal methods', () => {
    expect(canUseNativeTerminal(undefined)).toBe(false);
    expect(canUseNativeTerminal({} as NativeTerminalBridge)).toBe(false);
    expect(canUseNativeTerminal(makeBridge().bridge)).toBe(true);
  });
});

describe('createNativeTerminalStore', () => {
  it('reorders bottom tabs and moves them between panels without touching their process', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    store.openPanel('/w');
    await vi.waitFor(() => expect(store.tabs.value).toHaveLength(1));
    const second = await store.newTab('/w');
    store.moveTab(second!.id, 0);
    expect(store.tabs.value.map(tab => tab.id)).toEqual(['t2', 't1']);

    expect(store.moveTabToPanel('t2')?.id).toBe('t2');
    expect(store.tabs.value.map(tab => tab.id)).toEqual(['t1']);
    expect(store.activeTabId.value).toBe('t1');
    expect(store.panelTabOf('t2')?.id).toBe('t2');
    expect(store.open.value).toBe(true);

    store.moveTabToPanel('t1');
    expect(store.open.value).toBe(false);
    expect(store.activeTabId.value).toBeNull();
    expect(store.moveTabToPanel('missing')).toBeNull();

    expect(store.moveTabToBottom('t1', 0)?.id).toBe('t1');
    expect(store.open.value).toBe(true);
    expect(store.activeTabId.value).toBe('t1');
    expect(store.panelTabOf('t1')).toBeUndefined();
    store.moveTabToBottom('t2', 0);
    expect(store.tabs.value.map(tab => tab.id)).toEqual(['t2', 't1']);
    expect(store.activeTabId.value).toBe('t2');
    expect(store.moveTabToBottom('missing', 0)).toBeNull();
    expect(bridge.closeNativeTerminal).not.toHaveBeenCalled();
  });

  it('is an inert no-op without a bridge', async () => {
    const store = createNativeTerminalStore(undefined);
    expect(store.available).toBe(false);
    store.toggle('/work');
    expect(store.open.value).toBe(true);
    expect(store.tabs.value).toEqual([]);
    expect(await store.newTab('/work')).toBeNull();
    store.closePanel();
    expect(store.open.value).toBe(false);
  });

  it('spawns a first tab when the panel opens empty, and passes cwd through', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    store.toggle('/work/app');
    await vi.waitFor(() => {
      expect(store.tabs.value).toHaveLength(1);
    });
    expect(bridge.createNativeTerminal).toHaveBeenCalledWith({
      cwd: '/work/app',
      cols: undefined,
      rows: undefined,
    });
    expect(store.activeTabId.value).toBe('t1');
    expect(store.tabs.value[0]).toMatchObject({ shell: 'zsh', cwd: '/work/app', status: 'running' });
  });

  it('surfaces a create failure in error and keeps the tab list empty', async () => {
    const { bridge } = makeBridge({
      createNativeTerminal: vi.fn(async () => Promise.reject(new Error('spawn failed'))),
    });
    const store = createNativeTerminalStore(bridge);
    expect(await store.newTab('/work')).toBeNull();
    expect(store.error.value).toBe('spawn failed');
    expect(store.tabs.value).toEqual([]);
  });

  it('routes output and exit events to the right tab handlers', async () => {
    const { bridge, emitOutput, emitExit } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    const first = await store.newTab('/a');
    const second = await store.newTab('/b');
    const seenA: string[] = [];
    const seenB: string[] = [];
    store.onOutput(first!.id, (data) => seenA.push(data));
    store.onOutput(second!.id, (data) => seenB.push(data));
    emitOutput(first!.id, 'one');
    emitOutput(second!.id, 'two');
    expect(seenA).toEqual(['one']);
    expect(seenB).toEqual(['two']);

    const exits: Array<number | null> = [];
    store.onExit(first!.id, (code) => exits.push(code));
    emitExit(first!.id, 1);
    expect(exits).toEqual([1]);
    expect(store.tabs.value.find((tab) => tab.id === first!.id)).toMatchObject({
      status: 'exited',
      exitCode: 1,
    });
    expect(store.tabs.value.find((tab) => tab.id === second!.id)).toMatchObject({
      status: 'running',
    });
  });

  it('buffers output emitted before the view subscribes and replays it', async () => {
    const { bridge, emitOutput } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    const tab = await store.newTab('/a');
    emitOutput(tab!.id, 'prompt$ ');
    emitOutput(tab!.id, 'more');
    const seen: string[] = [];
    store.onOutput(tab!.id, (data) => seen.push(data));
    expect(seen).toEqual(['prompt$ ', 'more']);
    emitOutput(tab!.id, 'next');
    expect(seen).toEqual(['prompt$ ', 'more', 'next']);
  });

  it('applies an exit that arrives before the tab was pushed (instant death)', async () => {
    const { bridge, resolvers, emitExit } = makeDeferredBridge();
    const store = createNativeTerminalStore(bridge);
    store.openPanel('/work');
    emitExit('t1', 137);
    resolvers[0]!({ id: 't1', shell: 'zsh', cwd: '/work' });
    await vi.waitFor(() => expect(store.tabs.value).toHaveLength(1));
    expect(store.tabs.value[0]).toMatchObject({ id: 't1', status: 'exited', exitCode: 137 });
  });

  it('closeTab kills the pty and fixes the active selection', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    const first = await store.newTab('/a');
    const second = await store.newTab('/b');
    expect(store.activeTabId.value).toBe(second!.id);
    store.closeTab(second!.id);
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith(second!.id);
    expect(store.tabs.value.map((tab) => tab.id)).toEqual([first!.id]);
    expect(store.activeTabId.value).toBe(first!.id);
    store.closeTab(first!.id);
    expect(store.activeTabId.value).toBeNull();
  });

  it('restartTab keeps the tab position and reuses its cwd', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    await store.newTab('/a');
    const second = await store.newTab('/b');
    await store.newTab('/c');
    await store.restartTab(second!.id);
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith(second!.id);
    expect(store.tabs.value.map((tab) => tab.cwd)).toEqual(['/a', '/b', '/c']);
    const restarted = store.tabs.value[1]!;
    expect(restarted.id).not.toBe(second!.id);
    expect(store.activeTabId.value).toBe(restarted.id);
  });

  it('forwards the resolved ssh target on create and preserves it across restartTab', async () => {
    const { bridge } = makeBridge();
    let currentSsh: { host: string; identityFile?: string } | undefined = {
      host: 'dev',
      identityFile: '/home/u/.ssh/id_ed25519',
    };
    const store = createNativeTerminalStore(bridge, () => currentSsh);
    const tab = await store.newTab('/remote/app');
    expect(bridge.createNativeTerminal).toHaveBeenLastCalledWith({
      cwd: '/remote/app',
      cols: undefined,
      rows: undefined,
      ssh: { host: 'dev', identityFile: '/home/u/.ssh/id_ed25519' },
    });
    currentSsh = undefined;
    await store.restartTab(tab!.id);
    expect(bridge.createNativeTerminal).toHaveBeenLastCalledWith({
      cwd: '/remote/app',
      cols: undefined,
      rows: undefined,
      ssh: { host: 'dev', identityFile: '/home/u/.ssh/id_ed25519' },
    });
  });

  it('keeps the old tab and its selection when a restart spawn fails', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    const first = await store.newTab('/a');
    const second = await store.newTab('/b');
    vi.mocked(bridge.createNativeTerminal).mockRejectedValueOnce(new Error('spawn failed'));
    await store.restartTab(second!.id);
    expect(store.error.value).toBe('spawn failed');
    expect(store.tabs.value.map((tab) => tab.id)).toEqual([first!.id, second!.id]);
    expect(store.activeTabId.value).toBe(second!.id);
    expect(bridge.closeNativeTerminal).not.toHaveBeenCalled();
  });

  it('restart landing after the target was closed kills the replacement instead of splicing a neighbor', async () => {
    const { bridge, resolvers } = makeDeferredBridge();
    const store = createNativeTerminalStore(bridge);
    const firstPromise = store.newTab('/a');
    resolvers[0]!({ id: 't1', shell: 'zsh', cwd: '/a' });
    const first = await firstPromise;
    resolvers.length = 0;
    const restartPromise = store.restartTab(first!.id);
    store.closeTab(first!.id);
    resolvers[0]!({ id: 'replacement', shell: 'zsh', cwd: '/a' });
    await restartPromise;
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith('replacement');
    expect(store.tabs.value).toEqual([]);
  });

  it('write/resize only reach running tabs', async () => {
    const { bridge, emitExit } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    const tab = await store.newTab('/a');
    store.write(tab!.id, 'ls\n');
    store.resize(tab!.id, 120, 30);
    expect(bridge.nativeTerminalInput).toHaveBeenCalledWith(tab!.id, 'ls\n');
    expect(bridge.nativeTerminalResize).toHaveBeenCalledWith(tab!.id, 120, 30);
    emitExit(tab!.id, 0);
    store.write(tab!.id, 'nope');
    store.resize(tab!.id, 1, 1);
    store.write('unknown', 'nope');
    expect(bridge.nativeTerminalInput).toHaveBeenCalledTimes(1);
    expect(bridge.nativeTerminalResize).toHaveBeenCalledTimes(1);
  });

  it('ensureTab dedupes first-tab creation across rapid toggles', async () => {
    const { bridge, resolvers } = makeDeferredBridge();
    const store = createNativeTerminalStore(bridge);
    store.toggle('/work');
    store.closePanel();
    store.toggle('/work');
    store.ensureTab('/work');
    expect(bridge.createNativeTerminal).toHaveBeenCalledTimes(1);
    resolvers[0]!({ id: 't1', shell: 'zsh', cwd: '/work' });
    await vi.waitFor(() => expect(store.tabs.value).toHaveLength(1));
    store.ensureTab('/work');
    expect(bridge.createNativeTerminal).toHaveBeenCalledTimes(1);
  });

  it('keeps separate buckets per session and swaps them on switchSession', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    store.openPanel('/draft');
    await vi.waitFor(() => expect(store.tabs.value).toHaveLength(1));
    store.switchSession('session-a');
    expect(store.tabs.value).toEqual([]);
    expect(store.open.value).toBe(false);
    store.openPanel('/wa');
    await vi.waitFor(() => expect(store.tabs.value).toHaveLength(1));
    await store.newTab('/wa');
    expect(store.tabs.value).toHaveLength(2);
    store.switchSession('session-b');
    expect(store.tabs.value).toEqual([]);
    expect(store.open.value).toBe(false);
    expect(store.bucketsWithTabs.value.map((bucket) => bucket.key).sort()).toEqual([
      '__draft__',
      'session-a',
    ]);
    store.switchSession('session-a');
    expect(store.open.value).toBe(true);
    expect(store.tabs.value.map((tab) => tab.cwd)).toEqual(['/wa', '/wa']);
    store.switchSession(null);
    expect(store.open.value).toBe(true);
    expect(store.tabs.value.map((tab) => tab.cwd)).toEqual(['/draft']);
  });

  it('routes output by tab id across buckets', async () => {
    const { bridge, emitOutput } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    const draftTab = await store.newTab('/draft');
    store.switchSession('session-a');
    const aTab = await store.newTab('/wa');
    const seenDraft: string[] = [];
    const seenA: string[] = [];
    store.onOutput(draftTab!.id, (data) => seenDraft.push(data));
    store.onOutput(aTab!.id, (data) => seenA.push(data));
    emitOutput(draftTab!.id, 'bg');
    emitOutput(aTab!.id, 'fg');
    expect(seenDraft).toEqual(['bg']);
    expect(seenA).toEqual(['fg']);
  });

  it('a create resolving after its bucket was evicted is killed', async () => {
    const { bridge, resolvers } = makeDeferredBridge();
    const store = createNativeTerminalStore(bridge);
    store.openPanel('/draft');
    for (let i = 0; i < MAX_TERMINAL_SESSIONS; i += 1) {
      store.switchSession(`s${i}`);
      store.ensureTab(`/w${i}`);
      resolvers[i + 1]!({ id: `u${i}`, shell: 'zsh', cwd: `/w${i}` });
      await Promise.resolve();
    }
    expect(store.bucketsWithTabs.value.map((bucket) => bucket.key)).not.toContain('__draft__');
    resolvers[0]!({ id: 'stale', shell: 'zsh', cwd: '/draft' });
    await Promise.resolve();
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith('stale');
  });

  it('kills a create that resolves after its bucket was destroyed and recreated', async () => {
    const { bridge, resolvers } = makeDeferredBridge();
    const store = createNativeTerminalStore(bridge);
    store.openPanel('/draft');
    store.destroySession(store.currentKey.value);
    store.ensureTab('/work');
    resolvers[1]!({ id: 'fresh', shell: 'zsh', cwd: '/work' });
    await vi.waitFor(() => expect(store.tabs.value.map((tab) => tab.id)).toEqual(['fresh']));
    resolvers[0]!({ id: 'stale', shell: 'zsh', cwd: '/draft' });
    await Promise.resolve();
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith('stale');
    expect(store.tabs.value.map((tab) => tab.id)).toEqual(['fresh']);
  });

  it('does not evict running terminals when browsing sessions without using the terminal', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    const first = await store.newTab('/w');
    for (let i = 0; i < MAX_TERMINAL_SESSIONS + 2; i += 1) {
      store.switchSession(`s${i}`);
    }
    store.switchSession(null);
    expect(store.tabs.value.map((tab) => tab.id)).toEqual([first!.id]);
    expect(bridge.closeNativeTerminal).not.toHaveBeenCalled();
  });

  it('migrates draft terminals into the first created session', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    store.openPanel('/work');
    await vi.waitFor(() => expect(store.tabs.value).toHaveLength(1));
    store.migrateDraftTo('__draft__', 'new-session');
    store.switchSession('new-session');
    expect(store.currentKey.value).toBe('new-session');
    expect(store.open.value).toBe(true);
    expect(store.tabs.value.map((tab) => tab.cwd)).toEqual(['/work']);
    store.switchSession(null);
    expect(store.tabs.value).toEqual([]);
    expect(store.open.value).toBe(false);
  });

  it('migration re-keys the bucket, so an in-flight create lands in the new session', async () => {
    const { bridge, resolvers } = makeDeferredBridge();
    const store = createNativeTerminalStore(bridge);
    store.openPanel('/work');
    store.migrateDraftTo('__draft__', 'new-session');
    store.switchSession('new-session');
    resolvers[0]!({ id: 't1', shell: 'zsh', cwd: '/work' });
    await vi.waitFor(() => expect(store.tabs.value).toHaveLength(1));
    expect(store.currentKey.value).toBe('new-session');
    expect(store.tabs.value[0]!.id).toBe('t1');
    expect(bridge.closeNativeTerminal).not.toHaveBeenCalled();
  });

  it('merges draft terminals into a session that already has a bucket', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    store.switchSession('session-a');
    const own = await store.newTab('/wa');
    store.switchSession(null);
    const draftTab = await store.newTab('/draft');
    store.migrateDraftTo('__draft__', 'session-a');
    expect(bridge.closeNativeTerminal).not.toHaveBeenCalled();
    store.switchSession('session-a');
    expect(store.tabs.value.map((tab) => tab.id)).toEqual([own!.id, draftTab!.id]);
    expect(store.activeTabId.value).toBe(own!.id);
    store.switchSession(null);
    expect(store.tabs.value).toEqual([]);
  });

  it('keeps both in-flight creates when merging into an existing bucket', async () => {
    const { bridge, resolvers } = makeDeferredBridge();
    const store = createNativeTerminalStore(bridge);
    store.openPanel('/draft');
    store.switchSession('new-session');
    store.ensureTab('/w');
    store.migrateDraftTo('__draft__', 'new-session');
    resolvers[0]!({ id: 'd1', shell: 'zsh', cwd: '/draft' });
    resolvers[1]!({ id: 't1', shell: 'zsh', cwd: '/w' });
    await vi.waitFor(() => expect(store.tabs.value).toHaveLength(2));
    expect(store.tabs.value.map((tab) => tab.id).sort()).toEqual(['d1', 't1']);
    expect(bridge.closeNativeTerminal).not.toHaveBeenCalled();
  });

  it('stays deduped until every inherited in-flight create settles', async () => {
    const { bridge, resolvers } = makeDeferredBridge();
    const store = createNativeTerminalStore(bridge);
    store.openPanel('/draft');
    store.switchSession('new-session');
    store.ensureTab('/w');
    store.migrateDraftTo('__draft__', 'new-session');
    store.ensureTab('/w');
    expect(bridge.createNativeTerminal).toHaveBeenCalledTimes(2);
    resolvers[0]!({ id: 'd1', shell: 'zsh', cwd: '/draft' });
    await Promise.resolve();
    store.ensureTab('/w');
    expect(bridge.createNativeTerminal).toHaveBeenCalledTimes(2);
    resolvers[1]!({ id: 't1', shell: 'zsh', cwd: '/w' });
    await vi.waitFor(() => expect(store.tabs.value).toHaveLength(2));
  });

  it('re-arms a guard adopted from the dropped bucket so it clears on settle', async () => {
    const { bridge, resolvers } = makeDeferredBridge();
    const store = createNativeTerminalStore(bridge);
    store.openPanel('/draft');
    resolvers[0]!({ id: 'd1', shell: 'zsh', cwd: '/draft' });
    await vi.waitFor(() => expect(store.tabs.value).toHaveLength(1));
    store.switchSession('new-session');
    store.ensureTab('/w');
    store.migrateDraftTo('__draft__', 'new-session');
    resolvers[1]!({ id: 't1', shell: 'zsh', cwd: '/w' });
    await vi.waitFor(() => expect(store.tabs.value).toHaveLength(2));
    for (const id of ['d1', 't1']) store.closeTab(id);
    store.ensureTab('/w');
    expect(bridge.createNativeTerminal).toHaveBeenCalledTimes(3);
  });

  it('destroySession kills the bucket PTYs and removes it', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    const tab = await store.newTab('/w');
    store.destroySession(store.currentKey.value);
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith(tab!.id);
    expect(store.tabs.value).toEqual([]);
    expect(store.bucketsWithTabs.value).toEqual([]);
  });

  it('evicts the least-recently-used session bucket beyond the cap and kills its PTYs', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    const first = await store.newTab('/draft');
    for (let i = 0; i < MAX_TERMINAL_SESSIONS; i += 1) {
      store.switchSession(`s${i}`);
      store.openPanel(`/w${i}`);
      await vi.waitFor(() => expect(store.tabs.value).toHaveLength(1), {
        timeout: 2000,
      });
    }
    expect(store.bucketsWithTabs.value.map((bucket) => bucket.key)).not.toContain('__draft__');
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith(first!.id);
    expect(store.currentKey.value).toBe(`s${MAX_TERMINAL_SESSIONS - 1}`);
    expect(store.tabs.value).toHaveLength(1);
  });

  it('a just-used session is not the next eviction victim', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    for (let i = 0; i < MAX_TERMINAL_SESSIONS + 2; i += 1) {
      store.switchSession(`s${i}`);
      store.openPanel(`/w${i}`);
      await vi.waitFor(() => expect(store.tabs.value).toHaveLength(1));
    }
    const expected = Array.from({ length: MAX_TERMINAL_SESSIONS - 2 }, (_, i) => `s${i + 2}`);
    expected.push(`s${MAX_TERMINAL_SESSIONS}`, `s${MAX_TERMINAL_SESSIONS + 1}`);
    expect(store.bucketsWithTabs.value.map((bucket) => bucket.key)).toEqual(expected);
  });

  it('empty buckets do not count against the LRU cap', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    const first = await store.newTab('/draft');
    for (let i = 0; i < MAX_TERMINAL_SESSIONS + 3; i += 1) {
      store.switchSession(`s${i}`);
      const tab = await store.newTab(`/w${i}`);
      store.closeTab(tab!.id);
    }
    store.switchSession(null);
    expect(store.tabs.value.map((tab) => tab.id)).toEqual([first!.id]);
    expect(bridge.closeNativeTerminal).toHaveBeenCalledTimes(MAX_TERMINAL_SESSIONS + 3);
  });
});

describe('panel (right-sidebar) tabs', () => {
  it('spawns an independent PTY in the current bucket without touching the bottom strip', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    store.openPanel('/work');
    await vi.waitFor(() => expect(store.tabs.value).toHaveLength(1));
    const { tab: pty } = await store.newPanelTab('/work');
    expect(pty).toMatchObject({ id: 't2', shell: 'zsh', cwd: '/work', status: 'running' });
    expect(store.tabs.value.map((tab) => tab.id)).toEqual(['t1']);
    expect(store.activeTabId.value).toBe('t1');
    expect(store.open.value).toBe(true);
    expect(store.panelTabOf('t2')).toMatchObject({ id: 't2', status: 'running' });
  });

  it('closePanelTab kills the PTY and leaves the bottom strip alone', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    store.openPanel('/work');
    await vi.waitFor(() => expect(store.tabs.value).toHaveLength(1));
    const { tab: pty } = await store.newPanelTab('/work');
    store.closePanelTab(pty!.id);
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith(pty!.id);
    expect(store.panelTabOf(pty!.id)).toBeUndefined();
    expect(store.tabs.value).toHaveLength(1);
    expect(store.activeTabId.value).toBe('t1');
    store.closePanelTab(pty!.id);
    expect(bridge.closeNativeTerminal).toHaveBeenCalledTimes(1);
  });

  it('closePanelTab finds the PTY after the store switched buckets', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    const { tab: pty } = await store.newPanelTab('/draft');
    store.switchSession('session-a');
    store.closePanelTab(pty!.id);
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith(pty!.id);
    expect(store.panelTabOf(pty!.id)).toBeUndefined();
  });

  it('routes output, exit, write and resize by id to panel tabs', async () => {
    const { bridge, emitOutput, emitExit } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    const { tab: pty } = await store.newPanelTab('/work');
    const seen: string[] = [];
    store.onOutput(pty!.id, (data) => seen.push(data));
    emitOutput(pty!.id, 'hello');
    expect(seen).toEqual(['hello']);
    store.write(pty!.id, 'ls\n');
    store.resize(pty!.id, 100, 40);
    expect(bridge.nativeTerminalInput).toHaveBeenCalledWith(pty!.id, 'ls\n');
    expect(bridge.nativeTerminalResize).toHaveBeenCalledWith(pty!.id, 100, 40);
    const exits: Array<number | null> = [];
    store.onExit(pty!.id, (code) => exits.push(code));
    emitExit(pty!.id, 2);
    expect(exits).toEqual([2]);
    expect(store.panelTabOf(pty!.id)).toMatchObject({ status: 'exited', exitCode: 2 });
    store.write(pty!.id, 'nope');
    expect(bridge.nativeTerminalInput).toHaveBeenCalledTimes(1);
  });

  it('destroySession kills the bucket panel PTYs too', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    const bottom = await store.newTab('/w');
    const { tab: panel } = await store.newPanelTab('/w');
    store.destroySession(store.currentKey.value);
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith(bottom!.id);
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith(panel!.id);
    expect(store.panelTabOf(panel!.id)).toBeUndefined();
  });

  it('a bucket with only panel tabs counts as live for the LRU cap', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    const { tab: pty } = await store.newPanelTab('/draft');
    for (let i = 0; i < MAX_TERMINAL_SESSIONS; i += 1) {
      store.switchSession(`s${i}`);
      store.openPanel(`/w${i}`);
      await vi.waitFor(() => expect(store.tabs.value).toHaveLength(1), {
        timeout: 2000,
      });
    }
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith(pty!.id);
    expect(store.panelTabOf(pty!.id)).toBeUndefined();
  });

  it('migrates draft panel tabs into the first created session', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    const { tab: pty } = await store.newPanelTab('/draft');
    store.migrateDraftTo('__draft__', 'new-session');
    store.switchSession('new-session');
    expect(store.panelTabOf(pty!.id)).toBeDefined();
    expect(bridge.closeNativeTerminal).not.toHaveBeenCalled();
  });

  it('merges draft panel tabs into a session that already has some', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    store.switchSession('session-a');
    const { tab: own } = await store.newPanelTab('/wa');
    store.switchSession(null);
    const { tab: draft } = await store.newPanelTab('/draft');
    store.migrateDraftTo('__draft__', 'session-a');
    expect(bridge.closeNativeTerminal).not.toHaveBeenCalled();
    expect(store.panelTabOf(own!.id)).toBeDefined();
    expect(store.panelTabOf(draft!.id)).toBeDefined();
  });

  it('kills a panel create that resolves after its bucket was destroyed', async () => {
    const { bridge, resolvers } = makeDeferredBridge();
    const store = createNativeTerminalStore(bridge);
    void store.newPanelTab('/draft');
    store.destroySession(store.currentKey.value);
    resolvers[0]!({ id: 'stale', shell: 'zsh', cwd: '/draft' });
    await Promise.resolve();
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith('stale');
    expect(store.panelTabOf('stale')).toBeUndefined();
  });

  it('an in-flight panel spawn re-keys an otherwise empty draft bucket on promotion', async () => {
    const { bridge, resolvers } = makeDeferredBridge();
    const store = createNativeTerminalStore(bridge);
    const pending = store.newPanelTab('/draft');
    store.migrateDraftTo('__draft__', 'new-session');
    resolvers[0]!({ id: 'pty-late', shell: 'zsh', cwd: '/draft' });
    const { tab } = await pending;

    expect(tab?.id).toBe('pty-late');
    expect(bridge.closeNativeTerminal).not.toHaveBeenCalled();
    expect(store.panelTabOf('pty-late')).toBeDefined();
    store.destroySession('new-session');
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith('pty-late');
  });

  it('an in-flight panel spawn does not suppress the bottom first-tab dedup', async () => {
    const { bridge, resolvers } = makeDeferredBridge();
    const store = createNativeTerminalStore(bridge);
    void store.newPanelTab('/draft');
    store.openPanel('/draft');
    resolvers[0]!({ id: 'pty-panel', shell: 'zsh', cwd: '/draft' });
    resolvers[1]!({ id: 'pty-bottom', shell: 'zsh', cwd: '/draft' });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.panelTabOf('pty-panel')).toBeDefined();
    expect(store.tabs.value.map((tab) => tab.id)).toEqual(['pty-bottom']);
    expect(store.open.value).toBe(true);
  });

  it('a stillValid veto kills the PTY before it joins the bucket', async () => {
    const { bridge, resolvers } = makeDeferredBridge();
    const store = createNativeTerminalStore(bridge);
    let valid = true;
    const pending = store.newPanelTab('/draft', undefined, { stillValid: () => valid });
    valid = false;
    resolvers[0]!({ id: 'pty-stale', shell: 'zsh', cwd: '/draft' });
    const { tab } = await pending;

    expect(tab).toBeNull();
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith('pty-stale');
    expect(store.panelTabOf('pty-stale')).toBeUndefined();
  });

  it('a panel spawn failure reports to its caller and leaves the bottom panel’s error alone', async () => {
    const { bridge } = makeBridge({
      createNativeTerminal: vi.fn(async () => Promise.reject(new Error('spawn failed'))),
    });
    const store = createNativeTerminalStore(bridge);
    const { tab, error } = await store.newPanelTab('/work');
    expect(tab).toBeNull();
    expect(error).toBe('spawn failed');
    expect(store.error.value).toBeNull();
  });
});


it('updates program names for both dock and panel terminals without changing selection', async () => {
  const inspectNativeTerminals = vi.fn(async (ids: string[]) => ids.map(id => ({
    id, state: 'busy' as const, binary: 'node', cwd: '/work', processes: [{ pid: 42, binary: 'node' }],
  })));
  const { bridge } = makeBridge({ inspectNativeTerminals });
  const store = createNativeTerminalStore(bridge);
  const dock = await store.newTab('/work');
  const panel = await store.newPanelTab('/work');
  expect(store.allTabs.value).toHaveLength(2);
  await store.inspect(store.allTabs.value.map(tab => tab.id));
  expect(store.tabs.value[0]?.binary).toBe('node');
  expect(store.panelTabOf(panel.tab!.id)?.binary).toBe('node');
  expect(store.activeTabId.value).toBe(dock?.id);
});

it('keeps the tail of background output and reports truncation on replay', async () => {
  const { bridge, emitOutput } = makeBridge();
  const store = createNativeTerminalStore(bridge);
  const { tab } = await store.newPanelTab('/work');
  const unsubscribe = store.onOutput(tab!.id, () => {});
  unsubscribe();
  for (let index = 0; index < 1100; index += 1) emitOutput(tab!.id, `line-${index}\r\n`);
  emitOutput(tab!.id, 'final error');
  const seen: string[] = [];
  const truncated: boolean[] = [];
  store.onOutput(tab!.id, (data, cut) => { seen.push(data); if (cut) truncated.push(cut); });
  expect(truncated).toEqual([true]);
  expect(seen.join('')).not.toContain('line-0\r\n');
  expect(seen.join('')).toContain('line-1099\r\n');
  expect(seen.at(-1)).toBe('final error');
  const second = vi.fn();
  store.onOutput(tab!.id, second);
  expect(second).not.toHaveBeenCalled();
});

it('bounds the size of a single oversized background chunk', async () => {
  const { bridge, emitOutput } = makeBridge();
  const store = createNativeTerminalStore(bridge);
  const { tab } = await store.newPanelTab('/work');
  emitOutput(tab!.id, 'x'.repeat(1024 * 1024) + 'last');
  const seen: string[] = [];
  store.onOutput(tab!.id, data => seen.push(data));
  expect(seen.join('').length).toBeLessThanOrEqual(256 * 1024);
  expect(seen.join('').endsWith('last')).toBe(true);
});
