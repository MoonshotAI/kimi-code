import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { GOAL_MAIN_AGENT_ONLY, mainAgentOnlyExecution } from '#/agent/tools/mainAgentOnly';
import { type ToolExecution } from '#/tool/toolContract';

import { IAgentGoalService } from '#/features/goal/goal';
import type { GoalBudgetLimits, GoalSnapshot } from '#/features/goal/types';

import DESCRIPTION from './set-goal-budget.md?raw';
import {
  SetGoalBudgetToolInputSchema,
  ISetGoalBudgetTool,
  type SetGoalBudgetToolInput,
} from './set-goal-budget';

const MIN_REASONABLE_TIME_BUDGET_MS = 1_000;
const MAX_REASONABLE_TIME_BUDGET_MS = 24 * 60 * 60 * 1000;

export class SetGoalBudgetTool implements ISetGoalBudgetTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'SetGoalBudget' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SetGoalBudgetToolInputSchema);

  constructor(
    @IAgentGoalService private readonly goal: IAgentGoalService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(args: SetGoalBudgetToolInput): ToolExecution {
    const denied = mainAgentOnlyExecution(this.scopeContext, GOAL_MAIN_AGENT_ONLY);
    if (denied !== undefined) return denied;
    const normalizedArgs = normalizeBudgetInput(args);
    const budget = budgetLimitsFromInput(normalizedArgs);
    const goalAtResolution = this.goal.getGoal().goal;
    const overBudgetAfterSet =
      budget !== null &&
      goalAtResolution !== null &&
      this.wouldExceedBudget(goalAtResolution, budget);
    return {
      description: `Setting goal budget: ${formatBudget(
        normalizedArgs.value,
        normalizedArgs.unit,
      )}`,
      stopBatchAfterThis: overBudgetAfterSet,
      approvalRule: this.name,
      execute: async ({ turnId }) => {
        const currentGoal = this.goal.getGoal().goal;
        if (currentGoal === null) {
          return { output: 'Goal budget not set: no current goal.' };
        }
        if (
          currentGoal.goalId !== goalAtResolution?.goalId &&
          !this.goal.isGoalToolTarget(turnId, currentGoal.goalId)
        ) {
          return { output: 'Goal budget not set: the current goal changed.' };
        }
        if (budget === null) {
          return {
            output:
              `Goal budget not set: ${formatBudget(normalizedArgs.value, normalizedArgs.unit)} is not a ` +
              'reasonable goal budget.',
          };
        }
        const snapshot = await this.goal.setBudgetLimits({ budgetLimits: budget }, 'model');
        if (snapshot.budget.overBudget) {
          return {
            output:
              `Goal budget set: ${formatBudget(normalizedArgs.value, normalizedArgs.unit)}. ` +
              'The goal has already reached this budget and will stop now.',
            stopTurn: true,
          };
        }
        return {
          output: `Goal budget set: ${formatBudget(normalizedArgs.value, normalizedArgs.unit)}.`,
        };
      },
    };
  }

  private wouldExceedBudget(goal: GoalSnapshot, newLimits: GoalBudgetLimits): boolean {
    const current = goal.budget;
    const turnBudget = newLimits.turnBudget ?? current.turnBudget;
    const tokenBudget = newLimits.tokenBudget ?? current.tokenBudget;
    const wallClockBudgetMs = newLimits.wallClockBudgetMs ?? current.wallClockBudgetMs;
    return (
      (turnBudget !== null && goal.turnsUsed >= turnBudget) ||
      (tokenBudget !== null && goal.tokensUsed >= tokenBudget) ||
      (wallClockBudgetMs !== null && goal.wallClockMs >= wallClockBudgetMs)
    );
  }
}

function normalizeBudgetInput(input: SetGoalBudgetToolInput): SetGoalBudgetToolInput {
  switch (input.unit) {
    case 'turns':
    case 'tokens':
      return { ...input, value: Math.max(1, Math.round(input.value)) };
    case 'milliseconds':
    case 'seconds':
    case 'minutes':
    case 'hours':
      return input;
  }
}

function budgetLimitsFromInput(input: SetGoalBudgetToolInput): GoalBudgetLimits | null {
  switch (input.unit) {
    case 'turns':
      return { turnBudget: input.value };
    case 'tokens':
      return { tokenBudget: input.value };
    case 'milliseconds':
    case 'seconds':
    case 'minutes':
    case 'hours': {
      const wallClockBudgetMs = Math.round(toMilliseconds(input.value, input.unit));
      if (
        wallClockBudgetMs < MIN_REASONABLE_TIME_BUDGET_MS ||
        wallClockBudgetMs > MAX_REASONABLE_TIME_BUDGET_MS
      ) {
        return null;
      }
      return { wallClockBudgetMs };
    }
  }
}

function toMilliseconds(
  value: number,
  unit: Extract<SetGoalBudgetToolInput['unit'], 'milliseconds' | 'seconds' | 'minutes' | 'hours'>,
): number {
  switch (unit) {
    case 'milliseconds':
      return value;
    case 'seconds':
      return value * 1000;
    case 'minutes':
      return value * 60 * 1000;
    case 'hours':
      return value * 60 * 60 * 1000;
  }
}

function formatBudget(value: number, unit: SetGoalBudgetToolInput['unit']): string {
  const singular = unit.endsWith('s') ? unit.slice(0, -1) : unit;
  return `${String(value)} ${value === 1 ? singular : unit}`;
}
