import type { Projection } from '@moonshot-ai/agent-core/store/index';

import type { FeatureEvent } from '#/runtime/index';

import type { GoalActor, GoalBudgetLimits, GoalStatus } from './types';

export const GOAL_CREATE = 'goal.create';
export const GOAL_UPDATE = 'goal.update';
export const GOAL_CLEAR = 'goal.clear';

export interface GoalCreateEvent extends FeatureEvent {
  readonly type: typeof GOAL_CREATE;
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly wallClockResumedAt?: number;
  readonly budgetLimits?: GoalBudgetLimits;
}

export interface GoalUpdateEvent extends FeatureEvent {
  readonly type: typeof GOAL_UPDATE;
  readonly status?: GoalStatus;
  readonly reason?: string;
  readonly turnsUsed?: number;
  readonly tokensUsed?: number;
  readonly wallClockMs?: number;
  readonly wallClockResumedAt?: number;
  readonly budgetLimits?: GoalBudgetLimits;
  readonly actor?: GoalActor;
}

export interface GoalClearEvent extends FeatureEvent {
  readonly type: typeof GOAL_CLEAR;
}

export type GoalEvent = GoalCreateEvent | GoalUpdateEvent | GoalClearEvent;

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

function readBudgetLimits(value: unknown): GoalBudgetLimits {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const read = (key: string): number | undefined => {
    const field = record[key];
    return typeof field === 'number' && Number.isFinite(field) && field >= 0 ? field : undefined;
  };
  return {
    tokenBudget: read('tokenBudget'),
    turnBudget: read('turnBudget'),
    wallClockBudgetMs: read('wallClockBudgetMs'),
  };
}

function readCounter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readStatus(value: unknown): GoalStatus | undefined {
  return value === 'active' || value === 'paused' || value === 'blocked' || value === 'complete'
    ? value
    : undefined;
}

export const goalProjection: Projection<GoalModelState, GoalEvent> = {
  initial: () => null,
  reduce: (state, { event }) => {
    if (event.type === GOAL_CREATE) {
      if (typeof event.goalId !== 'string' || typeof event.objective !== 'string') return state;
      return {
        goalId: event.goalId,
        objective: event.objective,
        completionCriterion:
          typeof event.completionCriterion === 'string' ? event.completionCriterion : undefined,
        status: 'active',
        turnsUsed: 0,
        tokensUsed: 0,
        wallClockMs: 0,
        wallClockResumedAt: readCounter(event.wallClockResumedAt),
        budgetLimits: readBudgetLimits(event.budgetLimits),
      };
    }
    if (event.type === GOAL_UPDATE) {
      if (state === null) return null;
      let next = state;
      const status = readStatus(event.status);
      if (status !== undefined && status !== next.status) {
        next = {
          ...next,
          status,
          terminalReason:
            status === 'active'
              ? undefined
              : typeof event.reason === 'string'
                ? event.reason
                : undefined,
          wallClockResumedAt:
            status === 'active' ? readCounter(event.wallClockResumedAt) : undefined,
        };
      }
      const turnsUsed = readCounter(event.turnsUsed);
      if (turnsUsed !== undefined && turnsUsed !== next.turnsUsed) {
        next = { ...next, turnsUsed };
      }
      const tokensUsed = readCounter(event.tokensUsed);
      if (tokensUsed !== undefined && tokensUsed !== next.tokensUsed) {
        next = { ...next, tokensUsed };
      }
      const wallClockMs = readCounter(event.wallClockMs);
      if (wallClockMs !== undefined && wallClockMs !== next.wallClockMs) {
        next = { ...next, wallClockMs };
      }
      const wallClockResumedAt = readCounter(event.wallClockResumedAt);
      if (
        wallClockResumedAt !== undefined &&
        (status ?? next.status) === 'active' &&
        wallClockResumedAt !== next.wallClockResumedAt
      ) {
        next = { ...next, wallClockResumedAt };
      }
      if (event.budgetLimits !== undefined && event.budgetLimits !== next.budgetLimits) {
        next = { ...next, budgetLimits: readBudgetLimits(event.budgetLimits) };
      }
      return next;
    }
    if (event.type === GOAL_CLEAR) {
      return null;
    }
    return state;
  },
};
