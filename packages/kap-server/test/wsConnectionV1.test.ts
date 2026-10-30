import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IConnectionRegistry } from '../src/transport/ws/connectionRegistry';
import type { SessionEventBroadcaster } from '../src/transport/ws/v1/sessionEventBroadcaster';
import { type WsConnectionV1Options, WsConnectionV1 } from '../src/transport/ws/v1/wsConnectionV1';

class FakeSocket {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly handlers = new Map<string, Array<(...a: unknown[]) => void>>();

  on(event: string, cb: (...a: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = this.CLOSED;
    this.emit('close');
  }

  terminate(): void {
    this.readyState = this.CLOSED;
    this.emit('close');
  }

  emit(event: string, ...a: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...a);
  }

  frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function makeBroadcaster(overrides: Record<string, unknown> = {}): SessionEventBroadcaster {
  return {
    subscribe: async () => true,
    unsubscribe: () => {},
    updateTranscriptGrades: () => {},
    addGlobalTarget: () => {},
    removeGlobalTarget: () => {},
    addDiEventTarget: () => {},
    sendPendingInteractions: () => {},
    ...overrides,
  } as unknown as SessionEventBroadcaster;
}

function makeRegistry(): IConnectionRegistry {
  return {
    add: () => {},
    remove: () => {},
    get: () => undefined,
    values: () => [],
    closeAll: () => {},
    size: () => 0,
  };
}

function makeConn(socket: FakeSocket, opts: Partial<WsConnectionV1Options> = {}): WsConnectionV1 {
  return new WsConnectionV1({
    socket: socket as unknown as WebSocket,
    broadcaster: makeBroadcaster(),
    connectionRegistry: makeRegistry(),
    remoteAddress: null,
    userAgent: null,
    ...opts,
  });
}

function frame(type: string, sessionId: string, seq: number) {
  return {
    type,
    session_id: sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: { type, agent_id: 'main', seq },
  };
}

function controlFrame(type: string, payload: Record<string, unknown>, id = 'req-1'): string {
  return JSON.stringify({ type, id, payload });
}

function acks(socket: FakeSocket): Array<{ id: string; code: number; payload: unknown }> {
  return socket
    .frames()
    .filter((f) => (f as { type: string }).type === 'ack') as Array<{
    id: string;
    code: number;
    payload: unknown;
  }>;
}

describe('WsConnectionV1 control frames', () => {
  interface SubscribeCall {
    sessionId: string;
    grades: unknown;
    transcriptSince?: Record<string, number>;
  }

  function makeCapturingBroadcaster(): {
    broadcaster: SessionEventBroadcaster;
    calls: SubscribeCall[];
    unsubscribes: string[];
    updates: { sessionId: string; grades: unknown }[];
  } {
    const calls: SubscribeCall[] = [];
    const unsubscribes: string[] = [];
    const updates: { sessionId: string; grades: unknown }[] = [];
    const broadcaster = makeBroadcaster({
      subscribe: async (
        sessionId: string,
        _target: unknown,
        grades: unknown,
        transcriptSince?: Record<string, number>,
      ) => {
        calls.push({ sessionId, grades, transcriptSince });
        return true;
      },
      unsubscribe: (sessionId: string) => {
        unsubscribes.push(sessionId);
      },
      updateTranscriptGrades: (sessionId: string, _target: unknown, grades: unknown) => {
        updates.push({ sessionId, grades });
      },
    });
    return { broadcaster, calls, unsubscribes, updates };
  }

  it('acks client_hello with an empty payload and attaches nothing, ignoring legacy fields', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('client_hello', {
        client_id: 'c1',
        subscriptions: ['s1'],
        cursors: { s1: { seq: 3 } },
        agent_filter: { s1: ['main'] },
      }),
    );
    await vi.waitFor(() => expect(acks(socket)).toHaveLength(1));

    expect(acks(socket)[0]).toMatchObject({ id: 'req-1', code: 0, payload: {} });
    expect(calls).toHaveLength(0);
    expect(conn.subscriptions.size).toBe(0);
    expect(conn.hasClientHello).toBe(true);
    conn.close();
  });

  it('ignores the removed subscribe and unsubscribe frames', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls, unsubscribes } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit('message', controlFrame('subscribe', { session_ids: ['s1'] }, 'old-sub'));
    socket.emit('message', controlFrame('unsubscribe', { session_ids: ['s1'] }, 'old-unsub'));
    socket.emit('message', controlFrame('client_hello', { client_id: 'c1' }, 'hello'));
    await vi.waitFor(() => expect(acks(socket)).toHaveLength(1));

