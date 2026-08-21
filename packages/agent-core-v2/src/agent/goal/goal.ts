import { createDecorator } from '#/_base/di/instantiation';
import { defineAgentCapability } from '#/agent/runtime/agentRuntime';

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
  readonly continueIfPaused?: boolean;
  readonly continueIfBlocked?: boolean;
}

export interface IAgentGoal {
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
  pauseOnInterrupt(input?: GoalReasonInput): Promise<GoalSnapshot | null>;
  recordTokenUsage(tokenDelta: number): Promise<GoalSnapshot | null>;
  incrementTurn(): Promise<GoalSnapshot | null>;
}

export const IAgentGoal = createDecorator<IAgentGoal>('agentGoal');

export const AgentGoal = defineAgentCapability<IAgentGoal>('goal');
