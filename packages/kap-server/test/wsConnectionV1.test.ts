import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Error2, ErrorCodes, type AgentTaskOutputChunk, type IAgentTaskService } from '@moonshot-ai/agent-core-v2';
import type { AgentTaskInfo } from '@moonshot-ai/agent-core-v2/agent/task/types';

import { TASK_OUTPUT_DEFAULT_TAIL_BYTES, TASK_OUTPUT_MAX_TAIL_BYTES } from '../src/protocol/ws-task';
import type { IConnectionRegistry } from '../src/transport/ws/connectionRegistry';
import type { SessionEventBroadcaster } from '../src/transport/ws/v1/sessionEventBroadcaster';
import type { TaskSource } from '../src/transport/ws/v1/taskRequests';
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
    subscribe: async (_sessionId: string, _target: unknown, _agentIds: readonly string[], accepted?: () => void) => {
      accepted?.();
    },
    unsubscribe: () => {},
    sessionsOf: () => [],
    removeTarget: () => {},
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
    taskSource: async () => ({ kind: 'session_not_found' }),
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
    agentIds: readonly string[];
  }

  interface UnsubscribeCall {
    sessionId: string;
    agentIds?: readonly string[];
  }

  function makeCapturingBroadcaster(): {
    broadcaster: SessionEventBroadcaster;
    calls: SubscribeCall[];
    unsubscribes: UnsubscribeCall[];
    removals: unknown[];
  } {
    const calls: SubscribeCall[] = [];
    const unsubscribes: UnsubscribeCall[] = [];
    const removals: unknown[] = [];
    const subscribed = new Map<string, Set<string>>();
    const broadcaster = makeBroadcaster({
      subscribe: async (sessionId: string, _target: unknown, agentIds: readonly string[], accepted?: () => void) => {
        calls.push({ sessionId, agentIds });
        const agents = subscribed.get(sessionId) ?? new Set<string>();
        for (const agentId of agentIds) agents.add(agentId);
        subscribed.set(sessionId, agents);
        accepted?.();
      },
      unsubscribe: (sessionId: string, _target: unknown, agentIds?: readonly string[]) => {
        unsubscribes.push(agentIds === undefined ? { sessionId } : { sessionId, agentIds });
        const agents = subscribed.get(sessionId);
        for (const agentId of agentIds ?? [...(agents ?? [])]) agents?.delete(agentId);
        if (agents?.size === 0) subscribed.delete(sessionId);
      },
      sessionsOf: () => [...subscribed.keys()].toSorted(),
      removeTarget: (target: unknown) => {
        removals.push(target);
        subscribed.clear();
      },
    });
    return { broadcaster, calls, unsubscribes, removals };
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
    expect(conn.subscriptionSessionIds).toEqual([]);
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

    socket.emit('message', controlFrame('subscribe_v2', { session_id: 's1' }));
    await vi.waitFor(() => expect(types()).toEqual(['ack', 'interaction']));
    conn.close();
  });

  it('forwards subscribe_v2 agent ids to the broadcaster, defaulting to the main agent', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit('message', controlFrame('subscribe_v2', { session_id: 's1' }));
    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's2', agent_ids: ['main', 'agent-0'] }),
    );
    await vi.waitFor(() => expect(acks(socket)).toHaveLength(2));

    expect(calls).toEqual([
      { sessionId: 's1', agentIds: ['main'] },
      { sessionId: 's2', agentIds: ['main', 'agent-0'] },
    ]);
    expect(conn.subscriptionSessionIds).toEqual(['s1', 's2']);
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

    socket.emit('message', controlFrame('subscribe_v2', { session_id: 's1', agent_ids: [] }));
    await vi.waitFor(() => expect(acks(socket)).toHaveLength(1));

    expect(calls).toHaveLength(0);
    expect(conn.subscriptionSessionIds).toEqual([]);
    expect(acks(socket)[0]!.code).toBe(1);
    conn.close();
  });

  it('reports an unknown session with 40401 and the not_found list', async () => {
    const socket = new FakeSocket();
    const { broadcaster } = makeCapturingBroadcaster();
    broadcaster.subscribe = async () => {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, 'session not found: gone');
    };
    const conn = makeConn(socket, { broadcaster });

    socket.emit('message', controlFrame('subscribe_v2', { session_id: 'gone' }));
    await vi.waitFor(() => expect(acks(socket)).toHaveLength(1));

    expect(acks(socket)[0]).toMatchObject({
      code: 40401,
      payload: { accepted: [], not_found: ['gone'] },
    });
    expect(conn.subscriptionSessionIds).toEqual([]);
    conn.close();
  });

  it('reports why a session cannot be opened without listing it as not found', async () => {
    const socket = new FakeSocket();
    const { broadcaster } = makeCapturingBroadcaster();
    broadcaster.subscribe = async () => {
      throw new Error2(ErrorCodes.WIRE_VERSION_TOO_LOW, 'upgrade to read this session');
    };
    const conn = makeConn(socket, { broadcaster });

    socket.emit('message', controlFrame('subscribe_v2', { session_id: 'newer' }));
    await vi.waitFor(() => expect(acks(socket)).toHaveLength(1));

    expect(acks(socket)[0]).toMatchObject({
      code: 40930,
      msg: 'upgrade to read this session',
      payload: { accepted: [], not_found: [] },
    });
    expect(conn.subscriptionSessionIds).toEqual([]);
    conn.close();
  });

  it('unsubscribe_v2 with agent_ids keeps the session while another agent stays subscribed', async () => {
    const socket = new FakeSocket();
    const { broadcaster, unsubscribes } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', agent_ids: ['main', 'agent-0'] }),
    );
    socket.emit(
      'message',
      controlFrame('unsubscribe_v2', { session_id: 's1', agent_ids: ['main'] }),
    );
    await vi.waitFor(() => expect(acks(socket)).toHaveLength(2));

    expect(unsubscribes).toEqual([{ sessionId: 's1', agentIds: ['main'] }]);
    expect(conn.subscriptionSessionIds).toEqual(['s1']);
    expect(acks(socket)[1]).toMatchObject({
      code: 0,
      payload: { accepted: ['s1'], not_found: [] },
    });
    conn.close();
  });

  it('unsubscribe_v2 drops the session once no agent stays subscribed', async () => {
    const socket = new FakeSocket();
    const { broadcaster, unsubscribes } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit('message', controlFrame('subscribe_v2', { session_id: 's1' }));
    socket.emit('message', controlFrame('subscribe_v2', { session_id: 's2' }));
    socket.emit(
      'message',
      controlFrame('unsubscribe_v2', { session_id: 's1', agent_ids: ['main'] }),
    );
    socket.emit('message', controlFrame('unsubscribe_v2', { session_id: 's2' }));
    await vi.waitFor(() => expect(acks(socket)).toHaveLength(4));

    expect(unsubscribes).toEqual([{ sessionId: 's1', agentIds: ['main'] }, { sessionId: 's2' }]);
    expect(conn.subscriptionSessionIds).toEqual([]);
    conn.close();
  });

  it('unsubscribe_v2 acks an unsubscribed session and leaves the no-op to the broadcaster', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls, unsubscribes } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit('message', controlFrame('unsubscribe_v2', { session_id: 's1' }));
    await vi.waitFor(() => expect(acks(socket)).toHaveLength(1));

    expect(calls).toHaveLength(0);
    expect(unsubscribes).toEqual([{ sessionId: 's1' }]);
    expect(conn.subscriptionSessionIds).toEqual([]);
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

    socket.emit('message', controlFrame('subscribe_v2', { session_id: 's1' }));
    socket.emit('message', controlFrame('unsubscribe_v2', { session_id: 's1' }));
    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', agent_ids: ['agent-0'] }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls[1]).toEqual({ sessionId: 's1', agentIds: ['agent-0'] });
    expect(conn.subscriptionSessionIds).toEqual(['s1']);
    conn.close();
  });

  it('removes itself from the broadcaster when the socket closes', async () => {
    const socket = new FakeSocket();
    const { broadcaster, removals } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit('message', controlFrame('subscribe_v2', { session_id: 's1' }));
    socket.emit('message', controlFrame('subscribe_v2', { session_id: 's2' }));
    await vi.waitFor(() => expect(conn.subscriptionSessionIds).toEqual(['s1', 's2']));

    socket.emit('close');
    expect(removals).toEqual([conn]);
    expect(conn.subscriptionSessionIds).toEqual([]);
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

    conn.send(frame('turn.started', 's1', 7));
    conn.send(frame('item.delta', 's1', 8));
    conn.send(frame('item.delta', 's1', 9));
    expect(socket.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15);
    expect(socket.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    const frames = socket.frames() as Array<{ type: string; payload: { seq: number } }>;
    expect(frames.map((f) => f.type)).toEqual([
      'turn.started',
      'item.delta',
      'item.delta',
    ]);
    expect(frames.map((f) => f.payload.seq)).toEqual([7, 8, 9]);
    conn.close();
  });

  it('sends immediate frames at once and preserves FIFO with buffered frames', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 16 });
    socket.sent = [];

    conn.send(frame('item.delta', 's1', 1));
    expect(socket.sent).toHaveLength(0);
    conn.send(frame('event.session.work_changed', 's1', 2), 'immediate');

    expect(socket.frames().map((f) => (f as { type: string }).type)).toEqual([
      'item.delta',
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

    conn.send(frame('item.delta', 's1', 1));
    conn.send(frame('item.delta', 's1', 2));
    expect(socket.sent).toHaveLength(0);
    conn.send(frame('item.delta', 's1', 3));

    expect(socket.sent).toHaveLength(3);
    conn.close();
  });

  it('defers flushing while the peer is above the watermark, then drains', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 16, highWaterMarkBytes: 100 });
    socket.sent = [];

    socket.bufferedAmount = 200;
    conn.send(frame('item.delta', 's1', 1));
    await vi.advanceTimersByTimeAsync(16);
    expect(socket.sent).toHaveLength(0);

    conn.send(frame('item.delta', 's1', 2));
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

    conn.send(frame('item.delta', 's1', 1));
    expect(socket.sent).toHaveLength(0);

    conn.close();
    expect(socket.frames()).toHaveLength(1);
  });

  it('drops buffered frames when the socket is already closed at flush time', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 16 });
    socket.sent = [];

    socket.readyState = socket.CLOSED;
    conn.send(frame('item.delta', 's1', 1));
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
      removeTarget: (target: unknown) => removed.push(target),
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

