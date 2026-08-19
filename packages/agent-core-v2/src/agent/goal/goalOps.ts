/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

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

const GoalStatusSchema = z.enum(['active', 'paused', 'blocked', 'complete']);

const GoalActorSchema = z.enum(['user', 'model', 'runtime', 'system']);

const GoalBudgetLimitsSchema = z
  .object({
    tokenBudget: z.number().finite().nonnegative().optional(),
    turnBudget: z.number().finite().nonnegative().optional(),
    wallClockBudgetMs: z.number().finite().nonnegative().optional(),
  })
  .strict();

const goalCreateSchema = z
  .object({
    goalId: z.string(),
    objective: z.string(),
    completionCriterion: z.string().optional(),
    wallClockResumedAt: z.number().finite().nonnegative().optional(),
    status: GoalStatusSchema.optional(),
    actor: GoalActorSchema.optional(),
    budgetLimits: GoalBudgetLimitsSchema.optional(),
  })
  .strip();

export class GoalCreate extends Event2<z.infer<typeof goalCreateSchema>> {
  static override readonly type = 'goal.create';
  static override readonly durable = true;
  static override readonly schema = goalCreateSchema;
}
export interface GoalCreate extends z.infer<typeof goalCreateSchema> {}

const goalUpdateSchema = z
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
  .strip();

export class GoalUpdate extends Event2<z.infer<typeof goalUpdateSchema>> {
  static override readonly type = 'goal.update';
  static override readonly durable = true;
  static override readonly schema = goalUpdateSchema;
}
export interface GoalUpdate extends z.infer<typeof goalUpdateSchema> {}

const goalClearSchema = z.object({});

export class GoalClear extends Event2<z.infer<typeof goalClearSchema>> {
  static override readonly type = 'goal.clear';
  static override readonly durable = true;
  static override readonly schema = goalClearSchema;
}
export interface GoalClear extends z.infer<typeof goalClearSchema> {}

const goalForkedSchema = z.object({});

export class GoalForked extends Event2<z.infer<typeof goalForkedSchema>> {
  static override readonly type = 'forked';
  static override readonly durable = true;
  static override readonly schema = goalForkedSchema;
}
export interface GoalForked extends z.infer<typeof goalForkedSchema> {}

export interface GoalUpdatedPayload {
  snapshot: GoalSnapshot | null;
  change?: GoalChange;
}

export class GoalUpdated extends Event2<GoalUpdatedPayload> {
  static override readonly type = 'goal.updated';
  static override readonly observable = true;
}
export interface GoalUpdated extends GoalUpdatedPayload {}

export const goalKey = defineState('goal', (): GoalModelState => null).replayable({
  schema: z.custom<GoalModelState>(),
})
  .on(GoalCreate, (_s, e) => ({
    goalId: e.goalId,
    objective: e.objective,
    completionCriterion: e.completionCriterion,
    status: 'active' as const,
    turnsUsed: 0,
    tokensUsed: 0,
    wallClockMs: 0,
    wallClockResumedAt: e.wallClockResumedAt,
    budgetLimits: {},
  }))
  .on(GoalUpdate, (s, e) => {
    if (s === null) return;
    if (e.status !== undefined && e.status !== s.status) {
      s.status = e.status;
      s.terminalReason = e.status === 'active' ? undefined : e.reason;
      s.wallClockResumedAt = e.status === 'active' ? e.wallClockResumedAt : undefined;
    }
    if (e.turnsUsed !== undefined && e.turnsUsed !== s.turnsUsed) {
      s.turnsUsed = e.turnsUsed;
    }
    if (e.tokensUsed !== undefined && e.tokensUsed !== s.tokensUsed) {
      s.tokensUsed = e.tokensUsed;
    }
    if (e.wallClockMs !== undefined && e.wallClockMs !== s.wallClockMs) {
      s.wallClockMs = e.wallClockMs;
    }
    if (
      e.wallClockResumedAt !== undefined &&
      (e.status ?? s.status) === 'active' &&
      e.wallClockResumedAt !== s.wallClockResumedAt
    ) {
      s.wallClockResumedAt = e.wallClockResumedAt;
    }
    if (e.budgetLimits !== undefined && e.budgetLimits !== s.budgetLimits) {
      s.budgetLimits = e.budgetLimits;
    }
  })
  .on(GoalClear, () => null)
  .on(GoalForked, () => null);
