/**
 * `goal` domain (L4) — wire Model (`GoalModel`) and the `goal.create`
 * (`createGoal`) / `goal.update` (`updateGoal`) / `goal.clear` (`clearGoal`)
 * Ops for the per-agent goal lifecycle.
 *
 * Declares the current goal as `GoalState | null` (initial `null`); `GoalState`
 * holds the persistent, replayable fields — identity, objective, status,
 * `turnsUsed` / `tokensUsed`, the accumulated `wallClockMs`, `budgetLimits`,
 * and `terminalReason`. The non-deterministic bits stay OUT of `apply`:
 * `goalId` is minted at the call site and carried in the `goal.create` payload;
 * the `wallClockMs` `Date.now()` accumulation is computed by the live service
 * when leaving `active` and carried in the `goal.update` payload; and
 * `wallClockResumedAt` is a live-only service field (never persisted, reset on
 * replay). Each `apply` returns the same reference when nothing changes so the
 * wire's reference-equality gate stays quiet. The `goal.updated` fact is
 * published live to `IEventBus` by the service (declared here via
 * interface-merge); `wire.replay` rebuilds the Model silently and the
 * service's `wire.onRestored`
 * forces a replayed `active` goal back to `paused`. Consumed by the Agent-scope
 * `goalService`.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

import type {
  GoalActor,
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
  readonly budgetLimits: GoalBudgetLimits;
  readonly terminalReason?: string;
}

export type GoalModelState = GoalState | null;

export const GoalModel = defineModel<GoalModelState>('goal', () => null);

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
  schema: z.object({
    goalId: z.string(),
    objective: z.string(),
    completionCriterion: z.string().optional(),
  }),
  apply: (_s, p) => ({
    goalId: p.goalId,
    objective: p.objective,
    completionCriterion: p.completionCriterion,
    status: 'active',
    turnsUsed: 0,
    tokensUsed: 0,
    wallClockMs: 0,
    budgetLimits: {},
  }),
});

export const updateGoal = GoalModel.defineOp('goal.update', {
  schema: z.object({
    status: z.custom<GoalStatus>().optional(),
    reason: z.string().optional(),
    turnsUsed: z.number().optional(),
    tokensUsed: z.number().optional(),
    wallClockMs: z.number().optional(),
    budgetLimits: z.custom<GoalBudgetLimits>().optional(),
    actor: z.custom<GoalActor>().optional(),
  }),
  apply: (s, p) => {
    if (s === null) return null;
    let next: GoalState | undefined;
    if (p.status !== undefined && p.status !== s.status) {
      next = {
        ...(next ?? s),
        status: p.status,
        terminalReason: p.status === 'active' ? undefined : p.reason,
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
