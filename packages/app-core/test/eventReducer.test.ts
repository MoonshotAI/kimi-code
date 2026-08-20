import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppApprovalRequest,
  AppMessage,
  AppQuestionRequest,
  AppSession,
  AppTask,
} from '../src/api';
import { createInitialState, reduceAppEvent, type EventMeta, type KimiClientState } from '../src/api/daemon/eventReducer';

const SID = 's_1';

// Freshness matters: settle only runs for fresh events, so each event gets an
// increasing seq (reduceAppEvent advances lastSeqBySession from meta.seq).
let seq = 0;
function meta(): EventMeta {
  return { sessionId: SID, seq: ++seq };
}

function assistantMessage(id: string): AppMessage {
  return { id, sessionId: SID, role: 'assistant', content: [], createdAt: new Date().toISOString() };
}

function approval(id: string, createdAt = new Date().toISOString()): AppApprovalRequest {
  return {
    approvalId: id,
    sessionId: SID,
    toolCallId: 'tc_1',
    toolName: 'Bash',
    action: 'run',
    display: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt,
  };
}

function question(id: string): AppQuestionRequest {
  return {
    questionId: id,
    sessionId: SID,
    questions: [{ id: 'q1', question: 'Proceed?', options: [] }],
    createdAt: new Date().toISOString(),
  };
}

/** State with one assistant message carrying a live-streamed thinking part. */
function stateWithOpenThinking(messageId = 'm_1'): KimiClientState {
  let state = createInitialState();
  state = reduceAppEvent(state, { type: 'messageCreated', message: assistantMessage(messageId) }, meta());
  state = reduceAppEvent(
    state,
    { type: 'assistantDelta', sessionId: SID, messageId, contentIndex: 0, delta: { thinking: 'hmm' } },
    meta(),
  );
  return state;
}

function thinkingPart(state: KimiClientState, messageId = 'm_1') {
  const part = state.messagesBySession[SID]?.find((m) => m.id === messageId)?.content.find((p) => p.type === 'thinking');
  if (part?.type !== 'thinking') throw new Error('expected a thinking part');
  return part;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('reduceAppEvent session work state', () => {
  it('clears a stale pending interaction when an idle work event omits it', () => {
    const session: AppSession = {
      id: SID,
      title: 'Session',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      busy: true,
      mainTurnActive: false,
      pendingInteraction: 'approval',
      archived: false,
      cwd: '/workspace',
      model: 'model',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
        contextTokens: 0,
        contextLimit: 0,
        turnCount: 0,
      },
      messageCount: 0,
      lastSeq: 0,
    };
    let state = createInitialState();
    state.sessions = [session];
    state.approvalsBySession[SID] = [approval('approval_1')];
    state.questionsBySession[SID] = [question('question_1')];

    state = reduceAppEvent(
      state,
      {
        type: 'sessionWorkChanged',
        sessionId: SID,
        busy: false,
        mainTurnActive: false,
      },
      meta(),
    );

    expect(state.sessions[0]?.pendingInteraction).toBe('none');
    expect(state.approvalsBySession[SID]).toBeUndefined();
    expect(state.questionsBySession[SID]).toBeUndefined();
  });
});

describe('reduceAppEvent thinking-part timing on user interactions', () => {
  it('stamps durationMs on the open thinking part when an approval is requested', () => {
    const before = Date.now();
    const state = reduceAppEvent(stateWithOpenThinking(), { type: 'approvalRequested', sessionId: SID, approval: approval('ap_1') }, meta());
    const part = thinkingPart(state);
    expect(part.startedAt).toBeDefined();
    expect(part.durationMs).toBeTypeOf('number');
    expect(part.durationMs!).toBeGreaterThanOrEqual(0);
    expect(part.durationMs!).toBeLessThanOrEqual(Date.now() - before + 1000);
  });

  it('stamps durationMs on the open thinking part when a question is requested', () => {
    const state = reduceAppEvent(stateWithOpenThinking(), { type: 'questionRequested', sessionId: SID, question: question('q_1') }, meta());
    expect(thinkingPart(state).durationMs).toBeTypeOf('number');
  });

  it('settles at the request creation time, not at event consumption time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let state = stateWithOpenThinking();
    // The request was created 4s into the thinking stream but consumed at 10s
    // (throttled tab): the settled span must be ~4s, not ~10s.
    vi.setSystemTime(1_000_000 + 10_000);
    state = reduceAppEvent(
      state,
      { type: 'approvalRequested', sessionId: SID, approval: approval('ap_1', new Date(1_000_000 + 4_000).toISOString()) },
      meta(),
    );
    expect(thinkingPart(state).durationMs).toBe(4_000);
  });

  it('does not extend the settled span when the approval wait drags on', () => {
    let state = reduceAppEvent(stateWithOpenThinking(), { type: 'approvalRequested', sessionId: SID, approval: approval('ap_1') }, meta());
    const settled = thinkingPart(state).durationMs!;
    // A later full-content replace (e.g. tool.call.started after approval)
    // must keep the already-settled span instead of re-stamping it.
    state = reduceAppEvent(
      state,
      {
        type: 'messageUpdated',
        sessionId: SID,
        messageId: 'm_1',
        content: [...(state.messagesBySession[SID]!.find((m) => m.id === 'm_1')!.content), { type: 'toolUse', toolCallId: 'tc_1', toolName: 'Bash', input: {} }],
        status: 'pending',
      },
      meta(),
    );
    expect(thinkingPart(state).durationMs).toBe(settled);
  });

  it('leaves already-settled or untimed content untouched', () => {
    // History-loaded message: thinking part without renderer stamps.
    const history = assistantMessage('m_1');
    history.content = [{ type: 'thinking', thinking: 'old' }];
    let state = createInitialState();
    state = reduceAppEvent(state, { type: 'messageCreated', message: history }, meta());
    state = reduceAppEvent(state, { type: 'approvalRequested', sessionId: SID, approval: approval('ap_1') }, meta());
    const part = thinkingPart(state);
    expect(part.startedAt).toBeUndefined();
    expect(part.durationMs).toBeUndefined();
  });

  it('ignores replayed (already-listed) approval requests', () => {
    let state = reduceAppEvent(stateWithOpenThinking(), { type: 'approvalRequested', sessionId: SID, approval: approval('ap_1') }, meta());
    const settled = thinkingPart(state).durationMs!;
    state = reduceAppEvent(state, { type: 'approvalRequested', sessionId: SID, approval: approval('ap_1') }, meta());
    expect(thinkingPart(state).durationMs).toBe(settled);
  });

  it('does not freeze a later turn when a resolved request replays after reconnect', () => {
    // Turn N: thinking streams, an approval parks the turn, then resolves.
    let state = reduceAppEvent(stateWithOpenThinking(), { type: 'approvalRequested', sessionId: SID, approval: approval('ap_1') }, meta());
    state = reduceAppEvent(state, { type: 'approvalResolved', sessionId: SID, approvalId: 'ap_1', decision: 'approved', resolvedAt: new Date().toISOString() }, meta());
    // Turn N+1: a fresh assistant message with live thinking.
    state = reduceAppEvent(state, { type: 'messageCreated', message: assistantMessage('m_2') }, meta());
    state = reduceAppEvent(
      state,
      { type: 'assistantDelta', sessionId: SID, messageId: 'm_2', contentIndex: 0, delta: { thinking: 'new turn' } },
      meta(),
    );
    // The reconnect replay redelivers the resolved request with a stale seq:
    // the id dedupe misses (resolved dropped it), but the freshness gate must.
    state = reduceAppEvent(state, { type: 'approvalRequested', sessionId: SID, approval: approval('ap_1') }, { sessionId: SID, seq: 1 });
    expect(thinkingPart(state, 'm_2').durationMs).toBeUndefined();
  });
});

