import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TurnEndedEvent } from '@moonshot-ai/protocol';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import { IAgentGoalService } from '#/agent/goal/goal';
import { type AgentGoalService } from '#/agent/goal/goalService';
import { IAgentLoopService, type AfterStepContext } from '#/agent/loop/loop';
import { IAgentTurnService, type Turn } from '#/agent/turn/turn';
import type { PersistedWireRecord, WireRecord } from '#/agent/wireRecord/wireRecord';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import type { TokenUsage } from '#/app/llmProtocol/usage';
import { ErrorCodes, toKimiErrorPayload } from '#/errors';

import {
  InMemoryWireRecordPersistence,
  agentService,
  createTestAgent,
  telemetryServices,
  wireRecordPersistenceServices,
  type TestAgentContext,
} from '../harness';
import { recordingTelemetry, type TelemetryRecord } from '../telemetry/stubs';
import { stubLoopWithHooks, stubTurn, type StubTurn } from '../turn/stubs';

type GoalServiceTestManager = IAgentGoalService & AgentGoalService;
type GoalRecord = Extract<PersistedWireRecord, { type: `goal.${string}` }>;
type AgentEvent = DomainEvent;
type GoalUpdatedEvent = Extract<AgentEvent, { type: 'goal.updated' }>;
type TurnEndedInput = {
  readonly reason: TurnEndedEvent['reason'];
  readonly error?: unknown;
};

const zeroUsage: TokenUsage = {
  inputCacheRead: 0,
  inputCacheCreation: 0,
  inputOther: 0,
  output: 0,
};

function goalRecords(records: readonly PersistedWireRecord[]): readonly GoalRecord[] {
  return records.filter((record): record is GoalRecord => record.type.startsWith('goal.'));
}

async function restoreGoalRecords(
  ctx: TestAgentContext,
  goals: IAgentGoalService,
  records: readonly WireRecord[],
): Promise<void> {
  goals.getGoal();
  await ctx.restore(records as readonly PersistedWireRecord[]);
}

function makeTurn(id: number): Turn {
  return {
    id,
    signal: new AbortController().signal,
    ready: Promise.resolve(),
    result: Promise.resolve({ type: 'completed', steps: 0, truncated: false }),
  };
}

async function runGoalStep(loopService: IAgentLoopService, turn: Turn): Promise<boolean> {
  const step = {
    turnId: turn.id,
    step: 1,
    signal: turn.signal,
  };
  const afterStep: AfterStepContext = {
    turnId: turn.id,
    step: 1,
    signal: turn.signal,
    usage: zeroUsage,
    finishReason: 'completed' as const,
    continue: false,
  };
  await loopService.hooks.beforeStep.run(step);
  await loopService.hooks.afterStep.run(afterStep);
  return afterStep.continue;
}

async function runStepUsageHooks(
  loopService: IAgentLoopService,
  goals: IAgentGoalService,
  turn: Turn,
  usage: TokenUsage,
): Promise<boolean> {
  const afterStep: AfterStepContext = {
    turnId: turn.id,
    step: 1,
    signal: turn.signal,
    usage,
    finishReason: 'completed' as const,
    continue: false,
  };
  await loopService.hooks.afterStep.run(afterStep);
  return goals.getGoal().goal?.budget.overBudget === true;
}

function endTurn(
  eventBus: IEventBus,
  turn: Turn,
  result: TurnEndedInput = { reason: 'completed' },
): void {
  const error = result.error !== undefined ? toKimiErrorPayload(result.error) : undefined;
  eventBus.publish({
    type: 'turn.ended',
    turnId: turn.id,
    reason: result.reason,
    error,
    durationMs: 0,
  });
}

