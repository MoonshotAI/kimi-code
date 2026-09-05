/**
 * Message-protocol glue-layer tests — the app's own REST/WS/store/channel
 * plumbing for the v3 protocol. The wire schemas themselves are covered by
 * kap-server's contract tests and are intentionally not re-tested here.
 */

import type {
  AssistantMessage,
  HistoryMessage,
  InteractionMessage,
  ServerMessage,
  StepMessage,
  SystemMessage,
  TaskMessage,
  ToolCallMessage,
  TurnMessage,
  UserMessage,
} from '@moonshot-ai/kap-server/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { WsLike } from '../channel/wsLike';
import { fetchFullHistory, fetchHistoryPage } from './api';
import { ChatChannel } from './channel';
import { projectPlans } from './plan';
import {
  ChatStore,
  newestTerminalStepId,
  oldestTurnId,
  recoverLoadedWindow,
  type TimelineEntry,
} from './store';
import { ChatWs } from './ws';

// ---------------------------------------------------------------- fixtures

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
let tick = 0;

function ts(offsetMs?: number): string {
  tick += 1;
  return new Date(T0 + tick * 1000 + (offsetMs ?? 0)).toISOString();
}

const base = { session_id: 's1', agent_id: 'main' } as const;

function turnMsg(n: number, state: 'running' | 'completed' = 'completed', at?: string): TurnMessage {
  return {
    type: 'turn',
    ...base,
    timestamp: at ?? ts(),
    turn_id: `t${n}`,
    ordinal: n,
    state,
    origin: { kind: 'user' },
  };
}

function stepMsg(
  stepId: string,
  state: StepMessage['state'] = 'completed',
  at?: string,
): StepMessage {
  const turnId = stepId.split('.')[0] ?? 't1';
  const ordinal = Number(stepId.split('.')[1] ?? '1');
  return {
    type: 'step',
    ...base,
    timestamp: at ?? ts(),
    step_id: stepId,
    turn_id: turnId,
    ordinal,
    state,
  };
}

function userMsg(stepId: string, text: string, at?: string): UserMessage {
  const turnId = stepId.split('.')[0] ?? 't1';
  return {
    type: 'user',
    ...base,
    timestamp: at ?? ts(),
    message_id: `${stepId}.u0`,
    turn_id: turnId,
    step_id: stepId,
    text,
    status: 'completed',
    created_at: at ?? ts(),
  };
}

function assistantMsg(
  stepId: string,
  text: string,
  status: 'streaming' | 'completed' = 'completed',
  at?: string,
): AssistantMessage {
  const turnId = stepId.split('.')[0] ?? 't1';
  return {
    type: 'assistant',
    ...base,
    timestamp: at ?? ts(),
    message_id: `${stepId}.a0`,
    turn_id: turnId,
    step_id: stepId,
    status,
    text,
  };
}

function toolCallMsg(
  stepId: string,
  id: string,
  overrides: Partial<ToolCallMessage> = {},
): ToolCallMessage {
  const turnId = stepId.split('.')[0] ?? 't1';
  return {
    type: 'tool_call',
    ...base,
    timestamp: ts(),
    tool_call_id: id,
    turn_id: turnId,
    step_id: stepId,
    name: 'Bash',
    state: 'running',
    ...overrides,
  };
}

function systemMsg(
  subtype: SystemMessage['subtype'],
  systemId: string,
  payload?: unknown,
): SystemMessage {
  return {
    type: 'system',
    ...base,
    timestamp: ts(),
    system_id: systemId,
    subtype,
    payload,
  } as SystemMessage;
}

function interactionMsg(id: string, toolCallId?: string): InteractionMessage {
  return {
    type: 'interaction',
    ...base,
    timestamp: ts(),
    interaction_id: id,
    kind: 'approval',
    state: 'pending',
    tool_call_id: toolCallId,
  };
}

function taskMsg(id: string, state: TaskMessage['state'] = 'running'): TaskMessage {
  return {
    type: 'task',
    ...base,
    timestamp: ts(),
    task_id: id,
    kind: 'shell',
    state,
    detached: false,
    output_tail: '',
  };
}

function undoMsg(systemId: string, removedIds: readonly string[]): SystemMessage {
  return systemMsg('undo', systemId, { removed_ids: [...removedIds] });
}

function entryKeys(entries: readonly TimelineEntry[]): string[] {
  return entries.map((entry) => entry.key);
}

