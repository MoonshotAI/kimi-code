/**
 * `WsConnectionV1` — outbound send buffer: coalescing of high-frequency
 * volatile text deltas, batch flush, backpressure deferral, and close flush.
 */

import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IConnectionRegistry } from '../src/transport/ws/connectionRegistry';
import type { SessionEventBroadcaster } from '../src/transport/ws/v1/sessionEventBroadcaster';
import {
  type WsConnectionV1Options,
  WsConnectionV1,
  coalesceFrames,
} from '../src/transport/ws/v1/wsConnectionV1';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

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

function makeBroadcaster(): SessionEventBroadcaster {
  return {
    subscribe: async () => true,
    unsubscribe: () => {},
    addGlobalTarget: () => {},
    removeGlobalTarget: () => {},
    getCursor: async () => ({ seq: 0, epoch: '' }),
    getBufferedSince: async () => ({
      events: [],
      resyncRequired: false,
      currentSeq: 0,
      epoch: '',
    }),
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

function delta(
  sessionId: string,
  agentId: string,
  turnId: number,
  text: string,
  offset: number,
  type: 'assistant.delta' | 'thinking.delta' = 'assistant.delta',
) {
  return {
    type,
    seq: 1,
    volatile: true as const,
    offset,
    session_id: sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: { type, agentId, sessionId, turnId, delta: text },
  };
}

function durable(type: string, sessionId: string, seq: number) {
  return {
    type,
    seq,
    session_id: sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: { type, agentId: 'main', sessionId },
  };
}

// ---------------------------------------------------------------------------
// coalesceFrames — pure
// ---------------------------------------------------------------------------

describe('coalesceFrames', () => {
  it('merges adjacent compatible assistant deltas', () => {
    const out = coalesceFrames([
      delta('s1', 'main', 1, 'Hello', 0),
      delta('s1', 'main', 1, ' ', 5),
      delta('s1', 'main', 1, 'world', 6),
    ]);
    expect(out).toHaveLength(1);
    const f = out[0] as { offset: number; volatile: boolean; seq: number; payload: { delta: string } };
    expect(f.payload.delta).toBe('Hello world');
    expect(f.offset).toBe(0);
    expect(f.volatile).toBe(true);
    expect(f.seq).toBe(1);
  });

  it('does not merge across a durable frame', () => {
    const out = coalesceFrames([
      delta('s1', 'main', 1, 'a', 0),
      durable('turn.ended', 's1', 2),
      delta('s1', 'main', 1, 'b', 1),
    ]);
    expect(out).toHaveLength(3);
    expect((out[0] as { payload: { delta: string } }).payload.delta).toBe('a');
    expect((out[1] as { type: string }).type).toBe('turn.ended');
    expect((out[2] as { payload: { delta: string } }).payload.delta).toBe('b');
  });

  it('does not merge different delta types', () => {
    const out = coalesceFrames([
      delta('s1', 'main', 1, 'hi', 0, 'assistant.delta'),
      delta('s1', 'main', 1, 'think', 0, 'thinking.delta'),
    ]);
    expect(out).toHaveLength(2);
  });

  it('does not merge deltas from different sessions / agents / turns', () => {
    expect(
      coalesceFrames([delta('s1', 'main', 1, 'a', 0), delta('s2', 'main', 1, 'b', 0)]),
    ).toHaveLength(2);
    expect(
      coalesceFrames([delta('s1', 'main', 1, 'a', 0), delta('s1', 'sub', 1, 'b', 0)]),
    ).toHaveLength(2);
    expect(
      coalesceFrames([delta('s1', 'main', 1, 'a', 0), delta('s1', 'main', 2, 'b', 0)]),
    ).toHaveLength(2);
  });

  it('leaves non-volatile and non-text frames untouched', () => {
    const toolCallDelta = {
      type: 'tool.call.delta',
      seq: 1,
      volatile: true as const,
      session_id: 's1',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { type: 'tool.call.delta', agentId: 'main', turnId: 1, args: { x: 1 } },
    };
    expect(coalesceFrames([toolCallDelta, toolCallDelta])).toHaveLength(2);
  });

  it('does not mutate the input frames', () => {
    const a = delta('s1', 'main', 1, 'a', 0);
    const b = delta('s1', 'main', 1, 'b', 1);
    const out = coalesceFrames([a, b]);
    expect(out).toHaveLength(1);
    expect(a.payload.delta).toBe('a');
    expect(b.payload.delta).toBe('b');
  });

  it('handles empty and single-element input', () => {
    expect(coalesceFrames([])).toEqual([]);
    const only = delta('s1', 'main', 1, 'x', 0);
    const out = coalesceFrames([only]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(only);
  });
});

// ---------------------------------------------------------------------------
// WsConnectionV1 — transcript subscription parsing
// ---------------------------------------------------------------------------

describe('WsConnectionV1 transcript subscriptions (subscribe_v2)', () => {
  interface SubscribeCall {
    sessionId: string;
    filter: unknown;
    grades: unknown;
    opts?: { deferTranscriptReset?: boolean; transcriptSince?: Record<string, number> };
  }

  function makeCapturingBroadcaster(): {
    broadcaster: SessionEventBroadcaster;
    calls: SubscribeCall[];
    detaches: { sessionId: string; agentIds?: readonly string[] }[];
  } {
    const calls: SubscribeCall[] = [];
    const detaches: { sessionId: string; agentIds?: readonly string[] }[] = [];
    const broadcaster = {
      subscribe: async (
        sessionId: string,
        _target: unknown,
        filter: unknown,
        grades: unknown,
        opts?: { deferTranscriptReset?: boolean; transcriptSince?: Record<string, number> },
      ) => {
        calls.push({ sessionId, filter, grades, opts });
        return true;
      },
      unsubscribe: () => {},
      unsubscribeTranscript: (sessionId: string, _target: unknown, agentIds?: readonly string[]) => {
        detaches.push({ sessionId, agentIds });
      },
      addGlobalTarget: () => {},
      removeGlobalTarget: () => {},
      getCursor: async () => ({ seq: 0, epoch: '' }),
      getBufferedSince: async () => ({
        events: [],
        resyncRequired: false,
        currentSeq: 0,
        epoch: '',
      }),
    } as unknown as SessionEventBroadcaster;
    return { broadcaster, calls, detaches };
  }

  function controlFrame(type: string, payload: Record<string, unknown>): string {
    return JSON.stringify({ type, id: 'req-1', payload });
  }

  it('forwards subscribe_v2 grades and transcript_since to the broadcaster and stores them per session', async () => {
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
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]).toMatchObject({
      sessionId: 's1',
      grades: { '*': 'delta' },
      opts: { transcriptSince: { main: 7, '*': 3 } },
    });
    expect(conn.subscriptions.get('s1')).toEqual({
      agentFilter: undefined,
      transcriptGrades: { '*': 'delta' },
    });
    await vi.waitFor(() =>
      expect(socket.sent.some((f) => JSON.parse(f).type === 'ack')).toBe(true),
    );
    const ack = socket.sent.map((f) => JSON.parse(f)).find((f) => f.type === 'ack');
    expect(ack).toMatchObject({ code: 0, payload: { accepted: ['s1'], not_found: [] } });
    conn.close();
  });

  it('ignores legacy transcript fields on client_hello and subscribe', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('client_hello', {
        client_id: 'c1',
        subscriptions: ['s1'],
        transcript: { s1: { '*': 'delta' } },
        transcript_since: { s1: { main: 7 } },
      }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ sessionId: 's1', grades: undefined });
    expect(calls[0]!.opts?.transcriptSince).toBeUndefined();
    expect(conn.subscriptions.get('s1')).toEqual({
      agentFilter: undefined,
      transcriptGrades: undefined,
    });

    socket.emit(
      'message',
      controlFrame('subscribe', {
        session_ids: ['s2'],
        transcript: { s2: { '*': 'delta' } },
      }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ sessionId: 's2', grades: undefined });
    expect(conn.subscriptions.get('s2')).toEqual({
      agentFilter: undefined,
      transcriptGrades: undefined,
    });
    conn.close();
  });

  it('acks an invalid subscribe_v2 payload with an error and does not attach', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', {
        session_id: 's1',
        transcript: { main: 'everything' },
      }),
    );
    await vi.waitFor(() =>
      expect(socket.sent.some((f) => JSON.parse(f).type === 'ack')).toBe(true),
    );

    expect(calls).toHaveLength(0);
    expect(conn.subscriptions.size).toBe(0);
    const ack = socket.sent.map((f) => JSON.parse(f)).find((f) => f.type === 'ack');
    expect(ack.code).toBe(1);
    conn.close();
  });

  it('preserves the existing agent filter when subscribe_v2 updates the grades', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe', { session_ids: ['s1'], agent_filter: { s1: ['main'] } }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { main: 'block' } }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls[1]).toMatchObject({ sessionId: 's1', grades: { main: 'block' } });
    expect(calls[1]!.filter).toEqual(new Set(['main']));
    expect(conn.subscriptions.get('s1')).toEqual({
      agentFilter: new Set(['main']),
      transcriptGrades: { main: 'block' },
    });
    conn.close();
  });

  it('keeps subscribe_v2 grades across a plain re-subscribe and filters the cursor replay through them', async () => {
    const socket = new FakeSocket();
    const backlog = [
      durable('turn.started', 's1', 3),
      durable('assistant.delta', 's1', 4),
      durable('event.session.work_changed', 's1', 5),
    ];
    // Mirror the real broadcaster's replay crop: with a transcript grade spec
    // the projected types drop out, retained (global/lifecycle) events stay.
    // The dedicated suppression coverage lives in sessionEventBroadcaster's
    // tests — here we only verify the preserved grade spec reaches
    // `getBufferedSince`.
    const PROJECTED = new Set(['turn.started', 'assistant.delta']);
    let seenGrades: unknown;
    const broadcaster = {
      subscribe: async (
        _sid: string,
        target: { send: (e: unknown) => void },
        _filter: unknown,
        _grades: unknown,
        opts?: { deferTranscriptReset?: boolean },
      ) => {
        if (opts?.deferTranscriptReset !== true) {
          target.send({ type: 'transcript.reset', seq: 10, session_id: 's1', payload: {} });
        }
        return true;
      },
      flushTranscriptSeed: async (_sid: string, target: { send: (e: unknown) => void }) => {
        target.send({ type: 'transcript.reset', seq: 10, session_id: 's1', payload: {} });
      },
      unsubscribe: () => {},
      addGlobalTarget: () => {},
      removeGlobalTarget: () => {},
      getCursor: async () => ({ seq: 10, epoch: 'e1' }),
      getBufferedSince: async (_sid: string, _cursor: unknown, _filter: unknown, grades: unknown) => {
        seenGrades = grades;
        return {
          events: backlog
            .filter((envelope) => grades === undefined || !PROJECTED.has(envelope.type))
            .map((envelope) => ({ seq: envelope.seq, envelope })),
          resyncRequired: false,
          currentSeq: 10,
          epoch: 'e1',
        };
      },
    } as unknown as SessionEventBroadcaster;
    const conn = makeConn(socket, { broadcaster, flushIntervalMs: 1 });

    // Grades arrive via subscribe_v2 first (no cursor → immediate baseline)…
    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { '*': 'delta' } }),
    );
    await vi.waitFor(() => {
      const types = socket.frames().map((f) => (f as { type: string }).type);
      expect(types).toContain('transcript.reset');
    });
    expect(conn.subscriptions.get('s1')?.transcriptGrades).toEqual({ '*': 'delta' });

    // …then a plain re-subscribe with a durable cursor must not wipe them.
    socket.emit(
      'message',
      controlFrame('subscribe', {
        session_ids: ['s1'],
        cursors: { s1: { seq: 2, epoch: 'e1' } },
      }),
    );
    await vi.waitFor(() => expect(seenGrades).toEqual({ '*': 'delta' }));
    expect(conn.subscriptions.get('s1')?.transcriptGrades).toEqual({ '*': 'delta' });

    const types = socket.frames().map((f) => (f as { type: string }).type);
    // The replay is filtered through the preserved grades: projected events
    // are suppressed; only the retained global event replays, and the
    // deferred baseline reset lands after it.
    expect(types).not.toContain('turn.started');
    expect(types).not.toContain('assistant.delta');
    expect(
      types.slice(types.indexOf('event.session.work_changed'), types.lastIndexOf('transcript.reset') + 1),
    ).toEqual(['event.session.work_changed', 'transcript.reset']);
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
    await vi.waitFor(() =>
      expect(socket.sent.some((f) => JSON.parse(f).type === 'ack')).toBe(true),
    );

    const ack = socket.sent.map((f) => JSON.parse(f)).find((f) => f.type === 'ack');
    expect(ack).toMatchObject({ code: 0, payload: { accepted: [], not_found: ['gone'] } });
    expect(conn.subscriptions.size).toBe(0);
    conn.close();
  });

  it('unsubscribe_v2 detaches listed agents with an explicit off, keeping the filter and other grades', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls, detaches } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe', { session_ids: ['s1'], agent_filter: { s1: ['main'] } }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { '*': 'delta' } }),
    );
    await vi.waitFor(() =>
      expect(conn.subscriptions.get('s1')?.transcriptGrades).toEqual({ '*': 'delta' }),
    );

    socket.emit(
      'message',
      controlFrame('unsubscribe_v2', { session_id: 's1', agent_ids: ['main'] }),
    );
    await vi.waitFor(() => expect(detaches).toHaveLength(1));

    expect(detaches[0]).toEqual({ sessionId: 's1', agentIds: ['main'] });
    // An explicit 'off' — deleting the key would fall back to the '*' default.
    expect(conn.subscriptions.get('s1')).toEqual({
      agentFilter: new Set(['main']),
      transcriptGrades: { '*': 'delta', main: 'off' },
    });
    const ack = socket.sent.map((f) => JSON.parse(f)).findLast((f) => f.type === 'ack');
    expect(ack).toMatchObject({ code: 0, payload: { accepted: ['s1'], not_found: [] } });
    conn.close();
  });

  it('unsubscribe_v2 without agent_ids detaches the whole transcript stream', async () => {
    const socket = new FakeSocket();
    const { broadcaster, detaches } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { '*': 'delta' } }),
    );
    await vi.waitFor(() =>
      expect(conn.subscriptions.get('s1')?.transcriptGrades).toEqual({ '*': 'delta' }),
    );

    socket.emit('message', controlFrame('unsubscribe_v2', { session_id: 's1' }));
    await vi.waitFor(() => expect(detaches).toHaveLength(1));

    expect(detaches[0]).toEqual({ sessionId: 's1', agentIds: undefined });
    expect(conn.subscriptions.get('s1')).toEqual({
      agentFilter: undefined,
      transcriptGrades: undefined,
    });
    conn.close();
  });

  it('unsubscribe_v2 is idempotent for an unsubscribed session and never touches the broadcaster', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls, detaches } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit('message', controlFrame('unsubscribe_v2', { session_id: 's1' }));
    await vi.waitFor(() =>
      expect(socket.sent.some((f) => JSON.parse(f).type === 'ack')).toBe(true),
    );

    expect(calls).toHaveLength(0);
    expect(detaches).toHaveLength(0);
    const ack = socket.sent.map((f) => JSON.parse(f)).find((f) => f.type === 'ack');
    expect(ack).toMatchObject({ code: 0, payload: { accepted: ['s1'] } });
    conn.close();
  });

  it('acks an invalid unsubscribe_v2 payload with an error', async () => {
    const socket = new FakeSocket();
    const { broadcaster, detaches } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit('message', controlFrame('unsubscribe_v2', { agent_ids: ['main'] }));
    socket.emit(
      'message',
      controlFrame('unsubscribe_v2', { session_id: 's1', agent_ids: [] }),
    );
    await vi.waitFor(() =>
      expect(socket.sent.filter((f) => JSON.parse(f).type === 'ack')).toHaveLength(2),
    );

    expect(detaches).toHaveLength(0);
    const acks = socket.sent.map((f) => JSON.parse(f)).filter((f) => f.type === 'ack');
    expect(acks.every((a) => a.code === 1)).toBe(true);
    conn.close();
  });

  it('serializes back-to-back control frames: subscribe then subscribe_v2 lands filter and grades', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    // No awaits between the frames — the second handler reads state the
    // first one stores, so they must run in receive order.
    socket.emit(
      'message',
      controlFrame('subscribe', { session_ids: ['s1'], agent_filter: { s1: ['main'] } }),
    );
    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { '*': 'delta' } }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(conn.subscriptions.get('s1')).toEqual({
      agentFilter: new Set(['main']),
      transcriptGrades: { '*': 'delta' },
    });
    conn.close();
  });

  it('re-subscribes an agent at full grade after it was detached', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { '*': 'delta' } }),
    );
    socket.emit('message', controlFrame('unsubscribe_v2', { session_id: 's1' }));
    await vi.waitFor(() =>
      expect(conn.subscriptions.get('s1')?.transcriptGrades).toBeUndefined(),
    );

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { main: 'turn' } }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls[1]).toMatchObject({ sessionId: 's1', grades: { main: 'turn' } });
    expect(conn.subscriptions.get('s1')?.transcriptGrades).toEqual({ main: 'turn' });
    conn.close();
  });
});

