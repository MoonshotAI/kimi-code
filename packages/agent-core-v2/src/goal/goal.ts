import { createDecorator } from "#/_base/di";
import type {
  CreateGoalInput,
  GoalActor,
  GoalBudgetLimits,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
} from '../../../agent/goal';

export interface GoalReasonInput {
  readonly reason?: string;
}

export interface IGoalService {
  readonly _serviceBrand: undefined;
  getGoal(): GoalToolResult;
  createGoal(input: CreateGoalInput, actor?: GoalActor): Promise<GoalSnapshot>;
  pauseGoal(input?: GoalReasonInput, actor?: GoalActor): Promise<GoalSnapshot>;
  resumeGoal(input?: GoalReasonInput, actor?: GoalActor): Promise<GoalSnapshot>;
  cancelGoal(actor?: GoalActor): Promise<GoalSnapshot>;
}

declare module '../types' {
  interface WireRecordMap {
    forked: {};
    'goal.create': {
      goalId: string;
      objective: string;
      completionCriterion?: string;
    };
    'goal.update': {
      status?: GoalStatus;
      reason?: string;
      turnsUsed?: number;
      tokensUsed?: number;
      wallClockMs?: number;
      budgetLimits?: GoalBudgetLimits;
      actor?: GoalActor;
    };
    'goal.clear': {};
  }
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IGoalService = createDecorator<IGoalService>('agentGoalService');
