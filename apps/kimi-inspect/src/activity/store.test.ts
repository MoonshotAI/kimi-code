import { describe, expect, it, vi } from 'vitest';

import type { WsLike, WsLikeCtor } from '../channel/wsLike';
import { SessionActivityHub, SessionActivityStore, type SessionWorkFacts } from './store';

function facts(partial: Partial<SessionWorkFacts> = {}): SessionWorkFacts {
  return {
    busy: false,
    mainTurnActive: false,
    pendingInteraction: 'none',
    lastTurnReason: undefined,
    ...partial,
  };
}

class FakeWs implements WsLike {
  static readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(event: never) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: 'open' | 'message' | 'close' | 'error', event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
  emitFrame(frame: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }
}

function makeFakeWsCtor(): { ctor: WsLikeCtor; instances: FakeWs[] } {
  const instances: FakeWs[] = [];
  const ctor = class {
    static readonly OPEN = 1;
    constructor(_url: string, _protocols?: string | string[]) {
      const ws = new FakeWs();
      instances.push(ws);
      return ws;
    }
  } as unknown as WsLikeCtor;
  return { ctor, instances };
}

function seedFetch(items: Record<string, unknown>[]): typeof fetch {
  return vi.fn(async () => ({
    json: async () => ({ code: 0, data: { items, has_more: false } }),
  })) as unknown as typeof fetch;
}

function sessionMessage(
  subtype: 'created' | 'updated' | 'archived' | 'deleted',
  session: Record<string, unknown> & { id: string },
): Record<string, unknown> {
  return {
    type: 'session',
    event_created_at: new Date().toISOString(),
    subtype,
    session: {
      workspace_id: 'wd_example_0123456789ab',
      title: 'session',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      busy: false,
      metadata: { cwd: '/tmp/example' },
      agent_config: { model: 'test-model' },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        context_tokens: 0,
      },
      permission_rules: [],
      message_count: 0,
      last_seq: 0,
      ...session,
    },
  };
}