describe('WsConnectionV1 task output', () => {
  interface FakeTaskOutput {
    readonly source: TaskSource;
    write(text: string): void;
    readonly listenerCount: () => number;
    readonly sourceCalls: () => number;
    holdTailRead(): () => void;
    holdSource(): () => void;
    failTailRead(): void;
    corruptTailRead(): void;
    withholdTailBytes(count: number): void;
    refuseDetach(): void;
  }

  function makeTaskOutput(taskId: string, initial = '', ownerAgentId = 'main'): FakeTaskOutput {
    let bytes = Buffer.from(initial, 'utf-8');
    const listeners = new Set<(chunk: AgentTaskOutputChunk) => void>();
    let detachable = true;
    let gate: Promise<void> | undefined;
    let sourceGate: Promise<void> | undefined;
    let sourceCalls = 0;
    let tailReadFails = false;
    let tailReadCorrupt = false;
    let withheld = 0;
    let info: AgentTaskInfo = {
      taskId,
      kind: 'process',
      description: 'dev server',
      status: 'running',
      detached: false,
      startedAt: 1_700_000_000_000,
      endedAt: null,
      command: 'npm run dev',
      pid: 1,
      exitCode: null,
      parentToolCallId: 'call_bash',
    };
    const tasks = {
      getTask: (id: string) => (id === taskId ? info : undefined),
      stopByUser: async (id: string) => {
        if (id !== taskId) return undefined;
        info = { ...info, status: 'killed', endedAt: 1_700_000_005_000 };
        return info;
      },
      detach: (id: string) => {
        if (id !== taskId) return undefined;
        if (detachable) info = { ...info, detached: true };
        return info;
      },
      onDidAppendOutput: (listener: (chunk: AgentTaskOutputChunk) => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      readOutputTail: async (_id: string, maxBytes: number) => {
        await gate;
        if (tailReadFails) throw new Error('EACCES: permission denied');
        if (tailReadCorrupt) return { offset: 0, data: undefined };
        const visible = bytes.subarray(0, bytes.byteLength - withheld);
        const offset = Math.max(0, visible.byteLength - maxBytes);
        return { offset, data: new Uint8Array(visible.subarray(offset)) };
      },
    } as unknown as IAgentTaskService;
    return {
      source: async (sessionId, agentId, id) => {
        sourceCalls += 1;
        await sourceGate;
        if (sessionId !== 's1') return { kind: 'session_not_found' };
        if (agentId !== ownerAgentId || id !== taskId) return { kind: 'task_not_found' };
        return { kind: 'found', tasks };
      },
      sourceCalls: () => sourceCalls,
      holdSource: () => {
        let release!: () => void;
        sourceGate = new Promise((resolve) => {
          release = resolve;
        });
        return () => {
          sourceGate = undefined;
          release();
        };
      },
      corruptTailRead: () => {
        tailReadCorrupt = true;
      },
      withholdTailBytes: (count) => {
        withheld = count;
      },
      write: (text) => {
        const offset = bytes.byteLength;
        bytes = Buffer.concat([bytes, Buffer.from(text, 'utf-8')]);
        for (const listener of listeners) listener({ taskId, offset, text });
      },
      listenerCount: () => listeners.size,
      holdTailRead: () => {
        let release!: () => void;
        gate = new Promise((resolve) => {
          release = resolve;
        });
        return () => {
          gate = undefined;
          release();
        };
      },
      failTailRead: () => {
        tailReadFails = true;
      },
      refuseDetach: () => {
        detachable = false;
      },
    };
  }

  function send(socket: FakeSocket, frame: Record<string, unknown>): void {
    socket.emit('message', JSON.stringify(frame));
  }

  function taskFrames(socket: FakeSocket): unknown[] {
    return socket.frames().filter((frame) => (frame as { type: string }).type !== 'server_hello');
  }

  const ok = (requestId: string): unknown =>
    expect.objectContaining({ type: 'response', request_id: requestId, code: 0 });

  const startLines =
    '\n> web@0.1.0 dev\n> vite\n\n  VITE v6.3.5  ready in 412 ms\n\n  ➜  Local:   http://localhost:5173/\n';
  const hmrLine = '4:42:10 PM [vite] hmr update /src/App.vue\n';

  it('replies, sends the current output from offset 0, then streams new output', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab', startLines);
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });

    send(socket, { type: 'task.watch', request_id: 'r1', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(2));
    output.write(hmrLine);
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(3));

    expect(taskFrames(socket)).toEqual([
      ok('r1'),
      { type: 'task.output', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab', offset: 0, text: startLines },
      {
        type: 'task.output',
        session_id: 's1',
        agent_id: 'main',
        task_id: 'bash-k3f9x2ab',
        offset: Buffer.byteLength(startLines, 'utf-8'),
        text: hmrLine,
      },
    ]);
    conn.close();
  });

  it('sends only the output after since_offset when it is within the tail', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab', startLines + hmrLine);
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });
    const since = Buffer.byteLength(startLines, 'utf-8');

    send(socket, {
      type: 'task.watch',
      request_id: 'r1',
      session_id: 's1',
      agent_id: 'main',
      task_id: 'bash-k3f9x2ab',
      since_offset: since,
    });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(2));

    expect(taskFrames(socket)[1]).toEqual({
      type: 'task.output',
      session_id: 's1',
      agent_id: 'main',
      task_id: 'bash-k3f9x2ab',
      offset: since,
      text: hmrLine,
    });
    conn.close();
  });

  it('sends an empty first chunk when since_offset is already at the end', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab', startLines);
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });
    const end = Buffer.byteLength(startLines, 'utf-8');

    send(socket, {
      type: 'task.watch',
      request_id: 'r1',
      session_id: 's1',
      agent_id: 'main',
      task_id: 'bash-k3f9x2ab',
      since_offset: end,
    });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(taskFrames(socket)).toEqual([
      ok('r1'),
      { type: 'task.output', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab', offset: end, text: '' },
    ]);
    conn.close();
  });

  it('sends an empty first chunk when the task has no output yet', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab');
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });

    send(socket, { type: 'task.watch', request_id: 'r1', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(2));

    expect(taskFrames(socket)[1]).toEqual({
      type: 'task.output',
      session_id: 's1',
      agent_id: 'main',
      task_id: 'bash-k3f9x2ab',
      offset: 0,
      text: '',
    });
    conn.close();
  });

  it('falls back to the last tail bytes aligned to a character boundary when since_offset is too old', async () => {
    const filler = 'x'.repeat(TASK_OUTPUT_DEFAULT_TAIL_BYTES * 2);
    const total = filler + '➜' + 'y'.repeat(TASK_OUTPUT_DEFAULT_TAIL_BYTES - 2);
    const output = makeTaskOutput('bash-k3f9x2ab', total);
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });

    send(socket, {
      type: 'task.watch',
      request_id: 'r1',
      session_id: 's1',
      agent_id: 'main',
      task_id: 'bash-k3f9x2ab',
      since_offset: 12,
    });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(2));

    const totalBytes = Buffer.byteLength(total, 'utf-8');
    const first = taskFrames(socket)[1] as { offset: number; text: string };
    expect(first.offset).toBe(totalBytes - TASK_OUTPUT_DEFAULT_TAIL_BYTES + 2);
    expect(first.text).toBe('y'.repeat(TASK_OUTPUT_DEFAULT_TAIL_BYTES - 2));
    expect(first.text).not.toContain('\uFFFD');
    conn.close();
  });

  it('falls back to the tail start when since_offset splits a character', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab', startLines);
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });
    const arrowStart = Buffer.from(startLines, 'utf-8').indexOf(Buffer.from('➜', 'utf-8'));

    send(socket, {
      type: 'task.watch',
      request_id: 'r1',
      session_id: 's1',
      agent_id: 'main',
      task_id: 'bash-k3f9x2ab',
      since_offset: arrowStart + 1,
    });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(2));

    expect(taskFrames(socket)[1]).toEqual({
      type: 'task.output',
      session_id: 's1',
      agent_id: 'main',
      task_id: 'bash-k3f9x2ab',
      offset: 0,
      text: startLines,
    });
    conn.close();
  });

  it('drops output already covered by the first chunk and forwards output written during the read', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab', startLines);
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });
    const release = output.holdTailRead();

    send(socket, { type: 'task.watch', request_id: 'r1', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    await vi.waitFor(() => expect(output.listenerCount()).toBe(1));
    output.write(hmrLine);
    release();
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(taskFrames(socket)).toEqual([
      ok('r1'),
      {
        type: 'task.output',
        session_id: 's1',
        agent_id: 'main',
        task_id: 'bash-k3f9x2ab',
        offset: 0,
        text: startLines + hmrLine,
      },
    ]);
    conn.close();
  });

  it('stops streaming after task.unwatch and replies to it', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab', startLines);
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });

    send(socket, { type: 'task.watch', request_id: 'r1', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(2));
    send(socket, { type: 'task.unwatch', request_id: 'r2', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(3));
    output.write(hmrLine);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(taskFrames(socket)[2]).toEqual(ok('r2'));
    expect(taskFrames(socket)).toHaveLength(3);
    expect(output.listenerCount()).toBe(0);
    conn.close();
  });

  it('applies an unwatch sent during a pending watch after that watch completes', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab', startLines);
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });
    const release = output.holdTailRead();

    send(socket, { type: 'task.watch', request_id: 'r1', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    await vi.waitFor(() => expect(output.listenerCount()).toBe(1));
    send(socket, { type: 'task.unwatch', request_id: 'r2', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(taskFrames(socket)).toEqual([]);
    release();
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(3));

    expect(taskFrames(socket)).toEqual([
      ok('r1'),
      { type: 'task.output', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab', offset: 0, text: startLines },
      ok('r2'),
    ]);
    expect(output.listenerCount()).toBe(0);
    conn.close();
  });

  it('does not hold a watch behind a slow watch of another task', async () => {
    const slow = makeTaskOutput('bash-slow0001', startLines);
    const fast = makeTaskOutput('bash-fast0001', hmrLine);
    const socket = new FakeSocket();
    const conn = makeConn(socket, {
      taskSource: (sessionId, agentId, taskId) =>
        (taskId === 'bash-slow0001' ? slow : fast).source(sessionId, agentId, taskId),
    });
    const release = slow.holdTailRead();

    send(socket, { type: 'task.watch', request_id: 'r1', session_id: 's1', agent_id: 'main', task_id: 'bash-slow0001' });
    send(socket, { type: 'task.watch', request_id: 'r2', session_id: 's1', agent_id: 'main', task_id: 'bash-fast0001' });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(2));
    expect(taskFrames(socket)[0]).toEqual(ok('r2'));

    release();
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(4));
    expect(taskFrames(socket)[2]).toEqual(ok('r1'));
    conn.close();
  });

  it('limits the first chunk to tail_bytes', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab', startLines + hmrLine);
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });

    send(socket, {
      type: 'task.watch',
      request_id: 'r1',
      session_id: 's1',
      agent_id: 'main',
      task_id: 'bash-k3f9x2ab',
      tail_bytes: Buffer.byteLength(hmrLine, 'utf-8'),
    });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(2));

    expect(taskFrames(socket)[1]).toMatchObject({
      offset: Buffer.byteLength(startLines, 'utf-8'),
      text: hmrLine,
    });
    conn.close();
  });

  it('streams a task owned by a subagent under that agent id', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab', startLines, 'agent-sub1');
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });

    send(socket, { type: 'task.watch', request_id: 'r1', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    send(socket, { type: 'task.watch', request_id: 'r2', session_id: 's1', agent_id: 'agent-sub1', task_id: 'bash-k3f9x2ab' });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(3));

    expect(taskFrames(socket)).toEqual([
      { type: 'response', request_id: 'r1', code: 40406, msg: 'task not found' },
      ok('r2'),
      { type: 'task.output', session_id: 's1', agent_id: 'agent-sub1', task_id: 'bash-k3f9x2ab', offset: 0, text: startLines },
    ]);
    conn.close();
  });

  it('replies with error codes for unknown sessions, unknown tasks, and invalid messages', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab');
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });

    send(socket, { type: 'task.watch', request_id: 'r1', session_id: 's2', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    send(socket, { type: 'task.watch', request_id: 'r2', session_id: 's1', agent_id: 'main', task_id: 'bash-00000000' });
    send(socket, { type: 'task.watch', request_id: 'r3', session_id: 's1', agent_id: 'main' });
    send(socket, { type: 'task.watch', request_id: 'r4', session_id: 's1', agent_id: 'main', task_id: '' });
    send(socket, { type: 'task.unwatch', request_id: 'r5', session_id: '', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    send(socket, { type: 'task.watch', request_id: 'r6', session_id: 's1', task_id: 'bash-k3f9x2ab' });
    send(socket, {
      type: 'task.watch',
      request_id: 'r7',
      session_id: 's1',
      agent_id: 'main',
      task_id: 'bash-k3f9x2ab',
      tail_bytes: TASK_OUTPUT_MAX_TAIL_BYTES + 1,
    });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(7));

    const codes = Object.fromEntries(
      (taskFrames(socket) as Array<{ request_id: string; code: number }>).map((frame) => [
        frame.request_id,
        frame.code,
      ]),
    );
    expect(codes).toEqual({
      r1: 40401,
      r2: 40406,
      r3: 40001,
      r4: 40001,
      r5: 40001,
      r6: 40001,
      r7: 40001,
    });
    conn.close();
  });

  it('replies with an internal error when the task lookup throws', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, {
      taskSource: async () => {
        throw new Error('session restore failed');
      },
    });

    send(socket, { type: 'task.watch', request_id: 'r1', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(1));

    expect(taskFrames(socket)).toEqual([
      { type: 'response', request_id: 'r1', code: 50001, msg: 'internal error' },
    ]);
    conn.close();
  });

  it('replies with a persistence error and releases the watch when the output cannot be read', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab', startLines);
    output.failTailRead();
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });

    send(socket, { type: 'task.watch', request_id: 'r1', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(1));
    output.write(hmrLine);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(taskFrames(socket)).toEqual([
      { type: 'response', request_id: 'r1', code: 50003, msg: 'task output unavailable' },
    ]);
    expect(output.listenerCount()).toBe(0);
    conn.close();
  });

  it('closes the connection with 1008 when a task output message has no readable request_id', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab');
    const socket = new FakeSocket();
    makeConn(socket, { taskSource: output.source });

    send(socket, { type: 'task.watch', session_id: 's1', task_id: 'bash-k3f9x2ab' });
    await vi.waitFor(() => expect(socket.closeCalls).toHaveLength(1));

    expect(socket.closeCalls[0]).toEqual({ code: 1008, reason: 'invalid message' });
    expect(taskFrames(socket)).toEqual([]);
  });

  it('releases watches when the connection closes', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab', startLines);
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });

    send(socket, { type: 'task.watch', request_id: 'r1', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(2));
    conn.close();

    expect(output.listenerCount()).toBe(0);
  });

  it('does not resolve watches still queued when the connection closes', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab', startLines);
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });
    const release = output.holdSource();

    send(socket, { type: 'task.watch', request_id: 'r1', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    send(socket, { type: 'task.watch', request_id: 'r2', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    await vi.waitFor(() => expect(output.sourceCalls()).toBe(1));
    conn.close();
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(output.sourceCalls()).toBe(1);
    expect(output.listenerCount()).toBe(0);
  });

  it('replies with an internal error and releases the watch when streaming setup throws', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab', startLines);
    output.corruptTailRead();
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });

    send(socket, { type: 'task.watch', request_id: 'r1', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(1));

    expect(taskFrames(socket)).toEqual([
      { type: 'response', request_id: 'r1', code: 50001, msg: 'internal error' },
    ]);
    expect(output.listenerCount()).toBe(0);
    conn.close();
  });

  it('forwards the unread rest of a chunk the tail read caught mid-write', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab', startLines);
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });
    const release = output.holdTailRead();
    const line = 'héllo\n';

    send(socket, { type: 'task.watch', request_id: 'r1', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    await vi.waitFor(() => expect(output.listenerCount()).toBe(1));
    output.write(line);
    output.withholdTailBytes(Buffer.byteLength(line, 'utf-8') - 2);
    release();
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(3));

    const start = Buffer.byteLength(startLines, 'utf-8');
    expect(taskFrames(socket).slice(1)).toEqual([
      {
        type: 'task.output',
        session_id: 's1',
        agent_id: 'main',
        task_id: 'bash-k3f9x2ab',
        offset: 0,
        text: `${startLines}h`,
      },
      {
        type: 'task.output',
        session_id: 's1',
        agent_id: 'main',
        task_id: 'bash-k3f9x2ab',
        offset: start + 1,
        text: 'éllo\n',
      },
    ]);
    conn.close();
  });

  it('replies to a watch with the current state of the task', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab', startLines);
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });

    send(socket, { type: 'task.watch', request_id: 'r1', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(2));

    expect(taskFrames(socket)[0]).toEqual({
      type: 'response',
      request_id: 'r1',
      code: 0,
      task: {
        task_id: 'bash-k3f9x2ab',
        kind: 'shell',
        status: 'running',
        detached: false,
        description: 'dev server',
        parent_tool_call_id: 'call_bash',
        command: 'npm run dev',
        started_at: new Date(1_700_000_000_000).toISOString(),
      },
    });
    conn.close();
  });

  it('stops a task and moves a task to the background, replying with its new state', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab');
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });

    send(socket, { type: 'task.background', request_id: 'r1', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    send(socket, { type: 'task.stop', request_id: 'r2', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    send(socket, { type: 'task.stop', request_id: 'r3', session_id: 's1', agent_id: 'main', task_id: 'bash-00000000' });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(3));

    const responses = new Map(
      (taskFrames(socket) as Array<{ request_id: string; code: number; task?: unknown }>).map((frame) => [
        frame.request_id,
        frame,
      ]),
    );
    expect(responses.get('r1')).toMatchObject({ code: 0, task: { status: 'running', detached: true } });
    expect(responses.get('r2')).toMatchObject({
      code: 0,
      task: { status: 'ended', outcome: 'killed', detached: true },
    });
    expect(responses.get('r3')).toMatchObject({ code: 40406 });
    conn.close();
  });

  it('refuses to move a task to the background when it stays in the foreground', async () => {
    const output = makeTaskOutput('agent-member');
    output.refuseDetach();
    const socket = new FakeSocket();
    const conn = makeConn(socket, { taskSource: output.source });

    send(socket, { type: 'task.background', request_id: 'r1', session_id: 's1', agent_id: 'main', task_id: 'agent-member' });
    await vi.waitFor(() => expect(taskFrames(socket)).toHaveLength(1));

    expect(taskFrames(socket)[0]).toMatchObject({
      type: 'response',
      request_id: 'r1',
      code: 40933,
      msg: 'task cannot be moved to the background',
      task: { status: 'running', detached: false },
    });
    conn.close();
  });

  it('closes the connection with 1008 when a task command has no readable request_id', async () => {
    const output = makeTaskOutput('bash-k3f9x2ab');
    const socket = new FakeSocket();
    makeConn(socket, { taskSource: output.source });

    send(socket, { type: 'task.stop', session_id: 's1', agent_id: 'main', task_id: 'bash-k3f9x2ab' });
    await vi.waitFor(() => expect(socket.closeCalls).toHaveLength(1));

    expect(socket.closeCalls[0]).toEqual({ code: 1008, reason: 'invalid message' });
  });
});
