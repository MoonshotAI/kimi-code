import { describe, expect, it } from 'vitest';
import type {
  AppApprovalRequest,
  AppQuestionRequest,
  AppSession,
} from '../src/api';
import { createInitialState, isModelTurnErrorNotice, reduceAppEvent, type EventMeta, type KimiClientState } from '../src/api/daemon/eventReducer';

const SID = 's_1';

function meta(): EventMeta {
  return { sessionId: SID };
}

function approval(id: string): AppApprovalRequest {
  return {
    approvalId: id,
    sessionId: SID,
    toolCallId: 'tc_1',
    toolName: 'Bash',
    action: 'run',
    display: null,
  };
}

function question(id: string): AppQuestionRequest {
  return {
    questionId: id,
    sessionId: SID,
    questions: [{ id: 'q1', question: 'Proceed?', options: [] }],
  };
}

describe('reduceAppEvent interactions', () => {
  it('removes only the ended interaction of its kind', () => {
    const state = createInitialState();
    state.approvalsBySession[SID] = [approval('a1'), approval('a2')];
    state.questionsBySession[SID] = [question('a1')];
    const next = reduceAppEvent(
      state,
      { type: 'interactionEnded', sessionId: SID, interactionId: 'a1', kind: 'approval', outcome: 'cancelled' },
      { sessionId: SID },
    );
    expect(next.approvalsBySession[SID]?.map((a) => a.approvalId)).toEqual(['a2']);
    expect(next.questionsBySession[SID]?.map((q) => q.questionId)).toEqual(['a1']);
  });

  it('clears the session interactions on reset and keeps other sessions', () => {
    const state = createInitialState();
    state.approvalsBySession[SID] = [approval('a1')];
    state.questionsBySession[SID] = [question('q1')];
    state.approvalsBySession['other'] = [approval('a2')];
    const next = reduceAppEvent(
      state,
      { type: 'interactionsReset', sessionId: SID },
      { sessionId: SID },
    );
    expect(next.approvalsBySession[SID]).toBeUndefined();
    expect(next.questionsBySession[SID]).toBeUndefined();
    expect(next.approvalsBySession['other']).toHaveLength(1);
  });
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

describe('goalVersionBySession', () => {
  it('drops the version counter with the session', () => {
    const initial = createInitialState();
    initial.goalVersionBySession[SID] = 1;
    const state = reduceAppEvent(initial, { type: 'sessionDeleted', sessionId: SID }, meta());
    expect(state.goalVersionBySession[SID]).toBeUndefined();
  });
});


describe('turn liveness and session recency', () => {
  function stateWithRow(): KimiClientState {
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
    };
    const state = createInitialState();
    state.sessions = [session];
    return state;
  }

  it('a turn start applies state but never touches recency', () => {
    const state = reduceAppEvent(
      stateWithRow(),
      { type: 'sessionWorkChanged', sessionId: SID, busy: true, mainTurnActive: true },
      { sessionId: SID },
    );
    expect(state.sessions[0]!.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.sessions[0]!.mainTurnActive).toBe(true);
  });

  it('a turn end does not bump recency', () => {
    const state = reduceAppEvent(
      stateWithRow(),
      { type: 'sessionWorkChanged', sessionId: SID, busy: false, mainTurnActive: false },
      { sessionId: SID },
    );
    expect(state.sessions[0]!.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('preserves live model, usage, messageCount, and pullRequest when compact session snapshot arrives', () => {
    const initial = stateWithRow();
    initial.sessions[0] = {
      ...initial.sessions[0]!,
      model: 'kimi-k2',
      usage: {
        inputTokens: 120,
        outputTokens: 80,
        cacheReadTokens: 20,
        cacheCreationTokens: 0,
        totalCostUsd: 0.01,
        contextTokens: 200,
        contextLimit: 128000,
        turnCount: 3,
      },
      messageCount: 6,
      pullRequest: {
        number: 42,
        url: 'https://example.com/pr/42',
        state: 'open',
      },
    };
    const compactSession: AppSession = {
      id: SID,
      title: 'Renamed Session',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      busy: true,
      mainTurnActive: true,
      archived: false,
      cwd: '/workspace',
      model: '',
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
    };

    const next = reduceAppEvent(
      initial,
      {
        type: 'sessionWorkChanged',
        sessionId: SID,
        busy: true,
        mainTurnActive: true,
        session: compactSession,
      },
      { sessionId: SID },
    );

    expect(next.sessions[0]).toMatchObject({
      title: 'Renamed Session',
      updatedAt: '2026-01-02T00:00:00.000Z',
      model: 'kimi-k2',
      messageCount: 6,
      usage: {
        inputTokens: 120,
        outputTokens: 80,
        contextTokens: 200,
        contextLimit: 128000,
        turnCount: 3,
      },
      pullRequest: {
        number: 42,
        url: 'https://example.com/pr/42',
        state: 'open',
      },
    });
  });
});

describe('isModelTurnErrorNotice', () => {
  it('recognizes errors owned by the session failure card', () => {
    for (const code of [
      'provider.connection_error',
      'provider.auth_error',
      'provider.rate_limit',
      'provider.overloaded',
      'provider.filtered',
      'provider.api_error',
      'context.overflow',
    ]) {
      expect(isModelTurnErrorNotice({ level: 'error', title: 'boom', code })).toBe(true);
    }
  });

  it('does not claim unrelated notices', () => {
    for (const code of ['internal', 'compaction.cancelled', undefined]) {
      expect(isModelTurnErrorNotice({ level: 'error', title: 'boom', code })).toBe(false);
    }
  });
});
