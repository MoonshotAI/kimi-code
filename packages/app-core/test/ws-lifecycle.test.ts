
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DaemonEventSocket, type DaemonEventSocketHandlers } from '../src/api';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev?: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(
    public readonly url: string,
    public readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
  }

  emitMessage(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  open(): void {
    this.onopen?.();
  }
}

function makeHandlers(): DaemonEventSocketHandlers & {
  states: boolean[];
  interactionLog: string[];
} {
  const states: boolean[] = [];
  const interactionLog: string[] = [];
  return {
    states,
    interactionLog,
    onWireEvent: () => {},
    onInteraction: (interaction) => interactionLog.push(interaction.interaction_id),
    onInteractionsReset: (sessionId) => interactionLog.push(`reset:${sessionId}`),
    onConnectionState: (connected) => states.push(connected),
    onError: () => {},
  };
}

const WS_URL = 'ws://example.test/ws';

describe('DaemonEventSocket reconnect + staleness', () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it('reconnect() closes the old socket, detaches it, and opens a new one', () => {
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket({ wsUrl: WS_URL, handlers });
    socket.connect();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    expect(handlers.states).toEqual([true]);

    socket.reconnect();

    expect(first.closeCalls).toEqual([{ code: 1000, reason: 'reconnect' }]);
    expect(first.onclose).toBeNull();
    expect(first.onmessage).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(handlers.states).toEqual([true, false]);

    first.onclose?.({ code: 1000, reason: 'reconnect', wasClean: true });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('sends no handshake and answers pings with a bare pong', () => {
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket({ wsUrl: WS_URL, handlers });
    socket.connect();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    expect(handlers.states).toEqual([true]);
    expect(first.sent).toEqual([]);

    first.emitMessage({ type: 'ping' });
    expect(first.sent.map((raw) => JSON.parse(raw) as unknown)).toEqual([{ type: 'pong' }]);
  });

  it('reconnects once nothing has arrived for 25 seconds', () => {
    vi.useFakeTimers();
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket({ wsUrl: WS_URL, handlers });
    socket.connect();
    const first = FakeWebSocket.instances[0]!;
    first.open();

    vi.advanceTimersByTime(25_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(5_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(first.closeCalls).toEqual([{ code: 1000, reason: 'reconnect' }]);
    expect(handlers.states).toEqual([true, false]);
    socket.close();
  });

  it('keeps the connection while the server keeps pinging', () => {
    vi.useFakeTimers();
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket({ wsUrl: WS_URL, handlers });
    socket.connect();
    const first = FakeWebSocket.instances[0]!;
    first.open();

    for (let i = 0; i < 6; i += 1) {
      vi.advanceTimersByTime(10_000);
      first.emitMessage({ type: 'ping' });
    }
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(handlers.states).toEqual([true]);
    socket.close();
  });

  it('stops checking for a dead connection after close()', () => {
    vi.useFakeTimers();
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket({ wsUrl: WS_URL, handlers });
    socket.connect();
    FakeWebSocket.instances[0]!.open();
    socket.close();

    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('resets interactions on each accepted subscription before forwarding interaction frames', () => {
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket({ wsUrl: WS_URL, handlers });
    socket.connect();
    const first = FakeWebSocket.instances[0]!;
    socket.subscribeConversation('sess_1', 'main');
    first.open();
    const lastSubscribe = () =>
      first.sent
        .map((raw) => JSON.parse(raw) as { type: string; request_id: string })
        .filter((frame) => frame.type === 'subscribe')
        .at(-1)!;
    const interaction = (id: string) => ({
      type: 'interaction',
      session_id: 'sess_1',
      agent_id: 'main',
      event_created_at: '2026-01-01T00:00:00.000Z',
      interaction_id: id,
      kind: 'question',
      status: 'pending',
      request: { questions: [] },
    });

    first.emitMessage({ type: 'response', request_id: lastSubscribe().request_id, code: 0 });
    first.emitMessage(interaction('seed-1'));
    first.emitMessage(interaction('seed-2'));
    first.emitMessage({ type: 'ping' });
    first.emitMessage(interaction('live-1'));

    socket.subscribeConversation('sess_1', 'main');
    first.emitMessage({ type: 'response', request_id: lastSubscribe().request_id, code: 0 });
    first.emitMessage(interaction('seed-3'));

    expect(handlers.interactionLog).toEqual([
      'reset:sess_1',
      'seed-1',
      'seed-2',
      'live-1',
      'reset:sess_1',
      'seed-3',
    ]);
  });

  it('reconnect() is a no-op after close()', () => {
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket({ wsUrl: WS_URL, handlers });
    socket.connect();
    socket.close();
    socket.reconnect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('health() flips stale after a long silence and clears on the next frame', () => {
    vi.useFakeTimers();
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket({ wsUrl: WS_URL, handlers });
    socket.connect();
    const first = FakeWebSocket.instances[0]!;
    first.open();

    expect(socket.health().stale).toBe(false);

    vi.advanceTimersByTime(26_000);
    expect(socket.health().stale).toBe(true);

    first.emitMessage({ type: 'ping' });
    expect(socket.health().stale).toBe(false);
  });

  it('health().open reflects the underlying readyState', () => {
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket({ wsUrl: WS_URL, handlers });
    socket.connect();
    const first = FakeWebSocket.instances[0]!;
    expect(socket.health().open).toBe(true);
    first.readyState = FakeWebSocket.CLOSING;
    expect(socket.health().open).toBe(false);
  });
});

describe('DaemonEventSocket subscribe retry', () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  function sentFrames(ws: FakeWebSocket, type: string): Record<string, unknown>[] {
    return ws.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame['type'] === type);
  }

  function failedResponse(requestId: unknown, code = 50001): unknown {
    return { type: 'response', request_id: requestId, code, msg: 'session cannot be opened' };
  }

  function advanceWhilePinged(ws: FakeWebSocket, ms: number): void {
    for (let elapsed = 0; elapsed < ms; elapsed += 10_000) {
      vi.advanceTimersByTime(Math.min(10_000, ms - elapsed));
      ws.emitMessage({ type: 'ping' });
    }
  }

  it('retries a subscription the server could not open and stops once accepted', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket({ wsUrl: WS_URL, handlers });
    socket.connect();
    const first = FakeWebSocket.instances[0]!;
    first.open();

    socket.subscribeConversation('sess_1', 'main');
    const initial = sentFrames(first, 'subscribe');
    expect(initial).toHaveLength(1);

    first.emitMessage(failedResponse(initial[0]!['request_id']));
    expect(warnSpy).toHaveBeenCalledWith(
      'session event subscribe failed; scheduling retry',
      { sessionId: 'sess_1', code: 50001 },
    );

    vi.advanceTimersByTime(250);
    const retried = sentFrames(first, 'subscribe');
    expect(retried).toHaveLength(2);
    expect(retried[1]!['request_id']).not.toBe(initial[0]!['request_id']);
    expect(infoSpy).toHaveBeenCalledWith('session event subscribe retry', {
      sessionId: 'sess_1',
      attempt: 1,
    });

    first.emitMessage({ type: 'response', request_id: retried[1]!['request_id'], code: 0 });
    expect(infoSpy).toHaveBeenCalledWith('session event subscribe restored', {
      sessionId: 'sess_1',
    });

    vi.advanceTimersByTime(30_000);
    expect(sentFrames(first, 'subscribe')).toHaveLength(2);
  });

  it('resends the earlier agents of a session when another agent joins', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket({ wsUrl: WS_URL, handlers });
    socket.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();

    socket.subscribeConversation('sess_1', 'main');
    socket.subscribeConversation('sess_1', 'agent_1');
    const [mainOnly, joined] = sentFrames(ws, 'subscribe');
    expect(joined).toMatchObject({ session_id: 'sess_1', agent_ids: ['main', 'agent_1'] });

    ws.emitMessage(failedResponse(mainOnly!['request_id']));
    ws.emitMessage({ type: 'response', request_id: joined!['request_id'], code: 0 });
    vi.advanceTimersByTime(30_000);
    expect(sentFrames(ws, 'subscribe')).toHaveLength(2);
  });

  it('stops retrying after unsubscribeConversation', () => {
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket({ wsUrl: WS_URL, handlers });
    socket.connect();
    const first = FakeWebSocket.instances[0]!;
    first.open();

    socket.subscribeConversation('sess_1', 'main');
    const initial = sentFrames(first, 'subscribe');
    first.emitMessage(failedResponse(initial[0]!['request_id']));

    socket.unsubscribeConversation('sess_1');
    vi.advanceTimersByTime(30_000);
    expect(sentFrames(first, 'subscribe')).toHaveLength(1);
  });

  it('falls back to slow retry after the fast retry budget', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket({ wsUrl: WS_URL, handlers });
    socket.connect();
    const first = FakeWebSocket.instances[0]!;
    first.open();

    socket.subscribeConversation('sess_1', 'main');
    for (let i = 0; i < 8; i += 1) {
      const frames = sentFrames(first, 'subscribe');
      first.emitMessage(failedResponse(frames.at(-1)!['request_id']));
      vi.advanceTimersByTime(5_000);
    }
    const exhausted = sentFrames(first, 'subscribe');
    expect(exhausted).toHaveLength(1 + 8);

    first.emitMessage(failedResponse(exhausted.at(-1)!['request_id']));
    expect(warnSpy).toHaveBeenCalledWith(
      'session event subscribe retry budget exhausted; falling back to slow retry',
      { sessionId: 'sess_1', attempts: 8 },
    );
    advanceWhilePinged(first, 30_000);
    expect(sentFrames(first, 'subscribe')).toHaveLength(10);

    first.emitMessage(failedResponse(sentFrames(first, 'subscribe').at(-1)!['request_id']));
    advanceWhilePinged(first, 30_000);
    expect(sentFrames(first, 'subscribe')).toHaveLength(11);
  });

  it('resubscribes the conversation agents after a reconnect', () => {
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket({ wsUrl: WS_URL, handlers });
    socket.connect();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    socket.subscribeConversation('sess_1', 'main');

    socket.reconnect();
    const second = FakeWebSocket.instances[1]!;
    second.open();

    expect(second.sent.map((raw) => (JSON.parse(raw) as { type: string }).type)).toEqual(['subscribe']);
    expect(sentFrames(second, 'subscribe')[0]).toMatchObject({
      session_id: 'sess_1',
      agent_ids: ['main'],
    });
  });
});

describe('DaemonEventSocket task output', () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  function sentFrames(ws: FakeWebSocket, type: string): Record<string, unknown>[] {
    return ws.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame['type'] === type);
  }

  function connect(
    onTaskOutput: DaemonEventSocketHandlers['onTaskOutput'],
    onTaskOutputFailed?: DaemonEventSocketHandlers['onTaskOutputFailed'],
  ): {
    socket: DaemonEventSocket;
    ws: FakeWebSocket;
  } {
    const socket = new DaemonEventSocket({
      wsUrl: WS_URL,
      handlers: { ...makeHandlers(), onTaskOutput, onTaskOutputFailed },
    });
    socket.connect();
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    return { socket, ws };
  }

  it('watches once, forwards output, and unwatches', () => {
    const chunks: unknown[] = [];
    const { socket, ws } = connect((...args) => chunks.push(args));

    socket.watchTaskOutput('sess_1', 'main', 'task_1');
    socket.watchTaskOutput('sess_1', 'main', 'task_1');
    const [watch, ...rest] = sentFrames(ws, 'task.watch');
    expect(rest).toEqual([]);
    expect(watch).toMatchObject({ session_id: 'sess_1', agent_id: 'main', task_id: 'task_1' });
    expect(watch).not.toHaveProperty('since_offset');

    ws.emitMessage({ type: 'response', request_id: watch!['request_id'], code: 0 });
    ws.emitMessage({ type: 'task.output', session_id: 'sess_1', agent_id: 'main', task_id: 'task_1', offset: 0, text: 'hi' });
    ws.emitMessage({ type: 'task.output', session_id: 'sess_1', agent_id: 'main', task_id: 'other', offset: 0, text: 'x' });
    ws.emitMessage({ type: 'task.output', session_id: 'sess_1', agent_id: 'agent-1', task_id: 'task_1', offset: 0, text: 'y' });
    expect(chunks).toEqual([['sess_1', 'main', 'task_1', 0, 'hi']]);

    socket.unwatchTaskOutput('sess_1', 'main', 'task_1');
    expect(sentFrames(ws, 'task.unwatch')).toEqual([
      expect.objectContaining({ session_id: 'sess_1', agent_id: 'main', task_id: 'task_1' }),
    ]);
    ws.emitMessage({ type: 'task.output', session_id: 'sess_1', agent_id: 'main', task_id: 'task_1', offset: 2, text: '!' });
    expect(chunks).toHaveLength(1);
  });

  const RUNNING_SHELL = {
    task_id: 'bash-1',
    kind: 'shell',
    status: 'running',
    detached: true,
    command: 'sleep 60',
  } as const;

  function connectWithTasks(): {
    socket: DaemonEventSocket;
    ws: FakeWebSocket;
    lists: unknown[];
    tasks: unknown[][];
  } {
    const lists: unknown[] = [];
    const tasks: unknown[][] = [];
    const socket = new DaemonEventSocket({
      wsUrl: WS_URL,
      handlers: {
        ...makeHandlers(),
        onTaskList: (list) => lists.push(list),
        onTask: (...args) => tasks.push(args),
      },
    });
    socket.connect();
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    return { socket, ws, lists, tasks };
  }

  it('forwards task lists and task frames with their session and agent', () => {
    const { ws, lists, tasks } = connectWithTasks();
    const list = { type: 'task.list', session_id: 'sess_1', agent_id: 'main', tasks: [RUNNING_SHELL] };
    ws.emitMessage(list);
    const frame = {
      type: 'task',
      session_id: 'sess_1',
      agent_id: 'main',
      event_created_at: '2026-10-28T00:00:00.000Z',
      ...RUNNING_SHELL,
    };
    ws.emitMessage(frame);
    expect(lists).toEqual([list]);
    expect(tasks).toEqual([['sess_1', 'main', frame]]);
  });

  it('forwards the task state carried by a watch reply', () => {
    const { socket, ws, tasks } = connectWithTasks();
    socket.watchTaskOutput('sess_1', 'agent-1', 'bash-1');
    const watch = sentFrames(ws, 'task.watch')[0]!;
    const ended = { ...RUNNING_SHELL, status: 'ended', outcome: 'completed' };
    ws.emitMessage({ type: 'response', request_id: watch['request_id'], code: 0, task: ended });
    expect(tasks).toEqual([['sess_1', 'agent-1', ended]]);
  });

  it('sends stop and background requests and resolves each with its own reply', async () => {
    const { socket, ws, tasks } = connectWithTasks();
    const stopped = socket.sendTaskCommand('task.stop', 'sess_1', 'main', 'bash-1');
    const detached = socket.sendTaskCommand('task.background', 'sess_1', 'main', 'bash-2');
    const [stop] = sentFrames(ws, 'task.stop');
    const [background] = sentFrames(ws, 'task.background');
    expect(stop).toMatchObject({ session_id: 'sess_1', agent_id: 'main', task_id: 'bash-1' });
    expect(background).toMatchObject({ session_id: 'sess_1', agent_id: 'main', task_id: 'bash-2' });

    ws.emitMessage({ type: 'response', request_id: background!['request_id'], code: 40406, msg: 'task not found' });
    const killed = { ...RUNNING_SHELL, status: 'ended', outcome: 'killed' };
    ws.emitMessage({ type: 'response', request_id: stop!['request_id'], code: 0, task: killed });

    await expect(detached).resolves.toEqual({ code: 40406, msg: 'task not found' });
    await expect(stopped).resolves.toEqual({ code: 0, msg: undefined });
    expect(tasks).toEqual([['sess_1', 'main', killed]]);
  });

  it('rejects task commands sent while disconnected or left unanswered by a reconnect', async () => {
    const { socket } = connectWithTasks();
    const pending = socket.sendTaskCommand('task.stop', 'sess_1', 'main', 'bash-1');
    socket.reconnect();
    await expect(pending).rejects.toThrow(/closed before the task command was answered/);
    await expect(socket.sendTaskCommand('task.stop', 'sess_1', 'main', 'bash-1')).rejects.toThrow(
      /not connected/,
    );
  });

  it('re-watches after reconnect from the UTF-8 byte end it has seen', () => {
    const { socket, ws } = connect(() => {});
    socket.watchTaskOutput('sess_1', 'main', 'task_1');
    ws.emitMessage({ type: 'task.output', session_id: 'sess_1', agent_id: 'main', task_id: 'task_1', offset: 10, text: 'é!' });

    socket.reconnect();
    const next = FakeWebSocket.instances.at(-1)!;
    next.open();
    expect(sentFrames(next, 'task.watch')).toEqual([
      expect.objectContaining({ session_id: 'sess_1', agent_id: 'main', task_id: 'task_1', since_offset: 13 }),
    ]);
  });

  it('drops a failed watch and ignores a stale failure', () => {
    const failed = vi.fn();
    const { socket, ws } = connect(() => {}, failed);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    socket.watchTaskOutput('sess_1', 'main', 'task_1');
    const first = sentFrames(ws, 'task.watch')[0]!;
    socket.unwatchTaskOutput('sess_1', 'main', 'task_1');
    socket.watchTaskOutput('sess_1', 'main', 'task_1');
    ws.emitMessage({ type: 'response', request_id: first['request_id'], code: 40406, msg: 'task not found' });
    expect(failed).not.toHaveBeenCalled();

    socket.reconnect();
    let next = FakeWebSocket.instances.at(-1)!;
    next.open();
    const retried = sentFrames(next, 'task.watch')[0]!;
    expect(retried).toMatchObject({ agent_id: 'main', task_id: 'task_1' });

    next.emitMessage({ type: 'response', request_id: retried['request_id'], code: 40406, msg: 'task not found' });
    expect(failed).toHaveBeenCalledExactlyOnceWith('sess_1', 'main', 'task_1');
    socket.reconnect();
    next = FakeWebSocket.instances.at(-1)!;
    next.open();
    expect(sentFrames(next, 'task.watch')).toEqual([]);
  });

  it('forgets watches still awaiting a reply when it reconnects', () => {
    const failed = vi.fn();
    const { socket, ws } = connect(() => {}, failed);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    socket.watchTaskOutput('sess_1', 'main', 'task_1');
    const before = sentFrames(ws, 'task.watch')[0]!;

    socket.reconnect();
    const next = FakeWebSocket.instances.at(-1)!;
    next.open();
    next.emitMessage({ type: 'response', request_id: before['request_id'], code: 40406, msg: 'task not found' });

    expect(failed).not.toHaveBeenCalled();
    expect(sentFrames(next, 'task.watch')).toHaveLength(1);
  });
});
