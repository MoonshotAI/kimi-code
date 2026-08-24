import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import {
  CompactionCancelled,
  CompactionCompleted,
  CompactionStarted,
} from '#/agent/fullCompaction/compactionOps';
import type { CompactionResult } from '#/agent/fullCompaction/types';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { AgentGoal, GoalRuntime } from '#/features/goal/goalAgentRuntime';
import { GoalUpdated } from '#/features/goal/goalOps';
import {
  type EnqueueReceipt,
  type Step,
  type Turn,
} from '#/agent/loop/loop';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IEventBus } from '#/app/event/eventBus';
import { toKimiErrorPayload } from '#/errors';

import {
  agentService,
  createTestAgent as createHarnessTestAgent,
  permissionModeServices,
  type TestAgentContext,
} from '../../harness';
import { stubLoopWithHooks, makeTurn, type StubLoop } from '../../agent/loop/stubs';

const GOAL_COMPACTION_PAUSE_REASON =
  'Paused due to context compaction; will resume after compaction completes';

const COMPACTION_RESULT: CompactionResult = {
  summary: 'Compacted summary.',
  compactedCount: 4,
  tokensBefore: 1000,
  tokensAfter: 120,
};

type TurnEndedInput = {
  readonly reason: TurnEnded['reason'];
  readonly error?: unknown;
};

const COMPLETED_TURN_END: TurnEndedInput = { reason: 'completed' };

function endTurn(eventBus: IEventBus, turn: Turn, result: TurnEndedInput = COMPLETED_TURN_END): void {
  const error = result.error !== undefined ? toKimiErrorPayload(result.error) : undefined;
  eventBus.publish(
    new TurnEnded({ agentId: 'main', turnId: turn.id, reason: result.reason, error, durationMs: 0 }),
  );
}

