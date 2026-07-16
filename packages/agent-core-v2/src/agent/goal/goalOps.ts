/**
 * `goal` domain (L4) — wire Model (`GoalModel`) and the `goal.create`
 * (`createGoal`) / `goal.update` (`updateGoal`) / `goal.clear` (`clearGoal`)
 * Ops for the per-agent goal lifecycle.
 *
 * Declares the current goal as `GoalState | null` (initial `null`); `GoalState`
 * holds the persistent, replayable fields — identity, objective, status,
 * `turnsUsed` / `tokensUsed`, the accumulated `wallClockMs`, the current
 * active interval's epoch-ms `wallClockResumedAt`, `budgetLimits`, and
 * `terminalReason`. The persistence contract charges an active interval from
 * its persisted create/resume anchor through the first recovery clock read,
 * then folds that interval into `wallClockMs` while recovery pauses the goal.
 * This intentionally includes unobservable crash downtime: a monotonic clock
 * cannot span processes, while learning the crash instant would require
 * periodic durable writes. System-clock rollback is clamped to zero. The
 * 1.4 -> 1.5 compatibility transform (also applied before sealing
 * envelope-less logs) derives missing create/resume/checkpoint anchors from
 * those records' existing epoch-ms `time` stamps. The
 * non-deterministic values stay OUT of `apply`: `goalId` and the wall-clock
 * anchor/totals are computed by the live service and carried in Op payloads.
 * Each `apply` returns the same reference when nothing changes so the wire's
 * reference-equality gate stays quiet. The `goal.updated` fact is
 * published live to `IEventBus` by the service (declared here via
 * interface-merge); `wire.restore` rebuilds the Model silently and the
 * service's `wire.hooks.onDidRestore`
 * forces a replayed `active` goal back to `paused`. Consumed by the Agent-scope
 * `goalService`.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

import type {
  GoalBudgetLimits,
  GoalChange,
  GoalSnapshot,
  GoalStatus,
} from './types';

export interface GoalState {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: GoalStatus;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly wallClockResumedAt?: number;
  readonly budgetLimits: GoalBudgetLimits;
  readonly terminalReason?: string;
}

export type GoalModelState = GoalState | null;

export const GoalModel = defineModel<GoalModelState>('goal', () => null);

const GoalStatusSchema = z.enum(['active', 'paused', 'blocked', 'complete']);

const GoalActorSchema = z.enum(['user', 'model', 'runtime', 'system']);

const GoalBudgetLimitsSchema = z
  .object({
    tokenBudget: z.number().finite().nonnegative().optional(),
    turnBudget: z.number().finite().nonnegative().optional(),
    wallClockBudgetMs: z.number().finite().nonnegative().optional(),
  })
  .strict();

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'goal.updated': {
      snapshot: GoalSnapshot | null;
      change?: GoalChange;
    };
  }
}

declare module '#/wire/types' {
  interface PersistedOpMap {
    'goal.create': typeof createGoal;
    'goal.update': typeof updateGoal;
    'goal.clear': typeof clearGoal;
    forked: typeof forkGoal;
  }
}

export const createGoal = GoalModel.defineOp('goal.create', {
  schema: z
    .object({
      goalId: z.string(),
      objective: z.string(),
      completionCriterion: z.string().optional(),
      wallClockResumedAt: z.number().finite().nonnegative().optional(),
      status: GoalStatusSchema.optional(),
      actor: GoalActorSchema.optional(),
      budgetLimits: GoalBudgetLimitsSchema.optional(),
    })
    .strip(),
  apply: (_s, p) => ({
    goalId: p.goalId,
    objective: p.objective,
    completionCriterion: p.completionCriterion,
    status: 'active',
    turnsUsed: 0,
    tokensUsed: 0,
    wallClockMs: 0,
    wallClockResumedAt: p.wallClockResumedAt,
    budgetLimits: {},
  }),
});

export const updateGoal = GoalModel.defineOp('goal.update', {
  schema: z
    .object({
      goalId: z.string().optional(),
      status: GoalStatusSchema.optional(),
      reason: z.string().optional(),
      turnsUsed: z.number().finite().nonnegative().optional(),
      tokensUsed: z.number().finite().nonnegative().optional(),
      wallClockMs: z.number().finite().nonnegative().optional(),
      wallClockResumedAt: z.number().finite().nonnegative().optional(),
      budgetLimits: GoalBudgetLimitsSchema.optional(),
      actor: GoalActorSchema.optional(),
    })
    .strip(),
  apply: (s, p) => {
    if (s === null) return null;
    let next: GoalState | undefined;
    if (p.status !== undefined && p.status !== s.status) {
      next = {
        ...(next ?? s),
        status: p.status,
        terminalReason: p.status === 'active' ? undefined : p.reason,
        wallClockResumedAt:
          p.status === 'active' ? p.wallClockResumedAt : undefined,
      };
    }
    if (p.turnsUsed !== undefined && p.turnsUsed !== s.turnsUsed) {
      next = { ...(next ?? s), turnsUsed: p.turnsUsed };
    }
    if (p.tokensUsed !== undefined && p.tokensUsed !== s.tokensUsed) {
      next = { ...(next ?? s), tokensUsed: p.tokensUsed };
    }
    if (p.wallClockMs !== undefined && p.wallClockMs !== s.wallClockMs) {
      next = { ...(next ?? s), wallClockMs: p.wallClockMs };
    }
    if (
      p.wallClockResumedAt !== undefined &&
      (p.status ?? s.status) === 'active' &&
      p.wallClockResumedAt !== s.wallClockResumedAt
    ) {
      next = { ...(next ?? s), wallClockResumedAt: p.wallClockResumedAt };
    }
    if (p.budgetLimits !== undefined && p.budgetLimits !== s.budgetLimits) {
      next = { ...(next ?? s), budgetLimits: p.budgetLimits };
    }
    return next ?? s;
  },
});

export const clearGoal = GoalModel.defineOp('goal.clear', {
  schema: z.object({}),
  apply: () => null,
});

export const forkGoal = GoalModel.defineOp('forked', {
  schema: z.object({}),
  apply: () => null,
});
