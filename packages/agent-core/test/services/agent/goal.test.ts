import { describe, expect, it } from 'vitest';

import { ErrorCodes } from '../../../src/errors';
import {
  IEventBus,
  IGoalService,
  InMemoryWireRecordPersistence,
  IReplayBuilderService,
  type GoalService,
  type PersistedWireRecord,
  type WireRecord,
} from '../../../src/services/agent';
import { recordingTelemetry, type TelemetryRecord } from '../../fixtures/telemetry';
import { testAgent } from './harness';

type GoalServiceTestManager = IGoalService & GoalService;
type GoalRecord = Extract<PersistedWireRecord, { type: `goal.${string}` }>;
type AgentEvent = Parameters<IEventBus['emit']>[0];
type GoalUpdatedEvent = Extract<AgentEvent, { type: 'goal.updated' }>;
type GoalSnapshot = NonNullable<ReturnType<IGoalService['getGoal']>['goal']>;
type GoalChange = GoalUpdatedEvent['change'];

function makeGoalService() {
  const persistence = new InMemoryWireRecordPersistence();
  const events: Array<{ readonly type: string; readonly snapshot?: GoalSnapshot | null; readonly change?: GoalChange }> = [];
  const telemetry: TelemetryRecord[] = [];
  const ctx = testAgent({
    persistence,
    telemetry: recordingTelemetry(telemetry),
  });
  ctx.configure();
  ctx.events.on((event) => {
    if (event.type === 'goal.updated') events.push(event);
  });

  return {
    ctx,
    goals: ctx.get(IGoalService) as GoalServiceTestManager,
    records: persistence.records,
    replay: () => ctx.get(IReplayBuilderService).buildResult(),
    events,
    telemetry,
  };
}

function goalRecords(records: readonly PersistedWireRecord[]): readonly GoalRecord[] {
  return records.filter((record): record is GoalRecord => record.type.startsWith('goal.'));
}

async function restoreGoalRecords(
  ctx: ReturnType<typeof testAgent>,
  records: readonly WireRecord[],
): Promise<void> {
  ctx.get(IGoalService).getGoal();
  await ctx.runtime.restore(records);
}

describe('GoalService creation', () => {
  it('creates a goal and exposes it through getGoal', async () => {
    const { goals } = makeGoalService();

    const snapshot = await goals.createGoal({ objective: 'Ship feature X' });

    expect(snapshot.objective).toBe('Ship feature X');
    expect(snapshot.status).toBe('active');
    expect(goals.getGoal().goal?.goalId).toBe(snapshot.goalId);
  });

  it('stores a completion criterion when provided', async () => {
    const { goals } = makeGoalService();

    const snapshot = await goals.createGoal({
      objective: 'Ship feature X',
      completionCriterion: ' tests pass ',
    });

    expect(snapshot.completionCriterion).toBe('tests pass');
    expect(goals.getGoal().goal?.completionCriterion).toBe('tests pass');
  });

  it('sets no default work caps when none is provided', async () => {
    const { goals } = makeGoalService();

    const snapshot = await goals.createGoal({ objective: 'Do work' });

    expect(snapshot.budget.turnBudget).toBeNull();
    expect(snapshot.budget.tokenBudget).toBeNull();
    expect(snapshot.budget.wallClockBudgetMs).toBeNull();
    expect(snapshot.budget.overBudget).toBe(false);
  });

  it('rejects empty and too-long objectives', async () => {
    const { goals } = makeGoalService();

    await expect(goals.createGoal({ objective: '   ' })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_OBJECTIVE_EMPTY,
    });
    await expect(goals.createGoal({ objective: 'x'.repeat(4001) })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
    });
  });

  it('rejects duplicate active, paused, and blocked goals without replace', async () => {
    const { goals } = makeGoalService();

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
    const { goals, records } = makeGoalService();

    const first = await goals.createGoal({ objective: 'first' });
    const second = await goals.createGoal({ objective: 'second', replace: true });

    expect(second.goalId).not.toBe(first.goalId);
    expect(goals.getGoal().goal?.objective).toBe('second');
    expect(goalRecords(records).map((record) => record.type)).toEqual([
      'goal.create',
      'goal.clear',
      'goal.create',
    ]);
  });
});