describe('AgentGoalService compaction awareness', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let goals: GoalRuntime;
  let loopService: StubLoop;
  let eventBus: IEventBus;
  let updates: GoalUpdated[];

  beforeEach(async () => {
    loopService = stubLoopWithHooks();
    ctx = createHarnessTestAgent(agentService(IAgentLoopService, loopService), permissionModeServices('auto'));
    await ctx.restoreRuntimes();
    context = ctx.get(IAgentContextMemoryService);
    goals = ctx.resolve(AgentGoal);
    eventBus = ctx.get(IEventBus);
    updates = [];
    eventBus.subscribe(GoalUpdated, (event) => updates.push(event));
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  async function startLiveContinuation(): Promise<{
    readonly turn: Turn;
    readonly abort: ReturnType<typeof vi.fn<() => boolean>>;
    readonly enqueue: ReturnType<typeof vi.spyOn>;
  }> {
    const abort = vi.fn<() => boolean>(() => true);
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
    const enqueue = vi.spyOn(loopService, 'enqueue').mockReturnValue(receipt);

    await goals.createGoal({ objective: 'finish the task' });
    await goals.markBlocked({ reason: 'need credentials' });
    await goals.resumeGoal({ continueIfBlocked: true });
    await Promise.resolve();
    eventBus.publish(new TurnStarted({ agentId: 'main', turnId: turn.id, origin: { kind: 'user' } }));
    expect(goals.getGoal().goal?.status).toBe('active');
    return { turn, abort, enqueue };
  }

  function beginAutoCompaction(): void {
    eventBus.publish(new CompactionStarted({ agentId: 'main', trigger: 'auto' }));
  }

  function completeCompaction(): void {
    eventBus.publish(new CompactionCompleted({ agentId: 'main', result: COMPACTION_RESULT }));
  }

  function cancelCompaction(): void {
    eventBus.publish(new CompactionCancelled({ agentId: 'main' }));
  }

  it('parks an active goal for an auto compaction without aborting the live continuation', async () => {
    const { abort } = await startLiveContinuation();

    beginAutoCompaction();

    const goal = goals.getGoal().goal;
    expect(goal?.status).toBe('paused');
    expect(goal?.terminalReason).toBe(GOAL_COMPACTION_PAUSE_REASON);
    expect(abort).not.toHaveBeenCalled();
    expect(updates.at(-1)?.change).toMatchObject({
      kind: 'lifecycle',
      status: 'paused',
      reason: GOAL_COMPACTION_PAUSE_REASON,
      actor: 'runtime',
    });
  });

  it('does not launch another continuation while parked for compaction', async () => {
    const { turn, enqueue } = await startLiveContinuation();

    beginAutoCompaction();
    endTurn(eventBus, turn);

    await vi.waitFor(() => {
      expect(goals.getGoal().goal?.status).toBe('paused');
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('resumes a parked goal and continues pursuit after the compaction completes', async () => {
    const { turn, enqueue } = await startLiveContinuation();

    beginAutoCompaction();
    endTurn(eventBus, turn);
    await vi.waitFor(() => {
      expect(goals.getGoal().goal?.status).toBe('paused');
    });
    enqueue.mockRestore();

    completeCompaction();

    expect(goals.getGoal().goal?.status).toBe('active');
    expect(goals.getGoal().goal?.terminalReason).toBeUndefined();
    await vi.waitFor(() => {
      expect(loopService.launches).toHaveLength(1);
    });
    expect(loopService.drainNextBatch(context)).toBeDefined();
    expect(context.get().at(-1)?.origin).toEqual({
      kind: 'system_trigger',
      name: 'goal_continuation',
    });
    expect(updates.at(-1)?.change).toMatchObject({ kind: 'lifecycle', status: 'active' });
  });

  it('resumes a parked goal whose live turn is still running once compaction completes', async () => {
    const { turn, enqueue } = await startLiveContinuation();

    beginAutoCompaction();
    expect(goals.getGoal().goal?.status).toBe('paused');

    completeCompaction();
    expect(goals.getGoal().goal?.status).toBe('active');

    enqueue.mockRestore();
    endTurn(eventBus, turn);
    await vi.waitFor(() => {
      expect(loopService.launches).toHaveLength(1);
    });
  });

  it('keeps a parked goal paused when the compaction is cancelled, then resumes on a later success', async () => {
    const { turn, enqueue } = await startLiveContinuation();

    beginAutoCompaction();
    endTurn(eventBus, turn);
    await vi.waitFor(() => {
      expect(goals.getGoal().goal?.status).toBe('paused');
    });

    cancelCompaction();
    expect(goals.getGoal().goal?.status).toBe('paused');
    expect(goals.getGoal().goal?.terminalReason).toBe(GOAL_COMPACTION_PAUSE_REASON);

    enqueue.mockRestore();
    completeCompaction();
    expect(goals.getGoal().goal?.status).toBe('active');
    await vi.waitFor(() => {
      expect(loopService.launches).toHaveLength(1);
    });
  });

  it('keeps the parked reason when the preserved turn is interrupted mid-compaction', async () => {
    const { turn, abort } = await startLiveContinuation();

    beginAutoCompaction();
    endTurn(eventBus, turn, { reason: 'cancelled', error: new Error('user cancelled') });

    await vi.waitFor(() => {
      expect(goals.getGoal().goal?.status).toBe('paused');
    });
    expect(goals.getGoal().goal?.terminalReason).toBe(GOAL_COMPACTION_PAUSE_REASON);
    expect(abort).not.toHaveBeenCalled();
  });

  it('ignores manual compaction for goal parking', async () => {
    await startLiveContinuation();

    eventBus.publish(new CompactionStarted({ agentId: 'main', trigger: 'manual' }));

    expect(goals.getGoal().goal?.status).toBe('active');
    completeCompaction();
    expect(goals.getGoal().goal?.status).toBe('active');
  });

  it('does not resume a goal the user paused on their own', async () => {
    await goals.createGoal({ objective: 'finish the task' });
    await goals.pauseGoal({ reason: 'Paused by the user' });

    beginAutoCompaction();
    completeCompaction();

    expect(goals.getGoal().goal?.status).toBe('paused');
    expect(goals.getGoal().goal?.terminalReason).toBe('Paused by the user');
  });

  it('does not churn a goal the user resumed during the compaction', async () => {
    const { enqueue } = await startLiveContinuation();

    beginAutoCompaction();
    expect(goals.getGoal().goal?.status).toBe('paused');

    await goals.resumeGoal();
    expect(goals.getGoal().goal?.status).toBe('active');

    completeCompaction();
    expect(goals.getGoal().goal?.status).toBe('active');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
