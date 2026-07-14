import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TurnEndedEvent } from '@moonshot-ai/protocol';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import { IAgentGoalService } from '#/agent/goal/goal';
import { type AgentGoalService } from '#/agent/goal/goalService';
import { UpdateGoalTool, UpdateGoalToolInputSchema } from '#/agent/goal/tools/update-goal';
import { IAgentLoopService, type AfterStepContext, type Turn } from '#/agent/loop/loop';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentUsageService } from '#/agent/usage/usage';
import type { PersistedWireRecord } from '#/agent/wireRecord/wireRecord';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { APIConnectionError, APIStatusError } from '#/app/llmProtocol/errors';
import type { ToolCall } from '#/app/llmProtocol/message';
import type { TokenUsage } from '#/app/llmProtocol/usage';
import { ErrorCodes, Error2, errorInfo, toKimiErrorPayload } from '#/errors';

import {
  InMemoryWireRecordPersistence,
  agentService,
  createTestAgent,
  telemetryServices,
  testAgent,
  wireRecordPersistenceServices,
  type TestAgentContext,
  type TestAgentOptions,
} from '../../harness';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { stubLoopWithHooks, type StubLoop } from '../loop/stubs';

type GoalServiceTestManager = IAgentGoalService & AgentGoalService;
type GoalRecord = PersistedWireRecord & { type: `goal.${string}` };
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
  records: readonly PersistedWireRecord[],
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
    cancel: () => true,
  };
}

async function runGoalStep(loopService: StubLoop, turn: Turn): Promise<boolean> {
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
    stopTurn: false,
  };
  await loopService.hooks.onWillBeginStep.run(step);
  await loopService.hooks.onDidFinishStep.run(afterStep);
  return loopService.queue.takeNextBatch() !== undefined;
}

function recordStepUsage(
  usageService: IAgentUsageService,
  goals: IAgentGoalService,
  turn: Turn,
  usage: TokenUsage,
): boolean {
  usageService.record('mock-model', usage, { type: 'turn', turnId: turn.id, step: 1 });
  return goals.getGoal().goal?.budget.overBudget === true;
}