describe('reduceAppEvent settle stamp (endedAt)', () => {
  it('stamps endedAt when the daemon turn duration lands', () => {
    const before = Date.now();
    let state = reduceAppEvent(createInitialState(), { type: 'messageCreated', message: assistantMessage('m_1') }, meta());
    state = reduceAppEvent(
      state,
      { type: 'messageUpdated', sessionId: SID, messageId: 'm_1', content: [{ type: 'text', text: 'done' }], status: 'completed', durationMs: 12_000 },
      meta(),
    );
    const msg = state.messagesBySession[SID]!.find((m) => m.id === 'm_1')!;
    expect(msg.durationMs).toBe(12_000);
    expect(msg.endedAt).toBeTypeOf('string');
    expect(Date.parse(msg.endedAt!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(msg.endedAt!)).toBeLessThanOrEqual(Date.now());
  });

  it('leaves endedAt unset when the update carries no daemon duration', () => {
    let state = reduceAppEvent(createInitialState(), { type: 'messageCreated', message: assistantMessage('m_1') }, meta());
    state = reduceAppEvent(
      state,
      { type: 'messageUpdated', sessionId: SID, messageId: 'm_1', content: [{ type: 'text', text: 'partial' }], status: 'pending' },
      meta(),
    );
    expect(state.messagesBySession[SID]!.find((m) => m.id === 'm_1')!.endedAt).toBeUndefined();
  });

  it('keeps the first settle stamp when a duration update replays', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    let state = reduceAppEvent(createInitialState(), { type: 'messageCreated', message: assistantMessage('m_1') }, meta());
    state = reduceAppEvent(
      state,
      { type: 'messageUpdated', sessionId: SID, messageId: 'm_1', content: [], status: 'completed', durationMs: 12_000 },
      meta(),
    );
    const first = state.messagesBySession[SID]!.find((m) => m.id === 'm_1')!.endedAt;
    vi.setSystemTime(5_060_000);
    state = reduceAppEvent(
      state,
      { type: 'messageUpdated', sessionId: SID, messageId: 'm_1', content: [], status: 'completed', durationMs: 12_000 },
      meta(),
    );
    expect(state.messagesBySession[SID]!.find((m) => m.id === 'm_1')!.endedAt).toBe(first);
  });
});

describe('reduceAppEvent optimistic echo reconciliation', () => {
  function optimisticUser(id: string): AppMessage {
    return {
      id,
      userMessageId: id,
      sessionId: SID,
      role: 'user',
      content: [{ type: 'text', text: '' }],
      createdAt: new Date().toISOString(),
      metadata: { 'kimiWeb.optimisticUserMessage': true },
    };
  }

  function syntheticUser(id: string, origin: Record<string, unknown>): AppMessage {
    return {
      id,
      sessionId: SID,
      role: 'user',
      content: [{ type: 'text', text: '' }],
      createdAt: new Date().toISOString(),
      metadata: { origin },
    };
  }

  it('appends a system_trigger message instead of reconciling it into an optimistic echo', () => {
    let state = reduceAppEvent(createInitialState(), { type: 'messageCreated', message: optimisticUser('u_opt') }, meta());
    state = reduceAppEvent(
      state,
      { type: 'messageCreated', message: syntheticUser('goal_1', { kind: 'system_trigger', name: 'goal_continuation' }) },
      meta(),
    );
    const msgs = state.messagesBySession[SID]!;
    expect(msgs.map((m) => m.id)).toEqual(['u_opt', 'goal_1']);
    expect(msgs[0]?.metadata?.['kimiWeb.optimisticUserMessage']).toBe(true);
  });

  it('still reconciles a real user echo by identity', () => {
    let state = reduceAppEvent(createInitialState(), { type: 'messageCreated', message: optimisticUser('u_opt') }, meta());
    const echo: AppMessage = { ...syntheticUser('srv_1', { kind: 'user' }), userMessageId: 'u_opt' };
    state = reduceAppEvent(state, { type: 'messageCreated', message: echo }, meta());
    expect(state.messagesBySession[SID]!.map((m) => m.id)).toEqual(['u_opt']);
  });
});

