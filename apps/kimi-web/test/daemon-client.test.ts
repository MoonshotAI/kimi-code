// apps/kimi-web/test/daemon-client.test.ts
// Scenario: DaemonKimiWebApi exposes REST data and a session-scoped WS event stream.
// Responsibilities: map goal responses and release projector state on unsubscribe.
// Wiring: real daemon client/projector; fetch and browser WebSocket are the external stubs.
// Run: pnpm --filter @moonshot-ai/kimi-web test -- daemon-client.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DaemonKimiWebApi } from '../src/api/daemon/client';
import { createInitialState, reduceAppEvent } from '../src/api/daemon/eventReducer';
import type { AppEvent, KimiEventConnection } from '../src/api/types';

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const WIRE_GOAL = {
  goalId: 'goal_1',
  objective: 'fix all lint warnings',
  status: 'active',
  turnsUsed: 1,
  tokensUsed: 0,
  wallClockMs: 0,
  budget: {
    tokenBudget: null,
    turnBudget: null,
    wallClockBudgetMs: null,
    remainingTokens: null,
    remainingTurns: null,
    remainingWallClockMs: null,
    tokenBudgetReached: false,
    turnBudgetReached: false,
    wallClockBudgetReached: false,
    overBudget: false,
  },
};

function createApi(): DaemonKimiWebApi {
  return new DaemonKimiWebApi({
    serverHttpUrl: 'http://daemon.test',
    clientId: 'web_test',
    clientName: 'test',
    clientVersion: '0.0.0',
    clientUiMode: 'test',
  });
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor() {
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
  }

  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function promptFrame(seq: number, userMessageId: string) {
  return {
    type: 'prompt.submitted',
    seq,
    session_id: 'sess_1',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: {
      promptId: `prompt_${seq}`,
      userMessageId,
      content: [{ type: 'text', text: `message ${seq}` }],
    },
  };
}

function rawFrame(type: string, seq: number, payload: unknown) {
  return {
    type,
    seq,
    session_id: 'sess_1',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload,
  };
}

function protocolFrame(
  type: string,
  seq: number,
  payload: unknown,
  sessionId = 'sess_1',
) {
  return {
    type,
    seq,
    session_id: sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    payload,
  };
}

function eventConnectionRig(): {
  connection: KimiEventConnection;
  socket: FakeWebSocket;
  events: AppEvent[];
} {
  const events: AppEvent[] = [];
  const connection = createApi().connectEvents({
    onEvent: (event) => events.push(event),
    onResync: () => {},
    onError: () => {},
    onConnectionChange: () => {},
  });
  return { connection, socket: FakeWebSocket.instances[0]!, events };
}

function eventConnectionRigWithReducer(): {
  connection: KimiEventConnection;
  socket: FakeWebSocket;
  events: AppEvent[];
  getState: () => ReturnType<typeof createInitialState>;
  getResyncCount: () => number;
} {
  const events: AppEvent[] = [];
  let state = createInitialState();
  let resyncCount = 0;
  const connection = createApi().connectEvents({
    onEvent: (event, meta) => {
      events.push(event);
      state = reduceAppEvent(state, event, meta);
    },
    onResync: () => {
      resyncCount += 1;
    },
    onError: () => {},
    onConnectionChange: () => {},
  });
  return {
    connection,
    socket: FakeWebSocket.instances[0]!,
    events,
    getState: () => state,
    getResyncCount: () => resyncCount,
  };
}

describe('DaemonKimiWebApi.getSessionGoal', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps a present goal snapshot', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope(WIRE_GOAL));
    const goal = await createApi().getSessionGoal('sess_1');
    expect(goal?.objective).toBe('fix all lint warnings');
    expect(goal?.status).toBe('active');
    expect(goal?.turnsUsed).toBe(1);
  });

  it('maps null to null (no active goal)', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope(null));
    const goal = await createApi().getSessionGoal('sess_1');
    expect(goal).toBeNull();
  });

  it('requests the session goal endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope(null));
    await createApi().getSessionGoal('sess_42');
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/sessions/sess_42/goal',
    );
  });
});

