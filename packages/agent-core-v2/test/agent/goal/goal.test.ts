/**
 * Scenario: goal lifecycle, durable wire records, and continuation scheduling.
 * Responsibilities: verify public goal commands, replayable state, and one-turn admission.
 * Wiring: real goal/wire services; loop is stubbed only for focused scheduling cases.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/agent/goal/goal.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TurnEndedEvent } from '#/agent/loop/turnEvents';

import type { IDisposable } from '#/_base/di/lifecycle';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IGoalDeadlineScheduler } from '#/agent/goal/goalDeadlineScheduler';
import { type AgentGoalService } from '#/agent/goal/goalService';
import { UpdateGoalTool, UpdateGoalToolInputSchema } from '#/agent/goal/tools/update-goal';
import { IAgentLoopService, type AfterStepContext, type EnqueueReceipt, type Step, type Turn } from '#/agent/loop/loop';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  IAgentToolExecutorService,
  type ToolExecutionResult,
} from '#/agent/toolExecutor/toolExecutor';
import type { ToolBeforeExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentUsageService } from '#/agent/usage/usage';
import type { WireRecord } from '#/wire/record';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { APIConnectionError, APIStatusError } from '#/kosong/contract/errors';
import type { ToolCall } from '#/kosong/contract/message';
import type { TokenUsage } from '#/kosong/contract/usage';
import { ErrorCodes, Error2, errorInfo, toKimiErrorPayload } from '#/errors';
import type { ExecutableTool } from '#/tool/toolContract';

import {
  InMemoryWireRecordPersistence,
  appService,
  agentService,
  createTestAgent,
  permissionModeServices,
  telemetryServices,
  testAgent,
  wireRecordPersistenceServices,
  type TestAgentContext,
  type TestAgentOptions,
} from '../../harness';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { stubLoopWithHooks, type StubLoop } from '../loop/stubs';

type GoalServiceTestManager = IAgentGoalService & AgentGoalService;
type GoalRecord = WireRecord & { type: `goal.${string}` };
type AgentEvent = DomainEvent;
type GoalUpdatedEvent = Extract<AgentEvent, { type: 'goal.updated' }>;
type TurnEndedInput = {
  readonly reason: TurnEndedEvent['reason'];
  readonly error?: unknown;
};

interface ManualDeadline {
  readonly dueAt: number;
  readonly callback: () => void;
  cancelled: boolean;
}

class ManualGoalDeadlineScheduler implements IGoalDeadlineScheduler {
  declare readonly _serviceBrand: undefined;

  private currentTime = 0;
  private readonly deadlines = new Set<ManualDeadline>();

  now(): number {
    return this.currentTime;
  }

  schedule(delayMs: number, callback: () => void): IDisposable {
    const deadline: ManualDeadline = {
      dueAt: this.currentTime + Math.max(0, delayMs),
      callback,
      cancelled: false,
    };
    this.deadlines.add(deadline);
    return {
      dispose: () => {
        deadline.cancelled = true;
        this.deadlines.delete(deadline);
      },
    };
  }

  advanceBy(deltaMs: number): void {
    this.currentTime += deltaMs;
    while (true) {
      const due = [...this.deadlines]
        .filter((deadline) => !deadline.cancelled && deadline.dueAt <= this.currentTime)
        .toSorted((left, right) => left.dueAt - right.dueAt)[0];
      if (due === undefined) return;
      this.deadlines.delete(due);
      due.callback();
    }
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function blockingGenerate(): {
  readonly generate: NonNullable<TestAgentOptions['generate']>;
  readonly started: Promise<void>;
  readonly signal: () => AbortSignal;
} {
  const started = deferred();
  let activeSignal: AbortSignal | undefined;
  const generate: NonNullable<TestAgentOptions['generate']> = async (
    _chat,
    _systemPrompt,
    _tools,
    _history,
    _callbacks,
    options,
  ) => {
    const signal = options?.signal;
    if (signal === undefined) throw new Error('Expected an LLM abort signal');
    options?.onRequestStart?.();
    activeSignal = signal;
    started.resolve();
    return waitForAbort(signal);
  };
  return {
    generate,
    started: started.promise,
    signal: () => {
      if (activeSignal === undefined) throw new Error('LLM request has not started');
      return activeSignal;
    },
  };
}

const zeroUsage: TokenUsage = {
  inputCacheRead: 0,
  inputCacheCreation: 0,
  inputOther: 0,
  output: 0,
};

function goalRecords(records: readonly WireRecord[]): readonly GoalRecord[] {
  return records.filter((record): record is GoalRecord => record.type.startsWith('goal.'));
}

async function restoreGoalRecords(
  ctx: TestAgentContext,
  goals: IAgentGoalService,
  records: readonly WireRecord[],
): Promise<void> {
  goals.getGoal();
  await ctx.restore(records as readonly WireRecord[]);
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

async function executeToolCall(
  toolExecutor: IAgentToolExecutorService,
  turn: Turn,
  toolCall: ToolCall,
): Promise<ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = [];
  for await (const result of toolExecutor.execute([toolCall], {
    turnId: turn.id,
    signal: turn.signal,
  })) {
    results.push(result);
  }
  return results;
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
  let records: WireRecord[];
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
      await ctx.wire.flush();

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

    it('continues a resumed blocked goal after its first completed turn', async () => {
      ctx.configure({ tools: ['UpdateGoal'] });
      ctx.mockNextResponse({ type: 'text', text: 'Made progress.' });
      ctx.mockNextResponse({
        type: 'function',
        id: 'complete-after-resume',
        name: 'UpdateGoal',
        arguments: JSON.stringify({ status: 'complete' }),
      });
      ctx.mockNextResponse({ type: 'text', text: 'Goal completed.' });
      const endedTurnIds: number[] = [];
      const endedTurnReasons: string[] = [];
      const continuationTurnIds: number[] = [];
      const eventBus = ctx.get(IEventBus);
      eventBus.subscribe('turn.ended', (event) => {
        endedTurnIds.push(event.turnId);
        endedTurnReasons.push(event.reason);
      });
      eventBus.subscribe('turn.started', (event) => {
        if (
          event.origin.kind === 'system_trigger' &&
          event.origin.name === 'goal_continuation'
        ) {
          continuationTurnIds.push(event.turnId);
        }
      });

      await goals.createGoal({ objective: 'finish the task' });
      await goals.markBlocked({ reason: 'need credentials' });
      const [resumed, repeated] = await Promise.all([
        goals.resumeGoal({ continueIfBlocked: true }),
        goals.resumeGoal({ continueIfBlocked: true }),
      ]);

      expect(resumed.status).toBe('active');
      expect(repeated.status).toBe('active');
      await vi.waitFor(() => {
        expect(endedTurnIds).toHaveLength(2);
      });
      expect(ctx.llmCalls).toHaveLength(3);
      expect(continuationTurnIds).toEqual(endedTurnIds);
      expect(endedTurnReasons).toEqual(['completed', 'completed']);
      expect(goals.getGoal().goal).toBeNull();
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
      await goals.resumeGoal();
      await goals.cancelGoal();
      await ctx.wire.flush();

      const recordsWithoutMetadata = goalRecords(records);
      expect(recordsWithoutMetadata).toEqual([
        expect.objectContaining({
          type: 'goal.create',
          goalId: expect.any(String),
          objective: 'work',
          completionCriterion: 'tests pass',
          wallClockResumedAt: expect.any(Number),
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
        expect.objectContaining({
          type: 'goal.update',
          status: 'active',
          wallClockResumedAt: expect.any(Number),
          actor: 'user',
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
      expect(goalRecords(records).filter((record) => record.type === 'goal.update')).toEqual([
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
  let clock: ManualGoalDeadlineScheduler;

  beforeEach(() => {
    loopService = stubLoopWithHooks();
    clock = new ManualGoalDeadlineScheduler();
    ctx = createTestAgent(
      appService(IGoalDeadlineScheduler, clock),
      agentService(IAgentLoopService, loopService),
      permissionModeServices('auto'),
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

  async function startLiveContinuation(
    abortResult = true,
  ): Promise<ReturnType<typeof vi.fn<() => boolean>>> {
    const abort = vi.fn<() => boolean>(() => abortResult);
    const turn: Turn = { ...makeTurn(41), result: new Promise<never>(() => {}) };
    const step: Step = {
      id: 'goal-continuation',
      turnId: turn.id,
      state: 'queued',
      signal: turn.signal,
      result: Promise.resolve({ type: 'completed' }),
      cancel: () => true,
    };
    const receipt: EnqueueReceipt = { assigned: Promise.resolve({ turn, step }), abort };
    vi.spyOn(loopService, 'enqueue').mockReturnValue(receipt);

    await goals.createGoal({ objective: 'finish the task' });
    await goals.markBlocked({ reason: 'need credentials' });
    await goals.resumeGoal({ continueIfBlocked: true });
    await Promise.resolve();
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
    return abort;
  }

  it('starts a continuation when a user resumes an idle blocked goal', async () => {
    await goals.createGoal({ objective: 'finish the task' });
    await goals.markBlocked({ reason: 'need credentials' });

    const resumed = await goals.resumeGoal({ continueIfBlocked: true });

    expect(resumed.status).toBe('active');
    expect(loopService.launches).toHaveLength(1);
    expect(loopService.drainNextBatch(context)).toBeDefined();
    expect(context.get().at(-1)?.origin).toEqual({
      kind: 'system_trigger',
      name: 'goal_continuation',
    });
  });

  it.each([{ status: 'paused' as const }, { status: 'blocked' as const }])(
    'queues a continuation when a live non-goal turn resumes a $status goal',
    async ({ status }) => {
      await goals.createGoal({ objective: 'finish the task' });
      if (status === 'paused') {
        await goals.pauseGoal();
      } else {
        await goals.markBlocked({ reason: 'need credentials' });
      }
      const turn = makeTurn(49);
      eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
      await loopService.hooks.onWillBeginStep.run({
        turnId: turn.id,
        step: 1,
        signal: turn.signal,
      });

      await goals.resumeGoal();
      endTurn(eventBus, turn);

      await vi.waitFor(() => {
        expect(loopService.launches).toHaveLength(1);
      });
      expect(loopService.drainNextBatch(context)).toBeDefined();
      expect(context.get().at(-1)?.origin).toEqual({
        kind: 'system_trigger',
        name: 'goal_continuation',
      });
    },
  );

  it('records a live non-goal turn against the paused goal it resumes', async () => {
    await goals.createGoal({ objective: 'finish the task' });
    await goals.pauseGoal();
    const turn = makeTurn(50);
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
    await loopService.hooks.onWillBeginStep.run({
      turnId: turn.id,
      step: 1,
      signal: turn.signal,
    });

    await goals.resumeGoal();
    recordStepUsage(usageService, goals, turn, { ...zeroUsage, output: 5 });
    endTurn(eventBus, turn);

    expect(goals.getGoal().goal).toMatchObject({
      status: 'active',
      turnsUsed: 1,
      tokensUsed: 5,
    });
  });

  it('aborts a live continuation when the user pauses the goal', async () => {
    const abort = await startLiveContinuation();

    await goals.pauseGoal();

    expect(abort).toHaveBeenCalledOnce();
  });

  it('aborts a live continuation when the user cancels the goal', async () => {
    const abort = await startLiveContinuation();

    await goals.cancelGoal();

    expect(abort).toHaveBeenCalledOnce();
  });

  it('aborts a live continuation when the user replaces the goal', async () => {
    const abort = await startLiveContinuation();

    await goals.createGoal({ objective: 'new task', replace: true });

    expect(abort).toHaveBeenCalledOnce();
  });

  it('queues a continuation for a replacement goal created by its current goal turn', async () => {
    await goals.createGoal({ objective: 'old task' });
    const turn = makeTurn(47);
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
    await loopService.hooks.onWillBeginStep.run({
      turnId: turn.id,
      step: 1,
      signal: turn.signal,
    });
    const toolCall: ToolCall = {
      type: 'function',
      id: 'call_replace_goal',
      name: 'CreateGoal',
      arguments: JSON.stringify({ objective: 'new task', replace: true }),
    };
    const results = await executeToolCall(toolExecutor, turn, toolCall);
    expect(results[0]?.result.isError).not.toBe(true);

    endTurn(eventBus, turn);

    await vi.waitFor(() => {
      expect(loopService.launches).toHaveLength(1);
    });
    expect(goals.getGoal().goal).toMatchObject({ objective: 'new task', status: 'active' });
    expect(loopService.drainNextBatch(context)).toBeDefined();
    expect(context.get().at(-1)?.origin).toEqual({
      kind: 'system_trigger',
      name: 'goal_continuation',
    });
  });

  it('does not charge a same-turn replacement goal for usage owned by the prior goal', async () => {
    await goals.createGoal({ objective: 'old task' });
    const turn = makeTurn(48);
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
    await loopService.hooks.onWillBeginStep.run({
      turnId: turn.id,
      step: 1,
      signal: turn.signal,
    });
    const toolCall: ToolCall = {
      type: 'function',
      id: 'call_replace_goal',
      name: 'CreateGoal',
      arguments: JSON.stringify({ objective: 'new task', replace: true }),
    };
    await executeToolCall(toolExecutor, turn, toolCall);

    recordStepUsage(usageService, goals, turn, { ...zeroUsage, output: 5 });

    expect(goals.getGoal().goal).toMatchObject({
      objective: 'new task',
      tokensUsed: 0,
    });
  });

  it('keeps a replacement goal isolated from late user-turn accounting', async () => {
    await goals.createGoal({ objective: 'old task' });
    const oldTurn = makeTurn(42);
    eventBus.publish({ type: 'turn.started', turnId: oldTurn.id, origin: USER_PROMPT_ORIGIN });

    const replacement = await goals.createGoal({ objective: 'new task', replace: true });
    await loopService.hooks.onWillBeginStep.run({
      turnId: oldTurn.id,
      step: 1,
      signal: oldTurn.signal,
    });
    recordStepUsage(usageService, goals, oldTurn, { ...zeroUsage, output: 5 });
    endTurn(eventBus, oldTurn);

    expect(goals.getGoal().goal).toMatchObject({
      goalId: replacement.goalId,
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
    });
    expect(loopService.hasPendingRequests()).toBe(false);
    expect(loopService.launches).toEqual([]);
  });

  it('ignores a late outcome continuation from a replaced goal user turn', async () => {
    await goals.createGoal({ objective: 'old task' });
    const oldTurn = makeTurn(45);
    eventBus.publish({ type: 'turn.started', turnId: oldTurn.id, origin: USER_PROMPT_ORIGIN });
    const replacement = await goals.createGoal({ objective: 'new task', replace: true });

    await runTerminalUpdateGoalResult(toolExecutor, oldTurn, 'complete', 'old outcome');
    await loopService.hooks.onDidFinishStep.run({
      turnId: oldTurn.id,
      step: 1,
      signal: oldTurn.signal,
      usage: zeroUsage,
      finishReason: 'completed',
      stopTurn: false,
    });

    expect(loopService.hasPendingRequests()).toBe(false);
    expect(goals.getGoal().goal).toMatchObject({
      goalId: replacement.goalId,
      status: 'active',
    });
  });

  it.each([
    { name: 'CreateGoal', args: { objective: 'late task', replace: true } },
    { name: 'UpdateGoal', args: { status: 'complete' } },
    { name: 'SetGoalBudget', args: { value: 5, unit: 'turns' } },
  ])('rejects a stale $name call from a replaced goal turn', async ({ name, args }) => {
    await goals.createGoal({ objective: 'old task' });
    const oldTurn = makeTurn(46);
    eventBus.publish({ type: 'turn.started', turnId: oldTurn.id, origin: USER_PROMPT_ORIGIN });
    const replacement = await goals.createGoal({ objective: 'new task', replace: true });
    const toolCall: ToolCall = {
      type: 'function',
      id: 'call_stale_goal_tool',
      name,
      arguments: JSON.stringify(args),
    };
    const before: ToolBeforeExecuteContext = {
      turnId: oldTurn.id,
      signal: oldTurn.signal,
      toolCall,
      toolCalls: [toolCall],
      args,
      execution: { approvalRule: name, execute: async () => ({ output: 'executed' }) },
    };

    await toolExecutor.hooks.onBeforeExecuteTool.run(before);

    expect(before.decision?.syntheticResult).toEqual({
      output: 'Goal changed since this turn started; ignored stale goal tool call.',
    });
    expect(goals.getGoal().goal).toMatchObject({
      goalId: replacement.goalId,
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
    });
  });

  it.each([
    { reason: 'cancelled' as const },
    { reason: 'failed' as const, error: new Error('old turn failed') },
  ])('keeps a replacement goal active after the replaced goal turn ends as $reason', async (result) => {
    await goals.createGoal({ objective: 'old task' });
    const oldTurn = makeTurn(43);
    eventBus.publish({ type: 'turn.started', turnId: oldTurn.id, origin: USER_PROMPT_ORIGIN });
    const replacement = await goals.createGoal({ objective: 'new task', replace: true });

    endTurn(eventBus, oldTurn, result);

    expect(goals.getGoal().goal).toMatchObject({
      goalId: replacement.goalId,
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
    });
  });

  it.each([
    { reason: 'completed' as const },
    { reason: 'failed' as const, error: new Error('old continuation failed') },
  ])('keeps a replacement goal isolated when the replaced goal continuation settles as $reason', async (result) => {
    await goals.createGoal({ objective: 'old task' });
    const oldUserTurn = makeTurn(44);
    eventBus.publish({ type: 'turn.started', turnId: oldUserTurn.id, origin: USER_PROMPT_ORIGIN });
    await runGoalStep(loopService, oldUserTurn);
    endTurn(eventBus, oldUserTurn);
    await vi.waitFor(() => {
      expect(loopService.launches).toHaveLength(1);
    });

    const continuationTurn = makeTurn(loopService.launches[0]!);
    eventBus.publish({
      type: 'turn.started',
      turnId: continuationTurn.id,
      origin: { kind: 'system_trigger', name: 'goal_continuation' },
    });
    const replacement = await goals.createGoal({ objective: 'new task', replace: true });

    await loopService.hooks.onWillBeginStep.run({
      turnId: continuationTurn.id,
      step: 1,
      signal: continuationTurn.signal,
    });
    recordStepUsage(usageService, goals, continuationTurn, { ...zeroUsage, output: 7 });
    endTurn(eventBus, continuationTurn, result);

    expect(goals.getGoal().goal).toMatchObject({
      goalId: replacement.goalId,
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
    });
    expect(loopService.launches).toHaveLength(1);
  });

  it('cancels a preserved continuation turn after its original receipt settles', async () => {
    const abort = await startLiveContinuation(false);
    const cancel = vi.spyOn(loopService, 'cancel').mockReturnValue(true);
    await goals.markBlocked({ reason: 'still need credentials' }, 'model');
    await goals.cancelGoal();

    expect(abort).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(41);
  });

  it.each(['turn', 'token', 'wall-clock'] as const)(
    'keeps a goal blocked when its %s budget is exhausted before resume',
    async (budget) => {
      await goals.createGoal({ objective: 'finish the task' });
      if (budget === 'turn') {
        await goals.setBudgetLimits({ budgetLimits: { turnBudget: 1 } }, 'model');
      } else if (budget === 'token') {
        await goals.setBudgetLimits({ budgetLimits: { tokenBudget: 1 } }, 'model');
      } else {
        await goals.setBudgetLimits({ budgetLimits: { wallClockBudgetMs: 1 } }, 'model');
        clock.advanceBy(1);
      }

      const turn = makeTurn(101);
      eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
      if (budget === 'token') {
        recordStepUsage(usageService, goals, turn, { ...zeroUsage, output: 1 });
      } else {
        await runGoalStep(loopService, turn);
      }
      endTurn(eventBus, turn);
      expect(loopService.status()).toMatchObject({ state: 'idle', hasPendingRequests: false });

      const resumed = await goals.resumeGoal({ continueIfBlocked: true });

      expect(resumed.status).toBe('blocked');
      expect(resumed.budget.overBudget).toBe(true);
      expect(resumed.terminalReason).toMatch(/^Blocked after goal budget reached:/);
      expect(loopService.launches).toEqual([]);
    },
  );

  it('does not launch another turn when a user resumes a blocked goal during a live turn', async () => {
    await goals.createGoal({ objective: 'finish the task' });

    const turn = loopService.startTurn();
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
    await goals.markBlocked({ reason: 'need credentials' });
    const resumed = await goals.resumeGoal({ continueIfBlocked: true });

    expect(resumed.status).toBe('active');
    expect(loopService.launches).toEqual([turn.id]);
  });

  it('does not launch a continuation when another loop request is pending', async () => {
    loopService.enqueue(
      new MessageStepRequest({
        role: 'user',
        content: [{ type: 'text', text: 'queued work' }],
        toolCalls: [],
        origin: USER_PROMPT_ORIGIN,
      }),
    );
    await goals.createGoal({ objective: 'finish the task' });
    await goals.markBlocked({ reason: 'need credentials' });

    const resumed = await goals.resumeGoal({ continueIfBlocked: true });

    expect(resumed.status).toBe('active');
    expect(loopService.launches).toEqual([]);
    expect(loopService.drainNextBatch(context)).toBeDefined();
    expect(context.get().at(-1)?.origin).toEqual(USER_PROMPT_ORIGIN);
  });

  it('launches only one continuation when blocked resume is repeated', async () => {
    await goals.createGoal({ objective: 'finish the task' });
    await goals.markBlocked({ reason: 'need credentials' });

    await goals.resumeGoal({ continueIfBlocked: true });
    const repeated = await goals.resumeGoal({ continueIfBlocked: true });

    expect(repeated.status).toBe('active');
    expect(loopService.launches).toHaveLength(1);
  });

  it('does not launch a continuation when a paused goal resumes by default', async () => {
    await goals.createGoal({ objective: 'finish the task' });
    await goals.pauseGoal();

    const resumed = await goals.resumeGoal();

    expect(resumed.status).toBe('active');
    expect(loopService.launches).toEqual([]);
  });

  it('starts one continuation when a caller opts to resume a paused goal', async () => {
    await goals.createGoal({ objective: 'finish the task' });
    await goals.pauseGoal();

    const resumed = await goals.resumeGoal({ continueIfPaused: true });

    expect(resumed.status).toBe('active');
    expect(loopService.launches).toHaveLength(1);
  });

  it('starts a continuation after an opted paused resume waits for a cancelled turn', async () => {
    await startLiveContinuation();
    const enqueue = vi.mocked(loopService.enqueue);

    await goals.pauseGoal();
    const resumed = await goals.resumeGoal({ continueIfPaused: true });
    endTurn(eventBus, makeTurn(41), { reason: 'cancelled' });

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    expect(resumed.status).toBe('active');
    expect(goals.getGoal().goal?.status).toBe('active');
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

  it('blocks the next continuation only after the final allowed turn ends', async () => {
    await goals.createGoal({ objective: 'finish the task' });
    await goals.setBudgetLimits({ budgetLimits: { turnBudget: 1 } }, 'model');

    const turn = makeTurn(11);
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
    await loopService.hooks.onWillBeginStep.run({
      turnId: turn.id,
      step: 1,
      signal: turn.signal,
    });

    expect(goals.getGoal().goal).toMatchObject({
      status: 'active',
      turnsUsed: 1,
    });

    const afterStep: AfterStepContext = {
      turnId: turn.id,
      step: 1,
      signal: turn.signal,
      usage: zeroUsage,
      finishReason: 'completed',
      stopTurn: false,
    };
    await loopService.hooks.onDidFinishStep.run(afterStep);

    expect(afterStep.stopTurn).toBe(false);
    expect(goals.getGoal().goal?.status).toBe('active');

    endTurn(eventBus, turn);

    expect(goals.getGoal().goal).toMatchObject({
      status: 'blocked',
      turnsUsed: 1,
      terminalReason: 'Blocked after goal budget reached: turn budget 1',
    });
    expect(loopService.launches).toEqual([]);
  });

  it('completes on the final allowed continuation without applying the turn budget block', async () => {
    await goals.createGoal({ objective: 'finish the task' });
    await goals.setBudgetLimits({ budgetLimits: { turnBudget: 2 } }, 'model');

    const firstTurn = makeTurn(14);
    eventBus.publish({ type: 'turn.started', turnId: firstTurn.id, origin: USER_PROMPT_ORIGIN });
    await runGoalStep(loopService, firstTurn);
    endTurn(eventBus, firstTurn);

    await vi.waitFor(() => expect(loopService.launches).toHaveLength(1));
    const continuation = makeTurn(loopService.launches[0]!);
    eventBus.publish({
      type: 'turn.started',
      turnId: continuation.id,
      origin: { kind: 'system_trigger', name: 'goal_continuation' },
    });
    await loopService.hooks.onWillBeginStep.run({
      turnId: continuation.id,
      step: 1,
      signal: continuation.signal,
    });

    const completed = await goals.markComplete({ reason: 'done' }, 'model');
    endTurn(eventBus, continuation);

    expect(completed).toMatchObject({ status: 'complete', turnsUsed: 2 });
    expect(goals.getGoal().goal).toBeNull();
    expect(loopService.launches).toHaveLength(1);
  });

  it('requests a blocked outcome step when the final allowed turn blocks the goal', async () => {
    await goals.createGoal({ objective: 'finish the task' });
    await goals.setBudgetLimits({ budgetLimits: { turnBudget: 1 } }, 'model');

    const turn = makeTurn(15);
    eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: USER_PROMPT_ORIGIN });
    await loopService.hooks.onWillBeginStep.run({
      turnId: turn.id,
      step: 1,
      signal: turn.signal,
    });
    await goals.markBlocked({}, 'model');
    await runTerminalUpdateGoalResult(toolExecutor, turn, 'blocked', 'outcome prompt');

    const afterStep: AfterStepContext = {
      turnId: turn.id,
      step: 1,
      signal: turn.signal,
      usage: zeroUsage,
      finishReason: 'completed',
      stopTurn: false,
    };
    await loopService.hooks.onDidFinishStep.run(afterStep);

    expect(loopService.hasPendingRequests()).toBe(true);
    expect(goals.getGoal().goal).toMatchObject({ status: 'blocked', turnsUsed: 1 });
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

    await vi.waitFor(() => expect(goals.getGoal().goal?.status).toBe('blocked'));
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
      action: 'Only an active goal can be paused; resume a blocked goal with `/goal resume`.',
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
      action: 'Only paused or blocked goals can be resumed.',
    });
    expect(errorInfo('goal.unsupported_agent')).toEqual({
      title: 'Goals are unavailable for subagents',
      retryable: false,
      public: true,
      action: 'Run goal lifecycle commands on the main agent.',
    });
  });
});

describe('AgentGoalService agent eligibility', () => {
  let ctx: TestAgentContext;

  beforeEach(() => {
    ctx = createTestAgent(
      agentService(IAgentScopeContext, {
        _serviceBrand: undefined,
        agentId: 'sub-1',
        scope: (subKey?: string) =>
          subKey === undefined ? 'test/agents/sub-1' : `test/agents/sub-1/${subKey}`,
      }),
    );
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it.each([
    ['getGoal', (goals: IAgentGoalService) => goals.getGoal()],
    ['isGoalToolTarget', (goals: IAgentGoalService) => goals.isGoalToolTarget(1, 'goal-1')],
    ['createGoal', (goals: IAgentGoalService) => goals.createGoal({ objective: 'work' })],
    ['pauseGoal', (goals: IAgentGoalService) => goals.pauseGoal()],
    ['resumeGoal', (goals: IAgentGoalService) => goals.resumeGoal()],
    ['setBudgetLimits', (goals: IAgentGoalService) =>
      goals.setBudgetLimits({ budgetLimits: { turnBudget: 1 } })],
    ['cancelGoal', (goals: IAgentGoalService) => goals.cancelGoal()],
    ['markBlocked', (goals: IAgentGoalService) => goals.markBlocked()],
    ['markComplete', (goals: IAgentGoalService) => goals.markComplete()],
  ] as const)(
    '%s rejects direct goal service access when the agent is a subagent',
    async (_name, call) => {
      const goals = ctx.get(IAgentGoalService);
      await expect(Promise.resolve().then<unknown>(() => call(goals))).rejects.toMatchObject({
        code: 'goal.unsupported_agent',
        details: { agentId: 'sub-1' },
      });
    },
  );

  it.each([
    ['createGoal', () => ctx.rpc.createGoal({ objective: 'work' })],
    ['getGoal', () => ctx.rpc.getGoal({})],
    ['pauseGoal', () => ctx.rpc.pauseGoal({})],
    ['resumeGoal', () => ctx.rpc.resumeGoal({})],
    ['cancelGoal', () => ctx.rpc.cancelGoal({})],
  ] as const)(
    '%s rejects subagent goal RPC access with the stable goal error',
    async (_name, call) => {
      await expect(call()).rejects.toMatchObject({
        code: 'goal.unsupported_agent',
        details: { agentId: 'sub-1' },
      });
    },
  );

  it('does not continue a previously persisted goal when the agent is a subagent', async () => {
    await ctx.restore([
      { type: 'goal.create', goalId: 'legacy-subagent-goal', objective: 'work' },
    ]);
    ctx.mockNextResponse({ type: 'text', text: 'Handled as one normal subagent turn.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
    await ctx.untilTurnEnd();
    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.llmCalls).toHaveLength(1);
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

describe('AgentGoalService hard wall-clock deadline', () => {
  it('aborts an in-flight LLM request when the wall-clock budget expires', async () => {
    const clock = new ManualGoalDeadlineScheduler();
    const llm = blockingGenerate();
    const ctx = createTestAgent(appService(IGoalDeadlineScheduler, clock), {
      generate: llm.generate,
    });
    try {
      ctx.configure();
      await ctx.rpc.createGoal({ objective: 'finish bounded work' });
      await ctx
        .get(IAgentGoalService)
        .setBudgetLimits({ budgetLimits: { wallClockBudgetMs: 1_000 } }, 'user');

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start work' }] });
      await llm.started;
      clock.advanceBy(1_000);

      expect(llm.signal().aborted).toBe(true);
      const events = await ctx.untilTurnEnd();
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'turn.ended',
          args: expect.objectContaining({ reason: 'cancelled' }),
        }),
      );
      expect((await ctx.rpc.getGoal({})).goal).toMatchObject({
        status: 'blocked',
        wallClockMs: 1_000,
        budget: { wallClockBudgetReached: true },
        terminalReason: 'Blocked after goal budget reached: wall-clock budget 1000ms',
      });
    } finally {
      await ctx.dispose();
    }
  });

  it('aborts an in-flight tool execution when the wall-clock budget expires', async () => {
    const clock = new ManualGoalDeadlineScheduler();
    const toolStarted = deferred();
    let toolSignal: AbortSignal | undefined;
    const tool: ExecutableTool = {
      name: 'SlowWork',
      description: 'Wait for cancellation.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      resolveExecution: () => ({
        approvalRule: 'SlowWork',
        accesses: [],
        execute: async ({ signal }) => {
          toolSignal = signal;
          toolStarted.resolve();
          return waitForAbort(signal);
        },
      }),
    };
    const ctx = createTestAgent(
      appService(IGoalDeadlineScheduler, clock),
      permissionModeServices('yolo'),
    );
    try {
      ctx.get(IAgentToolRegistryService).register(tool);
      ctx.configure({ tools: ['SlowWork'] });
      await ctx.rpc.createGoal({ objective: 'finish bounded work' });
      await ctx
        .get(IAgentGoalService)
        .setBudgetLimits({ budgetLimits: { wallClockBudgetMs: 1_000 } }, 'user');
      ctx.mockNextResponse({
        type: 'function',
        id: 'slow_work',
        name: 'SlowWork',
        arguments: '{}',
      });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start work' }] });
      await toolStarted.promise;
      clock.advanceBy(1_000);

      expect(toolSignal?.aborted).toBe(true);
      const events = await ctx.untilTurnEnd();
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'turn.ended',
          args: expect.objectContaining({ reason: 'cancelled' }),
        }),
      );
      expect((await ctx.rpc.getGoal({})).goal).toMatchObject({
        status: 'blocked',
        budget: { wallClockBudgetReached: true },
      });
    } finally {
      await ctx.dispose();
    }
  });

  it('keeps user cancellation authoritative when it precedes the wall-clock deadline', async () => {
    const clock = new ManualGoalDeadlineScheduler();
    const llm = blockingGenerate();
    const ctx = createTestAgent(appService(IGoalDeadlineScheduler, clock), {
      generate: llm.generate,
    });
    try {
      ctx.configure();
      await ctx.rpc.createGoal({ objective: 'finish bounded work' });
      await ctx
        .get(IAgentGoalService)
        .setBudgetLimits({ budgetLimits: { wallClockBudgetMs: 1_000 } }, 'user');
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start work' }] });
      await llm.started;

      await ctx.rpc.cancelGoal({});
      expect(llm.signal()).toMatchObject({
        aborted: true,
        reason: expect.objectContaining({ userCancelled: true }),
      });
      clock.advanceBy(1_000);

      await ctx.untilTurnEnd();
      expect((await ctx.rpc.getGoal({})).goal).toBeNull();
    } finally {
      await ctx.dispose();
    }
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

  it('lets an automatic continuation report final status after crossing its token budget', async () => {
    const ctx = createTestAgent();
    try {
      ctx.configure({ tools: ['GetGoal'] });
      const goals = ctx.get(IAgentGoalService);
      await goals.createGoal({ objective: 'work' });
      await goals.markBlocked({ reason: 'ready for a fresh continuation' });
      await goals.setBudgetLimits({ budgetLimits: { tokenBudget: 1 } }, 'model');

      ctx.mockNextResponse({
        type: 'function',
        id: 'g1',
        name: 'GetGoal',
        arguments: JSON.stringify({}),
      });
      ctx.mockNextResponse({ type: 'text', text: 'Final status: budget exhausted.' });
      ctx.mockNextResponse({ type: 'text', text: 'This step should never run.' });

      const turnEnd = ctx.untilTurnEnd();
      await goals.resumeGoal({ continueIfBlocked: true });
      const events = await turnEnd;

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
          args: expect.objectContaining({ reason: 'cancelled' }),
        }),
      );

      const history = ctx.get(IAgentContextMemoryService).get();
      expect(JSON.stringify(history)).toContain('Final status: budget exhausted.');
      expect(JSON.stringify(history)).not.toContain('This step should never run.');
      expect(goals.getGoal().goal).toMatchObject({
        status: 'blocked',
        budget: { tokenBudgetReached: true },
      });
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

  it('rejects goal tool calls when an exhausted turn budget is resumed during a prompt', async () => {
    const ctx = createTestAgent();
    try {
      ctx.configure({ tools: ['UpdateGoal', 'SetGoalBudget'] });
      const goals = ctx.get(IAgentGoalService) as GoalServiceTestManager;
      await goals.createGoal({ objective: 'work' });
      await goals.setBudgetLimits({ budgetLimits: { turnBudget: 1 } }, 'model');
      await goals.incrementTurn();
      await goals.setBudgetLimits({ budgetLimits: { turnBudget: 1 } }, 'model');

      ctx.mockNextResponse({
        type: 'function',
        id: 'resume',
        name: 'UpdateGoal',
        arguments: JSON.stringify({ status: 'active' }),
      });
      ctx.mockNextResponse({
        type: 'function',
        id: 'raise-budget',
        name: 'SetGoalBudget',
        arguments: JSON.stringify({ value: 5, unit: 'turns' }),
      });
      ctx.mockNextResponse({ type: 'text', text: 'This step should never run.' });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'resume the goal' }] });
      await ctx.untilTurnEnd();

      expect(ctx.llmCalls).toHaveLength(2);
      const history = ctx.get(IAgentContextMemoryService).get();
      expect(JSON.stringify(history)).toContain(
        'Goal budget exhausted; tool calls are rejected. Write your final message.',
      );
      expect(JSON.stringify(history)).not.toContain('This step should never run.');
      await vi.waitFor(() => expect(goals.getGoal().goal?.status).toBe('blocked'));
      expect(goals.getGoal().goal?.budget.turnBudget).toBe(1);
    } finally {
      await ctx.dispose();
    }
  });

  it("runs the prompt as a normal turn when the goal's turn budget was reached at launch", async () => {
    const telemetry: TelemetryRecord[] = [];
    const ctx = createTestAgent(telemetryServices(recordingTelemetry(telemetry)));
    try {
      ctx.configure();
      const goals = ctx.get(IAgentGoalService) as GoalServiceTestManager;
      await goals.createGoal({ objective: 'work' });
      await goals.setBudgetLimits({ budgetLimits: { turnBudget: 1 } }, 'model');
      await goals.incrementTurn();
      expect(goals.getGoal().goal?.status).toBe('active');
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
  it('lets an automatic continuation explain the blocker after UpdateGoal blocks the goal', async () => {
    const ctx = createTestAgent();
    try {
      ctx.configure({ tools: ['UpdateGoal'] });
      const goals = ctx.get(IAgentGoalService);
      await goals.createGoal({ objective: 'work' });
      await goals.markBlocked({ reason: 'ready for a fresh continuation' });

      ctx.mockNextResponse({
        type: 'function',
        id: 'blocked',
        name: 'UpdateGoal',
        arguments: JSON.stringify({ status: 'blocked' }),
      });
      ctx.mockNextResponse({ type: 'text', text: 'Blocked because credentials are unavailable.' });

      const turnEnd = ctx.untilTurnEnd();
      await goals.resumeGoal({ continueIfBlocked: true });
      const events = await turnEnd;

      expect(ctx.llmCalls).toHaveLength(2);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'turn.ended',
          args: expect.objectContaining({ reason: 'completed' }),
        }),
      );
      const history = ctx.get(IAgentContextMemoryService).get();
      expect(JSON.stringify(history)).toContain('Blocked because credentials are unavailable.');
      expect(history.at(-1)?.role).toBe('assistant');
      expect(goals.getGoal().goal?.status).toBe('blocked');
    } finally {
      await ctx.dispose();
    }
  });

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
