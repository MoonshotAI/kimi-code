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