describe('AgentGoalService', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let goals: GoalServiceTestManager;
  let records: PersistedWireRecord[];
  let events: GoalUpdatedEvent[];
  let telemetry: TelemetryRecord[];

  beforeEach(() => {
    const persistence = new InMemoryWireRecordPersistence();
    telemetry = [];
    events = [];
    ctx = createTestAgent(
      wireRecordPersistenceServices(persistence),
      telemetryServices(recordingTelemetry(telemetry)),
    );
    context = ctx.get(IAgentContextMemoryService);
    goals = ctx.get(IAgentGoalService) as GoalServiceTestManager;
    records = persistence.records;
    const eventBus = ctx.get(IEventBus);
    eventBus.subscribe((event) => {
      if (event.type === 'goal.updated') events.push(event);
    });
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  describe('AgentGoalService creation', () => {
    it('creates a goal and exposes it through getGoal', async () => {
      const snapshot = await goals.createGoal({ objective: 'Ship feature X' });

      expect(snapshot.objective).toBe('Ship feature X');
      expect(snapshot.status).toBe('active');
      expect(goals.getGoal().goal?.goalId).toBe(snapshot.goalId);
    });

    it('stores a completion criterion when provided', async () => {
      const snapshot = await goals.createGoal({
        objective: 'Ship feature X',
        completionCriterion: ' tests pass ',
      });

      expect(snapshot.completionCriterion).toBe('tests pass');
      expect(goals.getGoal().goal?.completionCriterion).toBe('tests pass');
    });

    it('truncates an over-long completion criterion instead of failing', async () => {
      const snapshot = await goals.createGoal({
        objective: 'Ship feature X',
        completionCriterion: 'c'.repeat(4001),
      });

      expect(snapshot.completionCriterion).toBe('c'.repeat(4000));
    });

    it('sets no default work caps when none is provided', async () => {
      const snapshot = await goals.createGoal({ objective: 'Do work' });

      expect(snapshot.budget.turnBudget).toBeNull();
      expect(snapshot.budget.tokenBudget).toBeNull();
      expect(snapshot.budget.wallClockBudgetMs).toBeNull();
      expect(snapshot.budget.overBudget).toBe(false);
    });

    it('rejects empty and too-long objectives', async () => {
      await expect(goals.createGoal({ objective: '   ' })).rejects.toMatchObject({
        code: ErrorCodes.GOAL_OBJECTIVE_EMPTY,
      });
      await expect(goals.createGoal({ objective: 'x'.repeat(4001) })).rejects.toMatchObject({
        code: ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
      });
    });

    it('rejects duplicate active, paused, and blocked goals without replace', async () => {
      await goals.createGoal({ objective: 'first' });
      await expect(goals.createGoal({ objective: 'second' })).rejects.toMatchObject({
        code: ErrorCodes.GOAL_ALREADY_EXISTS,
      });
      await goals.pauseGoal();
      await expect(goals.createGoal({ objective: 'second' })).rejects.toMatchObject({
        code: ErrorCodes.GOAL_ALREADY_EXISTS,
      });
      await goals.resumeGoal();
      await goals.markBlocked({ reason: 'stuck' });
      await expect(goals.createGoal({ objective: 'second' })).rejects.toMatchObject({
        code: ErrorCodes.GOAL_ALREADY_EXISTS,
      });
    });

    it('replaces an existing goal when replace is set', async () => {
      const first = await goals.createGoal({ objective: 'first' });
      const second = await goals.createGoal({ objective: 'second', replace: true });
      await ctx.wireRecord.flush();

      expect(second.goalId).not.toBe(first.goalId);
      expect(goals.getGoal().goal?.objective).toBe('second');
      expect(goalRecords(records).map((record) => record.type)).toEqual([
        'goal.create',
        'goal.clear',
        'goal.create',
      ]);
    });

    it('cancels with dispatcher-style empty input', async () => {
      await goals.createGoal({ objective: 'work' });
      const removed = await goals.cancelGoal({});
      expect(removed.status).toBe('active');
      expect(goals.getGoal().goal).toBeNull();
    });
  });

  describe('AgentGoalService lifecycle', () => {
    it('emits typed lifecycle and completion changes', async () => {
      await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });
      expect(events.at(-1)?.change).toBeUndefined();

      await goals.pauseGoal();
      expect(events.at(-1)?.change).toMatchObject({ kind: 'lifecycle', status: 'paused' });

      await goals.resumeGoal();
      expect(events.at(-1)?.change).toMatchObject({ kind: 'lifecycle', status: 'active' });

      await goals.markComplete({ reason: 'done' }, 'model');
      const completion = events.find((event) => event.change?.kind === 'completion')?.change;
      expect(completion).toMatchObject({ kind: 'completion', status: 'complete', reason: 'done' });
      expect(goals.getGoal().goal).toBeNull();
      expect(events.at(-1)?.snapshot).toBeNull();
    });

    it('keeps blocked goals resumable', async () => {
      await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });
      const blocked = await goals.markBlocked({ reason: 'need creds' });
      expect(blocked?.status).toBe('blocked');
      expect(blocked?.terminalReason).toBe('need creds');

      const resumed = await goals.resumeGoal();
      expect(resumed.status).toBe('active');
      expect(resumed.terminalReason).toBeUndefined();
    });

    it('pauseOnInterrupt parks active goals and no-ops for stopped goals', async () => {
      await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });
      const paused = await goals.pauseOnInterrupt({ reason: 'Paused after interruption' });
      expect(paused?.status).toBe('paused');
      expect(paused?.terminalReason).toBe('Paused after interruption');

      expect(await goals.pauseOnInterrupt({ reason: 'again' })).toBeNull();
      expect(goals.getGoal().goal?.status).toBe('paused');
    });

    it('cancelGoal discards the goal and throws when missing', async () => {
      await goals.createGoal({ objective: 'work' });
      const removed = await goals.cancelGoal();
      expect(removed.status).toBe('active');
      expect(goals.getGoal()).toEqual({ goal: null });
      const reminder = context.get().at(-1);
      expect(reminder?.origin).toEqual({ kind: 'system_trigger', name: 'goal_cancelled' });
      expect(JSON.stringify(reminder?.content)).toContain('Ignore earlier active-goal reminders');
      await expect(goals.cancelGoal()).rejects.toMatchObject({ code: ErrorCodes.GOAL_NOT_FOUND });
    });
  });

  describe('AgentGoalService accounting and budgets', () => {
    it('counts tokens and turns only while active', async () => {
      await goals.createGoal({ objective: 'work' });
      await goals.recordTokenUsage(30);
      await goals.incrementTurn();
      expect(goals.getGoal().goal).toMatchObject({ tokensUsed: 30, turnsUsed: 1 });

      await goals.pauseGoal();
      await goals.recordTokenUsage(12);
      await goals.incrementTurn();
      expect(goals.getGoal().goal).toMatchObject({ tokensUsed: 30, turnsUsed: 1 });
    });

    it('sets budget limits through SetGoalBudget-style updates', async () => {
      await goals.createGoal({ objective: 'work' });
      const snapshot = await goals.setBudgetLimits(
        {
          budgetLimits: { tokenBudget: 100, turnBudget: 2, wallClockBudgetMs: 1000 },
        },
        'model',
      );

      expect(snapshot.budget.tokenBudget).toBe(100);
      expect(snapshot.budget.turnBudget).toBe(2);
      expect(snapshot.budget.wallClockBudgetMs).toBe(1000);
    });

    it('blocks when a token budget is reached', async () => {
      await goals.createGoal({ objective: 'work' });
      await goals.setBudgetLimits({ budgetLimits: { tokenBudget: 10 } }, 'model');

      const snapshot = await goals.recordTokenUsage(10);

      expect(snapshot).toMatchObject({
        status: 'blocked',
        tokensUsed: 10,
        terminalReason: 'Blocked after goal budget reached: token budget 10',
      });
      expect(goals.getGoal().goal).toMatchObject({
        status: 'blocked',
        budget: {
          tokenBudgetReached: true,
          overBudget: true,
        },
      });
    });

    it('blocks when a newly set budget is already exhausted', async () => {
      await goals.createGoal({ objective: 'work' });
      await goals.incrementTurn();

      const snapshot = await goals.setBudgetLimits({ budgetLimits: { turnBudget: 1 } }, 'model');

      expect(snapshot).toMatchObject({
        status: 'blocked',
        terminalReason: 'Blocked after goal budget reached: turn budget 1',
      });
    });

    it('tracks telemetry without goal text', async () => {
      await goals.createGoal({ objective: 'private objective', replace: true });
      await goals.setBudgetLimits({ budgetLimits: { tokenBudget: 100 } }, 'model');
      await goals.incrementTurn();
      await goals.pauseGoal({ reason: 'private pause reason' });
      await goals.resumeGoal();
      await goals.markComplete({ reason: 'private completion reason' }, 'model');

      expect(telemetry.map((record) => record.event)).toEqual([
        'goal_created',
        'goal_budget_set',
        'goal_continued',
        'goal_status_changed',
        'goal_status_changed',
        'goal_status_changed',
        'goal_cleared',
      ]);
      expect(telemetry[0]?.properties).toEqual({ actor: 'user', replace: true });
      expect(telemetry[1]?.properties).toMatchObject({ actor: 'model', has_token_budget: true });
      expect(telemetry[3]?.properties).toMatchObject({ status: 'paused', actor: 'user' });
      expect(JSON.stringify(telemetry)).not.toContain('private objective');
      expect(JSON.stringify(telemetry)).not.toContain('private pause reason');
      expect(JSON.stringify(telemetry)).not.toContain('private completion reason');
    });
  });

  describe('AgentGoalService records', () => {
    it('records only replay-relevant create/update/clear fields', async () => {
      await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });
      await goals.recordTokenUsage(5);
      await goals.incrementTurn();
      await goals.setBudgetLimits({ budgetLimits: { turnBudget: 2 } }, 'model');
      await goals.markBlocked({ reason: 'stuck' });
      await goals.cancelGoal();
      await ctx.wireRecord.flush();

      const recordsWithoutMetadata = goalRecords(records);
      expect(recordsWithoutMetadata).toEqual([
        expect.objectContaining({
          type: 'goal.create',
          goalId: expect.any(String),
          objective: 'work',
          completionCriterion: 'tests pass',
        }),
        expect.objectContaining({ type: 'goal.update', tokensUsed: 5 }),
        expect.objectContaining({ type: 'goal.update', turnsUsed: 1 }),
        expect.objectContaining({
          type: 'goal.update',
          budgetLimits: { turnBudget: 2 },
        }),
        expect.objectContaining({
          type: 'goal.update',
          status: 'blocked',
          reason: 'stuck',
          actor: 'runtime',
        }),
        expect.objectContaining({ type: 'goal.clear' }),
      ]);
      expect(recordsWithoutMetadata[0]).not.toHaveProperty('actor');
      expect(recordsWithoutMetadata[0]).not.toHaveProperty('budgetLimits');
      expect(recordsWithoutMetadata[1]).not.toHaveProperty('goalId');
      expect(recordsWithoutMetadata[1]).not.toHaveProperty('status');
      expect(recordsWithoutMetadata.at(-1)).not.toHaveProperty('goalId');
      expect(recordsWithoutMetadata.at(-1)).not.toHaveProperty('reason');
    });

    it('restores state from patch records', async () => {
      await restoreGoalRecords(ctx, goals, [
        {
          type: 'goal.create',
          goalId: 'g1',
          objective: 'work',
          completionCriterion: 'tests pass',
          time: Date.parse('2026-01-01T00:00:00.000Z'),
        },
        { type: 'goal.update', tokensUsed: 5 },
        { type: 'goal.update', turnsUsed: 1 },
        { type: 'goal.update', budgetLimits: { turnBudget: 2 } },
        { type: 'goal.update', status: 'blocked', reason: 'stuck' },
      ]);

      expect(goals.getGoal().goal).toMatchObject({
        objective: 'work',
        completionCriterion: 'tests pass',
        status: 'blocked',
        terminalReason: 'stuck',
        tokensUsed: 5,
        turnsUsed: 1,
      });
      expect(goals.getGoal().goal?.budget.turnBudget).toBe(2);
    });

    // TODO(phase-4.6): rewrite against wire resume — buildReplay() facade deleted
    // it('projects restored goal status changes into replay records', async () => {
    //   await restoreGoalRecords(ctx, goals, [
    //     {
    //       type: 'goal.create',
    //       goalId: 'g1',
    //       objective: 'work',
    //       completionCriterion: 'tests pass',
    //       time: Date.parse('2026-01-01T00:00:00.000Z'),
    //     },
    //     { type: 'goal.update', tokensUsed: 5 },
    //     { type: 'goal.update', turnsUsed: 1 },
    //     {
    //       type: 'goal.update',
    //       status: 'paused',
    //       reason: 'break',
    //       actor: 'runtime',
    //     },
    //     { type: 'goal.update', status: 'active', actor: 'user' },
    //     {
    //       type: 'goal.update',
    //       status: 'complete',
    //       reason: 'done',
    //       actor: 'model',
    //     },
    //   ]);
    //
    //   expect(replayBuilder.buildReplay()).toEqual([
    //     expect.objectContaining({
    //       type: 'goal_updated',
    //       snapshot: expect.objectContaining({ objective: 'work', status: 'active' }),
    //       change: { kind: 'created' },
    //     }),
    //     expect.objectContaining({
    //       type: 'goal_updated',
    //       snapshot: expect.objectContaining({ status: 'paused', terminalReason: 'break' }),
    //       change: { kind: 'lifecycle', status: 'paused', reason: 'break', actor: 'runtime' },
    //     }),
    //     expect.objectContaining({
    //       type: 'goal_updated',
    //       snapshot: expect.objectContaining({ status: 'active' }),
    //       change: { kind: 'lifecycle', status: 'active', reason: undefined, actor: 'user' },
    //     }),
    //     expect.objectContaining({
    //       type: 'goal_updated',
    //       snapshot: expect.objectContaining({
    //         status: 'complete',
    //         terminalReason: 'done',
    //         turnsUsed: 1,
    //         tokensUsed: 5,
    //       }),
    //       change: {
    //         kind: 'completion',
    //         status: 'complete',
    //         reason: 'done',
    //         stats: { turnsUsed: 1, tokensUsed: 5, wallClockMs: 0 },
    //         actor: 'model',
    //       },
    //     }),
    //   ]);
    // });

    // TODO(phase-4.6): rewrite against wire resume — buildReplay() facade deleted
    // it('keeps resume-normalization pauses in core replay records', async () => {
    //   await restoreGoalRecords(ctx, goals, [
    //     {
    //       type: 'goal.create',
    //       goalId: 'g1',
    //       objective: 'work',
    //       time: Date.parse('2026-01-01T00:00:00.000Z'),
    //     },
    //     {
    //       type: 'goal.update',
    //       status: 'paused',
    //       reason: 'Paused after agent resume',
    //     },
    //   ]);
    //
    //   expect(replayBuilder.buildReplay().at(-1)).toMatchObject({
    //     type: 'goal_updated',
    //     snapshot: { status: 'paused', terminalReason: 'Paused after agent resume' },
    //     change: {
    //       kind: 'lifecycle',
    //       status: 'paused',
    //       reason: 'Paused after agent resume',
    //       actor: undefined,
    //     },
    //   });
    // });

    it('normalizes active replayed goals to paused', async () => {
      records.length = 0;
      await restoreGoalRecords(ctx, goals, [
        {
          type: 'goal.create',
          goalId: 'g1',
          objective: 'resume me',
        },
      ]);

      expect(goals.getGoal().goal).toMatchObject({
        status: 'paused',
        terminalReason: 'Paused after agent resume',
      });
      expect(goalRecords(records)).toEqual([
        expect.objectContaining({
          type: 'goal.update',
          status: 'paused',
          reason: 'Paused after agent resume',
        }),
      ]);
    });
  });
});

