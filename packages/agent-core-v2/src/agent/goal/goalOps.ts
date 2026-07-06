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
 * wire's reference-equality gate stays quiet. The `goal.updated` signal is
 * emitted live through `wire.signal` (declared here via interface-merge);
 * `wire.replay` rebuilds the Model silently and the service's `wire.onRestored`
 * forces a replayed `active` goal back to `paused`. Consumed by the Agent-scope
 * `goalService`.
 */

import { defineModel, defineOp } from '#/wire';

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

declare module '#/wire' {
  interface SignalMap {
    'goal.updated': {
      snapshot: GoalSnapshot | null;
      change?: GoalChange;
    };
  }
}

export interface GoalCreatePayload {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
}

export const createGoal = defineOp(GoalModel, 'goal.create', {
  apply: (_s, p: GoalCreatePayload): GoalModelState => ({
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

export interface GoalUpdatePayload {
  readonly status?: GoalStatus;
  readonly reason?: string;
  readonly turnsUsed?: number;
  readonly tokensUsed?: number;
  readonly wallClockMs?: number;
  readonly budgetLimits?: GoalBudgetLimits;
  readonly actor?: GoalActor;
}

export const updateGoal = defineOp(GoalModel, 'goal.update', {
  apply: (s, p: GoalUpdatePayload): GoalModelState => {
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

export const clearGoal = defineOp(GoalModel, 'goal.clear', {
  apply: (): GoalModelState => null,
});

export const forkGoal = defineOp(GoalModel, 'forked', {
  apply: (): GoalModelState => null,
});