async function runTerminalUpdateGoalResult(
  toolExecutor: IAgentToolExecutorService,
  turn: Turn,
  status: 'complete' | 'blocked',
  output: string,
): Promise<void> {
  const toolCall: ToolCall = {
    type: 'function',
    id: 'call_update_goal',
    name: 'UpdateGoal',
    arguments: JSON.stringify({ status }),
  };
  await toolExecutor.hooks.onDidExecuteTool.run({
    turnId: turn.id,
    signal: turn.signal,
    toolCall,
    toolCalls: [toolCall],
    args: { status },
    result: { output, stopTurn: true },
  });
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
      expect(goals.getGoal().goal?.completionCriterion).toBe('c'.repeat(4000));
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

    it('forbids model-driven goal pauses', async () => {
      await goals.createGoal({ objective: 'work' });
      const tool = new UpdateGoalTool(goals);

      for (const status of ['active', 'complete', 'blocked']) {
        expect(UpdateGoalToolInputSchema.safeParse({ status }).success).toBe(true);
      }
      for (const status of ['paused', 'impossible', 'cancelled', '']) {
        expect(UpdateGoalToolInputSchema.safeParse({ status }).success).toBe(false);
      }

      const execution = tool.resolveExecution({ status: 'paused' } as never);
      expect(execution).toMatchObject({
        isError: true,
        output: 'Invalid goal status. Use `active`, `complete`, or `blocked`.',
      });
      expect(goals.getGoal().goal?.status).toBe('active');
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
  let loopService: StubLoop;
  let toolExecutor: IAgentToolExecutorService;
  let usageService: IAgentUsageService;
  let eventBus: IEventBus;

  beforeEach(() => {
    loopService = stubLoopWithHooks({ hasActiveTurn: true });
    ctx = createTestAgent(
      agentService(IAgentLoopService, loopService),
    );
    context = ctx.get(IAgentContextMemoryService);
    goals = ctx.get(IAgentGoalService);
    toolExecutor = ctx.get(IAgentToolExecutorService);
    usageService = ctx.get(IAgentUsageService);
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
    expect(loopService.launches).toHaveLength(1);
    expect(loopService.drainNextBatch(context)).toBeDefined();
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
    expect(loopService.launches).toEqual([]);
  });

  it('accounts recorded turn usage for active goal turns', async () => {
    await goals.createGoal({ objective: 'finish the task' });
    await goals.setBudgetLimits({ budgetLimits: { tokenBudget: 7 } }, 'model');

    const turn = loopService.startTurn();
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });

    expect(
      recordStepUsage(usageService, goals, turn, {
        inputCacheRead: 100_000,
        inputCacheCreation: 50_000,
        inputOther: 40_000,
        output: 4,
      }),
    ).toBe(false);
    expect(goals.getGoal().goal).toMatchObject({ status: 'active', tokensUsed: 4 });
    expect(
      recordStepUsage(usageService, goals, turn, {
        inputCacheRead: 0,
        inputCacheCreation: 0,
        inputOther: 90_000,
        output: 3,
      }),
    ).toBe(true);

    expect(goals.getGoal().goal).toMatchObject({
      status: 'blocked',
      tokensUsed: 7,
      terminalReason: 'Blocked after goal budget reached: token budget 7',
    });
  });

  it('ignores recorded turn usage for non-goal turns', async () => {
    await goals.createGoal({ objective: 'finish the task' });

    const turn = makeTurn(99);
    expect(
      recordStepUsage(usageService, goals, turn, {
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

  it('counts the goal-creating turn as the first goal turn and continues', async () => {
    const turn = makeTurn(2);
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
    await runGoalStep(loopService, turn);

    await goals.createGoal({ objective: 'finish the task' }, 'model');
    endTurn(eventBus, turn);

    await vi.waitFor(() => expect(loopService.launches).toHaveLength(1));
    expect(goals.getGoal().goal).toMatchObject({
      status: 'active',
      turnsUsed: 1,
    });
  });

  it('blocks at the turn budget when the goal-creating turn consumes it', async () => {
    const turn = makeTurn(12);
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
    await runGoalStep(loopService, turn);

    await goals.createGoal({ objective: 'finish the task' }, 'model');
    await goals.setBudgetLimits({ budgetLimits: { turnBudget: 1 } }, 'model');
    endTurn(eventBus, turn);

    expect(goals.getGoal().goal).toMatchObject({
      status: 'blocked',
      turnsUsed: 1,
      terminalReason: 'Blocked after goal budget reached: turn budget 1',
    });
    expect(loopService.launches).toEqual([]);
  });

  it('charges post-creation step output tokens for the goal-creating turn', async () => {
    const turn = makeTurn(13);
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
    await runGoalStep(loopService, turn);

    await goals.createGoal({ objective: 'finish the task' }, 'model');
    expect(
      recordStepUsage(usageService, goals, turn, {
        inputCacheRead: 100,
        inputCacheCreation: 0,
        inputOther: 50,
        output: 6,
      }),
    ).toBe(false);

    expect(goals.getGoal().goal).toMatchObject({
      status: 'active',
      tokensUsed: 6,
    });
  });

  it('requests one final outcome turn after a terminal UpdateGoal tool result', async () => {
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
      stopTurn: false,
    };
    await loopService.hooks.onWillBeginStep.run(step);

    await goals.markComplete({}, 'model');
    await runTerminalUpdateGoalResult(toolExecutor, turn, 'complete', 'outcome prompt');
    await loopService.hooks.onDidFinishStep.run(afterStep);

    expect(loopService.hasPendingRequests()).toBe(true);
    expect(goals.getGoal().goal).toBeNull();
    expect(loopService.launches).toEqual([]);
    expect(JSON.stringify(context.get())).not.toContain('goal_completion_summary');
    expect(JSON.stringify(context.get())).not.toContain('goal_blocked_reason');

    expect(loopService.drainNextBatch(context)).toBeDefined();
    const secondAfterStep: AfterStepContext = {
      turnId: turn.id,
      step: 2,
      signal: turn.signal,
      usage: zeroUsage,
      finishReason: 'completed' as const,
      stopTurn: false,
    };
    await loopService.hooks.onDidFinishStep.run(secondAfterStep);
    endTurn(eventBus, turn);
    expect(loopService.hasPendingRequests()).toBe(false);
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
    expect(loopService.launches).toEqual([]);
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
    expect(loopService.launches).toEqual([]);
  });

  it('pauses the goal when the continuation launch fails', async () => {
    await goals.createGoal({ objective: 'finish the task' });
    vi.spyOn(loopService, 'enqueue').mockImplementation(() => {
      throw new Error('wire dispatch exploded');
    });
    const updates: GoalUpdatedEvent[] = [];
    eventBus.subscribe((event) => {
      if (event.type === 'goal.updated') updates.push(event);
    });

    const turn = makeTurn(21);
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
    await runGoalStep(loopService, turn);
    endTurn(eventBus, turn);

    await vi.waitFor(() => expect(goals.getGoal().goal?.status).toBe('paused'));
    expect(goals.getGoal().goal?.terminalReason).toBe(
      'Paused after goal continuation failure: wire dispatch exploded',
    );
    expect(updates.at(-1)?.snapshot).toMatchObject({ status: 'paused' });
  });

  it('queues one continuation and lets the loop start it automatically', async () => {
    await goals.createGoal({ objective: 'finish the task' });

    const goalTurn = makeTurn(31);
    eventBus.publish({ type: 'turn.started', turnId: goalTurn.id, origin: USER_PROMPT_ORIGIN });
    await runGoalStep(loopService, goalTurn);
    endTurn(eventBus, goalTurn);

    await vi.waitFor(() => expect(loopService.launches).toHaveLength(1));
    expect(goals.getGoal().goal?.status).toBe('active');
    expect(loopService.hasPendingRequests()).toBe(true);
  });
});

describe('goal error catalog metadata', () => {
  it('surfaces title and action hints for every goal error code', () => {
    expect(errorInfo('goal.already_exists')).toEqual({
      title: 'A goal is already active',
      retryable: false,
      public: true,
      action: 'Use `/goal replace <objective>` to replace the current goal.',
    });
    expect(errorInfo('goal.not_found')).toEqual({
      title: 'No goal found',
      retryable: false,
      public: true,
      action: 'Start a goal with `/goal <objective>` first.',
    });
    expect(errorInfo('goal.objective_empty')).toEqual({
      title: 'Goal objective is empty',
      retryable: false,
      public: true,
      action: 'Provide a non-empty objective.',
    });
    expect(errorInfo('goal.objective_too_long')).toEqual({
      title: 'Goal objective is too long',
      retryable: false,
      public: true,
      action: 'Keep the objective under 4000 characters; reference long details by file path.',
    });
    expect(errorInfo('goal.status_invalid')).toEqual({
      title: 'Invalid goal status transition',
      retryable: false,
      public: true,
      action: 'Use a status allowed for this actor (complete, blocked, or impossible).',
    });
    expect(errorInfo('goal.metadata_reserved')).toEqual({
      title: 'Goal metadata is reserved',
      retryable: false,
      public: true,
      action: 'Do not write metadata.custom.goal directly; use the goal lifecycle methods.',
    });
    expect(errorInfo('goal.not_resumable')).toEqual({
      title: 'Goal is not resumable',
      retryable: false,
      public: true,
      action: 'Only paused goals can be resumed.',
    });
  });
});

describe('goal pause classification on provider errors', () => {
  type GenerateFn = NonNullable<TestAgentOptions['generate']>;

  function singleAttemptAgentOptions(): Pick<TestAgentOptions, 'initialConfig'> {
    return {
      initialConfig: {
        providers: {},
        loopControl: { maxRetriesPerStep: 1 },
      },
    };
  }

  async function goalAfterFailedTurn(generate: GenerateFn) {
    const ctx = testAgent({ generate, ...singleAttemptAgentOptions() });
    ctx.configure();
    const goals = ctx.get(IAgentGoalService);
    await goals.createGoal({ objective: 'work' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'work' }] });
    await ctx.untilTurnEnd();

    return goals.getGoal().goal;
  }

  it('pauses the goal on provider rate limits', async () => {
    const goal = await goalAfterFailedTurn(async () => {
      throw new APIStatusError(429, 'Rate limited', 'req-429');
    });

    expect(goal).toMatchObject({
      status: 'paused',
      terminalReason: 'Paused after provider rate limit',
    });
  });

  it('pauses the goal on provider connection errors', async () => {
    const goal = await goalAfterFailedTurn(async () => {
      throw new APIConnectionError('socket hang up');
    });

    expect(goal).toMatchObject({
      status: 'paused',
      terminalReason: 'Paused after provider connection error: socket hang up',
    });
  });

  it('pauses the goal on provider authentication errors', async () => {
    const goal = await goalAfterFailedTurn(async () => {
      throw new APIStatusError(401, 'Unauthorized', 'req-401');
    });

    expect(goal).toMatchObject({
      status: 'paused',
      terminalReason: 'Paused after provider authentication error: Unauthorized',
    });
  });

  it('pauses the goal on model configuration errors', async () => {
    const goal = await goalAfterFailedTurn(async () => {
      throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Model not set');
    });

    expect(goal).toMatchObject({
      status: 'paused',
      terminalReason: 'Paused after model configuration error: LLM not set, send "/login" to login',
    });
  });

  it('pauses the goal on provider safety policy blocks', async () => {
    const goal = await goalAfterFailedTurn(async () => ({
      id: 'mock-filtered',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'filtered' }],
        toolCalls: [],
      },
      usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    }));

    expect(goal).toMatchObject({
      status: 'paused',
      terminalReason: 'Paused after provider safety policy block',
    });
  });
});

