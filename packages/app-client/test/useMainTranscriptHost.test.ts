import { describe, expect, it, vi } from 'vitest';
import type { KimiEventConnection, KimiWebApi } from '@moonshot-ai/app-core/api';

import { createMainTranscriptHost } from '../src/composables/useMainTranscriptHost';

function makeHost() {
  const reconnect = vi.fn();
  const health = vi.fn(() => ({ connected: true, open: true, stale: false }));
  const connection = {
    subscribeTranscript: vi.fn(),
    unsubscribeTranscript: vi.fn(),
    health,
    reconnect,
    close: vi.fn(),
  } as unknown as KimiEventConnection;
  const api = {
    connectTranscriptChannel: vi.fn(() => connection),
    getSessionTranscript: vi.fn(async () => ({
      items: [],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: { activity: 'idle' },
      hasMoreOlder: false,
      seq: 3,
      agentId: 'main',
    })),
  } as unknown as KimiWebApi;
  const host = createMainTranscriptHost({ api });
  return { host, health, reconnect };
}

describe('createMainTranscriptHost', () => {
  it('drops the entry and reports when the first transcript read fails', async () => {
    // A failed FIRST read must not hang the baseline waiter: the entry is
    // dropped (the waiter resolves on a missing entry, so sessionLoading
    // ends) and the failure is surfaced for the facade to toast — the next
    // activate retries with a fresh entry.
    const onBaselineError = vi.fn();
    const connection = {
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      health: vi.fn(() => ({ connected: true, open: true, stale: false })),
      close: vi.fn(),
    } as unknown as KimiEventConnection;
    const api = {
      connectTranscriptChannel: vi.fn(() => connection),
      getSessionTranscript: vi.fn(async () => {
        throw new Error('network down');
      }),
    } as unknown as KimiWebApi;
    const host = createMainTranscriptHost({ api, onBaselineError });

    host.activate('s1');
    await vi.waitFor(() =>
      expect(onBaselineError).toHaveBeenCalledWith('s1', expect.any(Error)),
    );
    expect(host.pool.getEntry('s1')).toBeUndefined();
  });

  it('keeps a re-created entry when the evicted request fails late', async () => {
    // The first read is still in flight when the entry is evicted and the
    // session re-activated (a NEW entry): the OLD request failing afterwards
    // must not delete the new one — its own read may still succeed.
    const onBaselineError = vi.fn();
    const connection = {
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      health: vi.fn(() => ({ connected: true, open: true, stale: false })),
      close: vi.fn(),
    } as unknown as KimiEventConnection;
    let call = 0;
    let rejectFirst!: (err: Error) => void;
    const api = {
      connectTranscriptChannel: vi.fn(() => connection),
      getSessionTranscript: vi.fn(() => {
        call += 1;
        if (call === 1) {
          return new Promise((_, reject) => {
            rejectFirst = reject;
          });
        }
        return Promise.resolve({
          items: [],
          tasks: [],
          interactions: [],
          attachments: [],
          todos: [],
          prompts: [],
          meta: { activity: 'idle' },
          hasMoreOlder: false,
          seq: 3,
          agentId: 'main',
        });
      }),
    } as unknown as KimiWebApi;
    const host = createMainTranscriptHost({ api, onBaselineError });

    host.activate('s1');
    await vi.waitFor(() => expect(call).toBe(1));
    host.pool.forgetSession('s1');
    host.activate('s1');
    await vi.waitFor(() => expect(host.pool.getEntry('s1')?.baselineLoaded).toBe(true));

    rejectFirst(new Error('network down'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(host.pool.getEntry('s1')?.baselineLoaded).toBe(true);
    expect(onBaselineError).not.toHaveBeenCalled();
  });

  it('keeps a baseline-loaded entry when a resume refresh fails transiently', async () => {
    // refreshAndResume also runs for loaded sessions (gap recovery): dropping
    // the entry there blanks the session, and the surviving subscription
    // would silently consume later ops against nothing. Only a FIRST-read
    // failure may drop it.
    const onBaselineError = vi.fn();
    const connection = {
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      health: vi.fn(() => ({ connected: true, open: true, stale: false })),
      close: vi.fn(),
    } as unknown as KimiEventConnection;
    let offline = false;
    const api = {
      connectTranscriptChannel: vi.fn(() => connection),
      getSessionTranscript: vi.fn(async () => {
        if (offline) throw new Error('network down');
        return {
          items: [],
          tasks: [],
          interactions: [],
          attachments: [],
          todos: [],
          prompts: [],
          meta: { activity: 'idle' },
          hasMoreOlder: false,
          seq: 3,
          agentId: 'main',
        };
      }),
    } as unknown as KimiWebApi;
    const host = createMainTranscriptHost({ api, onBaselineError });

    host.activate('s1');
    await vi.waitFor(() => expect(host.pool.getEntry('s1')?.baselineLoaded).toBe(true));

    // The gap replay hits a transient REST failure mid-resume.
    offline = true;
    host.pool.applyOps('s1', [], 5);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const entry = host.pool.getEntry('s1');
    expect(entry?.baselineLoaded).toBe(true);
    expect(onBaselineError).not.toHaveBeenCalled();
  });

  it('reconnects the companion socket only once it exists and looks stale', () => {
    const { host, health, reconnect } = makeHost();

    host.recoverIfStale();
    expect(reconnect).not.toHaveBeenCalled();

    host.activate('s1');
    host.recoverIfStale();
    expect(reconnect).not.toHaveBeenCalled();

    health.mockReturnValue({ connected: true, open: true, stale: true });
    host.recoverIfStale();
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});