describe('GoalService lifecycle', () => {
  it('emits typed lifecycle and completion changes', async () => {
    const { goals, events } = makeGoalService();

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
    const { goals } = makeGoalService();

    await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });
    const blocked = await goals.markBlocked({ reason: 'need creds' });
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.terminalReason).toBe('need creds');

    const resumed = await goals.resumeGoal();
    expect(resumed.status).toBe('active');
    expect(resumed.terminalReason).toBeUndefined();
  });

  it('pauseOnInterrupt parks active goals and no-ops for stopped goals', async () => {
    const { goals } = makeGoalService();

    await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });
    const paused = await goals.pauseOnInterrupt({ reason: 'Paused after interruption' });
    expect(paused?.status).toBe('paused');
    expect(paused?.terminalReason).toBe('Paused after interruption');

    expect(await goals.pauseOnInterrupt({ reason: 'again' })).toBeNull();
    expect(goals.getGoal().goal?.status).toBe('paused');
  });

  it('cancelGoal discards the goal and throws when missing', async () => {
    const { ctx, goals } = makeGoalService();

    await goals.createGoal({ objective: 'work' });
    const removed = await goals.cancelGoal();
    expect(removed.status).toBe('active');
    expect(goals.getGoal()).toEqual({ goal: null });
    const reminder = ctx.context.getHistory().at(-1);
    expect(reminder?.origin).toEqual({ kind: 'system_trigger', name: 'goal_cancelled' });
    expect(JSON.stringify(reminder?.content)).toContain('Ignore earlier active-goal reminders');
    await expect(goals.cancelGoal()).rejects.toMatchObject({ code: ErrorCodes.GOAL_NOT_FOUND });
  });
});

describe('GoalService accounting and budgets', () => {
  it('counts tokens and turns only while active', async () => {
    const { goals } = makeGoalService();

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
    const { goals } = makeGoalService();

    await goals.createGoal({ objective: 'work' });
    const snapshot = await goals.setBudgetLimits({
      budgetLimits: { tokenBudget: 100, turnBudget: 2, wallClockBudgetMs: 1000 },
    }, 'model');

    expect(snapshot.budget.tokenBudget).toBe(100);
    expect(snapshot.budget.turnBudget).toBe(2);
    expect(snapshot.budget.wallClockBudgetMs).toBe(1000);
  });

  it('tracks telemetry without goal text', async () => {
    const { goals, telemetry } = makeGoalService();

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

describe('GoalService records', () => {
  it('records only replay-relevant create/update/clear fields', async () => {
    const { goals, records } = makeGoalService();

    await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });
    await goals.recordTokenUsage(5);
    await goals.incrementTurn();
    await goals.setBudgetLimits({ budgetLimits: { turnBudget: 2 } }, 'model');
    await goals.markBlocked({ reason: 'stuck' });
    await goals.cancelGoal();

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
    const { ctx, goals } = makeGoalService();

    await restoreGoalRecords(ctx, [
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

  it('projects restored goal status changes into replay records', async () => {
    const { ctx, replay } = makeGoalService();

    await restoreGoalRecords(ctx, [
      {
        type: 'goal.create',
        goalId: 'g1',
        objective: 'work',
        completionCriterion: 'tests pass',
        time: Date.parse('2026-01-01T00:00:00.000Z'),
      },
      { type: 'goal.update', tokensUsed: 5 },
      { type: 'goal.update', turnsUsed: 1 },
      {
        type: 'goal.update',
        status: 'paused',
        reason: 'break',
        actor: 'runtime',
      },
      { type: 'goal.update', status: 'active', actor: 'user' },
      {
        type: 'goal.update',
        status: 'complete',
        reason: 'done',
        actor: 'model',
      },
    ]);

    expect(replay()).toEqual([
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({ objective: 'work', status: 'active' }),
        change: { kind: 'created' },
      }),
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({ status: 'paused', terminalReason: 'break' }),
        change: { kind: 'lifecycle', status: 'paused', reason: 'break', actor: 'runtime' },
      }),
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({ status: 'active' }),
        change: { kind: 'lifecycle', status: 'active', reason: undefined, actor: 'user' },
      }),
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({
          status: 'complete',
          terminalReason: 'done',
          turnsUsed: 1,
          tokensUsed: 5,
        }),
        change: {
          kind: 'completion',
          status: 'complete',
          reason: 'done',
          stats: { turnsUsed: 1, tokensUsed: 5, wallClockMs: 0 },
          actor: 'model',
        },
      }),
    ]);
  });

  it('keeps resume-normalization pauses in core replay records', async () => {
    const { ctx, replay } = makeGoalService();

    await restoreGoalRecords(ctx, [
      {
        type: 'goal.create',
        goalId: 'g1',
        objective: 'work',
        time: Date.parse('2026-01-01T00:00:00.000Z'),
      },
      {
        type: 'goal.update',
        status: 'paused',
        reason: 'Paused after agent resume',
      },
    ]);

    expect(replay().at(-1)).toMatchObject({
      type: 'goal_updated',
      snapshot: { status: 'paused', terminalReason: 'Paused after agent resume' },
      change: {
        kind: 'lifecycle',
        status: 'paused',
        reason: 'Paused after agent resume',
        actor: undefined,
      },
    });
  });

  it('normalizes active replayed goals to paused', async () => {
    const { ctx, goals, records } = makeGoalService();

    records.length = 0;
    await restoreGoalRecords(ctx, [
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