    expect(acks(socket)[0]!.id).toBe('hello');
    expect(calls).toHaveLength(0);
    expect(unsubscribes).toHaveLength(0);
    conn.close();
  });

  it('sends the pending interactions of an accepted session right after the ack', async () => {
    const socket = new FakeSocket();
    const { broadcaster } = makeCapturingBroadcaster();
    broadcaster.sendPendingInteractions = (sessionId, target) => {
      target.send(
        { type: 'interaction', session_id: sessionId, timestamp: '', payload: {} },
        'immediate',
      );
    };
    const conn = makeConn(socket, { broadcaster });
    const types = () =>
      socket
        .frames()
        .map((f) => (f as { type: string }).type)
        .filter((type) => type !== 'server_hello');

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { main: 'delta' } }),
    );
    await vi.waitFor(() => expect(types()).toEqual(['ack', 'interaction']));
    conn.close();
  });

  it('forwards subscribe_v2 grades and transcript_since to the broadcaster and stores the grades', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', {
        session_id: 's1',
        transcript: { '*': 'delta' },
        transcript_since: { main: 7, '*': 3 },
      }),
    );
    await vi.waitFor(() => expect(acks(socket)).toHaveLength(1));

    expect(calls).toEqual([
      { sessionId: 's1', grades: { '*': 'delta' }, transcriptSince: { main: 7, '*': 3 } },
    ]);
    expect(conn.subscriptions.get('s1')).toEqual({ '*': 'delta' });
    expect(conn.subscriptionSessionIds).toEqual(['s1']);
    expect(acks(socket)[0]).toMatchObject({
      code: 0,
      payload: { accepted: ['s1'], not_found: [] },
    });
    conn.close();
  });

  it('acks an invalid subscribe_v2 payload with an error and does not attach', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { main: 'everything' } }),
    );
    await vi.waitFor(() => expect(acks(socket)).toHaveLength(1));

    expect(calls).toHaveLength(0);
    expect(conn.subscriptions.size).toBe(0);
    expect(acks(socket)[0]!.code).toBe(1);
    conn.close();
  });

  it('reports an unknown session in the subscribe_v2 ack not_found list', async () => {
    const socket = new FakeSocket();
    const { broadcaster } = makeCapturingBroadcaster();
    broadcaster.subscribe = async () => false;
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 'gone', transcript: { '*': 'delta' } }),
    );
    await vi.waitFor(() => expect(acks(socket)).toHaveLength(1));

    expect(acks(socket)[0]).toMatchObject({
      code: 0,
      payload: { accepted: [], not_found: ['gone'] },
    });
    expect(conn.subscriptions.size).toBe(0);
    conn.close();
  });

  it('unsubscribe_v2 with agent_ids narrows the grades with an explicit off', async () => {
    const socket = new FakeSocket();
    const { broadcaster, unsubscribes, updates } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { '*': 'delta' } }),
    );
    socket.emit(
      'message',
      controlFrame('unsubscribe_v2', { session_id: 's1', agent_ids: ['main'] }),
    );
    await vi.waitFor(() => expect(acks(socket)).toHaveLength(2));

    expect(updates).toEqual([{ sessionId: 's1', grades: { '*': 'delta', main: 'off' } }]);
    expect(unsubscribes).toHaveLength(0);
    expect(conn.subscriptions.get('s1')).toEqual({ '*': 'delta', main: 'off' });
    expect(acks(socket)[1]).toMatchObject({
      code: 0,
      payload: { accepted: ['s1'], not_found: [] },
    });
    conn.close();
  });

  it('unsubscribe_v2 drops the session once no agent keeps a grade', async () => {
    const socket = new FakeSocket();
    const { broadcaster, unsubscribes, updates } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { main: 'delta' } }),
    );
    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's2', transcript: { '*': 'delta' } }),
    );
    socket.emit(
      'message',
      controlFrame('unsubscribe_v2', { session_id: 's1', agent_ids: ['main'] }),
    );
    socket.emit('message', controlFrame('unsubscribe_v2', { session_id: 's2' }));
    await vi.waitFor(() => expect(acks(socket)).toHaveLength(4));

    expect(unsubscribes).toEqual(['s1', 's2']);
    expect(updates).toHaveLength(0);
    expect(conn.subscriptions.size).toBe(0);
    conn.close();
  });

  it('unsubscribe_v2 is idempotent for an unsubscribed session and never touches the broadcaster', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls, unsubscribes, updates } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit('message', controlFrame('unsubscribe_v2', { session_id: 's1' }));
    await vi.waitFor(() => expect(acks(socket)).toHaveLength(1));

    expect(calls).toHaveLength(0);
    expect(unsubscribes).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(acks(socket)[0]).toMatchObject({ code: 0, payload: { accepted: ['s1'] } });
    conn.close();
  });

  it('acks an invalid unsubscribe_v2 payload with an error', async () => {
    const socket = new FakeSocket();
    const { broadcaster, unsubscribes } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit('message', controlFrame('unsubscribe_v2', { agent_ids: ['main'] }));
    socket.emit('message', controlFrame('unsubscribe_v2', { session_id: 's1', agent_ids: [] }));
    await vi.waitFor(() => expect(acks(socket)).toHaveLength(2));

    expect(unsubscribes).toHaveLength(0);
    expect(acks(socket).every((a) => a.code === 1)).toBe(true);
    conn.close();
  });

  it('re-subscribes a session after it was fully detached', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { '*': 'delta' } }),
    );
    socket.emit('message', controlFrame('unsubscribe_v2', { session_id: 's1' }));
    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { main: 'turn' } }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls[1]).toMatchObject({ sessionId: 's1', grades: { main: 'turn' } });
    expect(conn.subscriptions.get('s1')).toEqual({ main: 'turn' });
    conn.close();
  });

  it('unsubscribes every session from the broadcaster when the socket closes', async () => {
    const socket = new FakeSocket();
    const { broadcaster, unsubscribes } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { '*': 'delta' } }),
    );
    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's2', transcript: { '*': 'delta' } }),
    );
    await vi.waitFor(() => expect(conn.subscriptions.size).toBe(2));

    socket.emit('close');
    expect(unsubscribes.toSorted()).toEqual(['s1', 's2']);
  });
});