describe('reduceAppEvent taskCreated replacement', () => {
  function subagentTask(id: string, agentId?: string): AppTask {
    return {
      id,
      ...(agentId !== undefined ? { agentId } : {}),
      sessionId: SID,
      kind: 'subagent',
      description: 'Explore repo',
      status: 'running',
      createdAt: '2026-07-28T00:00:00.000Z',
    };
  }

  it('keeps the roster-seeded agent id when a skeleton re-projection omits it', () => {
    let state = reduceAppEvent(
      createInitialState(),
      { type: 'taskCreated', sessionId: SID, task: subagentTask('agent-1', 'agent-1') },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCreated', sessionId: SID, task: subagentTask('agent-1') },
      meta(),
    );
    expect(state.tasksBySession[SID]).toHaveLength(1);
    expect(state.tasksBySession[SID]![0]!.agentId).toBe('agent-1');
  });

  it('lets an explicit agent id replace a previously missing one', () => {
    let state = reduceAppEvent(
      createInitialState(),
      { type: 'taskCreated', sessionId: SID, task: subagentTask('agent-1') },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCreated', sessionId: SID, task: subagentTask('agent-1', 'agent-1') },
      meta(),
    );
    expect(state.tasksBySession[SID]![0]!.agentId).toBe('agent-1');
  });

  it('keeps the restored model and effort when a skeleton re-projection omits them', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          ...subagentTask('agent-1', 'agent-1'),
          model: 'provider/secondary',
          thinkingEffort: 'low',
        },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCreated', sessionId: SID, task: subagentTask('agent-1', 'agent-1') },
      meta(),
    );
    const task = state.tasksBySession[SID]![0]!;
    expect(task.model).toBe('provider/secondary');
    expect(task.thinkingEffort).toBe('low');
  });

  it('keeps the settled terminal state when a replay re-announces the task as running', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: { ...subagentTask('agent-1', 'agent-1'), backgroundTaskId: 'task-9' },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCompleted', sessionId: SID, taskId: 'task-9', status: 'cancelled' },
      meta(),
    );
    state = reduceAppEvent(
      state,
      {
        type: 'taskCreated',
        sessionId: SID,
        task: { ...subagentTask('agent-1', 'agent-1'), backgroundTaskId: 'task-9' },
      },
      meta(),
    );
    const task = state.tasksBySession[SID]![0]!;
    expect(task.status).toBe('cancelled');
    expect(task.completedAt).toBeDefined();
    expect(task.completedAtEstimated).toBe(true);
  });

  it('settles a background subagent row when termination arrives under its task id', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: { ...subagentTask('agent-1', 'agent-1'), backgroundTaskId: 'task-9' },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCompleted', sessionId: SID, taskId: 'task-9', status: 'completed' },
      meta(),
    );
    expect(state.tasksBySession[SID]).toHaveLength(1);
    expect(state.tasksBySession[SID]![0]!.status).toBe('completed');
  });

  it('keeps the polled output when a termination event carries no output fields', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          ...subagentTask('agent-1', 'agent-1'),
          backgroundTaskId: 'task-9',
          outputPreview: 'final result',
          outputBytes: 128,
        },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCompleted', sessionId: SID, taskId: 'task-9', status: 'cancelled' },
      meta(),
    );
    const task = state.tasksBySession[SID]![0]!;
    expect(task.outputPreview).toBe('final result');
    expect(task.outputBytes).toBe(128);
  });

  it('keeps the polled output when a replayed taskCreated carries none', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          ...subagentTask('agent-1', 'agent-1'),
          backgroundTaskId: 'task-9',
          outputPreview: 'final result',
          outputBytes: 128,
        },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      {
        type: 'taskCreated',
        sessionId: SID,
        task: { ...subagentTask('agent-1', 'agent-1'), backgroundTaskId: 'task-9' },
      },
      meta(),
    );
    const task = state.tasksBySession[SID]![0]!;
    expect(task.outputPreview).toBe('final result');
    expect(task.outputBytes).toBe(128);
  });

  it('rekeys a task-id skeleton row when the spawned projection carries its task id', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          id: 'task-9',
          sessionId: SID,
          kind: 'subagent',
          description: 'Explore repo',
          status: 'running',
          createdAt: '2026-07-28T00:00:00.000Z',
        },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      {
        type: 'taskCreated',
        sessionId: SID,
        task: { ...subagentTask('agent-1', 'agent-1'), backgroundTaskId: 'task-9' },
      },
      meta(),
    );
    expect(state.tasksBySession[SID]).toHaveLength(1);
    expect(state.tasksBySession[SID]![0]).toMatchObject({
      id: 'agent-1',
      agentId: 'agent-1',
      backgroundTaskId: 'task-9',
    });
  });

  it('drops the skeleton copy when the agent-keyed row already exists at fold time', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          id: 'task-9',
          sessionId: SID,
          kind: 'subagent',
          description: 'Explore repo',
          status: 'running',
          createdAt: '2026-07-28T00:00:00.000Z',
        },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCreated', sessionId: SID, task: subagentTask('agent-1', 'agent-1') },
      meta(),
    );
    state = reduceAppEvent(
      state,
      {
        type: 'taskCreated',
        sessionId: SID,
        task: { ...subagentTask('agent-1', 'agent-1'), backgroundTaskId: 'task-9' },
      },
      meta(),
    );
    expect(state.tasksBySession[SID]).toHaveLength(1);
    expect(state.tasksBySession[SID]![0]!.id).toBe('agent-1');
  });

  it('keeps the dropped skeleton terminal state when folding over a live agent row', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          id: 'task-9',
          sessionId: SID,
          kind: 'subagent',
          description: 'Explore repo',
          status: 'cancelled',
          createdAt: '2026-07-28T00:00:00.000Z',
          completedAt: '2026-07-28T00:05:00.000Z',
        },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCreated', sessionId: SID, task: subagentTask('agent-1', 'agent-1') },
      meta(),
    );
    state = reduceAppEvent(
      state,
      {
        type: 'taskCreated',
        sessionId: SID,
        task: { ...subagentTask('agent-1', 'agent-1'), backgroundTaskId: 'task-9' },
      },
      meta(),
    );
    expect(state.tasksBySession[SID]).toHaveLength(1);
    expect(state.tasksBySession[SID]![0]).toMatchObject({
      id: 'agent-1',
      status: 'cancelled',
      completedAt: '2026-07-28T00:05:00.000Z',
    });
  });

  it('lets a resumed run back to running when its task binding changed', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          ...subagentTask('agent-1', 'agent-1'),
          status: 'completed' as const,
          backgroundTaskId: 'task-9',
          completedAt: '2026-07-28T00:05:00.000Z',
        },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      {
        type: 'taskCreated',
        sessionId: SID,
        task: { ...subagentTask('agent-1', 'agent-1'), backgroundTaskId: 'task-10' },
      },
      meta(),
    );
    expect(state.tasksBySession[SID]![0]!.status).toBe('running');
  });

  it('clears the accumulated output even when the previous run is still marked running', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          ...subagentTask('agent-1', 'agent-1'),
          backgroundTaskId: 'task-9',
          outputLines: ['old line'],
          text: 'old text',
          outputPreview: 'old result',
          outputBytes: 128,
        },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      {
        type: 'taskCreated',
        sessionId: SID,
        task: { ...subagentTask('agent-1', 'agent-1'), backgroundTaskId: 'task-10' },
      },
      meta(),
    );
    const task = state.tasksBySession[SID]![0]!;
    expect(task.outputLines).toBeUndefined();
    expect(task.text).toBeUndefined();
    expect(task.outputPreview).toBeUndefined();
    expect(task.outputBytes).toBeUndefined();
  });

  it('clears the accumulated output when a new run starts under a fresh binding', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          ...subagentTask('agent-1', 'agent-1'),
          status: 'completed' as const,
          backgroundTaskId: 'task-9',
          completedAt: '2026-07-28T00:05:00.000Z',
          outputPreview: 'old result',
          outputBytes: 128,
          outputLines: ['old line'],
          text: 'old text',
        },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      {
        type: 'taskCreated',
        sessionId: SID,
        task: { ...subagentTask('agent-1', 'agent-1'), backgroundTaskId: 'task-10' },
      },
      meta(),
    );
    const task = state.tasksBySession[SID]![0]!;
    expect(task.outputPreview).toBeUndefined();
    expect(task.outputBytes).toBeUndefined();
    expect(task.outputLines).toBeUndefined();
    expect(task.text).toBeUndefined();
  });

  it('keeps streaming output on a binding-less running row being re-projected', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          ...subagentTask('agent-1', 'agent-1'),
          outputLines: ['delta one'],
          text: 'delta one',
        },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCreated', sessionId: SID, task: subagentTask('agent-1', 'agent-1') },
      meta(),
    );
    const task = state.tasksBySession[SID]![0]!;
    expect(task.outputLines).toEqual(['delta one']);
    expect(task.text).toBe('delta one');
  });

  it('keeps a settled bash row terminal when its task.started replays', () => {
    const bashTask = {
      id: 'task-1',
      sessionId: SID,
      kind: 'bash' as const,
      description: 'npm test',
      status: 'running' as const,
      createdAt: '2026-07-28T00:00:00.000Z',
    };
    let state = reduceAppEvent(
      createInitialState(),
      { type: 'taskCreated', sessionId: SID, task: bashTask },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCompleted', sessionId: SID, taskId: 'task-1', status: 'completed' },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCreated', sessionId: SID, task: bashTask },
      meta(),
    );
    expect(state.tasksBySession[SID]![0]!.status).toBe('completed');
  });

  it('clears the stale binding on a new run so a late termination cannot kill it', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          ...subagentTask('agent-1', 'agent-1'),
          status: 'completed' as const,
          backgroundTaskId: 'task-9',
          completedAt: '2026-07-28T00:05:00.000Z',
        },
      },
      meta(),
    );
    // Resumed in the foreground: the new run ships no task binding at all.
    state = reduceAppEvent(
      state,
      { type: 'taskCreated', sessionId: SID, task: subagentTask('agent-1', 'agent-1') },
      meta(),
    );
    expect(state.tasksBySession[SID]![0]!.backgroundTaskId).toBeUndefined();
    // A late termination for the previous run must not hit the live row.
    state = reduceAppEvent(
      state,
      { type: 'taskCompleted', sessionId: SID, taskId: 'task-9', status: 'cancelled' },
      meta(),
    );
    expect(state.tasksBySession[SID]![0]!.status).toBe('running');
  });

  it('merges the dropped skeleton output into the fold', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          id: 'task-9',
          sessionId: SID,
          kind: 'subagent',
          description: 'Explore repo',
          status: 'completed',
          createdAt: '2026-07-28T00:00:00.000Z',
          completedAt: '2026-07-28T00:05:00.000Z',
          outputPreview: 'skeleton result',
          outputBytes: 256,
        },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCreated', sessionId: SID, task: subagentTask('agent-1', 'agent-1') },
      meta(),
    );
    state = reduceAppEvent(
      state,
      {
        type: 'taskCreated',
        sessionId: SID,
        task: { ...subagentTask('agent-1', 'agent-1'), backgroundTaskId: 'task-9' },
      },
      meta(),
    );
    expect(state.tasksBySession[SID]).toHaveLength(1);
    expect(state.tasksBySession[SID]![0]).toMatchObject({
      id: 'agent-1',
      status: 'completed',
      outputPreview: 'skeleton result',
      outputBytes: 256,
    });
  });

  it('treats a lone skeleton fold as the same run and keeps its terminal state and output', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          id: 'task-9',
          sessionId: SID,
          kind: 'subagent',
          description: 'Explore repo',
          status: 'cancelled',
          createdAt: '2026-07-28T00:00:00.000Z',
          completedAt: '2026-07-28T00:05:00.000Z',
          outputPreview: 'skeleton result',
          outputBytes: 256,
        },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      {
        type: 'taskCreated',
        sessionId: SID,
        task: { ...subagentTask('agent-1', 'agent-1'), backgroundTaskId: 'task-9' },
      },
      meta(),
    );
    expect(state.tasksBySession[SID]).toHaveLength(1);
    expect(state.tasksBySession[SID]![0]).toMatchObject({
      id: 'agent-1',
      status: 'cancelled',
      outputPreview: 'skeleton result',
      outputBytes: 256,
    });
  });

  it('keeps a settled skeleton terminal when its own task.started replays', () => {
    const skeletonTask = {
      id: 'task-9',
      sessionId: SID,
      kind: 'subagent' as const,
      description: 'Explore repo',
      status: 'running' as const,
      createdAt: '2026-07-28T00:00:00.000Z',
    };
    let state = reduceAppEvent(
      createInitialState(),
      { type: 'taskCreated', sessionId: SID, task: skeletonTask },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCompleted', sessionId: SID, taskId: 'task-9', status: 'cancelled' },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCreated', sessionId: SID, task: skeletonTask },
      meta(),
    );
    expect(state.tasksBySession[SID]![0]!.status).toBe('cancelled');
  });

  it('does not let a replayed completed downgrade a cancelled or failed row', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: { ...subagentTask('agent-1', 'agent-1'), backgroundTaskId: 'task-9' },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCompleted', sessionId: SID, taskId: 'task-9', status: 'cancelled' },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCompleted', sessionId: SID, taskId: 'task-9', status: 'completed' },
      meta(),
    );
    expect(state.tasksBySession[SID]![0]!.status).toBe('cancelled');
  });

  it('does not let a raced failed overwrite a user-cancelled row', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: { ...subagentTask('agent-1', 'agent-1'), backgroundTaskId: 'task-9' },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCompleted', sessionId: SID, taskId: 'task-9', status: 'cancelled' },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCompleted', sessionId: SID, taskId: 'task-9', status: 'failed' },
      meta(),
    );
    expect(state.tasksBySession[SID]![0]!.status).toBe('cancelled');
  });

  it('keeps the daemon completion stamp through a same-terminal replay', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          ...subagentTask('agent-1', 'agent-1'),
          status: 'completed' as const,
          backgroundTaskId: 'task-9',
          completedAt: '2026-07-28T00:05:00.000Z',
        },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          ...subagentTask('agent-1', 'agent-1'),
          status: 'completed',
          backgroundTaskId: 'task-9',
          completedAt: '2026-08-01T00:00:00.000Z',
          completedAtEstimated: true,
        },
      },
      meta(),
    );
    const task = state.tasksBySession[SID]![0]!;
    expect(task.completedAt).toBe('2026-07-28T00:05:00.000Z');
    expect(task.completedAtEstimated).toBeUndefined();
  });

  it('keeps the kernel terminal through the projector taskCreated leg of a replayed completion', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: { ...subagentTask('agent-1', 'agent-1'), backgroundTaskId: 'task-9' },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCompleted', sessionId: SID, taskId: 'task-9', status: 'cancelled' },
      meta(),
    );
    // A replayed subagent.completed always projects taskCreated first.
    state = reduceAppEvent(
      state,
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          ...subagentTask('agent-1', 'agent-1'),
          status: 'completed',
          backgroundTaskId: 'task-9',
          outputPreview: 'done',
        },
      },
      meta(),
    );
    expect(state.tasksBySession[SID]![0]!.status).toBe('cancelled');
    state = reduceAppEvent(
      state,
      { type: 'taskCompleted', sessionId: SID, taskId: 'task-9', status: 'completed' },
      meta(),
    );
    expect(state.tasksBySession[SID]![0]!.status).toBe('cancelled');
  });

  it('keeps the sticky row’s output fields when a replayed completion brings a summary', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          ...subagentTask('agent-1', 'agent-1'),
          backgroundTaskId: 'task-9',
          outputLines: ['cancelled tail'],
          text: 'cancelled tail',
        },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCompleted', sessionId: SID, taskId: 'task-9', status: 'cancelled' },
      meta(),
    );
    state = reduceAppEvent(
      state,
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          ...subagentTask('agent-1', 'agent-1'),
          status: 'completed',
          backgroundTaskId: 'task-9',
          outputPreview: 'success summary',
          outputBytes: 512,
        },
      },
      meta(),
    );
    const task = state.tasksBySession[SID]![0]!;
    expect(task.status).toBe('cancelled');
    expect(task.outputPreview).toBeUndefined();
    expect(task.outputBytes).toBeUndefined();
    expect(task.outputLines).toEqual(['cancelled tail']);
    expect(task.text).toBe('cancelled tail');
  });
});

