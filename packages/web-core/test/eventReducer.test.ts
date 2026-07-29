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
});
