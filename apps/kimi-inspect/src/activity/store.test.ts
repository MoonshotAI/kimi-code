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

describe('SessionActivityStore', () => {
  it('applies work facts and notifies with a version bump', () => {
    const store = new SessionActivityStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.applyWorkChanged('s1', facts({ busy: true, mainTurnActive: true }));

    expect(store.get('s1')).toEqual(facts({ busy: true, mainTurnActive: true }));
    expect(store.getVersion()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignores identical facts (no bump, no notify)', () => {
    const store = new SessionActivityStore();
    const listener = vi.fn();
    store.applyWorkChanged('s1', facts({ busy: true }));
    store.subscribe(listener);

    store.applyWorkChanged('s1', facts({ busy: true }));

    expect(store.getVersion()).toBe(1);
    expect(listener).not.toHaveBeenCalled();
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
    // The hello goes out with no subscriptions — global facts flow regardless.
    const hello = JSON.parse(instances[0]!.sent[0]!) as { type: string; payload: { subscriptions: string[] } };
    expect(hello.type).toBe('client_hello');
    expect(hello.payload.subscriptions).toEqual([]);
    hub.close();
  });

  it('applies live work_changed frames by session id', () => {
    const { ctor, instances } = makeFakeWsCtor();
    const hub = new SessionActivityHub({
      url: 'http://127.0.0.1:58627',
      onListChanged: () => {},
      WebSocketImpl: ctor,
      fetchImpl: seedFetch([]),
    });
    instances[0]!.emit('open');

    instances[0]!.emitFrame({
      type: 'event.session.work_changed',
      session_id: 's1',
      payload: {
        type: 'event.session.work_changed',
        busy: true,
        main_turn_active: true,
        pending_interaction: 'question',
        last_turn_reason: null,
      },
    });

    expect(hub.store.get('s1')).toEqual(
      facts({ busy: true, mainTurnActive: true, pendingInteraction: 'question' }),
    );
    hub.close();
  });

  it('forwards created and meta updates as list-level signals', () => {
    const { ctor, instances } = makeFakeWsCtor();
    const onListChanged = vi.fn();
    const hub = new SessionActivityHub({
      url: 'http://127.0.0.1:58627',
      onListChanged,
      WebSocketImpl: ctor,
      fetchImpl: seedFetch([]),
    });
    instances[0]!.emit('open');

    instances[0]!.emitFrame({ type: 'event.session.created', session_id: 's1', payload: {} });
    instances[0]!.emitFrame({ type: 'session.meta.updated', session_id: 's1', payload: {} });
    // Agent-grained frames are ignored even if they somehow arrive.
    instances[0]!.emitFrame({ type: 'turn.started', session_id: 's1', payload: {} });

    expect(onListChanged).toHaveBeenCalledTimes(2);
    expect(hub.store.get('s1')).toBeUndefined();
    hub.close();
  });
});