describe('AgentGoalService core workflow hooks', () => {
  let ctx: TestAgentContext | undefined;
  let context: IAgentContextMemoryService;
  let goals: IAgentGoalService;
  let turnService: StubTurn;
  let loopService: IAgentLoopService;
  let eventBus: IEventBus;

  beforeEach(() => {
    turnService = stubTurn({ hasActiveTurn: true });
    loopService = stubLoopWithHooks();
    ctx = createTestAgent(
      agentService(IAgentTurnService, turnService),
      agentService(IAgentLoopService, loopService),
    );
    context = ctx.get(IAgentContextMemoryService);
    goals = ctx.get(IAgentGoalService);
    eventBus = ctx.get(IEventBus);
  });

  afterEach(async () => {
    await ctx?.dispose();
  });

  it('counts an active goal turn and launches the next continuation', async () => {
    await goals.createGoal({ objective: 'finish the task' });

    const turn = makeTurn(1);
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
    await runGoalStep(loopService, turn);
    endTurn(eventBus, turn);

    expect(goals.getGoal().goal).toMatchObject({
      status: 'active',
      turnsUsed: 1,
    });
    expect(turnService.launches).toHaveLength(1);
    expect(context.get().at(-1)?.origin).toEqual({
      kind: 'system_trigger',
      name: 'goal_continuation',
    });
    expect(JSON.stringify(context.get().at(-1)?.content)).toContain('Continue working toward');
  });

  it('blocks at the turn budget instead of launching a continuation', async () => {
    await goals.createGoal({ objective: 'finish the task' });
    await goals.setBudgetLimits({ budgetLimits: { turnBudget: 1 } }, 'model');

    const turn = makeTurn(11);
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
    await runGoalStep(loopService, turn);
    endTurn(eventBus, turn);

    expect(goals.getGoal().goal).toMatchObject({
      status: 'blocked',
      turnsUsed: 1,
      terminalReason: 'Blocked after goal budget reached: turn budget 1',
    });
    expect(turnService.launches).toEqual([]);
  });

  it('accounts step usage through the loop usage hook for active goal turns', async () => {
    await goals.createGoal({ objective: 'finish the task' });
    await goals.setBudgetLimits({ budgetLimits: { tokenBudget: 7 } }, 'model');

    const turn = turnService.launch();
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });

    expect(
      await runStepUsageHooks(loopService, goals, turn, {
        inputCacheRead: 0,
        inputCacheCreation: 0,
        inputOther: 4,
        output: 0,
      }),
    ).toBe(false);
    expect(goals.getGoal().goal).toMatchObject({
      status: 'active',
      tokensUsed: 0,
    });
    expect(
      await runStepUsageHooks(loopService, goals, turn, {
        inputCacheRead: 0,
        inputCacheCreation: 0,
        inputOther: 0,
        output: 7,
      }),
    ).toBe(true);

    expect(goals.getGoal().goal).toMatchObject({
      status: 'blocked',
      tokensUsed: 7,
      terminalReason: 'Blocked after goal budget reached: token budget 7',
    });
  });

  it('ignores step usage for non-goal turns', async () => {
    await goals.createGoal({ objective: 'finish the task' });

    const turn = makeTurn(99);
    expect(
      await runStepUsageHooks(loopService, goals, turn, {
        inputCacheRead: 0,
        inputCacheCreation: 0,
        inputOther: 10,
        output: 5,
      }),
    ).toBe(false);
    expect(goals.getGoal().goal).toMatchObject({
      status: 'active',
      tokensUsed: 0,
    });
  });

  it('continues after creating a goal mid-turn without counting the starter turn', async () => {
    const turn = makeTurn(2);
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
    await runGoalStep(loopService, turn);

    await goals.createGoal({ objective: 'finish the task' }, 'model');
    endTurn(eventBus, turn);

    expect(goals.getGoal().goal).toMatchObject({
      status: 'active',
      turnsUsed: 0,
    });
    expect(turnService.launches).toHaveLength(1);
  });

  it('requests one final outcome turn after model completion', async () => {
    await goals.createGoal({ objective: 'finish the task' });

    const turn = makeTurn(3);
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
    const step = {
      turnId: turn.id,
      step: 1,
      signal: turn.signal,
    };
    const afterStep: AfterStepContext = {
      turnId: turn.id,
      step: 1,
      signal: turn.signal,
      usage: zeroUsage,
      finishReason: 'completed' as const,
      continue: false,
    };
    await loopService.hooks.beforeStep.run(step);

    await goals.markComplete({}, 'model');
    await loopService.hooks.afterStep.run(afterStep);
    endTurn(eventBus, turn);

    expect(afterStep.continue).toBe(true);
    expect(goals.getGoal().goal).toBeNull();
    expect(turnService.launches).toEqual([]);
    expect(context.get().at(-1)?.origin).toEqual({
      kind: 'system_trigger',
      name: 'goal_completion_summary',
    });
  });

  it('pauses active goals after failed turns', async () => {
    await goals.createGoal({ objective: 'finish the task' });

    const turn = makeTurn(4);
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
    endTurn(eventBus, turn, { reason: 'failed', error: new Error('boom') });

    expect(goals.getGoal().goal).toMatchObject({
      status: 'paused',
      terminalReason: 'Paused after runtime error: boom',
    });
    expect(turnService.launches).toEqual([]);
  });

  it('blocks active goals when the user prompt hook blocks the turn', async () => {
    await goals.createGoal({ objective: 'finish the task' });

    const turn = makeTurn(5);
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
    endTurn(eventBus, turn, { reason: 'blocked' });

    expect(goals.getGoal().goal).toMatchObject({
      status: 'blocked',
      terminalReason: 'Blocked by UserPromptSubmit hook',
    });
    expect(turnService.launches).toEqual([]);
  });
});
