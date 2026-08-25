import { describe, expect, it, vi } from 'vitest';
import { createInitialState, reduceAppEvent } from '@moonshot-ai/app-core/api';
import type { AppApprovalRequest, AppMessage, AppQuestionRequest, AppSession, AppTask } from '../src/api/types';
import { i18n } from '../src/i18n';

function makeSession(id: string, updatedAt: string): AppSession {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    busy: false,
    archived: false,
    cwd: '/workspace',
    model: 'kimi-code',
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
}

function makeMessage(sessionId: string, createdAt: string): AppMessage {
  return {
    id: `msg_${createdAt}`,
    sessionId,
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    createdAt,
  };
}

function makeSubagentTask(id: string, sessionId: string): AppTask {
  return {
    id,
    sessionId,
    kind: 'subagent',
    description: 'subagent task',
    busy: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeApproval(sessionId: string): AppApprovalRequest {
  return {
    approvalId: 'ap_1',
    sessionId,
    toolCallId: 'tc_1',
    toolName: 'Bash',
    action: 'run',
    display: null,
    expiresAt: '2026-06-01T12:05:00.000Z',
    createdAt: '2026-06-01T12:00:00.000Z',
  };
}

function makeQuestion(sessionId: string): AppQuestionRequest {
  return {
    questionId: 'q_1',
    sessionId,
    questions: [{ id: 'q1', question: 'pick one', options: [{ id: 'a', label: 'A' }] }],
    createdAt: '2026-06-01T12:00:00.000Z',
  };
}

describe('reduceAppEvent turnActiveChanged', () => {
  it('sets and clears the per-session main-turn liveness flag', () => {
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
    };
    const started = reduceAppEvent(
      state,
      { type: 'turnActiveChanged', sessionId: 's1', active: true },
      { sessionId: 's1', seq: 1 },
    );
    expect(started.turnActiveBySession['s1']).toBe(true);
    expect(started.sessions[0]?.mainTurnActive).toBe(true);
    const ended = reduceAppEvent(
      started,
      { type: 'turnActiveChanged', sessionId: 's1', active: false, reason: 'completed' },
      { sessionId: 's1', seq: 2 },
    );
    expect(ended.turnActiveBySession['s1']).toBeUndefined();
    expect(ended.sessions[0]?.mainTurnActive).toBe(false);
  });

  it('drops the flag with the rest of a deleted session', () => {
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
      turnActiveBySession: { s1: true },
    };
    const next = reduceAppEvent(state, { type: 'sessionDeleted', sessionId: 's1' }, { sessionId: 's1', seq: 1 });
    expect(next.turnActiveBySession['s1']).toBeUndefined();
  });

  it('bumps the session updatedAt when the main turn ends', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const state = {
        ...createInitialState(),
        sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
        turnActiveBySession: { s1: true },
      };
      const next = reduceAppEvent(
        state,
        { type: 'turnActiveChanged', sessionId: 's1', active: false, reason: 'completed' },
        { sessionId: 's1', seq: 1 },
      );
      expect(next.sessions[0]?.updatedAt).toBe('2026-06-01T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bumps the session updatedAt when a turn starts (turn start is real activity)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-01T11:00:00.000Z'));
      const state = {
        ...createInitialState(),
        sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
      };
      const next = reduceAppEvent(
        state,
        { type: 'turnActiveChanged', sessionId: 's1', active: true },
        { sessionId: 's1', seq: 1 },
      );
      expect(next.sessions[0]?.updatedAt).toBe('2026-06-01T11:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never moves updatedAt backwards on turn end', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const state = {
        ...createInitialState(),
        sessions: [makeSession('s1', '2026-06-01T12:00:00.000Z')],
      };
      const next = reduceAppEvent(
        state,
        { type: 'turnActiveChanged', sessionId: 's1', active: false, reason: 'completed' },
        { sessionId: 's1', seq: 1 },
      );
      expect(next.sessions[0]?.updatedAt).toBe('2026-06-01T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves other sessions untouched on turn end', () => {
    const state = {
      ...createInitialState(),
      sessions: [
        makeSession('s-a', '2026-01-01T00:00:00.000Z'),
        makeSession('s-b', '2026-01-01T00:00:00.000Z'),
      ],
    };
    const next = reduceAppEvent(
      state,
      { type: 'turnActiveChanged', sessionId: 's-a', active: false, reason: 'completed' },
      { sessionId: 's-a', seq: 1 },
    );
    expect(next.sessions.find((s) => s.id === 's-b')?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('reduceAppEvent stale-replay recency gate', () => {
  it('does not bump updatedAt for a stale/replayed turn end', () => {
    // A snapshot resync advanced the cursor to seq 10; a late duplicate
    // turn.ended (seq 5) must not float the session again.
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
      lastSeqBySession: { s1: 10 },
    };
    const next = reduceAppEvent(
      state,
      { type: 'turnActiveChanged', sessionId: 's1', active: false, reason: 'completed' },
      { sessionId: 's1', seq: 5 },
    );
    expect(next.sessions[0]?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('does not bump updatedAt for a stale/replayed prompt abort', () => {
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
      lastSeqBySession: { s1: 10 },
    };
    const next = reduceAppEvent(
      state,
      { type: 'promptAborted', sessionId: 's1', promptId: 'pr_1' },
      { sessionId: 's1', seq: 5 },
    );
    expect(next.sessions[0]?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('does not bump updatedAt for a stale/replayed approval request (already resolved)', () => {
    // The approval resolved before the snapshot, so the pending list no
    // longer dedupes the replay — freshness must catch it instead.
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
      lastSeqBySession: { s1: 10 },
    };
    const next = reduceAppEvent(
      state,
      { type: 'approvalRequested', sessionId: 's1', approval: makeApproval('s1') },
      { sessionId: 's1', seq: 5 },
    );
    expect(next.sessions[0]?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('does not bump updatedAt for a stale/replayed question request', () => {
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
      lastSeqBySession: { s1: 10 },
    };
    const next = reduceAppEvent(
      state,
      { type: 'questionRequested', sessionId: 's1', question: makeQuestion('s1') },
      { sessionId: 's1', seq: 5 },
    );
    expect(next.sessions[0]?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('reduceAppEvent prompt terminal recency', () => {
  it('bumps updatedAt when a queued prompt is aborted before any turn', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const state = {
        ...createInitialState(),
        sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
      };
      const next = reduceAppEvent(
        state,
        { type: 'promptAborted', sessionId: 's1', promptId: 'pr_1' },
        { sessionId: 's1', seq: 1 },
      );
      expect(next.sessions[0]?.updatedAt).toBe('2026-06-01T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bumps updatedAt when a prompt is blocked before any turn starts', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const state = {
        ...createInitialState(),
        sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
      };
      const next = reduceAppEvent(
        state,
        { type: 'promptCompleted', sessionId: 's1', promptId: 'pr_1', reason: 'blocked' },
        { sessionId: 's1', seq: 1 },
      );
      expect(next.sessions[0]?.updatedAt).toBe('2026-06-01T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not bump updatedAt for a normal-turn prompt completion', () => {
    // The turn's own turn.ended already bumped; promptCompleted(reason
    // 'completed') must not be a second recency moment.
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
    };
    const next = reduceAppEvent(
      state,
      { type: 'promptCompleted', sessionId: 's1', promptId: 'pr_1', reason: 'completed' },
      { sessionId: 's1', seq: 1 },
    );
    expect(next.sessions[0]?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('does not bump again for an active-turn abort (turn.ended already did)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const state = {
        ...createInitialState(),
        sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
        turnActiveBySession: { s1: true },
      };
      const ended = reduceAppEvent(
        state,
        { type: 'turnActiveChanged', sessionId: 's1', active: false, reason: 'cancelled', promptId: 'pr_1' },
        { sessionId: 's1', seq: 1 },
      );
      vi.setSystemTime(new Date('2026-06-01T12:00:01.000Z'));
      const aborted = reduceAppEvent(
        ended,
        { type: 'promptAborted', sessionId: 's1', promptId: 'pr_1' },
        { sessionId: 's1', seq: 2 },
      );
      expect(aborted.sessions[0]?.updatedAt).toBe('2026-06-01T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still bumps for an abort of a different (queued) prompt', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const state = {
        ...createInitialState(),
        sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
        turnEndedPromptIdBySession: { s1: 'pr_1' },
      };
      const next = reduceAppEvent(
        state,
        { type: 'promptAborted', sessionId: 's1', promptId: 'pr_2' },
        { sessionId: 's1', seq: 1 },
      );
      expect(next.sessions[0]?.updatedAt).toBe('2026-06-01T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reduceAppEvent sessionWorkChanged fallback recency', () => {
  it('bumps updatedAt when a lost turn.ended retires via work_changed', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const state = {
        ...createInitialState(),
        sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
        turnActiveBySession: { s1: true },
      };
      const next = reduceAppEvent(
        state,
        { type: 'sessionWorkChanged', sessionId: 's1', busy: false, mainTurnActive: false },
        { sessionId: 's1', seq: 1 },
      );
      expect(next.sessions[0]?.updatedAt).toBe('2026-06-01T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not bump updatedAt for an idle work_changed without an active turn', () => {
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
    };
    const next = reduceAppEvent(
      state,
      { type: 'sessionWorkChanged', sessionId: 's1', busy: false },
      { sessionId: 's1', seq: 1 },
    );
    expect(next.sessions[0]?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('does not double-bump when turn.ended already retired the turn', () => {
    // turnActiveChanged cleared the flag; the trailing work_changed finds it
    // unset and must skip its fallback bump.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const state = {
        ...createInitialState(),
        sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
        turnActiveBySession: { s1: true },
      };
      const ended = reduceAppEvent(
        state,
        { type: 'turnActiveChanged', sessionId: 's1', active: false, reason: 'completed', promptId: 'pr_1' },
        { sessionId: 's1', seq: 1 },
      );
      vi.setSystemTime(new Date('2026-06-01T12:00:01.000Z'));
      const after = reduceAppEvent(
        ended,
        { type: 'sessionWorkChanged', sessionId: 's1', busy: false, mainTurnActive: false },
        { sessionId: 's1', seq: 2 },
      );
      expect(after.sessions[0]?.updatedAt).toBe('2026-06-01T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reduceAppEvent pending-interaction recency', () => {
  it('bumps the session updatedAt when a new approval is requested', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const state = {
        ...createInitialState(),
        sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
      };
      const next = reduceAppEvent(
        state,
        { type: 'approvalRequested', sessionId: 's1', approval: makeApproval('s1') },
        { sessionId: 's1', seq: 1 },
      );
      expect(next.sessions[0]?.updatedAt).toBe('2026-06-01T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-bump updatedAt for a duplicate approval request', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const state = {
        ...createInitialState(),
        sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
      };
      const first = reduceAppEvent(
        state,
        { type: 'approvalRequested', sessionId: 's1', approval: makeApproval('s1') },
        { sessionId: 's1', seq: 1 },
      );
      vi.setSystemTime(new Date('2026-06-01T12:01:00.000Z'));
      const second = reduceAppEvent(
        first,
        { type: 'approvalRequested', sessionId: 's1', approval: makeApproval('s1') },
        { sessionId: 's1', seq: 2 },
      );
      expect(second.sessions[0]?.updatedAt).toBe('2026-06-01T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bumps the session updatedAt when a new question is requested', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const state = {
        ...createInitialState(),
        sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
      };
      const next = reduceAppEvent(
        state,
        { type: 'questionRequested', sessionId: 's1', question: makeQuestion('s1') },
        { sessionId: 's1', seq: 1 },
      );
      expect(next.sessions[0]?.updatedAt).toBe('2026-06-01T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reduceAppEvent sessionWorkChanged', () => {
  it('updates list-level main-turn liveness for an unopened session', () => {
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
    };

    const next = reduceAppEvent(
      state,
      {
        type: 'sessionWorkChanged',
        sessionId: 's1',
        busy: true,
        mainTurnActive: true,
      },
      { sessionId: 's1', seq: 1 },
    );

    expect(next.sessions[0]).toMatchObject({
      busy: true,
      mainTurnActive: true,
    });
    expect(next.turnActiveBySession['s1']).toBe(true);
  });

  it('updates the listed action-required fallback for an unopened session', () => {
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
    };

    const next = reduceAppEvent(
      state,
      {
        type: 'sessionWorkChanged',
        sessionId: 's1',
        busy: true,
        pendingInteraction: 'question',
      },
      { sessionId: 's1', seq: 1 },
    );

    expect(next.sessions[0]?.pendingInteraction).toBe('question');
  });

  it('clears streamed main-turn liveness while aggregate work remains busy', () => {
    const state = {
      ...createInitialState(),
      sessions: [
        {
          ...makeSession('s1', '2026-01-01T00:00:00.000Z'),
          busy: true,
          mainTurnActive: true,
        },
      ],
      turnActiveBySession: { s1: true },
    };

    const next = reduceAppEvent(
      state,
      {
        type: 'sessionWorkChanged',
        sessionId: 's1',
        busy: true,
        mainTurnActive: false,
        pendingInteraction: 'none',
      },
      { sessionId: 's1', seq: 1 },
    );

    expect(next.sessions[0]).toMatchObject({ busy: true, mainTurnActive: false });
    expect(next.turnActiveBySession['s1']).toBeUndefined();
  });

  it('clears stale main-turn liveness when an idle update omits the optional field', () => {
    const state = {
      ...createInitialState(),
      sessions: [
        {
          ...makeSession('s1', '2026-01-01T00:00:00.000Z'),
          busy: true,
          mainTurnActive: true,
        },
      ],
      turnActiveBySession: { s1: true },
    };

    const next = reduceAppEvent(
      state,
      {
        type: 'sessionWorkChanged',
        sessionId: 's1',
        busy: false,
      },
      { sessionId: 's1', seq: 1 },
    );

    expect(next.sessions[0]).toMatchObject({ busy: false, mainTurnActive: false });
    expect(next.turnActiveBySession['s1']).toBeUndefined();
  });

  it('clears a stale turn outcome when the update omits lastTurnReason', () => {
    // An omitted last_turn_reason is authoritative ("no current outcome" —
    // e.g. a fresh turn cleared the previous one), not "keep the old value".
    const state = {
      ...createInitialState(),
      sessions: [
        {
          ...makeSession('s1', '2026-01-01T00:00:00.000Z'),
          busy: false,
          lastTurnReason: 'cancelled' as const,
        },
      ],
    };

    const cleared = reduceAppEvent(
      state,
      { type: 'sessionWorkChanged', sessionId: 's1', busy: true },
      { sessionId: 's1', seq: 1 },
    );
    expect(cleared.sessions[0]?.lastTurnReason).toBeUndefined();

    const set = reduceAppEvent(
      state,
      { type: 'sessionWorkChanged', sessionId: 's1', busy: false, lastTurnReason: 'failed' },
      { sessionId: 's1', seq: 2 },
    );
    expect(set.sessions[0]?.lastTurnReason).toBe('failed');
  });
});

describe('reduceAppEvent messageCreated', () => {
  it('does not bump the session updatedAt (recency is turn-grained)', () => {
    // Messages are created per step and per tool call; bumping recency on each
    // one re-sorted the sidebar mid-turn. The bump moved to turn end
    // (see reduceAppEvent turnActiveChanged).
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s-old', '2026-01-01T00:00:00.000Z')],
    };
    const next = reduceAppEvent(
      state,
      { type: 'messageCreated', message: makeMessage('s-old', '2026-06-01T12:00:00.000Z') },
      { sessionId: 's-old', seq: 1 },
    );
    expect(next.sessions[0]?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

});

describe('reduceAppEvent taskProgress', () => {
  it('accumulates the full progress output without truncating to a fixed window', () => {
    const state = {
      ...createInitialState(),
      tasksBySession: { 's1': [makeSubagentTask('t1', 's1')] },
    };
    let next = state;
    for (let i = 0; i < 60; i++) {
      // The real projector emits a taskCreated (without reducer-owned
      // outputLines) right before every taskProgress; progress must survive
      // that replacement.
      next = reduceAppEvent(
        next,
        { type: 'taskCreated', sessionId: 's1', task: makeSubagentTask('t1', 's1') },
        { sessionId: 's1', seq: i * 2 + 1 },
      );
      next = reduceAppEvent(
        next,
        { type: 'taskProgress', sessionId: 's1', taskId: 't1', outputChunk: `line ${i}`, stream: 'stdout' },
        { sessionId: 's1', seq: i * 2 + 2 },
      );
    }
    const lines = next.tasksBySession['s1']?.[0]?.outputLines;
    expect(lines).toHaveLength(60);
    expect(lines?.[0]).toBe('line 0');
    expect(lines?.at(-1)).toBe('line 59');
  });

  it('deduplicates a repeated trailing chunk', () => {
    const state = {
      ...createInitialState(),
      tasksBySession: { 's1': [makeSubagentTask('t1', 's1')] },
    };
    const event = { type: 'taskProgress', sessionId: 's1', taskId: 't1', outputChunk: 'same', stream: 'stdout' } as const;
    const once = reduceAppEvent(state, event, { sessionId: 's1', seq: 1 });
    const twice = reduceAppEvent(once, event, { sessionId: 's1', seq: 2 });
    expect(twice.tasksBySession['s1']?.[0]?.outputLines).toEqual(['same']);
  });

  it('caps accumulated output for non-subagent (background) tasks', () => {
    const bash: AppTask = { ...makeSubagentTask('b1', 's1'), kind: 'bash' };
    const state = { ...createInitialState(), tasksBySession: { 's1': [bash] } };
    let next = state;
    for (let i = 0; i < 60; i++) {
      next = reduceAppEvent(
        next,
        { type: 'taskProgress', sessionId: 's1', taskId: 'b1', outputChunk: `line ${i}`, stream: 'stdout' },
        { sessionId: 's1', seq: i + 1 },
      );
    }
    const lines = next.tasksBySession['s1']?.[0]?.outputLines;
    expect(lines).toHaveLength(40);
    expect(lines?.[0]).toBe('line 20');
    expect(lines?.at(-1)).toBe('line 59');
  });

  it('concatenates subagent text-kind chunks into a growing text block', () => {
    const state = {
      ...createInitialState(),
      tasksBySession: { 's1': [makeSubagentTask('t1', 's1')] },
    };
    let next = state;
    for (const chunk of ['Hello', ', ', 'world', '!']) {
      next = reduceAppEvent(
        next,
        {
          type: 'taskProgress',
          sessionId: 's1',
          taskId: 't1',
          outputChunk: chunk,
          stream: 'stdout',
          kind: 'text',
        },
        { sessionId: 's1', seq: 1 },
      );
    }
    const task = next.tasksBySession['s1']?.[0];
    expect(task?.text).toBe('Hello, world!');
    // Text chunks must not pollute the line-based progress output.
    expect(task?.outputLines ?? []).toHaveLength(0);
  });

  it('preserves accumulated text across a taskCreated replacement', () => {
    const state = {
      ...createInitialState(),
      tasksBySession: { 's1': [{ ...makeSubagentTask('t1', 's1'), text: 'partial' }] },
    };
    const next = reduceAppEvent(
      state,
      { type: 'taskCreated', sessionId: 's1', task: makeSubagentTask('t1', 's1') },
      { sessionId: 's1', seq: 1 },
    );
    expect(next.tasksBySession['s1']?.[0]?.text).toBe('partial');
  });

  it('preserves subagent identity metadata across a taskCreated replacement with omitted fields', () => {
    const state = {
      ...createInitialState(),
      tasksBySession: {
        's1': [
          {
            ...makeSubagentTask('t1', 's1'),
            parentToolCallId: 'call-1',
            swarmIndex: 2,
            subagentType: 'explore',
            runInBackground: true,
            outputLines: ['old line'],
            text: 'partial',
          },
        ],
      },
    };
    const next = reduceAppEvent(
      state,
      { type: 'taskCreated', sessionId: 's1', task: makeSubagentTask('t1', 's1') },
      { sessionId: 's1', seq: 1 },
    );
    expect(next.tasksBySession['s1']?.[0]).toMatchObject({
      parentToolCallId: 'call-1',
      swarmIndex: 2,
      subagentType: 'explore',
      runInBackground: true,
      outputLines: ['old line'],
      text: 'partial',
    });
  });
});

describe('reduceAppEvent sessions reference stability', () => {
  // The sidebar computeds (sessionsForView / workspaceGroups / mergedWorkspaces)
  // depend on `rawState.sessions`. Events that do not change sessions must keep
  // the SAME array reference so those computeds are not dirtied; events that do
  // change sessions must produce a NEW array.

  it('reuses the sessions reference for an event that does not touch sessions', () => {
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
      messagesBySession: { s1: [makeMessage('s1', '2026-01-01T00:00:00.000Z')] },
    };
    const next = reduceAppEvent(
      state,
      {
        type: 'messageUpdated',
        sessionId: 's1',
        messageId: 'msg_2026-01-01T00:00:00.000Z',
        content: [{ type: 'text', text: 'updated' }],
        status: 'completed',
      },
      { sessionId: 's1', seq: 2 },
    );
    expect(next.sessions).toBe(state.sessions);
  });

  it('produces a new sessions array for an event that changes sessions', () => {
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
    };
    const next = reduceAppEvent(
      state,
      { type: 'sessionCreated', session: makeSession('s2', '2026-02-01T00:00:00.000Z') },
      { sessionId: 's2', seq: 3 },
    );
    expect(next.sessions).not.toBe(state.sessions);
    expect(next.sessions.map((s) => s.id)).toEqual(['s2', 's1']);
  });
});

describe('reduceAppEvent unknown agent error', () => {
  function reduceRaw(raw: unknown): ReturnType<typeof reduceAppEvent> {
    return reduceAppEvent(
      createInitialState(),
      { type: 'unknown', raw },
      { sessionId: 's1', seq: 1 },
      { t: (k, p) => (p === undefined ? i18n.global.t(k) : i18n.global.t(k, p)) },
    );
  }

  it('surfaces a rate-limit failure as a structured notice with full diagnostics', () => {
    const next = reduceRaw({
      _agentError: true,
      code: 'provider.rate_limit',
      message: 'Rate limit reached for requests. Please try again later.',
      name: 'RateLimitError',
      details: { statusCode: 429, requestId: 'req_1' },
      retryable: true,
    });
    const notice = next.warnings[0];
    expect(typeof notice).toBe('object');
    if (typeof notice !== 'object' || notice === null) return;
    expect(notice.severity).toBe('error');
    expect(notice.title).toBe(i18n.global.t('warnings.agentError.rateLimit'));
    expect(notice.message).toBe('Rate limit reached for requests. Please try again later.');
    const byLabel = new Map(notice.details?.map((d) => [d.label, d.value]));
    expect(byLabel.get(i18n.global.t('warnings.details.code'))).toBe('provider.rate_limit');
    expect(byLabel.get(i18n.global.t('warnings.details.status'))).toBe('429');
    expect(byLabel.get(i18n.global.t('warnings.details.requestId'))).toBe('req_1');
    expect(byLabel.get(i18n.global.t('warnings.details.errorName'))).toBe('RateLimitError');
  });

  it('keeps extra detail fields such as finishReason visible', () => {
    const next = reduceRaw({
      _agentError: true,
      code: 'provider.filtered',
      message: 'Provider filtered the response',
      details: { finishReason: 'filtered', rawFinishReason: 'content_filter' },
    });
    const notice = next.warnings[0];
    if (typeof notice !== 'object' || notice === null) throw new Error('expected notice');
    const values = notice.details?.map((d) => d.value) ?? [];
    expect(values).toContain('filtered');
    expect(values).toContain('content_filter');
  });

  it('shows a connection failure without status/requestId rows', () => {
    const next = reduceRaw({
      _agentError: true,
      code: 'provider.connection_error',
      message: 'Connection error.',
    });
    const notice = next.warnings[0];
    if (typeof notice !== 'object' || notice === null) throw new Error('expected notice');
    expect(notice.title).toBe(i18n.global.t('warnings.agentError.connection'));
    expect(notice.message).toBe('Connection error.');
    expect(notice.details?.map((d) => d.value)).toEqual(['provider.connection_error']);
  });

  it('falls back to the generic title for unmapped or missing codes', () => {
    for (const code of ['internal', undefined]) {
      const next = reduceRaw({ _agentError: true, code, message: 'boom' });
      const notice = next.warnings[0];
      if (typeof notice !== 'object' || notice === null) throw new Error('expected notice');
      expect(notice.title).toBe(i18n.global.t('warnings.agentError.title'));
      expect(notice.message).toBe('boom');
    }
  });

  it('still renders agent warnings as plain strings', () => {
    const next = reduceRaw({ _agentWarning: true, message: 'heads up' });
    expect(next.warnings[0]).toBe(`${i18n.global.t('warnings.noteLabel')}: heads up`);
  });
});


