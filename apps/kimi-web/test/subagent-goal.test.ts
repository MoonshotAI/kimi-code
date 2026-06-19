import { describe, expect, it } from 'vitest';
import { createAgentProjector } from '../src/api/daemon/agentEventProjector';
import { createInitialState, reduceAppEvent } from '../src/api/daemon/eventReducer';
import { toAppEvent } from '../src/api/daemon/mappers';

describe('subagent and goal projection', () => {
  it('tracks subagent lifecycle metadata across partial events', () => {
    const projector = createAgentProjector();
    const sid = 'ses_1';

    const spawned = projector.project('subagent.spawned', {
      subagentId: 'agent_1',
      subagentName: 'coder',
      parentToolCallId: 'tc_agent',
      description: 'Review API timeout',
      swarmIndex: 2,
    }, sid);
    expect(spawned).toEqual([
      expect.objectContaining({
        type: 'taskCreated',
        task: expect.objectContaining({
          id: 'agent_1',
          description: 'Review API timeout',
          subagentPhase: 'queued',
          subagentType: 'coder',
          parentToolCallId: 'tc_agent',
          swarmIndex: 2,
        }),
      }),
    ]);

    const started = projector.project('subagent.started', { subagentId: 'agent_1' }, sid);
    expect(started[0]).toEqual(expect.objectContaining({
      type: 'taskCreated',
      task: expect.objectContaining({
        id: 'agent_1',
        description: 'Review API timeout',
        subagentPhase: 'working',
        parentToolCallId: 'tc_agent',
      }),
    }));

    const suspended = projector.project('subagent.suspended', { subagentId: 'agent_1', reason: 'rate limit' }, sid);
    expect(suspended[0]).toEqual(expect.objectContaining({
      type: 'taskCreated',
      task: expect.objectContaining({
        subagentPhase: 'suspended',
        suspendedReason: 'rate limit',
      }),
    }));

    const completed = projector.project('subagent.completed', { subagentId: 'agent_1', resultSummary: 'ok' }, sid);
    expect(completed).toEqual([
      expect.objectContaining({
        type: 'taskCreated',
        task: expect.objectContaining({
          subagentPhase: 'completed',
          status: 'completed',
          outputPreview: 'ok',
        }),
      }),
      expect.objectContaining({
        type: 'taskCompleted',
        taskId: 'agent_1',
        status: 'completed',
        outputPreview: 'ok',
      }),
    ]);
  });

  it('does not fold subagent transcript frames into the parent session', () => {
    const projector = createAgentProjector();
    const sid = 'ses_1';

    // Main agent turn starts and streams text into the parent transcript.
    projector.project('turn.started', { turnId: 1, agentId: 'main' }, sid);
    const mainStep = projector.project('turn.step.started', { turnId: 1, agentId: 'main' }, sid);
    expect(mainStep.some((e) => e.type === 'messageCreated')).toBe(true);
    const mainDelta = projector.project('assistant.delta', { delta: 'main answer', agentId: 'main' }, sid, { offset: 0 });
    expect(mainDelta.some((e) => e.type === 'assistantDelta')).toBe(true);

    // A subagent turn streams over the SAME session id with its OWN agentId.
    // None of its transcript frames may produce parent-transcript events — they
    // used to open empty "skeleton" assistant bubbles + fragmented snippets.
    const subTurn = projector.project('turn.started', { turnId: 2, agentId: 'agent_1' }, sid);
    expect(subTurn.some((e) => e.type === 'messageCreated' || e.type === 'messageUpdated')).toBe(false);
    const subStep = projector.project('turn.step.started', { turnId: 2, agentId: 'agent_1' }, sid);
    expect(subStep.some((e) => e.type === 'messageCreated' || e.type === 'messageUpdated')).toBe(false);
    expect(subStep.some((e) => e.type === 'taskProgress')).toBe(true);
    expect(projector.project('thinking.delta', { delta: 'sub thinking', agentId: 'agent_1' }, sid, { offset: 0 })).toEqual([]);
    expect(projector.project('assistant.delta', { delta: 'sub answer', agentId: 'agent_1' }, sid, { offset: 0 })).toEqual([]);
    const subTool = projector.project('tool.use', { toolName: 'bash', toolCallId: 'tc_x', turnId: 2, agentId: 'agent_1' }, sid);
    expect(subTool.some((e) => e.type === 'messageCreated' || e.type === 'messageUpdated')).toBe(false);
    expect(subTool.some((e) => e.type === 'taskProgress')).toBe(true);

    // The main stream keeps appending to its OWN message: the subagent frames
    // did not hijack currentAssistantMsgId or the per-turn text offset.
    const moreMain = projector.project('assistant.delta', { delta: ' continues', agentId: 'main' }, sid, { offset: 'main answer'.length });
    expect(moreMain.some((e) => e.type === 'assistantDelta')).toBe(true);

    // The subagent lifecycle is still surfaced as a task (AgentCard path).
    const spawned = projector.project('subagent.spawned', { subagentId: 'agent_1', subagentName: 'coder', parentToolCallId: 'tc_x', description: 'sub' }, sid);
    expect(spawned.some((e) => e.type === 'taskCreated')).toBe(true);
  });

  it('projects subagent tool frames into task progress instead of the parent transcript', () => {
    const projector = createAgentProjector();
    const sid = 'ses_1';

    projector.project('subagent.spawned', {
      subagentId: 'agent_1',
      subagentName: 'coder',
      parentToolCallId: 'tc_agent',
      description: 'Review code',
    }, sid);

    const events = projector.project('tool.call.started', {
      agentId: 'agent_1',
      turnId: 2,
      toolCallId: 'tc_bash',
      name: 'Bash',
      args: { command: 'pnpm test' },
    }, sid);

    expect(events).toEqual([
      expect.objectContaining({ type: 'taskCreated', task: expect.objectContaining({ id: 'agent_1', subagentPhase: 'working' }) }),
      expect.objectContaining({ type: 'taskProgress', taskId: 'agent_1', outputChunk: expect.stringContaining('Calling Bash') }),
    ]);
    expect(events.some((event) => event.type === 'messageCreated' || event.type === 'messageUpdated')).toBe(false);
  });

  it('stores active goals and clears complete/null goals in the reducer', () => {
    const projector = createAgentProjector();
    const sid = 'ses_1';
    const [active] = projector.project('goal.updated', {
      snapshot: {
        goalId: 'goal_1',
        objective: 'Ship P3',
        completionCriterion: 'All checks pass',
        status: 'active',
        turnsUsed: 3,
        tokensUsed: 1200,
        wallClockMs: 90_000,
        budget: {
          tokenBudget: 10_000,
          remainingTokens: 8_800,
          turnBudget: 10,
          remainingTurns: 7,
          wallClockBudgetMs: null,
          remainingWallClockMs: null,
          overBudget: false,
        },
      },
    }, sid);

    let state = reduceAppEvent(createInitialState(), active!, { sessionId: sid, seq: 1 });
    expect(state.goalBySession[sid]).toEqual(expect.objectContaining({
      goalId: 'goal_1',
      objective: 'Ship P3',
      status: 'active',
      turnsUsed: 3,
    }));

    const [complete] = projector.project('goal.updated', {
      snapshot: {
        goalId: 'goal_1',
        objective: 'Ship P3',
        status: 'complete',
        turnsUsed: 4,
        tokensUsed: 1600,
        wallClockMs: 100_000,
        budget: { tokenBudget: null, remainingTokens: null, turnBudget: null, remainingTurns: null, wallClockBudgetMs: null, remainingWallClockMs: null, overBudget: false },
      },
    }, sid);
    state = reduceAppEvent(state, complete!, { sessionId: sid, seq: 2 });
    expect(state.goalBySession[sid]).toBeUndefined();

    const [cleared] = projector.project('goal.updated', { snapshot: null }, sid);
    state = reduceAppEvent(state, cleared!, { sessionId: sid, seq: 3 });
    expect(state.goalBySession[sid]).toBeUndefined();
  });

  it('maps projected goal events from the daemon wire protocol', () => {
    const event = toAppEvent({
      type: 'event.goal.updated',
      seq: 1,
      session_id: 'ses_1',
      timestamp: '2026-06-13T00:00:00.000Z',
      payload: {
        snapshot: {
          goal_id: 'goal_1',
          objective: 'Ship P3',
          completion_criterion: 'All checks pass',
          status: 'active',
          turns_used: 3,
          tokens_used: 1200,
          wall_clock_ms: 90_000,
          budget: {
            token_budget: 10_000,
            remaining_tokens: 8_800,
            turn_budget: 10,
            remaining_turns: 7,
            over_budget: false,
          },
        },
      },
    } as never);

    expect(event).toEqual(expect.objectContaining({
      type: 'goalUpdated',
      sessionId: 'ses_1',
      goal: expect.objectContaining({
        goalId: 'goal_1',
        objective: 'Ship P3',
        completionCriterion: 'All checks pass',
        status: 'active',
        turnsUsed: 3,
      }),
    }));
  });
});
