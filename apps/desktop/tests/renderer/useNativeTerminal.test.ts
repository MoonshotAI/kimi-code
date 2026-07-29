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
  it('is an inert no-op without a bridge', async () => {
    const store = createNativeTerminalStore(undefined);
    expect(store.available).toBe(false);
    store.toggle('/work');
    expect(store.open.value).toBe(true); // panel flag still flips (local only)
    expect(store.tabs.value).toEqual([]); // …but nothing spawns
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
    store.toggle('/work'); // open → in-flight create
    store.closePanel();
    store.toggle('/work'); // reopen while the first create is still pending
    store.ensureTab('/work');
    expect(bridge.createNativeTerminal).toHaveBeenCalledTimes(1);
    resolvers[0]!({ id: 't1', shell: 'zsh', cwd: '/work' });
    await vi.waitFor(() => expect(store.tabs.value).toHaveLength(1));
    store.ensureTab('/work');
    expect(bridge.createNativeTerminal).toHaveBeenCalledTimes(1);
  });

  // --- per-session buckets ------------------------------------------------

  it('keeps separate buckets per session and swaps them on switchSession', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    // Draft session: one tab, panel open.
    store.openPanel('/draft');
    await vi.waitFor(() => expect(store.tabs.value).toHaveLength(1));
    // Session A: two tabs.
    store.switchSession('session-a');
    expect(store.tabs.value).toEqual([]);
    expect(store.open.value).toBe(false);
    store.openPanel('/wa');
    await vi.waitFor(() => expect(store.tabs.value).toHaveLength(1));
    await store.newTab('/wa');
    expect(store.tabs.value).toHaveLength(2);
    // Session B: empty, closed.
    store.switchSession('session-b');
    expect(store.tabs.value).toEqual([]);
    expect(store.open.value).toBe(false);
    expect(store.bucketsWithTabs.value.map((bucket) => bucket.key).sort()).toEqual([
      '__draft__',
      'session-a',
    ]);
    // Back to A: its two tabs and open flag are exactly as left.
    store.switchSession('session-a');
    expect(store.open.value).toBe(true);
    expect(store.tabs.value.map((tab) => tab.cwd)).toEqual(['/wa', '/wa']);
    // And the draft bucket is untouched.
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
    emitOutput(draftTab!.id, 'bg'); // hidden session still receives (its view stays mounted)
    emitOutput(aTab!.id, 'fg');
    expect(seenDraft).toEqual(['bg']);
    expect(seenA).toEqual(['fg']);
  });

  it('a create resolving after its bucket was evicted is killed', async () => {
    const { bridge, resolvers } = makeDeferredBridge();
    const store = createNativeTerminalStore(bridge);
    store.openPanel('/draft'); // in-flight create in the draft bucket
    // Fill the LRU with other sessions that actually use the terminal —
    // buckets only come to exist on use, so mere browsing must not evict.
    for (let i = 0; i < MAX_TERMINAL_SESSIONS; i += 1) {
      store.switchSession(`s${i}`);
      store.ensureTab(`/w${i}`);
      resolvers[i + 1]!({ id: `u${i}`, shell: 'zsh', cwd: `/w${i}` });
      await Promise.resolve();
    }
    expect(store.bucketsWithTabs.value.map((bucket) => bucket.key)).not.toContain('__draft__');
    // Draft create resolves after eviction → killed, never shown.
    resolvers[0]!({ id: 'stale', shell: 'zsh', cwd: '/draft' });
    await Promise.resolve();
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith('stale');
  });

  it('kills a create that resolves after its bucket was destroyed and recreated', async () => {
    const { bridge, resolvers } = makeDeferredBridge();
    const store = createNativeTerminalStore(bridge);
    store.openPanel('/draft'); // call 1 pends
    store.destroySession(store.currentKey.value);
    store.ensureTab('/work'); // call 2 pends — a fresh bucket under the same key
    resolvers[1]!({ id: 'fresh', shell: 'zsh', cwd: '/work' });
    await vi.waitFor(() => expect(store.tabs.value.map((tab) => tab.id)).toEqual(['fresh']));
    // The destroyed bucket's late create must NOT land in the replacement.
    resolvers[0]!({ id: 'stale', shell: 'zsh', cwd: '/draft' });
    await Promise.resolve();
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith('stale');
    expect(store.tabs.value.map((tab) => tab.id)).toEqual(['fresh']);
  });

  it('does not evict running terminals when browsing sessions without using the terminal', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    const first = await store.newTab('/w');
    // Browsing creates no buckets — the running draft terminal survives any
    // number of drive-by switches.
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
    // The shell carries over instead of collapsing into an empty bucket.
    expect(store.currentKey.value).toBe('new-session');
    expect(store.open.value).toBe(true);
    expect(store.tabs.value.map((tab) => tab.cwd)).toEqual(['/work']);
    // Draft is empty again for the next new-chat flow.
    store.switchSession(null);
    expect(store.tabs.value).toEqual([]);
    expect(store.open.value).toBe(false);
  });

  it('migration re-keys the bucket, so an in-flight create lands in the new session', async () => {
    const { bridge, resolvers } = makeDeferredBridge();
    const store = createNativeTerminalStore(bridge);
    store.openPanel('/work'); // first create still spawning
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
    // The user opened a terminal in the create window, so the new session
    // owns a bucket before migration runs — merging must not abandon the
    // draft's PTYs under the stale key.
    store.switchSession('session-a');
    const own = await store.newTab('/wa');
    store.switchSession(null);
    const draftTab = await store.newTab('/draft');
    store.migrateDraftTo('__draft__', 'session-a');
    expect(bridge.closeNativeTerminal).not.toHaveBeenCalled();
    store.switchSession('session-a');
    expect(store.tabs.value.map((tab) => tab.id)).toEqual([own!.id, draftTab!.id]);
    // The pre-existing bucket keeps its own active tab.
    expect(store.activeTabId.value).toBe(own!.id);
    // The draft key is free again for the next new-chat flow.
    store.switchSession(null);
    expect(store.tabs.value).toEqual([]);
  });

  it('keeps both in-flight creates when merging into an existing bucket', async () => {
    const { bridge, resolvers } = makeDeferredBridge();
    const store = createNativeTerminalStore(bridge);
    store.openPanel('/draft'); // draft's first spawn still in flight
    store.switchSession('new-session');
    store.ensureTab('/w'); // target bucket's own spawn in flight too
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
    store.openPanel('/draft'); // draft spawn pending (call 1)
    store.switchSession('new-session');
    store.ensureTab('/w'); // target spawn pending (call 2)
    store.migrateDraftTo('__draft__', 'new-session');
    // Both inherited creates are still pending — no third spawn.
    store.ensureTab('/w');
    expect(bridge.createNativeTerminal).toHaveBeenCalledTimes(2);
    resolvers[0]!({ id: 'd1', shell: 'zsh', cwd: '/draft' });
    await Promise.resolve();
    // One tab landed but the other spawn is still in flight.
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
    store.ensureTab('/w'); // only the target has an in-flight create
    store.migrateDraftTo('__draft__', 'new-session');
    resolvers[1]!({ id: 't1', shell: 'zsh', cwd: '/w' });
    await vi.waitFor(() => expect(store.tabs.value).toHaveLength(2));
    // The adopted guard cleared on settle: with every tab closed, the next
    // ensureTab spawns again instead of staying blocked forever.
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
    // Open terminals in MAX_TERMINAL_SESSIONS more sessions → draft must go.
    for (let i = 0; i < MAX_TERMINAL_SESSIONS; i += 1) {
      store.switchSession(`s${i}`);
      store.openPanel(`/w${i}`);
      await vi.waitFor(() => expect(store.tabs.value).toHaveLength(1), {
        timeout: 2000,
      });
    }
    expect(store.bucketsWithTabs.value.map((bucket) => bucket.key)).not.toContain('__draft__');
    expect(bridge.closeNativeTerminal).toHaveBeenCalledWith(first!.id);
    // The most recent one is still intact.
    expect(store.currentKey.value).toBe(`s${MAX_TERMINAL_SESSIONS - 1}`);
    expect(store.tabs.value).toHaveLength(1);
  });

  it('a just-used session is not the next eviction victim', async () => {
    const { bridge } = makeBridge();
    const store = createNativeTerminalStore(bridge);
    // Walk past the cap one session at a time: each eviction must take the
    // OLDEST survivor — a freshly used bucket (unstamped before first use
    // was timestamped) must never be sacrificed instead.
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
    // Pile up EMPTY buckets (each had a tab once, all closed since).
    for (let i = 0; i < MAX_TERMINAL_SESSIONS + 3; i += 1) {
      store.switchSession(`s${i}`);
      const tab = await store.newTab(`/w${i}`);
      store.closeTab(tab!.id);
    }
    store.switchSession(null);
    // Only the draft still owns a terminal — nothing may be evicted.
    expect(store.tabs.value.map((tab) => tab.id)).toEqual([first!.id]);
    expect(bridge.closeNativeTerminal).toHaveBeenCalledTimes(MAX_TERMINAL_SESSIONS + 3);
  });
});