function makeStore(): ChatStore {
  return new ChatStore({ notifyIntervalMs: 0 });
}

function okEnvelope(data: unknown) {
  return { code: 0, msg: 'success', data, request_id: 'r1' };
}

function fakeFetch(envelope: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { json: async () => envelope };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

class FakeWs implements WsLike {
  static OPEN = 1;
  static instances: FakeWs[] = [];
  readyState = 1;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, ((event: never) => void)[]>();

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWs.instances.push(this);
  }

  static reset(): void {
    FakeWs.instances = [];
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit('close');
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }

  open(): void {
    this.emit('open');
  }

  serverFrame(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  sentFrames(): Record<string, unknown>[] {
    return this.sent.map((data) => JSON.parse(data) as Record<string, unknown>);
  }

  hello(): void {
    this.serverFrame({
      type: 'hello',
      protocol_version: '3',
      server_id: 'srv',
      capabilities: ['step_replay_v1'],
    });
  }
}

function makeWs(handlers: Partial<ConstructorParameters<typeof ChatWs>[0]['handlers']> = {}) {
  const seen = {
    messages: [] as ServerMessage[],
    acks: [] as { code: number; msg?: string }[],
    protocolErrors: [] as { code: number; msg: string }[],
    invalid: 0,
    reconnects: 0,
  };
  const ws = new ChatWs({
    url: 'http://h:1',
    token: 'tok',
    sessionId: 's1',
    agentIds: ['main'],
    WebSocketImpl: FakeWs,
    reconnectDelayMs: 1,
    handlers: {
      onMessage: (message) => {
        seen.messages.push(message);
        handlers.onMessage?.(message);
      },
      onAck: (code, msg) => {
        seen.acks.push({ code, msg });
        handlers.onAck?.(code, msg);
      },
      onProtocolError: (code, msg) => {
        seen.protocolErrors.push({ code, msg });
        handlers.onProtocolError?.(code, msg);
      },
      onInvalidFrame: () => {
        seen.invalid += 1;
        handlers.onInvalidFrame?.(null);
      },
      onReconnectScheduled: () => {
        seen.reconnects += 1;
        handlers.onReconnectScheduled?.(0);
      },
    },
  });
  return { ws, seen };
}

// ---------------------------------------------------------------- api

describe('fetchHistoryPage', () => {
  const pageData = {
    messages: [turnMsg(1)],
    has_more: false,
    in_flight: { turn_id: 't1', step_id: 't1.2' },
  };

  it('requests the endpoint with cursor params and bearer auth, unwraps the envelope', async () => {
    const { calls, fetchImpl } = fakeFetch(okEnvelope(pageData));
    const page = await fetchHistoryPage({
      baseUrl: 'http://h:1',
      token: 'tok',
      sessionId: 's 1',
      agentId: 'main',
      beforeTurn: 't5',
      pageSize: 50,
      fetchImpl,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/api/v1/sessions/s%201/history?');
    expect(calls[0]!.url).toContain('agent_id=main');
    expect(calls[0]!.url).toContain('before_turn=t5');
    expect(calls[0]!.url).toContain('page_size=50');
    expect(calls[0]!.init?.headers).toEqual({ authorization: 'Bearer tok' });
    expect(page.messages).toHaveLength(1);
    expect(page.inFlight).toEqual({ turn_id: 't1', step_id: 't1.2' });
  });

  it('sends after_step and omits unset cursors', async () => {
    const { calls, fetchImpl } = fakeFetch(okEnvelope({ messages: [], has_more: false }));
    await fetchHistoryPage({
      baseUrl: 'http://h:1',
      sessionId: 's1',
      agentId: 'main',
      afterStep: 't1.3',
      fetchImpl,
    });
    expect(calls[0]!.url).toContain('after_step=t1.3');
    expect(calls[0]!.url).not.toContain('before_turn');
    expect(calls[0]!.init?.headers).toEqual({});
  });

  it('throws on a non-zero envelope code', async () => {
    const { fetchImpl } = fakeFetch({ code: 40401, msg: 'session not found', data: null });
    await expect(
      fetchHistoryPage({ baseUrl: 'http://h:1', sessionId: 's9', agentId: 'main', fetchImpl }),
    ).rejects.toThrow('session not found');
  });

  it('throws when the payload fails schema validation', async () => {
    const { fetchImpl } = fakeFetch(okEnvelope({ messages: 'nope' }));
    await expect(
      fetchHistoryPage({ baseUrl: 'http://h:1', sessionId: 's1', agentId: 'main', fetchImpl }),
    ).rejects.toThrow('unexpected response shape');
  });

  it('fetchFullHistory pages before_turn to the beginning and returns timeline order', async () => {
    const pages: Record<string, unknown> = {
      newest: okEnvelope({ messages: [turnMsg(3), stepMsg('t3.1')], has_more: true }),
      't3': okEnvelope({ messages: [turnMsg(1), turnMsg(2)], has_more: false }),
    };
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url);
      calls.push(text);
      const before = /before_turn=([^&]+)/.exec(text)?.[1];
      const envelope = before === undefined ? pages['newest'] : (pages[before] ?? okEnvelope({ messages: [], has_more: false }));
      return { json: async () => envelope };
    }) as unknown as typeof fetch;
    const messages = await fetchFullHistory({
      baseUrl: 'http://h:1',
      sessionId: 's1',
      agentId: 'main',
      pageSize: 2,
      fetchImpl,
    });
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain('before_turn=t3');
    expect(calls[2]).toContain('before_turn=t1');
    expect(messages.map((m) => ('turn_id' in m ? m.turn_id : ''))).toEqual(['t1', 't2', 't3', 't3']);
  });
});