// ---------------------------------------------------------------------------
// WsConnectionV1 — flush / backpressure / close
// ---------------------------------------------------------------------------

describe('WsConnectionV1 outbound buffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('buffers server_hello and flushes it after the interval', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 16 });
    expect(socket.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(16);
    expect(socket.frames().map((f) => (f as { type: string }).type)).toContain('server_hello');
    conn.close();
  });

  it('coalesces adjacent deltas into one socket.send', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 16 });
    await vi.advanceTimersByTimeAsync(16); // flush server_hello
    socket.sent = [];

    conn.send(delta('s1', 'main', 1, 'Hello', 0));
    conn.send(delta('s1', 'main', 1, ' ', 5));
    conn.send(delta('s1', 'main', 1, 'world', 6));
    expect(socket.sent).toHaveLength(0); // still buffered
    await vi.advanceTimersByTimeAsync(16);

    const frames = socket.frames();
    expect(frames).toHaveLength(1);
    const f = frames[0] as { type: string; offset: number; payload: { delta: string } };
    expect(f.type).toBe('assistant.delta');
    expect(f.offset).toBe(0);
    expect(f.payload.delta).toBe('Hello world');
    conn.close();
  });

  it('flushes immediately once the batch reaches maxBatchSize', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 1000, maxBatchSize: 3 });
    // constructor already queued server_hello (1); two deltas bring it to 3.
    conn.send(delta('s1', 'main', 1, 'a', 0));
    conn.send(delta('s1', 'main', 1, 'b', 1));
    // No timer advanced — flush must have happened synchronously.
    const types = socket.frames().map((f) => (f as { type: string }).type);
    expect(types).toEqual(['server_hello', 'assistant.delta']);
    conn.close();
  });

  it('defers flushing while the peer is above the watermark, then coalesces on drain', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, {
      flushIntervalMs: 16,
      highWaterMarkBytes: 100,
    });
    await vi.advanceTimersByTimeAsync(16); // flush server_hello
    socket.sent = [];

    socket.bufferedAmount = 200; // above the watermark
    conn.send(delta('s1', 'main', 1, 'Hello', 0));
    await vi.advanceTimersByTimeAsync(16); // flush attempted → deferred
    expect(socket.sent).toHaveLength(0);

    // More deltas arrive while deferred — they merge into the queued frame.
    conn.send(delta('s1', 'main', 1, ' world', 5));
    await vi.advanceTimersByTimeAsync(5); // backpressure retry, still high
    expect(socket.sent).toHaveLength(0);

    socket.bufferedAmount = 0; // peer drained
    await vi.advanceTimersByTimeAsync(5); // retry succeeds
    const frames = socket.frames();
    expect(frames).toHaveLength(1);
    expect((frames[0] as { payload: { delta: string } }).payload.delta).toBe('Hello world');
    conn.close();
  });

  it('force-flushes buffered frames on close', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 1000 });
    // server_hello is still buffered (interval not elapsed).
    conn.send(delta('s1', 'main', 1, 'tail', 0));
    expect(socket.sent).toHaveLength(0);

    conn.close();
    const types = socket.frames().map((f) => (f as { type: string }).type);
    expect(types).toContain('server_hello');
    expect(types).toContain('assistant.delta');
    const tail = socket
      .frames()
      .find((f) => (f as { type: string }).type === 'assistant.delta') as {
      payload: { delta: string };
    };
    expect(tail.payload.delta).toBe('tail');
  });

  it('drops buffered frames when the socket is already closed at flush time', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 16 });
    await vi.advanceTimersByTimeAsync(16); // flush server_hello
    socket.sent = [];

    socket.readyState = socket.CLOSED; // peer went away
    conn.send(delta('s1', 'main', 1, 'lost', 0));
    await vi.advanceTimersByTimeAsync(16);
    expect(socket.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// WsConnectionV1 — global-event registration lifecycle
// ---------------------------------------------------------------------------

describe('WsConnectionV1 global target registration', () => {
  function makeGlobalTargetBroadcaster() {
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const broadcaster = {
      subscribe: async () => true,
      unsubscribe: () => {},
      addGlobalTarget: (target: unknown) => added.push(target),
      removeGlobalTarget: (target: unknown) => removed.push(target),
      getCursor: async () => ({ seq: 0, epoch: '' }),
      getBufferedSince: async () => ({
        events: [],
        resyncRequired: false,
        currentSeq: 0,
        epoch: '',
      }),
    } as unknown as SessionEventBroadcaster;
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
