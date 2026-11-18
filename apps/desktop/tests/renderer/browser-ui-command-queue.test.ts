import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import { createBrowserUiCommandQueue, createBrowserUiRequestTracker } from '../../src/renderer/lib/browserUiCommandQueue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('browser UI command queue', () => {
  it('reports each control change before the next command in the session mutates it', async () => {
    const enqueue = createBrowserUiCommandQueue();
    let controlled: string | null = null;
    const createTab = (tabId: string) => enqueue('session-1', async () => {
      controlled = tabId;
      await nextTick();
      return controlled;
    });
    await expect(Promise.all([createTab('tab-1'), createTab('tab-2')])).resolves.toEqual(['tab-1', 'tab-2']);
  });

  it('runs commands for different sessions independently', async () => {
    const enqueue = createBrowserUiCommandQueue();
    const blocker = deferred();
    const events: string[] = [];
    const slow = enqueue('session-1', async () => { await blocker.promise; events.push('session-1'); });
    await enqueue('session-2', async () => { events.push('session-2'); });
    expect(events).toEqual(['session-2']);
    blocker.resolve();
    await slow;
    expect(events).toEqual(['session-2', 'session-1']);
  });

  it('keeps running later commands after one fails', async () => {
    const enqueue = createBrowserUiCommandQueue();
    const failing = enqueue('session-1', async () => { throw new Error('rejected'); });
    const next = enqueue('session-1', async () => 'next');
    await expect(failing).rejects.toThrow('rejected');
    await expect(next).resolves.toBe('next');
  });

  it('skips a queued command once its request is cancelled', async () => {
    const enqueue = createBrowserUiCommandQueue();
    const requests = createBrowserUiRequestTracker();
    const blocker = deferred();
    const closed: number[] = [];
    const run = (requestId: number, work: () => Promise<void>) => {
      requests.accept(requestId);
      return enqueue('session-1', async () => {
        if (!requests.isLive(requestId)) return;
        try { await work(); } finally { requests.cancel(requestId); }
      });
    };
    const first = run(1, () => blocker.promise);
    const second = run(2, async () => { closed.push(2); });
    requests.cancel(2);
    requests.cancel(99);
    blocker.resolve();
    await Promise.all([first, second]);
    expect(closed).toEqual([]);
    expect(requests.isLive(1)).toBe(false);
    expect(requests.isLive(99)).toBe(false);
  });
});