describe('SessionActivityStore', () => {
  it('applies work facts with a version bump and ignores identical facts', () => {
    const store = new SessionActivityStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.applyWorkChanged('s1', facts({ busy: true, mainTurnActive: true }));

    expect(store.get('s1')).toEqual(facts({ busy: true, mainTurnActive: true }));
    expect(store.getVersion()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);

    store.applyWorkChanged('s1', facts({ busy: true, mainTurnActive: true }));

    expect(store.getVersion()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('seed replaces the whole map', () => {
    const store = new SessionActivityStore();
    store.applyWorkChanged('stale', facts({ busy: true }));

    store.seed([['s1', facts({ pendingInteraction: 'approval' })]]);

    expect(store.get('stale')).toBeUndefined();
    expect(store.get('s1')?.pendingInteraction).toBe('approval');
  });
});

describe('SessionActivityHub', () => {
  it('pings on an interval and drops the socket into a reconnect when responses go missing', () => {
    vi.useFakeTimers();
    try {
      const { ctor, instances } = makeFakeWsCtor();
      const hub = new SessionActivityHub({
        url: 'http://127.0.0.1:58627',
        onListChanged: () => {},
        WebSocketImpl: ctor,
        fetchImpl: seedFetch([]),
        heartbeatIntervalMs: 100,
      });
      const first = instances[0]!;
      first.emit('open');
      const firstFrames = (): Record<string, unknown>[] =>
        first.sent.map((data) => JSON.parse(data) as Record<string, unknown>);

      vi.advanceTimersByTime(100);
      const ping = firstFrames().find((frame) => frame['type'] === 'ping')!;
      expect(typeof ping['request_id']).toBe('string');
      first.emitFrame({ type: 'response', request_id: ping['request_id'], code: 0 });

      vi.advanceTimersByTime(100);
      expect(firstFrames().filter((frame) => frame['type'] === 'ping')).toHaveLength(2);
      expect(instances).toHaveLength(1);

      vi.advanceTimersByTime(100);
      expect(first.closed).toBe(false);
      vi.advanceTimersByTime(100);
      expect(first.closed).toBe(true);
      vi.advanceTimersByTime(500);
      expect(instances.length).toBeGreaterThan(1);
      hub.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('seeds the store from the REST session list when the socket opens', async () => {
    const { ctor, instances } = makeFakeWsCtor();
    const hub = new SessionActivityHub({
      url: 'http://127.0.0.1:58627',
      onListChanged: () => {},
      WebSocketImpl: ctor,
      fetchImpl: seedFetch([
        { id: 's1', busy: true, main_turn_active: true, pending_interaction: 'none' },
        { id: 's2', busy: false, main_turn_active: false, pending_interaction: 'approval' },
      ]),
    });

    instances[0]!.emit('open');
    await vi.waitFor(() => expect(hub.store.get('s1')).toBeDefined());

    expect(hub.store.get('s1')).toEqual(facts({ busy: true, mainTurnActive: true }));
    expect(hub.store.get('s2')?.pendingInteraction).toBe('approval');
    // No subscribe frame — global messages flow to every connection; only
    // the periodic heartbeat ping goes out, and none fires within the test.
    expect(instances[0]!.sent).toEqual([]);
    hub.close();
  });

  it('applies live session messages by session id', () => {
    const { ctor, instances } = makeFakeWsCtor();
    const hub = new SessionActivityHub({
      url: 'http://127.0.0.1:58627',
      onListChanged: () => {},
      WebSocketImpl: ctor,
      fetchImpl: seedFetch([]),
    });
    instances[0]!.emit('open');

    instances[0]!.emitFrame(
      sessionMessage('updated', {
        id: 's1',
        busy: true,
        main_turn_active: true,
        pending_interaction: 'question',
      }),
    );

    expect(hub.store.get('s1')).toEqual(
      facts({ busy: true, mainTurnActive: true, pendingInteraction: 'question' }),
    );
    hub.close();
  });

  it('forwards created and updated messages as list-level signals', () => {
    const { ctor, instances } = makeFakeWsCtor();
    const onListChanged = vi.fn();
    const hub = new SessionActivityHub({
      url: 'http://127.0.0.1:58627',
      onListChanged,
      WebSocketImpl: ctor,
      fetchImpl: seedFetch([]),
    });
    instances[0]!.emit('open');

    instances[0]!.emitFrame(sessionMessage('created', { id: 's1' }));
    instances[0]!.emitFrame(sessionMessage('updated', { id: 's1' }));
    // Unknown future message types are ignored silently.
    instances[0]!.emitFrame({ type: 'turn.started', session_id: 's1', payload: {} });

    expect(onListChanged).toHaveBeenCalledTimes(2);
    expect(hub.store.get('s1')).toEqual(facts());
    hub.close();
  });

  it('forwards archived/deleted and workspace messages as list-level signals and drops gone facts', () => {
    const { ctor, instances } = makeFakeWsCtor();
    const onListChanged = vi.fn();
    const hub = new SessionActivityHub({
      url: 'http://127.0.0.1:58627',
      onListChanged,
      WebSocketImpl: ctor,
      fetchImpl: seedFetch([]),
    });
    instances[0]!.emit('open');

    instances[0]!.emitFrame(sessionMessage('updated', { id: 's1', busy: true }));
    expect(hub.store.get('s1')).toBeDefined();

    instances[0]!.emitFrame(sessionMessage('archived', { id: 's1', archived: true }));
    expect(hub.store.get('s1')).toBeUndefined();
    expect(onListChanged).toHaveBeenCalledTimes(2);

    instances[0]!.emitFrame(sessionMessage('updated', { id: 's2', busy: true }));
    expect(hub.store.get('s2')).toBeDefined();

    instances[0]!.emitFrame(sessionMessage('deleted', { id: 's2' }));
    expect(hub.store.get('s2')).toBeUndefined();
    expect(onListChanged).toHaveBeenCalledTimes(4);

    for (const subtype of ['created', 'updated', 'deleted']) {
      instances[0]!.emitFrame({
        type: 'workspace',
        event_created_at: new Date().toISOString(),
        subtype,
        workspace: {
          id: 'wd_example_0123456789ab',
          root: '/tmp/example',
          name: 'example',
          created_at: new Date().toISOString(),
          last_opened_at: new Date().toISOString(),
          session_count: 0,
        },
      });
    }
    expect(onListChanged).toHaveBeenCalledTimes(7);
    hub.close();
  });
});