describe('AgentGoalService mid-turn budget stop', () => {
  it('grants one tool-free grace step when a token budget is reached mid-turn', async () => {
    const ctx = createTestAgent();
    try {
      ctx.configure({ tools: ['GetGoal'] });
      await ctx.rpc.createGoal({ objective: 'work' });
      const goals = ctx.get(IAgentGoalService);
      await goals.setBudgetLimits({ budgetLimits: { tokenBudget: 1 } }, 'model');

      ctx.mockNextResponse({
        type: 'function',
        id: 'g1',
        name: 'GetGoal',
        arguments: JSON.stringify({}),
      });
      ctx.mockNextResponse({ type: 'text', text: 'Final status: budget exhausted.' });
      ctx.mockNextResponse({ type: 'text', text: 'This step should never run.' });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'work' }] });
      const events = await ctx.untilTurnEnd();

      expect(ctx.llmCalls).toHaveLength(2);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'turn.ended',
          args: expect.objectContaining({ reason: 'completed' }),
        }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({
          event: 'turn.ended',
          args: expect.objectContaining({ reason: 'failed' }),
        }),
      );

      const history = ctx.get(IAgentContextMemoryService).get();
      const toolResultIndex = history.findIndex((message) => message.role === 'tool');
      const reminderIndex = history.findIndex(
        (message) =>
          message.origin?.kind === 'system_trigger' && message.origin.name === 'goal_budget_stop',
      );
      expect(toolResultIndex).toBeGreaterThanOrEqual(0);
      expect(reminderIndex).toBeGreaterThan(toolResultIndex);
      expect(JSON.stringify(history)).toContain('Final status: budget exhausted.');
      expect(JSON.stringify(history)).not.toContain('This step should never run.');

      const goal = (await ctx.rpc.getGoal({})).goal;
      expect(goal?.status).toBe('blocked');
      expect(goal?.terminalReason).toMatch(/^Blocked after goal budget reached/);
      expect(goal?.tokensUsed).toBeGreaterThan(1);
    } finally {
      await ctx.dispose();
    }
  });

  it('rejects tool calls made during the budget grace step without executing them', async () => {
    const ctx = createTestAgent();
    try {
      ctx.configure({ tools: ['GetGoal', 'SetGoalBudget'] });
      await ctx.rpc.createGoal({ objective: 'work' });
      const goals = ctx.get(IAgentGoalService);
      await goals.setBudgetLimits({ budgetLimits: { tokenBudget: 1 } }, 'model');

      ctx.mockNextResponse({
        type: 'function',
        id: 'g1',
        name: 'GetGoal',
        arguments: JSON.stringify({}),
      });
      ctx.mockNextResponse({
        type: 'function',
        id: 'g2',
        name: 'SetGoalBudget',
        arguments: JSON.stringify({ value: 5, unit: 'turns' }),
      });
      ctx.mockNextResponse({ type: 'text', text: 'This step should never run.' });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'work' }] });
      const events = await ctx.untilTurnEnd();

      expect(ctx.llmCalls).toHaveLength(2);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'turn.ended',
          args: expect.objectContaining({ reason: 'completed' }),
        }),
      );

      const history = ctx.get(IAgentContextMemoryService).get();
      const toolResults = history.filter((message) => message.role === 'tool');
      expect(toolResults).toHaveLength(2);
      expect(JSON.stringify(toolResults.at(-1))).toContain(
        'Goal budget exhausted; tool calls are rejected. Write your final message.',
      );
      expect(JSON.stringify(history)).not.toContain('This step should never run.');

      const goal = (await ctx.rpc.getGoal({})).goal;
      expect(goal?.status).toBe('blocked');
      expect(goal?.budget.turnBudget).toBeNull();
    } finally {
      await ctx.dispose();
    }
  });

  it('blocks an over-budget goal at turn launch and runs the prompt as a normal turn', async () => {
    const telemetry: TelemetryRecord[] = [];
    const ctx = createTestAgent(telemetryServices(recordingTelemetry(telemetry)));
    try {
      ctx.configure();
      const goals = ctx.get(IAgentGoalService) as GoalServiceTestManager;
      await goals.createGoal({ objective: 'work' });
      await goals.setBudgetLimits({ budgetLimits: { turnBudget: 1 } }, 'model');
      await goals.incrementTurn();
      expect(goals.getGoal().goal?.status).toBe('blocked');

      const resumed = await goals.resumeGoal();
      expect(resumed.status).toBe('active');
      const telemetryAfterResume = telemetry.length;

      ctx.mockNextResponse({ type: 'text', text: 'Answering the prompt normally.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
      const events = await ctx.untilTurnEnd();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(ctx.llmCalls).toHaveLength(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'turn.ended',
          args: expect.objectContaining({ reason: 'completed' }),
        }),
      );

      const goal = goals.getGoal().goal;
      expect(goal?.status).toBe('blocked');
      expect(goal?.terminalReason).toBe('Blocked after goal budget reached: turn budget 1');
      expect(goal?.turnsUsed).toBe(1);
      expect(
        telemetry.slice(telemetryAfterResume).map((record) => record.event),
      ).not.toContain('goal_continued');
      expect(
        ctx.allEvents.filter(
          (entry) => entry.type === '[rpc]' && entry.event === 'turn.started',
        ),
      ).toHaveLength(1);
    } finally {
      await ctx.dispose();
    }
  });
});