describe('foreground subagent sweep at main turn end', () => {
  const fgTask = (id: string): AppTask => ({
    id,
    agentId: id,
    sessionId: SID,
    kind: 'subagent',
    description: 'Explore repo',
    status: 'running',
    runInBackground: false,
    createdAt: '2026-07-28T00:00:00.000Z',
  });

  it('settles running foreground subagent rows when the main turn ends completed', () => {
    let state = reduceAppEvent(
      createInitialState(),
      { type: 'taskCreated', sessionId: SID, task: fgTask('agent-0') },
      meta(),
    );
    state = reduceAppEvent(
      state,
      {
        type: 'taskCreated',
        sessionId: SID,
        task: { ...fgTask('agent-1'), runInBackground: true, backgroundTaskId: 'task-9' },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'turnActiveChanged', sessionId: SID, active: false, reason: 'completed' },
      meta(),
    );
    const [fg, bg] = state.tasksBySession[SID]!;
    expect(fg).toMatchObject({
      status: 'completed',
      subagentPhase: 'completed',
      completedAtEstimated: true,
    });
    expect(fg!.completedAt).toBeDefined();
    expect(bg!.status).toBe('running');
  });

  it('finalizes live foreground rows as failed when the turn aborts', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: { ...fgTask('agent-0'), subagentPhase: 'suspended' as const, suspendedReason: 'approval' },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'turnActiveChanged', sessionId: SID, active: false, reason: 'cancelled' },
      meta(),
    );
    const row = state.tasksBySession[SID]![0]!;
    expect(row.status).toBe('failed');
    expect(row.subagentPhase).toBe('failed');
    expect(row.suspendedReason).toBeUndefined();
  });

  it('leaves already-settled and other-session rows alone', () => {
    let state = reduceAppEvent(
      createInitialState(),
      {
        type: 'taskCreated',
        sessionId: SID,
        task: {
          ...fgTask('agent-0'),
          status: 'failed' as const,
          completedAt: '2026-07-28T00:05:00.000Z',
        },
      },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskCreated', sessionId: 's2', task: { ...fgTask('agent-1'), sessionId: 's2' } },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'turnActiveChanged', sessionId: SID, active: false, reason: 'completed' },
      meta(),
    );
    expect(state.tasksBySession[SID]![0]).toMatchObject({
      status: 'failed',
      completedAt: '2026-07-28T00:05:00.000Z',
    });
    expect(state.tasksBySession['s2']![0]!.status).toBe('running');
  });
});

