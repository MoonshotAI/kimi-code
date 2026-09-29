import type { BranchRef, Projection, RecordEvent } from '@moonshot-ai/agent-core';

import type { GoalBudgetLimits, GoalStatus } from './types';

export const GOAL_CREATE = 'goal.create';
export const GOAL_UPDATE = 'goal.update';
export const GOAL_CLEAR = 'goal.clear';

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

function readCounter(event: RecordEvent, key: string): number | undefined {
  const value = event[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readStatus(value: unknown): GoalStatus | undefined {
  return value === 'active' || value === 'paused' || value === 'blocked' || value === 'complete'
    ? value
    : undefined;
}

export const goalProjection: Projection<GoalModelState, RecordEvent, BranchRef> = {
  initial: () => null,
  reduce: (state, event) => {
    if (event.type === GOAL_CREATE) {
      const goalId = event['goalId'];
      const objective = event['objective'];
      if (typeof goalId !== 'string' || typeof objective !== 'string') return state;
      const completionCriterion = event['completionCriterion'];
      return {
        goalId,
        objective,
        completionCriterion:
          typeof completionCriterion === 'string' ? completionCriterion : undefined,
        status: 'active',
        turnsUsed: 0,
        tokensUsed: 0,
        wallClockMs: 0,
        wallClockResumedAt: readCounter(event, 'wallClockResumedAt'),
        budgetLimits: readBudgetLimits(event['budgetLimits']),
      };
    }
    if (event.type === GOAL_UPDATE) {
      if (state === null) return null;
      let next = state;
      const status = readStatus(event['status']);
      if (status !== undefined && status !== next.status) {
        const reason = event['reason'];
        next = {
          ...next,
          status,
          terminalReason:
            status === 'active'
              ? undefined
              : typeof reason === 'string'
                ? reason
                : undefined,
          wallClockResumedAt:
            status === 'active' ? readCounter(event, 'wallClockResumedAt') : undefined,
        };
      }
      const turnsUsed = readCounter(event, 'turnsUsed');
      if (turnsUsed !== undefined && turnsUsed !== next.turnsUsed) {
        next = { ...next, turnsUsed };
      }
      const tokensUsed = readCounter(event, 'tokensUsed');
      if (tokensUsed !== undefined && tokensUsed !== next.tokensUsed) {
        next = { ...next, tokensUsed };
      }
      const wallClockMs = readCounter(event, 'wallClockMs');
      if (wallClockMs !== undefined && wallClockMs !== next.wallClockMs) {
        next = { ...next, wallClockMs };
      }
      const wallClockResumedAt = readCounter(event, 'wallClockResumedAt');
      if (
        wallClockResumedAt !== undefined &&
        (status ?? next.status) === 'active' &&
        wallClockResumedAt !== next.wallClockResumedAt
      ) {
        next = { ...next, wallClockResumedAt };
      }
      const budgetLimits = event['budgetLimits'];
      if (budgetLimits !== undefined && budgetLimits !== next.budgetLimits) {
        next = { ...next, budgetLimits: readBudgetLimits(budgetLimits) };
      }
      return next;
    }
    if (event.type === GOAL_CLEAR) {
      return null;
    }
    return state;
  },
};