describe('AgentGoalService goal outcome tool result flow', () => {
  it('does not force a goal outcome summary after maxStepsPerTurn is exhausted', async () => {
    const ctx = createTestAgent({
      initialConfig: { providers: {}, loopControl: { maxStepsPerTurn: 1 } },
    });
    try {
      ctx.configure({ tools: ['GetGoal', 'UpdateGoal'] });
      await ctx.rpc.createGoal({ objective: 'work' });

      ctx.mockNextResponse({
        type: 'function',
        id: 'complete',
        name: 'UpdateGoal',
        arguments: JSON.stringify({ status: 'complete' }),
      });
      ctx.mockNextResponse({ type: 'text', text: 'This summary should not run.' });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'work' }] });
      const events = await ctx.untilTurnEnd();

      expect(ctx.llmCalls).toHaveLength(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'turn.ended',
          args: expect.objectContaining({ reason: 'completed' }),
        }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({
          event: 'turn.ended',
          args: expect.objectContaining({ reason: 'failed' }),
        }),
      );
      expect((await ctx.rpc.getGoal({})).goal).toBeNull();
      const history = ctx.get(IAgentContextMemoryService).get();
      expect(JSON.stringify(history)).toContain('Write a concise final message');
      expect(JSON.stringify(history)).not.toContain('This summary should not run.');
      expect(history.at(-1)?.role).toBe('tool');
    } finally {
      await ctx.dispose();
    }
  });
});