describe('turnErrorBySession', () => {
  const agentError = {
    type: 'unknown' as const,
    raw: {
      _agentError: true,
      code: 'provider.rate_limit',
      message: '429 The engine is currently overloaded, please try again later',
      name: 'APIProviderRateLimitError',
      details: { statusCode: 429 },
      retryable: true,
    },
  };

  it('records the agent error per session so the failed-turn card survives the toast', () => {
    const state = reduceAppEvent(createInitialState(), agentError, meta());
    expect(state.turnErrorBySession[SID]).toEqual({
      code: 'provider.rate_limit',
      message: '429 The engine is currently overloaded, please try again later',
      name: 'APIProviderRateLimitError',
      retryable: true,
      statusCode: 429,
      requestId: undefined,
    });
    // A background (non-viewed) session keeps the transient warning toast —
    // it is the only failure signal there.
    expect(state.warnings).toHaveLength(1);
  });

  it('ignores stale replays of an already-surfaced error', () => {
    let state = reduceAppEvent(createInitialState(), agentError, meta());
    // A replayed frame with an older seq and different content must not
    // overwrite the recorded failure nor re-toast.
    const stale = {
      type: 'unknown' as const,
      raw: { _agentError: true, code: 'provider.connection_error', message: 'stale copy' },
    };
    state = reduceAppEvent(state, stale, { sessionId: SID, seq: 0 });
    expect(state.turnErrorBySession[SID]?.code).toBe('provider.rate_limit');
    expect(state.warnings).toHaveLength(1);
  });

  it('suppresses the toast when the failed session is the one being viewed', () => {
    const initial = createInitialState();
    initial.activeSessionId = SID;
    const state = reduceAppEvent(initial, agentError, meta());
    expect(state.turnErrorBySession[SID]?.code).toBe('provider.rate_limit');
    expect(state.warnings).toHaveLength(0);
  });

  it('clears the recorded error when the next main turn starts', () => {
    let state = reduceAppEvent(createInitialState(), agentError, meta());
    state = reduceAppEvent(
      state,
      { type: 'turnActiveChanged', sessionId: SID, active: true },
      meta(),
    );
    expect(state.turnErrorBySession[SID]).toBeUndefined();
  });

  it('keeps the recorded error when the turn merely ends', () => {
    let state = reduceAppEvent(createInitialState(), agentError, meta());
    state = reduceAppEvent(
      state,
      { type: 'turnActiveChanged', sessionId: SID, active: false },
      meta(),
    );
    expect(state.turnErrorBySession[SID]?.code).toBe('provider.rate_limit');
  });

  it('drops the record when the session is deleted', () => {
    let state = reduceAppEvent(createInitialState(), agentError, meta());
    state = reduceAppEvent(state, { type: 'sessionDeleted', sessionId: SID }, meta());
    expect(state.turnErrorBySession[SID]).toBeUndefined();
  });
});