describe('WsConnectionV1 outbound buffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends server_hello immediately without an event buffer size', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 16 });
    const frames = socket.frames() as Array<{ type: string; payload: Record<string, unknown> }>;
    expect(frames.map((f) => f.type)).toEqual(['server_hello']);
    expect(frames[0]!.payload).not.toHaveProperty('max_event_buffer_size');
    conn.close();
  });

  it('buffers subscription frames and flushes them in order after the interval', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 16 });
    socket.sent = [];

    conn.send(frame('transcript.reset', 's1', 7));
    conn.send(frame('transcript.ops', 's1', 8));
    conn.send(frame('transcript.ops', 's1', 9));
    expect(socket.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15);
    expect(socket.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    const frames = socket.frames() as Array<{ type: string; payload: { seq: number } }>;
    expect(frames.map((f) => f.type)).toEqual([
      'transcript.reset',
      'transcript.ops',
      'transcript.ops',
    ]);
    expect(frames.map((f) => f.payload.seq)).toEqual([7, 8, 9]);
    conn.close();
  });

  it('sends immediate frames at once and preserves FIFO with buffered frames', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 16 });
    socket.sent = [];

    conn.send(frame('transcript.ops', 's1', 1));
    expect(socket.sent).toHaveLength(0);
    conn.send(frame('event.session.work_changed', 's1', 2), 'immediate');

    expect(socket.frames().map((f) => (f as { type: string }).type)).toEqual([
      'transcript.ops',
      'event.session.work_changed',
    ]);
    await vi.advanceTimersByTimeAsync(16);
    expect(socket.sent).toHaveLength(2);
    conn.close();
  });

  it('flushes immediately once the buffered batch reaches maxBatchSize', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 1000, maxBatchSize: 3 });
    socket.sent = [];

    conn.send(frame('transcript.ops', 's1', 1));
    conn.send(frame('transcript.ops', 's1', 2));
    expect(socket.sent).toHaveLength(0);
    conn.send(frame('transcript.ops', 's1', 3));

    expect(socket.sent).toHaveLength(3);
    conn.close();
  });

  it('defers flushing while the peer is above the watermark, then drains', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 16, highWaterMarkBytes: 100 });
    socket.sent = [];

    socket.bufferedAmount = 200;
    conn.send(frame('transcript.ops', 's1', 1));
    await vi.advanceTimersByTimeAsync(16);
    expect(socket.sent).toHaveLength(0);

    conn.send(frame('transcript.ops', 's1', 2));
    await vi.advanceTimersByTimeAsync(5);
    expect(socket.sent).toHaveLength(0);

    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(5);
    expect(
      (socket.frames() as Array<{ payload: { seq: number } }>).map((f) => f.payload.seq),
    ).toEqual([1, 2]);
    conn.close();
  });

  it('force-flushes buffered subscription frames on close', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 1000 });
    socket.sent = [];

    conn.send(frame('transcript.ops', 's1', 1));
    expect(socket.sent).toHaveLength(0);

    conn.close();
    expect(socket.frames()).toHaveLength(1);
  });

  it('drops buffered frames when the socket is already closed at flush time', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 16 });
    socket.sent = [];

    socket.readyState = socket.CLOSED;
    conn.send(frame('transcript.ops', 's1', 1));
    await vi.advanceTimersByTimeAsync(16);
    expect(socket.sent).toHaveLength(0);
  });
});

