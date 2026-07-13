/**
 * Scenario: daemon events update the browser's session-scoped client state.
 * Responsibilities: reconcile messages and bridge plan approvals without cross-session leakage.
 * Wiring: real event reducer; no collaborators are stubbed.
 * Run: pnpm --filter @moonshot-ai/kimi-web test -- event-reducer.test.ts
 */
import { describe, expect, it } from 'vitest';
import { createInitialState, reduceAppEvent } from '../src/api/daemon/eventReducer';
import type {
  AppApprovalRequest,
  AppMessage,
  AppSession,
  AppTask,
  ApprovalResponse,
} from '../src/api/types';
import { messagesToTurns } from '../src/composables/messagesToTurns';

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

function makePlanApproval(
  sessionId: string,
  approvalId: string,
  toolCallId: string,
): AppApprovalRequest {
  return {
    approvalId,
    sessionId,
    turnId: 7,
    toolCallId,
    toolName: 'ExitPlanMode',
    action: 'Review plan',
    display: {
      kind: 'plan_review',
      plan: `## Plan for ${sessionId}`,
      path: `/workspace/${sessionId}.md`,
    },
    expiresAt: '2026-01-01T00:05:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function applyPlanToolUse(
  state: ReturnType<typeof createInitialState>,
  approval: AppApprovalRequest,
  seq: number,
): ReturnType<typeof createInitialState> {
  const withAssistant = reduceAppEvent(
    state,
    {
      type: 'messageCreated',
      message: {
        id: 'assistant-live',
        sessionId: approval.sessionId,
        role: 'assistant',
        content: [],
        createdAt: '2026-01-01T00:01:01.000Z',
        promptId: 'prompt-1',
      },
    },
    { sessionId: approval.sessionId, seq },
  );
  return reduceAppEvent(
    withAssistant,
    {
      type: 'messageUpdated',
      sessionId: approval.sessionId,
      messageId: 'assistant-live',
      content: [
        {
          type: 'toolUse',
          toolCallId: approval.toolCallId,
          toolName: approval.toolName,
          input: {},
          turnId: approval.turnId,
          toolInputDisplay: approval.display,
        },
      ],
      status: 'pending',
    },
    { sessionId: approval.sessionId, seq: seq + 1 },
  );
}

function appendPlanToolResult(
  state: ReturnType<typeof createInitialState>,
  approval: AppApprovalRequest,
  output: string,
  isError: boolean,
  seq: number,
): ReturnType<typeof createInitialState> {
  return reduceAppEvent(
    state,
    {
      type: 'messageCreated',
      message: {
        id: 'tool-live',
        sessionId: approval.sessionId,
        role: 'tool',
        content: [
          {
            type: 'toolResult',
            toolCallId: approval.toolCallId,
            output,
            isError,
          },
        ],
        createdAt: '2026-01-01T00:01:03.000Z',
        promptId: 'prompt-1',
      },
    },
    { sessionId: approval.sessionId, seq },
  );
}

function runResolvedPlanSequence(
  response: ApprovalResponse,
  source: 'live' | 'snapshot',
): {
  planReview: NonNullable<ReturnType<typeof messagesToTurns>[number]['tools']>[number]['planReview'];
  remainingOverlays: Record<string, unknown>;
  pendingPlanCount: number;
} {
  const approval = makePlanApproval('session-a', 'approval-a', 'call-1');
  const requested =
    source === 'live'
      ? reduceAppEvent(
          createInitialState(),
          { type: 'approvalRequested', sessionId: 'session-a', approval },
          { sessionId: 'session-a', seq: 1 },
        )
      : {
          ...createInitialState(),
          messagesBySession: {
            'session-a': [
              {
                id: 'assistant-live',
                sessionId: 'session-a',
                role: 'assistant' as const,
                content: [
                  {
                    type: 'toolUse' as const,
                    toolCallId: 'call-1',
                    toolName: 'ExitPlanMode',
                    input: {},
                    toolInputDisplay: approval.display,
                  },
                ],
                createdAt: '2026-01-01T00:01:01.000Z',
                promptId: 'prompt-1',
              },
            ],
          },
          planReviewOverlayBySession: {
            'session-a': {
              'approval-a': {
                approvalId: 'approval-a',
                toolCallId: 'call-1',
                turnId: 7,
                toolInputDisplay: approval.display,
                renderSynthetic: false,
              },
            },
          },
        };
  const pendingTurns = messagesToTurns(
    requested.messagesBySession['session-a'] ?? [],
    [],
    undefined,
    true,
    requested.planReviewOverlayBySession['session-a'] ?? {},
  );
  const pendingPlanCount = pendingTurns
    .flatMap((turn) => turn.tools ?? [])
    .filter((tool) => tool.planReview?.status === 'pending').length;
  // respondApproval removes the Dock item before the server's resolved event
  // can arrive. The approval-scoped overlay must remain sufficient on its own.
  const withoutPendingApproval = {
    ...requested,
    approvalsBySession: { ...requested.approvalsBySession, 'session-a': [] },
  };
  const resolved = reduceAppEvent(
    withoutPendingApproval,
    {
      type: 'approvalResolved',
      sessionId: 'session-a',
      approvalId: 'approval-a',
      decision: response.decision,
      scope: response.scope,
      feedback: response.feedback,
      selectedLabel: response.selectedLabel,
      resolvedAt: '2026-01-01T00:01:00.000Z',
    },
    { sessionId: 'session-a', seq: 2 },
  );
  const withToolUse = applyPlanToolUse(resolved, approval, 3);
  const withToolResult = appendPlanToolResult(
    withToolUse,
    approval,
    'Plan review completed.',
    response.decision === 'rejected' &&
      response.selectedLabel !== 'Revise' &&
      !response.feedback,
    5,
  );
  const planReview = messagesToTurns(
    withToolResult.messagesBySession['session-a'] ?? [],
    [],
    undefined,
    false,
    withToolResult.planReviewOverlayBySession['session-a'] ?? {},
  )[0]?.tools?.[0]?.planReview;
  return {
    planReview,
    remainingOverlays: withToolResult.planReviewOverlayBySession['session-a'] ?? {},
    pendingPlanCount,
  };
}

describe('reduceAppEvent plan review overlays (live approval bridge)', () => {
  it('stores a requested plan overlay only under the approval session', () => {
    const approval = makePlanApproval('session-a', 'approval-a', 'call-1');

    const next = reduceAppEvent(
      createInitialState(),
      { type: 'approvalRequested', sessionId: 'session-a', approval },
      { sessionId: 'session-a', seq: 1 },
    );

    expect(next.planReviewOverlayBySession['session-a']?.['approval-a']).toMatchObject({
      approvalId: 'approval-a',
      toolCallId: 'call-1',
      turnId: 7,
      toolInputDisplay: {
        kind: 'plan_review',
        plan: '## Plan for session-a',
      },
    });
    expect(next.planReviewOverlayBySession['session-b']).toBeUndefined();
  });

  it('keeps the resolved plan decision in the overlay after removing the pending approval', () => {
    const approval = makePlanApproval('session-a', 'approval-a', 'call-1');
    const requested = reduceAppEvent(
      createInitialState(),
      { type: 'approvalRequested', sessionId: 'session-a', approval },
      { sessionId: 'session-a', seq: 1 },
    );

    const resolved = reduceAppEvent(
      requested,
      {
        type: 'approvalResolved',
        sessionId: 'session-a',
        approvalId: 'approval-a',
        decision: 'rejected',
        selectedLabel: 'Revise',
        feedback: 'Add rollback checks.',
        resolvedAt: '2026-01-01T00:01:00.000Z',
      },
      { sessionId: 'session-a', seq: 2 },
    );

    expect(resolved.approvalsBySession['session-a']).toEqual([]);
    expect(resolved.planReviewOverlayBySession['session-a']?.['approval-a']?.approvalResult).toEqual({
      decision: 'rejected',
      scope: undefined,
      feedback: 'Add rollback checks.',
      selectedLabel: 'Revise',
    });
  });

  it('keeps an expired plan interrupted after its real message, duplicate, and result arrive', () => {
    const approval = makePlanApproval('session-a', 'approval-a', 'call-1');
    const requested = reduceAppEvent(
      createInitialState(),
      { type: 'approvalRequested', sessionId: 'session-a', approval },
      { sessionId: 'session-a', seq: 1 },
    );
    const expired = reduceAppEvent(
      requested,
      { type: 'approvalExpired', sessionId: 'session-a', approvalId: 'approval-a' },
      { sessionId: 'session-a', seq: 2 },
    );
    const withToolUse = applyPlanToolUse(expired, approval, 3);
    const withDurableDuplicate = reduceAppEvent(
      withToolUse,
      {
        type: 'messageCreated',
        message: {
          id: 'assistant-durable',
          sessionId: 'session-a',
          role: 'assistant',
          content: [
            {
              type: 'toolUse',
              toolCallId: 'call-1',
              toolName: 'ExitPlanMode',
              input: {},
              toolInputDisplay: approval.display,
            },
          ],
          createdAt: '2026-01-01T00:01:02.000Z',
          promptId: 'prompt-1',
        },
      },
      { sessionId: 'session-a', seq: 5 },
    );
    const withToolResult = appendPlanToolResult(
      withDurableDuplicate,
      approval,
      'Plan review expired.',
      true,
      6,
    );

    const turns = messagesToTurns(
      withToolResult.messagesBySession['session-a'] ?? [],
      [],
      undefined,
      false,
      withToolResult.planReviewOverlayBySession['session-a'] ?? {},
    );

    expect(turns[0]?.tools?.[0]?.planReview).toMatchObject({
      status: 'interrupted',
      plan: '## Plan for session-a',
    });
    expect(withToolResult.planReviewOverlayBySession['session-a']).toEqual({});
  });

  it('projects a live requested and resolved rejection into the exact later tool event', () => {
    const result = runResolvedPlanSequence(
      {
        decision: 'rejected',
        selectedLabel: 'Reject and Exit',
      },
      'live',
    );

    expect(result.planReview).toMatchObject({
      status: 'rejected',
      plan: '## Plan for session-a',
    });
    expect(result.remainingOverlays).toEqual({});
  });

  it('does not consume a resolved overlay when a reused tool call id comes from another turn', () => {
    const approval = makePlanApproval('session-a', 'approval-a', 'call-1');
    const requested = reduceAppEvent(
      createInitialState(),
      { type: 'approvalRequested', sessionId: 'session-a', approval },
      { sessionId: 'session-a', seq: 1 },
    );
    const resolved = reduceAppEvent(
      {
        ...requested,
        approvalsBySession: { ...requested.approvalsBySession, 'session-a': [] },
      },
      {
        type: 'approvalResolved',
        sessionId: 'session-a',
        approvalId: 'approval-a',
        decision: 'rejected',
        selectedLabel: 'Reject and Exit',
        resolvedAt: '2026-01-01T00:01:00.000Z',
      },
      { sessionId: 'session-a', seq: 2 },
    );
    const withOldMessage = reduceAppEvent(
      resolved,
      {
        type: 'messageCreated',
        message: {
          id: 'old-plan',
          sessionId: 'session-a',
          role: 'assistant',
          content: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          promptId: 'old-prompt',
        },
      },
      { sessionId: 'session-a', seq: 3 },
    );

    const oldTurnUpdated = reduceAppEvent(
      withOldMessage,
      {
        type: 'messageUpdated',
        sessionId: 'session-a',
        messageId: 'old-plan',
        content: [
          {
            type: 'toolUse',
            toolCallId: 'call-1',
            toolName: 'ExitPlanMode',
            input: {},
            turnId: 6,
            toolInputDisplay: approval.display,
          },
        ],
        status: 'completed',
      },
      { sessionId: 'session-a', seq: 4 },
    );

    const oldToolUse = oldTurnUpdated.messagesBySession['session-a']?.[0]?.content[0];
    expect(oldToolUse).toMatchObject({ type: 'toolUse', turnId: 6 });
    if (oldToolUse?.type !== 'toolUse') throw new Error('expected old tool use');
    expect(oldToolUse.approvalResult).toBeUndefined();
    expect(
      oldTurnUpdated.planReviewOverlayBySession['session-a']?.['approval-a']?.approvalResult,
    ).toMatchObject({ decision: 'rejected' });
  });

  it('projects snapshot rejection when the Dock item was already removed', () => {
    const result = runResolvedPlanSequence(
      {
        decision: 'rejected',
        selectedLabel: 'Reject and Exit',
      },
      'snapshot',
    );

    expect(result.pendingPlanCount).toBe(1);
    expect(result.planReview).toMatchObject({
      status: 'rejected',
      plan: '## Plan for session-a',
      selectedLabel: 'Reject and Exit',
    });
    expect(result.remainingOverlays).toEqual({});
  });

  it('projects snapshot revision feedback after approval resolution', () => {
    const result = runResolvedPlanSequence(
      {
        decision: 'rejected',
        selectedLabel: 'Revise',
        feedback: 'Add rollback checks.',
      },
      'snapshot',
    );

    expect(result.pendingPlanCount).toBe(1);
    expect(result.planReview).toMatchObject({
      status: 'revision_requested',
      feedback: 'Add rollback checks.',
    });
    expect(result.remainingOverlays).toEqual({});
  });
});

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