describe('turnRetryBySession', () => {
  const retry = { failedAttempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 1000, statusCode: 429 };

  it('records the live retry state and clears it when the backoff ends', () => {
    let state = reduceAppEvent(createInitialState(), { type: 'turnRetry', sessionId: SID, retry }, meta());
    expect(state.turnRetryBySession[SID]).toEqual(retry);
    state = reduceAppEvent(state, { type: 'turnRetry', sessionId: SID, retry: undefined }, meta());
    expect(state.turnRetryBySession[SID]).toBeUndefined();
  });

  it('clears the retry state when the turn ends', () => {
    let state = reduceAppEvent(createInitialState(), { type: 'turnRetry', sessionId: SID, retry }, meta());
    state = reduceAppEvent(
      state,
      { type: 'turnActiveChanged', sessionId: SID, active: false },
      meta(),
    );
    expect(state.turnRetryBySession[SID]).toBeUndefined();
  });

  it('drops the retry state with the session', () => {
    let state = reduceAppEvent(createInitialState(), { type: 'turnRetry', sessionId: SID, retry }, meta());
    state = reduceAppEvent(state, { type: 'sessionDeleted', sessionId: SID }, meta());
    expect(state.turnRetryBySession[SID]).toBeUndefined();
  });
});

describe('freshness gates on turn failure/retry state', () => {
  const retry = { failedAttempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 1000 };

  it('ignores a stale turnRetry write', () => {
    let state = reduceAppEvent(createInitialState(), { type: 'turnRetry', sessionId: SID, retry }, meta());
    expect(state.turnRetryBySession[SID]).toEqual(retry);
    // A replayed older write must not resurrect an earlier turn's retry.
    state = reduceAppEvent(
      state,
      { type: 'turnRetry', sessionId: SID, retry: { ...retry, nextAttempt: 9 } },
      { sessionId: SID, seq: 0 },
    );
    expect(state.turnRetryBySession[SID]?.nextAttempt).toBe(2);
  });

  it('ignores a stale turnRetry clear against a live retry', () => {
    let state = reduceAppEvent(createInitialState(), { type: 'turnRetry', sessionId: SID, retry }, meta());
    state = reduceAppEvent(
      state,
      { type: 'turnRetry', sessionId: SID, retry: undefined },
      { sessionId: SID, seq: 0 },
    );
    expect(state.turnRetryBySession[SID]).toEqual(retry);
  });

  it('keeps the recorded failure when a stale turn start replays', () => {
    const agentError = {
      type: 'unknown' as const,
      raw: { _agentError: true, code: 'provider.rate_limit', message: '429' },
    };
    let state = reduceAppEvent(createInitialState(), agentError, meta());
    expect(state.turnErrorBySession[SID]?.code).toBe('provider.rate_limit');
    state = reduceAppEvent(
      state,
      { type: 'turnActiveChanged', sessionId: SID, active: true },
      { sessionId: SID, seq: 0 },
    );
    expect(state.turnErrorBySession[SID]?.code).toBe('provider.rate_limit');
  });
});

