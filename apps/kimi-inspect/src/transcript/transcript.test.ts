/**
 * Transcript glue-layer tests — the app's own REST/WS/store plumbing. The L2
 * reducer semantics themselves are covered by `@moonshot-ai/transcript`'s own
 * test suite and are intentionally not re-tested here.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  itemId,
  type StepHeader,
  type TranscriptOperation,
  type TranscriptTurn,
  type TurnHeader,
  type TurnState,
} from '@moonshot-ai/transcript';

import type { WsLike } from '../channel/wsLike';
import {
  fetchTranscriptOps,
  fetchTranscriptPage,
  type TranscriptPage,
} from './api';
import {
  countTurns,
  createCoalescedRunner,
  oldestTurnId,
  recoverLoadedWindow,
  TranscriptChatStore,
} from './store';
import { TranscriptWs } from './ws';

// ---------------------------------------------------------------- fixtures

function turnHeader(n: number, state: TurnState = 'completed'): TurnHeader {
  return { kind: 'turn', turnId: `t${n}`, ordinal: n, state, origin: { kind: 'user' } };
}

function turnItem(n: number): TranscriptTurn {
  return { ...turnHeader(n), steps: [] };
}

function stepHeader(stepId: string, ordinal: number): StepHeader {
  return { kind: 'step', stepId, turnId: stepId.split('.')[0] ?? 't1', ordinal, state: 'running' };
}

const textFrameUpsert = (turnId: string, stepId: string, frameId: string, text: string) => ({
  op: 'frame.upsert' as const,
  turnId,
  stepId,
  frame: { kind: 'text' as const, frameId, role: 'assistant' as const, text },
});

const frameAppend = (turnId: string, stepId: string, frameId: string, offset: number, text: string) => ({
  op: 'append' as const,
  target: { type: 'frame' as const, turnId, stepId, frameId },
  offset,
  text,
});

const emptyPage = {
  tasks: [],
  interactions: [],
  attachments: [],
  todos: [],
  meta: {},
  pendingInteractions: [],
} as const;

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
}

function makeWs(handlers: Partial<ConstructorParameters<typeof TranscriptWs>[0]['handlers']> = {}) {
  const seen = {
    ops: [] as { agentId: string; ops: readonly TranscriptOperation[]; at?: string; seq?: number }[],
    resets: [] as { agentId: string; hasMoreOlder: boolean; at?: string; seq?: number }[],
    resyncs: 0,
    reconnects: 0,
  };
  const ws = new TranscriptWs({
    url: 'http://h:1',
    token: 'tok',
    sessionId: 's1',
    agentId: 'main',
    WebSocketImpl: FakeWs,
    handlers: {
      onOps: (agentId, ops, meta) => {
        seen.ops.push({ agentId, ops, at: meta?.at, seq: meta?.seq });
        handlers.onOps?.(agentId, ops, meta);
      },
      onReset: (agentId, _snapshot, hasMoreOlder, meta) => {
        seen.resets.push({ agentId, hasMoreOlder, at: meta?.at, seq: meta?.seq });
        handlers.onReset?.(agentId, _snapshot, hasMoreOlder, meta);
      },
      onResyncRequired: () => {
        seen.resyncs += 1;
        handlers.onResyncRequired?.();
      },
      onReconnected: () => {
        seen.reconnects += 1;
        handlers.onReconnected?.();
      },
    },
  });
  return { ws, seen };
}

// ---------------------------------------------------------------- api

describe('fetchTranscriptPage', () => {
  const pageData = {
    agent_id: 'main',
    items: [turnItem(1)],
    has_more: true,
    tasks: [{ taskId: 'bash-1', kind: 'shell', state: 'running', detached: false, outputTail: 'x' }],
    interactions: [],
    attachments: [],
    todos: [],
    meta: { activity: 'turn' },
    agents: [],
    pending_interactions: ['apr-1'],
    seq: 42,
  };

  it('requests the endpoint with cursor params and bearer auth, unwraps the envelope', async () => {
    const { calls, fetchImpl } = fakeFetch(okEnvelope(pageData));
    const page = await fetchTranscriptPage({
      baseUrl: 'http://h:1',
      token: 'tok',
      sessionId: 's 1',
      agentId: 'main',
      beforeTurn: 't5',
      fetchImpl,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/api/v1/sessions/s%201/transcript?');
    expect(calls[0]!.url).toContain('agent_id=main');
    expect(calls[0]!.url).toContain('before_turn=t5');
    expect(calls[0]!.url).toContain('page_size=1');
    expect(calls[0]!.init?.headers).toEqual({ authorization: 'Bearer tok' });
    expect(page.hasMoreOlder).toBe(true);
    expect(page.items.map((item) => itemId(item))).toEqual(['t1']);
    expect(page.tasks.map((task) => task.taskId)).toEqual(['bash-1']);
    expect(page.meta.activity).toBe('turn');
    expect(page.pendingInteractions).toEqual(['apr-1']);
    expect(page.seq).toBe(42);
  });

  it('throws on a non-zero envelope code', async () => {
    const { fetchImpl } = fakeFetch({ code: 40401, msg: 'session not found', data: null });
    await expect(
      fetchTranscriptPage({ baseUrl: 'http://h:1', sessionId: 's9', agentId: 'main', fetchImpl }),
    ).rejects.toThrow('session not found');
  });

  it('throws when the payload fails schema validation', async () => {
    const { fetchImpl } = fakeFetch(okEnvelope({ agent_id: 'main', items: 'nope' }));
    await expect(
      fetchTranscriptPage({ baseUrl: 'http://h:1', sessionId: 's1', agentId: 'main', fetchImpl }),
    ).rejects.toThrow('unexpected response shape');
  });
});

// ---------------------------------------------------------------- ops catch-up

describe('fetchTranscriptOps', () => {
  const catchupData = {
    agent_id: 'main',
    batches: [
      { seq: 6, ops: [{ op: 'meta.merge', meta: { activity: 'turn' } }] },
      { seq: 7, ops: [{ op: 'turn.upsert', turn: turnHeader(7, 'running') }] },
    ],
    latest_seq: 7,
    complete: true,
  };

  it('requests the ops endpoint with since_seq and unwraps batches in order', async () => {
    const { calls, fetchImpl } = fakeFetch(okEnvelope(catchupData));
    const res = await fetchTranscriptOps({
      baseUrl: 'http://h:1',
      token: 'tok',
      sessionId: 's1',
      agentId: 'main',
      sinceSeq: 5,
      fetchImpl,
    });
    expect(calls[0]!.url).toContain('/api/v1/sessions/s1/transcript/ops?');
    expect(calls[0]!.url).toContain('agent_id=main');
    expect(calls[0]!.url).toContain('since_seq=5');
    expect(res.complete).toBe(true);
    expect(res.latestSeq).toBe(7);
    expect(res.batches.map((batch) => batch.seq)).toEqual([6, 7]);
  });

  it('surfaces an incomplete catch-up (journal cannot cover)', async () => {
    const { fetchImpl } = fakeFetch(
      okEnvelope({ ...catchupData, batches: [], latest_seq: 500, complete: false }),
    );
    const res = await fetchTranscriptOps({
      baseUrl: 'http://h:1',
      sessionId: 's1',
      agentId: 'main',
      sinceSeq: 5,
      fetchImpl,
    });
    expect(res.complete).toBe(false);
    expect(res.batches).toEqual([]);
  });

  it('throws on a legacy server (envelope error) so callers fall back', async () => {
    const { fetchImpl } = fakeFetch({ code: 40404, msg: 'unknown route', data: null });
    await expect(
      fetchTranscriptOps({
        baseUrl: 'http://h:1',
        sessionId: 's1',
        agentId: 'main',
        sinceSeq: 5,
        fetchImpl,
      }),
    ).rejects.toThrow('unknown route');
  });
});

// ---------------------------------------------------------------- ws

describe('TranscriptWs', () => {
  it('connects with the bearer subprotocol and sends client_hello with the transcript grade spec', () => {
    FakeWs.reset();
    makeWs();
    const sock = FakeWs.instances[0]!;
    expect(sock.url).toBe('ws://h:1/api/v1/ws');
    expect(sock.protocols).toEqual(['kimi-code.bearer.tok']);
    sock.open();
    expect(sock.sentFrames()[0]).toMatchObject({
      type: 'client_hello',
      payload: {
        subscriptions: ['s1'],
        transcript: { s1: { main: 'delta' } },
      },
    });
  });

  it('forwards transcript.ops and surfaces transcript.reset via onReset, both with envelope meta', () => {
    FakeWs.reset();
    const { seen } = makeWs();
    const sock = FakeWs.instances[0]!;
    sock.open();
    sock.serverFrame({
      type: 'transcript.reset',
      seq: 1,
      volatile: true,
      session_id: 's1',
      timestamp: '2026-01-01T00:00:00Z',
      payload: {
        type: 'transcript.reset',
        agent_id: 'main',
        snapshot: { items: [], tasks: [], interactions: [], meta: {} },
        has_more_older: true,
        seq: 41,
      },
    });
    expect(seen.ops).toHaveLength(0);
    expect(seen.resets).toEqual([
      { agentId: 'main', hasMoreOlder: true, at: '2026-01-01T00:00:00Z', seq: 41 },
    ]);
    sock.serverFrame({
      type: 'transcript.ops',
      seq: 1,
      volatile: true,
      session_id: 's1',
      timestamp: '2026-01-01T00:00:01Z',
      payload: {
        type: 'transcript.ops',
        agent_id: 'main',
        ops: [{ op: 'meta.merge', meta: { activity: 'turn' } }],
        seq: 42,
      },
    });
    expect(seen.ops).toHaveLength(1);
    expect(seen.ops[0]!.agentId).toBe('main');
    expect(seen.ops[0]!.at).toBe('2026-01-01T00:00:01Z');
    expect(seen.ops[0]!.seq).toBe(42);
    expect(seen.ops[0]!.ops[0]).toMatchObject({ op: 'meta.merge' });
  });

  it('sends transcript_since in client_hello when getSince has a watermark', async () => {
    FakeWs.reset();
    let watermark: number | undefined;
    new TranscriptWs({
      url: 'http://h:1',
      sessionId: 's1',
      agentId: 'main',
      WebSocketImpl: FakeWs,
      getSince: () => watermark,
      reconnectDelayMs: 1,
      handlers: { onOps: () => {}, onResyncRequired: () => {}, onReconnected: () => {} },
    });
    const sock = FakeWs.instances[0]!;
    sock.open();
    expect(sock.sentFrames()[0]).toMatchObject({
      type: 'client_hello',
      payload: { transcript: { s1: { main: 'delta' } } },
    });
    expect(
      (sock.sentFrames()[0] as { payload: Record<string, unknown> }).payload['transcript_since'],
    ).toBeUndefined();
    watermark = 42;
    sock.emit('close');
    await vi.waitFor(() => {
      expect(FakeWs.instances.length).toBeGreaterThan(1);
    });
    const second = FakeWs.instances[1]!;
    second.open();
    expect(second.sentFrames()[0]).toMatchObject({
      type: 'client_hello',
      payload: { transcript_since: { s1: { main: 42 } } },
    });
  });

  it('still ignores transcript.reset when no onReset handler is set', () => {
    FakeWs.reset();
    const seen = { ops: 0 };
    new TranscriptWs({
      url: 'http://h:1',
      sessionId: 's1',
      agentId: 'main',
      WebSocketImpl: FakeWs,
      handlers: {
        onOps: () => {
          seen.ops += 1;
        },
        onResyncRequired: () => {},
        onReconnected: () => {},
      },
    });
    const sock = FakeWs.instances[0]!;
    sock.open();
    sock.serverFrame({
      type: 'transcript.reset',
      timestamp: '2026-01-01T00:00:00Z',
      payload: {
        type: 'transcript.reset',
        agent_id: 'main',
        snapshot: { items: [], tasks: [], interactions: [], meta: {} },
        has_more_older: false,
      },
    });
    expect(seen.ops).toBe(0);
  });

  it('answers ping with pong carrying the nonce', () => {
    FakeWs.reset();
    makeWs();
    const sock = FakeWs.instances[0]!;
    sock.open();
    sock.serverFrame({ type: 'ping', timestamp: '2026-01-01T00:00:00Z', payload: { nonce: 'n1' } });
    expect(sock.sentFrames().at(-1)).toEqual({ type: 'pong', payload: { nonce: 'n1' } });
  });

  it('surfaces resync_required for its session (and ignores other sessions)', () => {
    FakeWs.reset();
    const { seen } = makeWs();
    const sock = FakeWs.instances[0]!;
    sock.open();
    sock.serverFrame({
      type: 'resync_required',
      timestamp: '2026-01-01T00:00:00Z',
      payload: { session_id: 'other', reason: 'buffer_overflow', current_seq: 5 },
    });
    expect(seen.resyncs).toBe(0);
    sock.serverFrame({
      type: 'resync_required',
      timestamp: '2026-01-01T00:00:00Z',
      payload: { session_id: 's1', reason: 'buffer_overflow', current_seq: 5 },
    });
    expect(seen.resyncs).toBe(1);
  });

  it('re-subscribes after a drop and reports the reconnect only on the subscribe ack', () => {
    vi.useFakeTimers();
    try {
      FakeWs.reset();
      const { seen } = makeWs();
      const first = FakeWs.instances[0]!;
      first.open();
      // Open alone does not reconcile: the server attaches the transcript
      // stream only after processing client_hello.
      expect(seen.reconnects).toBe(0);
      const helloId = (first.sentFrames()[0] as { id: string }).id;
      first.serverFrame({ type: 'ack', id: helloId, code: 0, msg: 'success', payload: {} });
      expect(seen.reconnects).toBe(1);
      first.emit('close');
      vi.advanceTimersByTime(600);
      expect(FakeWs.instances).toHaveLength(2);
      const second = FakeWs.instances[1]!;
      second.open();
      expect(second.sentFrames()[0]).toMatchObject({ type: 'client_hello' });
      expect(seen.reconnects).toBe(1);
      const helloId2 = (second.sentFrames()[0] as { id: string }).id;
      second.serverFrame({ type: 'ack', id: helloId2, code: 0, msg: 'success', payload: {} });
      expect(seen.reconnects).toBe(2);
    } finally {
      vi.useRealTimers();
    }
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

describe('TranscriptChatStore', () => {
  it('applyPage(replace) installs the newest slice wholesale (items + globals)', () => {
    const store = new TranscriptChatStore();
    store.applyOps([{ op: 'turn.upsert', turn: turnHeader(9, 'running') }]);
    store.applyPage(
      {
        ...emptyPage,
        items: [turnItem(1), turnItem(2)],
        hasMoreOlder: true,
        tasks: [{ taskId: 'bash-1', kind: 'shell', state: 'running', detached: false, outputTail: '' }],
        meta: { activity: 'idle' },
        pendingInteractions: ['apr-1'],
      },
      { replace: true },
    );
    const state = store.getState();
    expect(state.items.map((item) => itemId(item))).toEqual(['t1', 't2']);
    expect(state.hasMoreOlder).toBe(true);
    expect(state.tasks.get('bash-1')?.kind).toBe('shell');
    expect(state.meta.activity).toBe('idle');
    expect([...state.pendingInteractions]).toEqual(['apr-1']);
  });

  it('prepends older pages ahead of the window, dedupes, keeps live globals', () => {
    const store = new TranscriptChatStore();
    store.applyPage({ ...emptyPage, items: [turnItem(3)], hasMoreOlder: true, meta: { activity: 'idle' } }, { replace: true });
    store.applyPage({ ...emptyPage, items: [turnItem(1), turnItem(2)], hasMoreOlder: true, meta: {} });
    expect(store.getState().items.map((item) => itemId(item))).toEqual(['t1', 't2', 't3']);
    expect(store.getState().hasMoreOlder).toBe(true);
    // Globals from the older page do not clobber the fresher live state.
    expect(store.getState().meta.activity).toBe('idle');
    store.applyPage({ ...emptyPage, items: [turnItem(2)], hasMoreOlder: false });
    expect(store.getState().items.map((item) => itemId(item))).toEqual(['t1', 't2', 't3']);
    expect(store.getState().hasMoreOlder).toBe(false);
  });

  it('applies ops through the package reducer and notifies once per batch', () => {
    const store = new TranscriptChatStore();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.applyOps([
      { op: 'turn.upsert', turn: turnHeader(1, 'running') },
      { op: 'step.upsert', turnId: 't1', step: stepHeader('t1.1', 1) },
      textFrameUpsert('t1', 't1.1', 't1.1.f1', ''),
      frameAppend('t1', 't1.1', 't1.1.f1', 0, 'hel'),
      frameAppend('t1', 't1.1', 't1.1.f1', 3, 'lo'),
    ]);
    expect(notified).toBe(1);
    const turn = store.getState().items[0];
    expect(turn?.kind).toBe('turn');
    if (turn?.kind === 'turn') {
      expect(turn.steps[0]?.frames[0]).toMatchObject({ kind: 'text', text: 'hello' });
    }
  });

  it('absorbs duplicate ops without notifying', () => {
    const store = new TranscriptChatStore();
    store.applyOps([{ op: 'turn.upsert', turn: turnHeader(1, 'running') }]);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.applyOps([{ op: 'turn.upsert', turn: turnHeader(1, 'running') }]);
    expect(notified).toBe(0);
  });

  it('buffered ops converge when flushed onto freshly fetched pages', () => {
    const store = new TranscriptChatStore();
    // Simulate: REST page lands AFTER the live ops were produced (buffered).
    const buffered: TranscriptOperation[] = [
      { op: 'turn.upsert', turn: turnHeader(1, 'running') },
      { op: 'step.upsert', turnId: 't1', step: stepHeader('t1.1', 1) },
      textFrameUpsert('t1', 't1.1', 't1.1.f1', ''),
      frameAppend('t1', 't1.1', 't1.1.f1', 0, 'hello'),
    ];
    // The REST snapshot already includes part of the stream ('hel').
    const pageTurn: TranscriptTurn = {
      ...turnHeader(1, 'running'),
      steps: [
        {
          kind: 'step',
          stepId: 't1.1',
          turnId: 't1',
          ordinal: 1,
          state: 'running',
          frames: [{ kind: 'text', frameId: 't1.1.f1', role: 'assistant', text: 'hel' }],
        },
      ],
    };
    store.applyPage({ ...emptyPage, items: [pageTurn], hasMoreOlder: false }, { replace: true });
    store.applyOps(buffered);
    const turn = store.getState().items[0];
    if (turn?.kind !== 'turn') throw new Error('expected turn');
    expect(turn.steps[0]?.frames[0]).toMatchObject({ kind: 'text', text: 'hello' });
  });

  it('surfaces append placement gaps through onGap', () => {
    const store = new TranscriptChatStore();
    let gaps = 0;
    store.onGap = () => {
      gaps += 1;
    };
    store.applyOps([frameAppend('t1', 't1.1', 't1.1.f1', 0, 'x')]);
    expect(gaps).toBe(1);
  });
});

describe('recoverLoadedWindow', () => {
  const range = (from: number, to: number): TranscriptTurn[] =>
    Array.from({ length: to - from + 1 }, (_, i) => turnItem(from + i));
  const pageOf = (items: TranscriptTurn[], hasMoreOlder: boolean): TranscriptPage => ({
    ...emptyPage,
    items,
    hasMoreOlder,
  });

  it('pages backwards until the previous oldest turn is re-covered', async () => {
    const store = new TranscriptChatStore();
    // The refresh landed the newest page (t36..t65) while the previously
    // loaded window reached t1 — a count-based stop would drop t1..t5.
    store.applyPage(pageOf(range(36, 65), true), { replace: true });

    const fetched: string[] = [];
    await recoverLoadedWindow(
      store,
      't1',
      async (beforeTurn) => {
        fetched.push(beforeTurn);
        return beforeTurn === 't36' ? pageOf(range(6, 35), true) : pageOf(range(1, 5), false);
      },
      () => false,
    );

    expect(fetched).toEqual(['t36', 't6']);
    expect(countTurns(store.getState().items)).toBe(65);
    expect(oldestTurnId(store.getState().items)).toBe('t1');
  });

  it('stops immediately when the window is already covered', async () => {
    const store = new TranscriptChatStore();
    store.applyPage(pageOf(range(1, 30), true), { replace: true });
    let calls = 0;
    await recoverLoadedWindow(
      store,
      't1',
      async () => {
        calls += 1;
        return pageOf([], false);
      },
      () => false,
    );
    expect(calls).toBe(0);
  });

  it('stops when there is no older history left, even if the anchor is gone', async () => {
    const store = new TranscriptChatStore();
    store.applyPage(pageOf(range(10, 20), true), { replace: true });
    const fetched: string[] = [];
    await recoverLoadedWindow(
      store,
      't1',
      async (beforeTurn) => {
        fetched.push(beforeTurn);
        return pageOf([], false);
      },
      () => false,
    );
    // The anchor no longer exists server-side: one no-progress probe, then stop.
    expect(fetched).toEqual(['t10']);
    expect(countTurns(store.getState().items)).toBe(11);
  });

  it('reports each applied page through onPageApplied', async () => {
    const store = new TranscriptChatStore();
    store.applyPage(pageOf(range(36, 65), true), { replace: true });
    const applied: TranscriptPage[] = [];
    await recoverLoadedWindow(
      store,
      't1',
      async (beforeTurn) =>
        beforeTurn === 't36' ? pageOf(range(6, 35), true) : pageOf(range(1, 5), false),
      () => false,
      (page) => {
        applied.push(page);
      },
    );
    expect(applied.map((page) => page.items.map((item) => itemId(item)))).toEqual([
      range(6, 35).map((turn) => turn.turnId),
      range(1, 5).map((turn) => turn.turnId),
    ]);
  });
});

describe('createCoalescedRunner', () => {
  const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('runs once per trigger when idle', async () => {
    let runs = 0;
    const kick = createCoalescedRunner(async () => {
      runs += 1;
    });
    kick();
    await Promise.resolve();
    kick();
    await Promise.resolve();
    expect(runs).toBe(2);
  });

  it('coalesces triggers during a run into exactly one follow-up', async () => {
    let runs = 0;
    const gates: Array<() => void> = [];
    const kick = createCoalescedRunner(async () => {
      runs += 1;
      const gate = deferred();
      gates.push(gate.resolve);
      await gate.promise;
    });
    kick();
    kick();
    kick();
    expect(runs).toBe(1);
    gates[0]?.();
    await vi.waitFor(() => {
      expect(runs).toBe(2);
    });
    gates[1]?.();
    await vi.waitFor(() => {
      expect(gates.length).toBe(2);
    });
    // No third run: the two mid-run triggers were coalesced into one.
  });

  it('queues again when a trigger lands during the follow-up run', async () => {
    let runs = 0;
    const gates: Array<() => void> = [];
    const kick = createCoalescedRunner(async () => {
      runs += 1;
      const gate = deferred();
      gates.push(gate.resolve);
      await gate.promise;
    });
    kick();
    kick();
    gates[0]?.();
    await vi.waitFor(() => {
      expect(runs).toBe(2);
    });
    kick();
    gates[1]?.();
    await vi.waitFor(() => {
      expect(runs).toBe(3);
    });
    gates[2]?.();
  });
});
