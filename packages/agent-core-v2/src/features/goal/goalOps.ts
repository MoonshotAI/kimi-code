/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';

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
    agentId: z.string(),
    goalId: z.string(),
    objective: z.string(),
    completionCriterion: z.string().optional(),
    wallClockResumedAt: z.number().finite().nonnegative().optional(),
    status: GoalStatusSchema.optional(),
    actor: GoalActorSchema.optional(),
    budgetLimits: GoalBudgetLimitsSchema.optional(),
  })
  .strip();

export class GoalCreate extends AgentEvent2<z.infer<typeof goalCreateSchema>> {
  static override readonly type = 'goal.create';
  static override readonly durable = true;
  static override readonly schema = goalCreateSchema;
}
export interface GoalCreate {
  readonly agentId: string;
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly wallClockResumedAt?: number;
  readonly status?: GoalStatus;
  readonly actor?: GoalActor;
  readonly budgetLimits?: GoalBudgetLimits;
}

const goalUpdateSchema = z
  .object({
    agentId: z.string(),
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

export class GoalUpdate extends AgentEvent2<z.infer<typeof goalUpdateSchema>> {
  static override readonly type = 'goal.update';
  static override readonly durable = true;
  static override readonly schema = goalUpdateSchema;
}
export interface GoalUpdate {
  readonly agentId: string;
  readonly goalId?: string;
  readonly status?: GoalStatus;
  readonly reason?: string;
  readonly turnsUsed?: number;
  readonly tokensUsed?: number;
  readonly wallClockMs?: number;
  readonly wallClockResumedAt?: number;
  readonly budgetLimits?: GoalBudgetLimits;
  readonly actor?: GoalActor;
}

const goalClearSchema = z.object({ agentId: z.string() });

export class GoalClear extends AgentEvent2<z.infer<typeof goalClearSchema>> {
  static override readonly type = 'goal.clear';
  static override readonly durable = true;
  static override readonly schema = goalClearSchema;
}
export interface GoalClear {
  readonly agentId: string;
}

const goalForkedSchema = z.object({ agentId: z.string() });

export class GoalForked extends AgentEvent2<z.infer<typeof goalForkedSchema>> {
  static override readonly type = 'forked';
  static override readonly durable = true;
  static override readonly schema = goalForkedSchema;
}
export interface GoalForked {
  readonly agentId: string;
}

export interface GoalUpdatedPayload {
  readonly agentId: string;
  snapshot: GoalSnapshot | null;
  change?: GoalChange;
}

export class GoalUpdated extends AgentEvent2<GoalUpdatedPayload> {
  static override readonly type = 'goal.updated';
  static override readonly observable = true;
}
export interface GoalUpdated extends GoalUpdatedPayload {}