describe('turn-start recency bump', () => {
  function stateWithIdleSession(): KimiClientState {
    const session: AppSession = {
      id: SID,
      title: 'Session',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      busy: false,
      mainTurnActive: false,
      archived: false,
      cwd: '/workspace',
      model: 'model',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
        contextTokens: 0,
        contextLimit: 0,
        turnCount: 0,
      },
      messageCount: 0,
      lastSeq: 0,
    };
    const state = createInitialState();
    state.sessions = [session];
    return state;
  }

  it('a fresh turn start floats the session (turn start is real activity)', () => {
    const state = reduceAppEvent(
      stateWithIdleSession(),
      { type: 'turnActiveChanged', sessionId: SID, active: true },
      meta(),
    );
    expect(state.sessions[0]!.updatedAt > '2026-01-01T00:00:00.000Z').toBe(true);
  });

  it('a replayed (stale) turn start does not bump recency', () => {
    const state = reduceAppEvent(
      stateWithIdleSession(),
      { type: 'turnActiveChanged', sessionId: SID, active: true },
      { sessionId: SID, seq: 0 },
    );
    expect(state.sessions[0]!.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('sessionWorkChanged fallback freshness', () => {  it('does not clear a live retry on a stale work_changed replay', () => {
    const retry = { failedAttempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 1000 };
    let state = reduceAppEvent(createInitialState(), { type: 'turnRetry', sessionId: SID, retry }, meta());
    const session = {
      id: SID,
      workspaceId: 'w',
      title: '',
      createdAt: '',
      updatedAt: '',
      busy: true,
      archived: false,
      cwd: '/tmp',
      model: '',
      thinking: 'high',
      permission: 'auto',
      usage: {},
      lastPrompt: '',
      messageCount: 0,
      lastSeq: 0,
    } as never;
    state.sessions = [session];
    // A stale idle work_changed (older seq) must not retire the live retry.
    state = reduceAppEvent(
      state,
      { type: 'sessionWorkChanged', sessionId: SID, busy: false, mainTurnActive: false },
      { sessionId: SID, seq: 0 },
    );
    expect(state.turnRetryBySession[SID]).toEqual(retry);
  });
});

describe('reduceAppEvent toolOutput replace', () => {
  function stateWithToolUse(toolCallId: string, messageId: string): KimiClientState {
    const message: AppMessage = {
      id: messageId,
      sessionId: SID,
      role: 'assistant',
      content: [{ type: 'toolUse', toolCallId, toolName: 'WaitFor', input: {} }],
      createdAt: new Date().toISOString(),
    };
    return reduceAppEvent(createInitialState(), { type: 'messageCreated', message }, meta());
  }

  function toolUseLines(state: KimiClientState, messageId: string): string[] | undefined {
    const part = state.messagesBySession[SID]
      ?.find((m) => m.id === messageId)
      ?.content.find((p) => p.type === 'toolUse');
    return part?.type === 'toolUse' ? part.outputLines : undefined;
  }

  function toolOutput(toolCallId: string, outputChunk: string, replace?: boolean) {
    return { type: 'toolOutput', sessionId: SID, toolCallId, outputChunk, stream: 'stdout', replace } as const;
  }

  it('appends chunks by default', () => {
    let state = stateWithToolUse('tc_1', 'm_1');
    state = reduceAppEvent(state, toolOutput('tc_1', 'line 1'), meta());
    state = reduceAppEvent(state, toolOutput('tc_1', 'line 2', false), meta());
    expect(toolUseLines(state, 'm_1')).toEqual(['line 1', 'line 2']);
  });

  it('rewrites the last line on replace updates', () => {
    let state = stateWithToolUse('tc_1', 'm_1');
    state = reduceAppEvent(state, toolOutput('tc_1', 'Waiting 1s / 15s', true), meta());
    state = reduceAppEvent(state, toolOutput('tc_1', 'Waiting 2s / 15s', true), meta());
    state = reduceAppEvent(state, toolOutput('tc_1', 'Waiting 3s / 15s', true), meta());
    expect(toolUseLines(state, 'm_1')).toEqual(['Waiting 3s / 15s']);
  });

  it('rewrites only the last line on replace, keeping earlier ones', () => {
    let state = stateWithToolUse('tc_1', 'm_1');
    state = reduceAppEvent(state, toolOutput('tc_1', 'first'), meta());
    state = reduceAppEvent(state, toolOutput('tc_1', 'second'), meta());
    state = reduceAppEvent(state, toolOutput('tc_1', 'tick 1', true), meta());
    state = reduceAppEvent(state, toolOutput('tc_1', 'tick 2', true), meta());
    expect(toolUseLines(state, 'm_1')).toEqual(['first', 'tick 2']);
  });

  it('pushes a replace chunk when there is no prior line', () => {
    let state = stateWithToolUse('tc_1', 'm_1');
    state = reduceAppEvent(state, toolOutput('tc_1', 'Waiting 1s / 15s', true), meta());
    expect(toolUseLines(state, 'm_1')).toEqual(['Waiting 1s / 15s']);
  });

  it('only touches the message carrying the matching toolCallId', () => {
    let state = stateWithToolUse('tc_1', 'm_1');
    state = reduceAppEvent(
      state,
      {
        type: 'messageCreated',
        message: {
          id: 'm_2',
          sessionId: SID,
          role: 'assistant',
          content: [{ type: 'toolUse', toolCallId: 'tc_2', toolName: 'Bash', input: {} }],
          createdAt: new Date().toISOString(),
        },
      },
      meta(),
    );
    state = reduceAppEvent(state, toolOutput('tc_2', 'Waiting 1s / 15s', true), meta());
    state = reduceAppEvent(state, toolOutput('tc_2', 'Waiting 2s / 15s', true), meta());
    expect(toolUseLines(state, 'm_1')).toBeUndefined();
    expect(toolUseLines(state, 'm_2')).toEqual(['Waiting 2s / 15s']);
  });
});

describe('reduceAppEvent taskProgress replace', () => {
  function stateWithTask(taskId: string): KimiClientState {
    const task: AppTask = {
      id: taskId,
      sessionId: SID,
      kind: 'subagent',
      description: 'Wait for tests',
      status: 'running',
      createdAt: new Date().toISOString(),
    };
    return reduceAppEvent(createInitialState(), { type: 'taskCreated', sessionId: SID, task }, meta());
  }

  function taskLines(state: KimiClientState, taskId: string): string[] | undefined {
    return state.tasksBySession[SID]?.find((task) => task.id === taskId)?.outputLines;
  }

  function taskProgress(taskId: string, outputChunk: string, replace?: boolean) {
    return { type: 'taskProgress', sessionId: SID, taskId, outputChunk, stream: 'stdout', replace } as const;
  }

  it('rewrites the last progress line on replace updates', () => {
    let state = stateWithTask('sub-1');
    state = reduceAppEvent(state, taskProgress('sub-1', 'Waiting 1s / 15s', true), meta());
    state = reduceAppEvent(state, taskProgress('sub-1', 'Waiting 2s / 15s', true), meta());
    state = reduceAppEvent(state, taskProgress('sub-1', 'Waiting 3s / 15s', true), meta());
    expect(taskLines(state, 'sub-1')).toEqual(['Waiting 3s / 15s']);
  });

  it('rewrites only the last line, keeping earlier progress lines', () => {
    let state = stateWithTask('sub-1');
    state = reduceAppEvent(state, taskProgress('sub-1', 'Calling Read: src/a.ts'), meta());
    state = reduceAppEvent(state, taskProgress('sub-1', 'Calling WaitFor: bg_7f3a'), meta());
    state = reduceAppEvent(state, taskProgress('sub-1', 'Waiting 1s / 15s', true), meta());
    state = reduceAppEvent(state, taskProgress('sub-1', 'Waiting 2s / 15s', true), meta());
    expect(taskLines(state, 'sub-1')).toEqual(['Calling Read: src/a.ts', 'Waiting 2s / 15s']);
  });

  it('pushes a replace chunk when there is no prior line', () => {
    let state = stateWithTask('sub-1');
    state = reduceAppEvent(state, taskProgress('sub-1', 'Waiting 1s / 15s', true), meta());
    expect(taskLines(state, 'sub-1')).toEqual(['Waiting 1s / 15s']);
  });

  it('still concatenates text-kind chunks regardless of the line path', () => {
    let state = stateWithTask('sub-1');
    state = reduceAppEvent(
      state,
      { type: 'taskProgress', sessionId: SID, taskId: 'sub-1', outputChunk: 'Hello', stream: 'stdout', kind: 'text' },
      meta(),
    );
    state = reduceAppEvent(
      state,
      { type: 'taskProgress', sessionId: SID, taskId: 'sub-1', outputChunk: ' world', stream: 'stdout', kind: 'text' },
      meta(),
    );
    expect(state.tasksBySession[SID]?.find((task) => task.id === 'sub-1')?.text).toBe('Hello world');
  });
});