describe('AgentGoalService fork boundaries', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let goals: IAgentGoalService;

  beforeEach(() => {
    ctx = createTestAgent(wireRecordPersistenceServices(new InMemoryWireRecordPersistence()));
    context = ctx.get(IAgentContextMemoryService);
    goals = ctx.get(IAgentGoalService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('appends a fork-cleared reminder when a fork clears a copied goal', async () => {
    await restoreGoalRecords(ctx, goals, [
      { type: 'goal.create', goalId: 'source-goal', objective: 'source work' },
      { type: 'forked' },
    ]);

    expect(goals.getGoal().goal).toBeNull();
    const reminder = context.get().at(-1);
    expect(reminder?.origin).toEqual({ kind: 'system_trigger', name: 'goal_fork_cleared' });
    const text = JSON.stringify(reminder?.content);
    expect(text).toContain('This fork does not have a current goal.');
    expect(text).toContain('Ignore earlier active-goal reminders from the source session.');
    expect(text).toContain('Handle requests normally unless the user starts a new goal.');
  });

  it('does not append a fork-cleared reminder when the fork had no goal', async () => {
    await restoreGoalRecords(ctx, goals, [{ type: 'forked' }]);

    expect(goals.getGoal().goal).toBeNull();
    expect(context.get()).toEqual([]);
  });

  it('does not append a fork-cleared reminder when the goal was cleared before the fork', async () => {
    await restoreGoalRecords(ctx, goals, [
      { type: 'goal.create', goalId: 'source-goal', objective: 'source work' },
      { type: 'goal.clear' },
      { type: 'forked' },
    ]);

    expect(context.get()).toEqual([]);
  });
});