describe('WsConnectionV1 heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function sentTypes(socket: FakeSocket): string[] {
    return socket.frames().map((f) => (f as { type: string }).type);
  }

  function sentPings(socket: FakeSocket): Array<{ type: string; payload: { nonce: string } }> {
    return socket.frames() as Array<{ type: string; payload: { nonce: string } }>;
  }

  it('advertises the heartbeat interval in server_hello', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { heartbeatIntervalMs: 10 });
    const hello = socket.frames()[0] as { type: string; payload: { heartbeat_ms?: number } };
    expect(hello.type).toBe('server_hello');
    expect(hello.payload.heartbeat_ms).toBe(10);
    conn.close();
  });

  it('defaults to a 10s heartbeat interval', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket);
    const hello = socket.frames()[0] as { payload: { heartbeat_ms?: number } };
    expect(hello.payload.heartbeat_ms).toBe(10_000);
    conn.close();
  });

  it('sends a ping every interval while the peer keeps answering', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { heartbeatIntervalMs: 10 });
    socket.sent = [];

    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(10);
      expect(sentTypes(socket)).toHaveLength(i + 1);
      socket.emit('message', JSON.stringify({ type: 'pong', payload: { nonce: 'n' } }));
    }

    const pings = sentPings(socket);
    expect(pings.every((f) => f.type === 'ping')).toBe(true);
    expect(typeof pings[0]!.payload.nonce).toBe('string');
    expect(new Set(pings.map((f) => f.payload.nonce)).size).toBe(3);
    expect(socket.closeCalls).toHaveLength(0);
    conn.close();
  });

  it('reaps the connection after two silent cycles', () => {
    const socket = new FakeSocket();
    makeConn(socket, { heartbeatIntervalMs: 10 });
    socket.sent = [];

    vi.advanceTimersByTime(10);
    expect(sentTypes(socket)).toEqual(['ping']);
    expect(socket.closeCalls).toHaveLength(0);

    vi.advanceTimersByTime(10);
    expect(socket.closeCalls).toEqual([{ code: 1001, reason: 'heartbeat timeout' }]);
    expect(sentTypes(socket)).toEqual(['ping']);

    vi.advanceTimersByTime(100);
    expect(sentTypes(socket)).toEqual(['ping']);
    expect(socket.closeCalls).toHaveLength(1);
  });

  it('treats any inbound frame — not just pong — as proof of life', () => {
    const socket = new FakeSocket();
    makeConn(socket, { heartbeatIntervalMs: 10 });
    socket.sent = [];

    vi.advanceTimersByTime(15);
    socket.emit('message', JSON.stringify({ type: 'some_future_frame', payload: {} }));

    vi.advanceTimersByTime(20);
    expect(sentTypes(socket)).toEqual(['ping', 'ping', 'ping']);
    expect(socket.closeCalls).toHaveLength(0);

    vi.advanceTimersByTime(5);
    expect(socket.closeCalls).toEqual([{ code: 1001, reason: 'heartbeat timeout' }]);
  });

  it('stops heartbeating once the socket closes on its own', () => {
    const socket = new FakeSocket();
    makeConn(socket, { heartbeatIntervalMs: 10 });
    socket.sent = [];

    vi.advanceTimersByTime(10);
    expect(sentTypes(socket)).toEqual(['ping']);

    socket.terminate();
    vi.advanceTimersByTime(100);
    expect(sentTypes(socket)).toEqual(['ping']);
    expect(socket.closeCalls).toHaveLength(0);
  });
});

describe('WsConnectionV1 global target registration', () => {
  function makeGlobalTargetBroadcaster() {
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const broadcaster = makeBroadcaster({
      addGlobalTarget: (target: unknown) => added.push(target),
      removeGlobalTarget: (target: unknown) => removed.push(target),
    });
    return { broadcaster, added, removed };
  }

  it('registers the connection as a global target on construction and unregisters on close', () => {
    const socket = new FakeSocket();
    const { broadcaster, added, removed } = makeGlobalTargetBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    expect(added).toEqual([conn]);
    expect(removed).toEqual([]);

    conn.close();
    expect(removed).toEqual([conn]);
  });

  it('unregisters when the socket closes on its own', () => {
    const socket = new FakeSocket();
    const { broadcaster, added, removed } = makeGlobalTargetBroadcaster();
    const conn = makeConn(socket, { broadcaster });
    expect(added).toEqual([conn]);

    socket.emit('close');
    expect(removed).toEqual([conn]);
  });
});