describe('DaemonKimiWebApi event connection (session ownership)', () => {
  let originalWebSocket: typeof globalThis.WebSocket;
  let connection: KimiEventConnection | undefined;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    connection?.close();
    connection = undefined;
    globalThis.WebSocket = originalWebSocket;
  });

  it('drops a raw frame that arrives after its session is unsubscribed', () => {
    const rig = eventConnectionRig();
    connection = rig.connection;
    connection.subscribe('sess_1');
    rig.socket.emit(promptFrame(1, 'message_1'));
    expect(rig.events).toHaveLength(1);

    connection.unsubscribe('sess_1');
    rig.socket.emit(promptFrame(2, 'message_2'));

    expect(rig.events).toHaveLength(1);
  });

  it('accepts raw frames after a released session is subscribed again', () => {
    const rig = eventConnectionRig();
    connection = rig.connection;
    connection.subscribe('sess_1');
    connection.unsubscribe('sess_1');
    connection.subscribe('sess_1');

    rig.socket.emit(promptFrame(1, 'message_1'));

    expect(rig.events).toContainEqual(expect.objectContaining({ type: 'messageCreated' }));
  });

  it('drops late transcript and interaction frames without rebuilding reducer maps', () => {
    const rig = eventConnectionRigWithReducer();
    connection = rig.connection;
    connection.subscribe('sess_1');
    connection.unsubscribe('sess_1');

    const frames = [
      protocolFrame('event.message.updated', 1, {
        message_id: 'late_message',
        content: [],
        status: 'completed',
      }),
      protocolFrame('event.task.progress', 2, {
        task_id: 'late_task',
        output_chunk: 'late',
        stream: 'stdout',
      }),
      protocolFrame('event.approval.resolved', 3, {
        approval_id: 'late_approval',
        decision: 'rejected',
        resolved_by: 'user',
        resolved_at: '2026-01-01T00:00:00.000Z',
      }),
      protocolFrame('event.question.dismissed', 4, {
        question_id: 'late_question',
        dismissed_by: 'user',
        dismissed_at: '2026-01-01T00:00:00.000Z',
      }),
    ];
    for (const frame of frames) rig.socket.emit(frame);

    expect(rig.events).toEqual([]);
    expect(rig.getResyncCount()).toBe(0);
    const state = rig.getState();
    expect(state.messagesBySession).toEqual({});
    expect(state.tasksBySession).toEqual({});
    expect(state.approvalsBySession).toEqual({});
    expect(state.questionsBySession).toEqual({});
    expect(state.compactionBySession).toEqual({});
    expect(state.lastSeqBySession).toEqual({});
  });

  it('keeps all late session lifecycle fan-out events without resyncing an evicted session', () => {
    const rig = eventConnectionRigWithReducer();
    connection = rig.connection;
    connection.subscribe('sess_1');
    connection.unsubscribe('sess_1');

    const usage = {
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 3,
      cache_creation_tokens: 4,
      total_cost_usd: 0,
      context_tokens: 5,
      context_limit: 6,
      turn_count: 1,
    };
    rig.socket.emit(
      protocolFrame('event.session.usage_updated', 1, {
        usage,
        delta: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_tokens: 3,
          cache_creation_tokens: 4,
          cost_usd: 0,
        },
      }),
    );
    rig.socket.emit(
      protocolFrame('event.session.history_compacted', 2, {
        before_seq: 1,
        reason: 'history_rewrite',
      }),
    );

    expect(rig.events.map((event) => event.type)).toEqual([
      'sessionUsageUpdated',
      'historyCompacted',
    ]);
    expect(rig.getResyncCount()).toBe(0);
    expect(rig.getState().lastSeqBySession).toEqual({ sess_1: 2 });
    expect(rig.getState().messagesBySession).toEqual({});
    expect(rig.getState().tasksBySession).toEqual({});
  });

  it('keeps late real-session lifecycle and metadata fan-out events', () => {
    const rig = eventConnectionRigWithReducer();
    connection = rig.connection;
    connection.subscribe('sess_1');
    connection.unsubscribe('sess_1');

    rig.socket.emit(
      protocolFrame('event.session.status_changed', 1, {
        status: 'running',
        previous_status: 'idle',
      }),
    );
    rig.socket.emit(
      rawFrame('session.meta.updated', 2, {
        patch: { title: 'Updated title', lastPrompt: 'hello' },
      }),
    );

    expect(rig.events).toEqual([
      expect.objectContaining({ type: 'sessionStatusChanged', sessionId: 'sess_1' }),
      expect.objectContaining({ type: 'sessionMetaUpdated', sessionId: 'sess_1' }),
    ]);
    expect(rig.getState().lastSeqBySession).toEqual({ sess_1: 2 });
  });

  it('keeps global workspace protocol frames when no session is subscribed', () => {
    const rig = eventConnectionRig();
    connection = rig.connection;
    connection.subscribe('sess_1');
    connection.unsubscribe('sess_1');

    rig.socket.emit(
      protocolFrame(
        'event.workspace.created',
        1,
        {
          workspace: {
            id: 'workspace_1',
            root: '/tmp/workspace',
            name: 'workspace',
            is_git_repo: false,
            branch: null,
            session_count: 0,
          },
        },
        '__global__',
      ),
    );

    expect(rig.events).toContainEqual(
      expect.objectContaining({ type: 'workspaceCreated' }),
    );
  });

  it('does not carry released raw projector state into a reactivated session', () => {
    const rig = eventConnectionRig();
    connection = rig.connection;
    connection.subscribe('sess_1');
    rig.socket.emit(rawFrame('turn.started', 1, { turnId: 1 }));
    rig.socket.emit(rawFrame('turn.step.started', 2, { turnId: 1, step: 1 }));
    rig.socket.emit(rawFrame('assistant.delta', 3, { turnId: 1, delta: 'old' }));
    const assistantEventsBeforeRelease = rig.events.filter((event) => event.type === 'assistantDelta');
    expect(assistantEventsBeforeRelease).toHaveLength(1);

    connection.unsubscribe('sess_1');
    connection.subscribe('sess_1');
    rig.socket.emit(rawFrame('assistant.delta', 4, { turnId: 1, delta: 'late' }));
    expect(rig.events.filter((event) => event.type === 'assistantDelta')).toHaveLength(1);
  });

  it('continues an inactive side-channel stream without reviving main state', () => {
    const rig = eventConnectionRig();
    connection = rig.connection;
    connection.subscribe('sess_1');
    connection.markSideChannelAgent('agent_btw_1', 'sess_1');
    connection.unsubscribe('sess_1');

    rig.socket.emit(
      rawFrame('assistant.delta', 1, {
        agentId: 'agent_btw_1',
        delta: 'side chat continues',
      }),
    );

    expect(rig.events).toContainEqual(
      expect.objectContaining({ type: 'agentDelta', agentId: 'agent_btw_1' }),
    );
    expect(rig.events).not.toContainEqual(expect.objectContaining({ type: 'assistantDelta' }));
  });
});
