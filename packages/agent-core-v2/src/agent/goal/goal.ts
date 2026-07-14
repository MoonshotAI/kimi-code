/**
 * `goal` domain (L4) — per-agent goal lifecycle contract.
 *
 * Defines the commands and snapshots used to create, inspect, update, and clear
 * the durable goal state. Bound at Agent scope.
 */
import { createDecorator } from "#/_base/di/instantiation";
import type {
  CreateGoalInput,
  GoalActor,
  GoalBudgetLimits,
  GoalSnapshot,
  GoalToolResult,
} from './types';

export interface GoalReasonInput {
  readonly reason?: string;
}

export interface ResumeGoalInput extends GoalReasonInput {
  readonly continueIfBlocked?: boolean;
}

export interface IAgentGoalService {
  readonly _serviceBrand: undefined;

  getGoal(): GoalToolResult;
  isGoalToolTarget(turnId: number, goalId: string): boolean;
  createGoal(input: CreateGoalInput, actor?: GoalActor): Promise<GoalSnapshot>;
  pauseGoal(input?: GoalReasonInput, actor?: GoalActor): Promise<GoalSnapshot>;
  resumeGoal(input?: ResumeGoalInput, actor?: GoalActor): Promise<GoalSnapshot>;
  cancelGoal(input?: GoalReasonInput, actor?: GoalActor): Promise<GoalSnapshot>;
  setBudgetLimits(
    input: { readonly budgetLimits: GoalBudgetLimits },
    actor?: GoalActor,
  ): Promise<GoalSnapshot>;
  markComplete(input?: GoalReasonInput, actor?: GoalActor): Promise<GoalSnapshot | null>;
  markBlocked(input?: GoalReasonInput, actor?: GoalActor): Promise<GoalSnapshot | null>;
}

export const IAgentGoalService = createDecorator<IAgentGoalService>('agentGoalService');
