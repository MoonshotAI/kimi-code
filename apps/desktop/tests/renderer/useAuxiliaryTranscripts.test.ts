import { describe, expect, it, vi } from 'vitest';
import type { KimiEventConnection, KimiWebApi } from '@moonshot-ai/app-core/api';

import { createAuxiliaryTranscriptPool } from '../../src/renderer/composables/client/useAuxiliaryTranscripts';

describe('createAuxiliaryTranscriptPool', () => {
  it('loads the cold baseline before subscribing and switches agents with one replacement', async () => {
    const subscribeTranscript = vi.fn();
    const unsubscribeTranscript = vi.fn();
    const getSessionTranscript = vi.fn(
      async (_sessionId: string, query: { agentId: string }) => page(query.agentId),
    );
    const pool = createAuxiliaryTranscriptPool({
      api: { getSessionTranscript } as unknown as KimiWebApi,
      connectEventsIfNeeded: vi.fn(),
      getEventConnection: () =>
        ({ subscribeTranscript, unsubscribeTranscript }) as unknown as KimiEventConnection,
    });

    pool.activate('s1', 'agent-a');
    expect(subscribeTranscript).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(subscribeTranscript).toHaveBeenCalledWith('s1', 'agent-a', 3);
    });

    subscribeTranscript.mockClear();
    pool.activate('s1', 'agent-b');
    await vi.waitFor(() => {
      expect(subscribeTranscript).toHaveBeenCalledWith('s1', 'agent-b', 3);
    });
    expect(subscribeTranscript).toHaveBeenCalledTimes(1);
    expect(unsubscribeTranscript).not.toHaveBeenCalled();

    pool.deactivate('s1', 'agent-b');
    expect(unsubscribeTranscript).toHaveBeenCalledWith('s1', ['agent-b']);
  });

  it('does not subscribe after a cold load finishes for a panel that was closed', async () => {
    let finishLoad: ((value: ReturnType<typeof page>) => void) | undefined;
    const loading = new Promise<ReturnType<typeof page>>((resolve) => {
      finishLoad = resolve;
    });
    const subscribeTranscript = vi.fn();
    const pool = createAuxiliaryTranscriptPool({
      api: {
        getSessionTranscript: vi.fn().mockReturnValue(loading),
      } as unknown as KimiWebApi,
      connectEventsIfNeeded: vi.fn(),
      getEventConnection: () =>
        ({ subscribeTranscript, unsubscribeTranscript: vi.fn() }) as unknown as KimiEventConnection,
    });

    pool.activate('s1', 'agent-a');
    pool.deactivate('s1', 'agent-a');
    finishLoad?.(page('agent-a'));
    await loading;
    await Promise.resolve();

    expect(subscribeTranscript).not.toHaveBeenCalled();
  });

  it('detaches the actually subscribed agent when a cold switch is closed', async () => {
    let finishSecondLoad: ((value: ReturnType<typeof page>) => void) | undefined;
    const secondLoad = new Promise<ReturnType<typeof page>>((resolve) => {
      finishSecondLoad = resolve;
    });
    const subscribeTranscript = vi.fn();
    const unsubscribeTranscript = vi.fn();
    const pool = createAuxiliaryTranscriptPool({
      api: {
        getSessionTranscript: vi.fn(
          async (_sessionId: string, query: { agentId: string }) =>
            query.agentId === 'agent-a' ? page('agent-a') : secondLoad,
        ),
      } as unknown as KimiWebApi,
      connectEventsIfNeeded: vi.fn(),
      getEventConnection: () =>
        ({ subscribeTranscript, unsubscribeTranscript }) as unknown as KimiEventConnection,
    });

    pool.activate('s1', 'agent-a');
    await vi.waitFor(() => {
      expect(subscribeTranscript).toHaveBeenCalledWith('s1', 'agent-a', 3);
    });

    subscribeTranscript.mockClear();
    pool.activate('s1', 'agent-b');
    pool.deactivate('s1', 'agent-b');

    expect(unsubscribeTranscript).toHaveBeenCalledWith('s1', ['agent-a']);
    finishSecondLoad?.(page('agent-b'));
    await secondLoad;
    await Promise.resolve();
    expect(subscribeTranscript).not.toHaveBeenCalled();
  });

  it('detaches and forgets transcript state when a session is evicted', async () => {
    const unsubscribeTranscript = vi.fn();
    const pool = createAuxiliaryTranscriptPool({
      api: {
        getSessionTranscript: vi.fn().mockResolvedValue(page('agent-a')),
      } as unknown as KimiWebApi,
      connectEventsIfNeeded: vi.fn(),
      getEventConnection: () =>
        ({ subscribeTranscript: vi.fn(), unsubscribeTranscript }) as unknown as KimiEventConnection,
    });

    pool.activate('s1', 'agent-a');
    await vi.waitFor(() => expect(pool.getEntry('s1', 'agent-a')?.baselineLoaded).toBe(true));
    pool.forgetSession('s1');
    pool.receiveReset('s1', 'agent-a', page('agent-a'), 4);

    expect(unsubscribeTranscript).toHaveBeenCalledWith('s1');
    expect(pool.getEntry('s1', 'agent-a')).toBeUndefined();
  });

  it('rejects a sequence gap so the socket keeps its last accepted cursor', async () => {
    const pool = createAuxiliaryTranscriptPool({
      api: {
        getSessionTranscript: vi.fn().mockResolvedValue(page('agent-a')),
      } as unknown as KimiWebApi,
      connectEventsIfNeeded: vi.fn(),
      getEventConnection: () => null,
    });
    const entry = pool.activate('s1', 'agent-a');
    await vi.waitFor(() => expect(entry.baselineLoaded).toBe(true));

    const accepted = pool.applyOps(
      's1',
      'agent-a',
      [{ op: 'meta.merge', meta: { activity: 'turn' } }],
      5,
    );

    expect(accepted).toBe(false);
    expect(entry.channel.seq).toBe(3);
  });

  it('coalesces change notifications into one version bump per frame', async () => {
    const pool = createAuxiliaryTranscriptPool({
      api: {
        getSessionTranscript: vi.fn().mockResolvedValue(page('agent-a')),
      } as unknown as KimiWebApi,
      connectEventsIfNeeded: vi.fn(),
      getEventConnection: () => null,
    });
    const entry = pool.activate('s1', 'agent-a');
    await vi.waitFor(() => expect(entry.baselineLoaded).toBe(true));
    // Let the baseline load's own scheduled notification settle first.
    await vi.waitFor(() => expect(entry.version.value).toBeGreaterThan(0));
    const before = entry.version.value;

    pool.applyOps('s1', 'agent-a', [{ op: 'meta.merge', meta: { activity: 'turn' } }], 4);
    pool.applyOps('s1', 'agent-a', [{ op: 'meta.merge', meta: { activity: 'idle' } }], 5);
    expect(entry.version.value).toBe(before);

    await vi.waitFor(() => expect(entry.version.value).toBe(before + 1));
  });

  it('coalesces change notifications on the animation frame when rAF is available', async () => {
    const pending = new Map<number, (time: number) => void>();
    let nextHandle = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => {
      const handle = ++nextHandle;
      pending.set(handle, cb);
      return handle;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      pending.delete(handle);
    });
    const runFrame = (): void => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const cb of callbacks) cb(0);
    };
    try {
      const pool = createAuxiliaryTranscriptPool({
        api: {
          getSessionTranscript: vi.fn().mockResolvedValue(page('agent-a')),
        } as unknown as KimiWebApi,
        connectEventsIfNeeded: vi.fn(),
        getEventConnection: () => null,
      });
      const entry = pool.activate('s1', 'agent-a');
      await vi.waitFor(() => expect(entry.baselineLoaded).toBe(true));
      runFrame();
      const before = entry.version.value;
      expect(before).toBeGreaterThan(0);

      pool.applyOps('s1', 'agent-a', [{ op: 'meta.merge', meta: { activity: 'turn' } }], 4);
      pool.applyOps('s1', 'agent-a', [{ op: 'meta.merge', meta: { activity: 'idle' } }], 5);
      expect(entry.version.value).toBe(before);

      runFrame();
      expect(entry.version.value).toBe(before + 1);

      // The frame flush cancels the hidden-tab fallback: no later second bump.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(entry.version.value).toBe(before + 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function page(agentId: string) {
  return {
    agentId,
    items: [],
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
    hasMoreOlder: false,
    agents: [],
    pendingInteractions: [],
    seq: 3,
  };
}
