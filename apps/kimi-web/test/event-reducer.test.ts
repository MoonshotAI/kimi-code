import { describe, expect, it } from 'vitest';
import { createInitialState, reduceAppEvent } from '../src/api/daemon/eventReducer';
import type { AppMessage, AppSession, AppTask } from '../src/api/types';

function makeSession(id: string, updatedAt: string): AppSession {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    status: 'idle',
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
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('reduceAppEvent messageCreated', () => {
  it('bumps the session updatedAt so it floats to the top of the sidebar', () => {
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s-old', '2026-01-01T00:00:00.000Z')],
    };
    const next = reduceAppEvent(
      state,
      { type: 'messageCreated', message: makeMessage('s-old', '2026-06-01T12:00:00.000Z') },
      { sessionId: 's-old', seq: 1 },
    );
    expect(next.sessions[0]?.updatedAt).toBe('2026-06-01T12:00:00.000Z');
  });

  it('does not move a session backwards when an older message arrives', () => {
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s-new', '2026-06-01T12:00:00.000Z')],
    };
    const next = reduceAppEvent(
      state,
      { type: 'messageCreated', message: makeMessage('s-new', '2026-01-01T00:00:00.000Z') },
      { sessionId: 's-new', seq: 1 },
    );
    expect(next.sessions[0]?.updatedAt).toBe('2026-06-01T12:00:00.000Z');
  });

  it('leaves other sessions untouched', () => {
    const state = {
      ...createInitialState(),
      sessions: [
        makeSession('s-a', '2026-01-01T00:00:00.000Z'),
        makeSession('s-b', '2026-01-01T00:00:00.000Z'),
      ],
    };
    const next = reduceAppEvent(
      state,
      { type: 'messageCreated', message: makeMessage('s-a', '2026-06-01T12:00:00.000Z') },
      { sessionId: 's-a', seq: 1 },
    );
    expect(next.sessions.find((s) => s.id === 's-a')?.updatedAt).toBe('2026-06-01T12:00:00.000Z');
    expect(next.sessions.find((s) => s.id === 's-b')?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('reconciles a resolved video echo into the optimistic user message', () => {
    // The optimistic copy still carries the original `video` part (no promptId
    // yet — the echo raced the submit response). The daemon echo carries the
    // server-resolved `<video path=…></video>` text tag. They must collapse into
    // one bubble, not render as a duplicate.
    const optimistic: AppMessage = {
      id: 'msg_opt_1',
      sessionId: 's-vid',
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'video', source: { kind: 'file', fileId: 'f_abc' } },
      ],
      createdAt: '2026-06-01T12:00:00.000Z',
      metadata: { 'kimiWeb.optimisticUserMessage': true },
    };
    const echo: AppMessage = {
      id: 'msg_real',
      sessionId: 's-vid',
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'text', text: '<video path="/Users/me/.kimi-code/cache/f_abc.mp4"></video>' },
      ],
      createdAt: '2026-06-01T12:00:00.000Z',
      promptId: 'p1',
    };
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s-vid', '2026-01-01T00:00:00.000Z')],
      messagesBySession: { 's-vid': [optimistic] },
    };
    const next = reduceAppEvent(
      state,
      { type: 'messageCreated', message: echo },
      { sessionId: 's-vid', seq: 1 },
    );
    const msgs = next.messagesBySession['s-vid'] ?? [];
    expect(msgs).toHaveLength(1);
    // Keeps the optimistic id so the bubble doesn't remount…
    expect(msgs[0]?.id).toBe('msg_opt_1');
    // …but takes the daemon's resolved content (the video text tag).
    expect(msgs[0]?.content).toEqual(echo.content);
    expect(msgs[0]?.promptId).toBe('p1');
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

  it('keeps the roster-seeded description when a re-projected task carries the placeholder', () => {
    // After a page refresh the snapshot roster seeds the real description; a
    // later subagent.* lifecycle event re-projects the task with the
    // projector's skeleton default ('Sub Agent') — it must not clobber it.
    const state = {
      ...createInitialState(),
      tasksBySession: {
        's1': [{ ...makeSubagentTask('t1', 's1'), description: 'explore the auth flow' }],
      },
    };
    const next = reduceAppEvent(
      state,
      {
        type: 'taskCreated',
        sessionId: 's1',
        task: { ...makeSubagentTask('t1', 's1'), description: 'Sub Agent' },
      },
      { sessionId: 's1', seq: 1 },
    );
    expect(next.tasksBySession['s1']?.[0]?.description).toBe('explore the auth flow');
  });

  it('takes the incoming description when it is a real one', () => {
    const state = {
      ...createInitialState(),
      tasksBySession: {
        's1': [{ ...makeSubagentTask('t1', 's1'), description: 'Sub Agent' }],
      },
    };
    const next = reduceAppEvent(
      state,
      {
        type: 'taskCreated',
        sessionId: 's1',
        task: { ...makeSubagentTask('t1', 's1'), description: 'write the tests' },
      },
      { sessionId: 's1', seq: 1 },
    );
    expect(next.tasksBySession['s1']?.[0]?.description).toBe('write the tests');
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

describe('reduceAppEvent messageCreated cron origin', () => {
  it('appends a cron-origin user message instead of reconciling it into an optimistic echo', () => {
    const sid = 's-cron';
    const optimistic: AppMessage = {
      id: 'opt_1',
      sessionId: sid,
      role: 'user',
      content: [{ type: 'text', text: 'check the BTC price' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      promptId: 'pr_user',
      metadata: { 'kimiWeb.optimisticUserMessage': true },
    };
    const state = {
      ...createInitialState(),
      sessions: [makeSession(sid, '2026-01-01T00:00:00.000Z')],
      messagesBySession: { [sid]: [optimistic] },
    };
    const cronMessage: AppMessage = {
      id: 'cron_1',
      sessionId: sid,
      role: 'user',
      content: [{ type: 'text', text: 'check the BTC price' }],
      createdAt: '2026-01-01T00:01:00.000Z',
      promptId: 'cron_pr_x',
      metadata: {
        origin: {
          kind: 'cron_job',
          jobId: 'j',
          cron: '* * * * *',
          recurring: true,
          coalescedCount: 1,
          stale: false,
        },
      },
    };
    const next = reduceAppEvent(
      state,
      { type: 'messageCreated', message: cronMessage },
      { sessionId: sid, seq: 2 },
    );
    const msgs = next.messagesBySession[sid]!;
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.id)).toEqual(['opt_1', 'cron_1']);
  });
});