// ---------------------------------------------------------------- ws

describe('ChatWs', () => {
  it('connects with the bearer subprotocol and subscribes after the server hello', () => {
    FakeWs.reset();
    makeWs();
    const sock = FakeWs.instances[0]!;
    expect(sock.url).toBe('ws://h:1/api/v3/ws');
    expect(sock.protocols).toEqual(['kimi-code.bearer.tok']);
    sock.open();
    expect(sock.sent).toHaveLength(0);
    sock.hello();
    expect(sock.sentFrames()[0]).toEqual({
      type: 'subscribe',
      id: 1,
      session_id: 's1',
      agent_ids: ['main'],
    });
  });

  it('fires onAck on the subscribe ack and forwards entity messages', () => {
    FakeWs.reset();
    const { seen } = makeWs();
    const sock = FakeWs.instances[0]!;
    sock.open();
    sock.hello();
    sock.serverFrame({ type: 'ack', id: 1, code: 0 });
    expect(seen.acks).toEqual([{ code: 0 }]);
    sock.serverFrame(turnMsg(1, 'running'));
    sock.serverFrame({
      type: 'session.state',
      session_id: 's1',
      timestamp: ts(),
      busy: false,
      main_turn_active: false,
      activity: 'idle',
    });
    expect(seen.messages.map((m) => m.type)).toEqual(['turn', 'session.state']);
  });

  it('surfaces protocol error frames and ignores acks for other ids', () => {
    FakeWs.reset();
    const { seen } = makeWs();
    const sock = FakeWs.instances[0]!;
    sock.open();
    sock.hello();
    sock.serverFrame({ type: 'ack', id: 99, code: 0 });
    expect(seen.acks).toHaveLength(0);
    sock.serverFrame({ type: 'error', code: 1008, msg: 'slow consumer' });
    expect(seen.protocolErrors).toEqual([{ code: 1008, msg: 'slow consumer' }]);
  });

  it('ignores unknown future message types but reports malformed known ones', () => {
    FakeWs.reset();
    const { seen } = makeWs();
    const sock = FakeWs.instances[0]!;
    sock.open();
    sock.hello();
    sock.serverFrame({ type: 'turn.supercharged', whatever: true });
    sock.serverFrame({ type: 'turn', turn_id: 42 });
    expect(seen.messages).toHaveLength(0);
    expect(seen.invalid).toBe(1);
  });

  it('re-subscribes after a drop and fires onAck per subscribe', async () => {
    FakeWs.reset();
    const { seen } = makeWs();
    const first = FakeWs.instances[0]!;
    first.open();
    first.hello();
    first.serverFrame({ type: 'ack', id: 1, code: 0 });
    expect(seen.acks).toHaveLength(1);
    first.emit('close');
    await vi.waitFor(() => {
      expect(FakeWs.instances.length).toBeGreaterThan(1);
    });
    const second = FakeWs.instances[1]!;
    second.open();
    second.hello();
    expect(second.sentFrames()[0]).toMatchObject({ type: 'subscribe', id: 2 });
    second.serverFrame({ type: 'ack', id: 2, code: 0 });
    expect(seen.acks).toHaveLength(2);
  });

  it('stays closed after close()', () => {
    FakeWs.reset();
    const { ws } = makeWs();
    FakeWs.instances[0]!.open();
    ws.close();
    expect(FakeWs.instances).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- store

describe('ChatStore', () => {
  it('upserts entities by (type, id) and replaces in place', () => {
    const store = makeStore();
    store.applyLive(turnMsg(1, 'running'));
    store.applyLive(stepMsg('t1.1', 'running'));
    store.applyLive(turnMsg(1, 'completed'));
    const state = store.getState();
    expect(entryKeys(state.entries)).toEqual(['turn:t1', 'step:t1.1']);
    const turn = state.entries[0]!.message as TurnMessage;
    expect(turn.state).toBe('completed');
  });

  it('skips an upsert whose timestamp is older than the held entity', () => {
    const store = makeStore();
    store.applyLive(assistantMsg('t1.1', 'hello world', 'streaming', '2026-01-01T00:00:10.000Z'));
    store.applyLive(assistantMsg('t1.1', 'hel', 'streaming', '2026-01-01T00:00:05.000Z'));
    const held = store.getState().entries[0]!.message as AssistantMessage;
    expect(held.text).toBe('hello world');
  });

  it('appends deltas to the held entity and drops orphan deltas', () => {
    const store = makeStore();
    store.applyLive({
      type: 'assistant.delta',
      ...base,
      timestamp: ts(),
      message_id: 't1.1.a0',
      text: 'orphan',
    });
    expect(store.getState().entries).toHaveLength(0);
    store.applyLive(assistantMsg('t1.1', '', 'streaming'));
    store.applyLive({
      type: 'assistant.delta',
      ...base,
      timestamp: ts(),
      message_id: 't1.1.a0',
      text: 'hel',
    });
    store.applyLive({
      type: 'assistant.delta',
      ...base,
      timestamp: ts(),
      message_id: 't1.1.a0',
      text: 'lo',
    });
    const held = store.getState().entries[0]!.message as AssistantMessage;
    expect(held.text).toBe('hello');
  });

  it('treats an entity arrival after deltas as the authoritative whole', () => {
    const store = makeStore();
    store.applyLive(assistantMsg('t1.1', '', 'streaming'));
    store.applyLive({
      type: 'assistant.delta',
      ...base,
      timestamp: ts(),
      message_id: 't1.1.a0',
      text: 'partial',
    });
    store.applyLive(assistantMsg('t1.1', 'partial but authoritative', 'completed'));
    const held = store.getState().entries[0]!.message as AssistantMessage;
    expect(held.text).toBe('partial but authoritative');
    expect(held.status).toBe('completed');
  });

  it('appends tool_call deltas to input_text and patches tool.progress', () => {
    const store = makeStore();
    store.applyLive(toolCallMsg('t1.1', 'call_1', { input_text: '' }));
    store.applyLive({
      type: 'tool_call.delta',
      ...base,
      timestamp: ts(),
      tool_call_id: 'call_1',
      input_text: '{"command"',
    });
    store.applyLive({
      type: 'tool_call.delta',
      ...base,
      timestamp: ts(),
      tool_call_id: 'call_1',
      input_text: ':"ls"}',
    });
    store.applyLive({
      type: 'tool.progress',
      ...base,
      timestamp: ts(),
      tool_call_id: 'call_1',
      progress: { kind: 'stdout', text: 'file.txt' },
    });
    const held = store.getState().entries[0]!.message as ToolCallMessage;
    expect(held.input_text).toBe('{"command":"ls"}');
    expect(held.progress).toEqual({ kind: 'stdout', text: 'file.txt' });
  });

  it('truncates the removed turn subtree on system(undo) and keeps the marker', () => {
    const store = makeStore();
    store.applyLive(turnMsg(1));
    store.applyLive(stepMsg('t1.1'));
    store.applyLive(assistantMsg('t1.1', 'first'));
    store.applyLive(turnMsg(2));
    store.applyLive(stepMsg('t2.1'));
    store.applyLive(toolCallMsg('t2.1', 'call_1'));
    store.applyLive(undoMsg('sys-undo-1', ['t2']));
    const state = store.getState();
    expect(entryKeys(state.entries)).toEqual([
      'turn:t1',
      'step:t1.1',
      'assistant:t1.1.a0',
      'system:sys-undo-1',
    ]);
  });

  it('cascades undo to interactions anchored at removed tool calls', () => {
    const store = makeStore();
    store.applyLive(turnMsg(1));
    store.applyLive(toolCallMsg('t1.1', 'call_1'));
    store.applyLive(interactionMsg('ix-1', 'call_1'));
    store.applyLive(interactionMsg('ix-2', 'call_other'));
    store.applyLive(undoMsg('sys-undo-1', ['t1']));
    expect([...store.getState().interactions.keys()]).toEqual(['ix-2']);
  });

  it('empties the timeline on system(clear)', () => {
    const store = makeStore();
    store.applyLive(turnMsg(1));
    store.applyLive(stepMsg('t1.1'));
    store.applyLive(assistantMsg('t1.1', 'gone'));
    store.applyLive(systemMsg('clear', 'sys-clear-1', { removed_ids: ['t1', 't1.1', 't1.1.a0'] }));
    expect(entryKeys(store.getState().entries)).toEqual(['system:sys-clear-1']);
  });

  it('upserts state entities into their own maps and ignores global messages', () => {
    const store = makeStore();
    store.applyLive(interactionMsg('ix-1', 'call_1'));
    store.applyLive(taskMsg('task-1'));
    store.applyLive({
      type: 'todo',
      ...base,
      timestamp: ts(),
      todo_id: 'todo',
      items: [{ title: 'x', status: 'pending' }],
    });
    store.applyLive({
      type: 'session.state',
      session_id: 's1',
      timestamp: ts(),
      busy: true,
      main_turn_active: true,
      activity: 'turn',
    });
    store.applyLive({
      type: 'workspace',
      timestamp: ts(),
      subtype: 'updated',
      workspace: {
        id: 'wd_test_0123456789ab',
        root: '/tmp',
        name: 'tmp',
        created_at: ts(),
        last_opened_at: ts(),
        session_count: 1,
      },
    });
    const state = store.getState();
    expect(state.interactions.get('ix-1')?.state).toBe('pending');
    expect(state.tasks.get('task-1')?.kind).toBe('shell');
    expect(state.todos.get('todo')?.items).toHaveLength(1);
    expect(state.sessionState?.busy).toBe(true);
    expect(state.entries).toHaveLength(0);
  });

  it('replace installs the page as the window and keeps entries newer than the page', () => {
    const store = makeStore();
    store.applyLive(turnMsg(9, 'running', '2026-01-01T00:00:09.000Z'));
    store.applyLive(turnMsg(1, 'completed', '2026-01-01T00:00:01.000Z'));
    store.applyHistoryPage(
      [turnMsg(1, 'completed', '2026-01-01T00:00:01.500Z'), stepMsg('t1.1', 'completed', '2026-01-01T00:00:02.000Z')],
      'replace',
    );
    expect(entryKeys(store.getState().entries)).toEqual(['turn:t1', 'step:t1.1', 'turn:t9']);
  });

  it('prepend inserts older pages ahead of the window and dedupes by key', () => {
    const store = makeStore();
    store.applyHistoryPage([turnMsg(3)], 'replace');
    store.applyHistoryPage([turnMsg(1), turnMsg(2), turnMsg(3)], 'prepend');
    expect(entryKeys(store.getState().entries)).toEqual(['turn:t1', 'turn:t2', 'turn:t3']);
  });

  it('tail upserts the catch-up slice in page order', () => {
    const store = makeStore();
    store.applyHistoryPage([turnMsg(1), stepMsg('t1.1')], 'replace');
    store.applyHistoryPage(
      [assistantMsg('t1.1', 'tail'), turnMsg(2), stepMsg('t2.1', 'running')],
      'tail',
    );
    expect(entryKeys(store.getState().entries)).toEqual([
      'turn:t1',
      'step:t1.1',
      'assistant:t1.1.a0',
      'turn:t2',
      'step:t2.1',
    ]);
  });

  it('applies a system(undo) inside a history page like a live one', () => {
    const store = makeStore();
    store.applyLive(turnMsg(1));
    store.applyLive(turnMsg(2));
    store.applyHistoryPage([undoMsg('sys-undo-1', ['t2'])], 'tail');
    expect(entryKeys(store.getState().entries)).toEqual(['turn:t1', 'system:sys-undo-1']);
  });
});

// ---------------------------------------------------------------- helpers

describe('recoverLoadedWindow', () => {
  const pageOf = (items: HistoryMessage[], hasMore: boolean): HistoryMessage[] => items;

  it('pages backwards until the previous oldest turn is re-covered', async () => {
    const store = makeStore();
    store.applyHistoryPage([turnMsg(4), turnMsg(5), turnMsg(6)], 'replace');
    store.setHasMoreOlder(true);
    const fetched: string[] = [];
    await recoverLoadedWindow(
      store,
      't2',
      async (beforeTurn) => {
        fetched.push(beforeTurn);
        store.setHasMoreOlder(beforeTurn !== 't2');
        return beforeTurn === 't4' ? [turnMsg(2), turnMsg(3)] : [];
      },
      () => false,
    );
    expect(fetched).toEqual(['t4']);
    expect(oldestTurnId(store.getState().entries)).toBe('t2');
    expect(newestTerminalStepId(store.getState().entries)).toBeUndefined();
  });

  it('stops when there is no older history left, even if the anchor is gone', async () => {
    const store = makeStore();
    store.applyHistoryPage([turnMsg(5)], 'replace');
    store.setHasMoreOlder(true);
    const fetched: string[] = [];
    await recoverLoadedWindow(
      store,
      't1',
      async (beforeTurn) => {
        fetched.push(beforeTurn);
        store.setHasMoreOlder(false);
        return pageOf([], false);
      },
      () => false,
    );
    expect(fetched).toEqual(['t5']);
  });
});

describe('ChatChannel', () => {
  function scriptedFetch(script: { noCursor: unknown[]; afterStep?: Record<string, readonly unknown[]> }) {
    const calls: string[] = [];
    let noCursorIndex = 0;
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url);
      calls.push(text);
      const after = /after_step=([^&]+)/.exec(text)?.[1];
      let envelope: unknown;
      if (after !== undefined) {
        envelope = okEnvelope({ messages: [...(script.afterStep?.[after] ?? [])], has_more: false });
      } else {
        envelope = script.noCursor[Math.min(noCursorIndex, script.noCursor.length - 1)];
        noCursorIndex += 1;
      }
      return { json: async () => envelope };
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  function makeChannel(fetchImpl: typeof fetch): { channel: ChatChannel; sock: FakeWs } {
    FakeWs.reset();
    const channel = new ChatChannel({
      baseUrl: 'http://h:1',
      token: 'tok',
      sessionId: 's1',
      agentId: 'main',
      pageSize: 50,
      WebSocketImpl: FakeWs,
      fetchImpl,
      notifyIntervalMs: 0,
    });
    return { channel, sock: FakeWs.instances[0]! };
  }

  it('serializes the initial refresh with the ack catch-up behind one queue', async () => {
    const newest = okEnvelope({ messages: [turnMsg(1), stepMsg('t1.1')], has_more: false });
    const { calls, fetchImpl } = scriptedFetch({ noCursor: [newest] });
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let first = true;
    const gatedFetch = (async (url: string | URL, init?: RequestInit) => {
      if (first) {
        first = false;
        await gate;
      }
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const { channel, sock } = makeChannel(gatedFetch);
    channel.start();
    sock.open();
    sock.hello();
    sock.serverFrame({ type: 'ack', id: 1, code: 0 });
    releaseFirst();
    await vi.waitFor(() => {
      expect(calls).toHaveLength(3);
    });
    const restEntries = channel.trail.getEntries().filter((e) => e.kind === 'rest');
    expect(restEntries.filter((e) => e.mode === 'replace')).toHaveLength(1);
    expect(channel.trail.getEntries().some((e) => e.kind === 'event' && e.event === 'catchup-refresh')).toBe(false);
    expect(calls.filter((url) => !url.includes('after_step='))).toHaveLength(2);
    expect(calls[1]).toContain('after_step=t1.1');
    expect(newestTerminalStepId(channel.store.getState().entries)).toBe('t1.1');
    channel.close();
  });

  it('probes the newest page for the anchor step or turn before falling back to a refresh', async () => {
    const first = okEnvelope({ messages: [turnMsg(1), stepMsg('t1.1')], has_more: false });
    const probeWithTurn = okEnvelope({ messages: [systemMsg('notice', 'sys_n1'), turnMsg(1)], has_more: false });
    const alive = scriptedFetch({ noCursor: [first, probeWithTurn] });
    const aliveChannel = makeChannel(alive.fetchImpl);
    aliveChannel.channel.start();
    aliveChannel.sock.open();
    aliveChannel.sock.hello();
    aliveChannel.sock.serverFrame({ type: 'ack', id: 1, code: 0 });
    await vi.waitFor(() => {
      expect(aliveChannel.channel.store.getState().entries.length).toBeGreaterThan(0);
    });
    await vi.waitFor(() => {
      expect(alive.calls).toHaveLength(3);
    });
    expect(
      aliveChannel.channel.trail.getEntries().some((e) => e.kind === 'event' && e.event === 'catchup-refresh'),
    ).toBe(false);
    expect(aliveChannel.channel.trail.getEntries().filter((e) => e.kind === 'rest' && e.mode === 'replace')).toHaveLength(1);
    aliveChannel.channel.close();

    const movedOn = okEnvelope({ messages: [turnMsg(2), stepMsg('t2.1')], has_more: false });
    const gone = scriptedFetch({ noCursor: [first, movedOn] });
    const goneChannel = makeChannel(gone.fetchImpl);
    goneChannel.channel.start();
    goneChannel.sock.open();
    goneChannel.sock.hello();
    goneChannel.sock.serverFrame({ type: 'ack', id: 1, code: 0 });
    await vi.waitFor(() => {
      expect(
        goneChannel.channel.trail.getEntries().some((e) => e.kind === 'event' && e.event === 'catchup-refresh'),
      ).toBe(true);
    });
    await vi.waitFor(() => {
      expect(newestTerminalStepId(goneChannel.channel.store.getState().entries)).toBe('t2.1');
    });
    goneChannel.channel.close();
  });
});

// ---------------------------------------------------------------- plan

describe('projectPlans', () => {
  const planCall = (id: string, overrides: Partial<ToolCallMessage> = {}): ToolCallMessage =>
    toolCallMsg('t1.1', id, { name: 'ExitPlanMode', state: 'done', ...overrides });

  it('derives plan content and review from the linked approval interaction', () => {
    const messages: HistoryMessage[] = [
      turnMsg(1),
      planCall('call_plan', { approval_id: 'ix-1' }),
      {
        type: 'interaction',
        ...base,
        timestamp: ts(),
        interaction_id: 'ix-1',
        kind: 'approval',
        state: 'approved',
        tool_call_id: 'call_plan',
        request: {
          tool_name: 'ExitPlanMode',
          action: 'review',
          tool_input_display: {
            kind: 'plan_review',
            plan: '# The Plan\n\nDo the thing.',
            path: '/tmp/plans/foo.md',
            options: [{ label: 'Approach A', description: 'fast' }],
          },
        },
        response: { decision: 'approved', selected_label: 'Approach A', feedback: 'looks good' },
      },
    ];
    const plans = projectPlans(messages);
    expect(plans).toEqual([
      {
        toolCallId: 'call_plan',
        turnId: 't1',
        source: 'interaction',
        plan: '# The Plan\n\nDo the thing.',
        path: '/tmp/plans/foo.md',
        options: [{ label: 'Approach A', description: 'fast' }],
        review: { state: 'approved', selectedOption: 'Approach A', feedback: 'looks good' },
      },
    ]);
  });

  it('falls back to the tool call display, then to the output body', () => {
    const fromDisplay = projectPlans([
      planCall('call_display', {
        display: { kind: 'plan_review', plan: '# Draft', path: '/tmp/draft.md' },
      }),
    ]);
    expect(fromDisplay[0]).toMatchObject({ source: 'display', plan: '# Draft', path: '/tmp/draft.md' });
    const fromOutput = projectPlans([
      planCall('call_output', {
        output: 'Plan saved to: /tmp/out.md\n## Approved Plan:\n# Final',
      }),
    ]);
    expect(fromOutput[0]).toMatchObject({ source: 'output', plan: '# Final', path: '/tmp/out.md' });
  });

  it('filters by tool_call_id and ignores non-ExitPlanMode calls', () => {
    const messages: HistoryMessage[] = [
      planCall('call_a', { display: { kind: 'plan_review', plan: '# A' } }),
      toolCallMsg('t1.1', 'call_bash', { name: 'Bash', state: 'done' }),
      planCall('call_b', { display: { kind: 'plan_review', plan: '# B' } }),
    ];
    expect(projectPlans(messages, 'call_b').map((p) => p.toolCallId)).toEqual(['call_b']);
    expect(projectPlans(messages).map((p) => p.toolCallId)).toEqual(['call_a', 'call_b']);
  });
});
