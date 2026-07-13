/**
 * SetGoalBudgetTool — lets the model record a user-stated hard runtime limit
 * for the current goal. The tool accepts one limit at a time, converts supported
 * time units to milliseconds, and rejects obviously unreasonable time limits.
 * Registered for the main agent only, mirroring v1's `agent.type === 'main'`
 * gate.
 */

import { z } from 'zod';

import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { BuiltinTool, ToolExecution } from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';

import { IAgentGoalService } from '#/agent/goal/goal';
import type { GoalBudgetLimits } from '#/agent/goal/types';
import DESCRIPTION from './set-goal-budget.md?raw';

const MIN_REASONABLE_TIME_BUDGET_MS = 1_000;
const MAX_REASONABLE_TIME_BUDGET_MS = 24 * 60 * 60 * 1000;
const BUDGET_UNITS = ['turns', 'tokens', 'milliseconds', 'seconds', 'minutes', 'hours'] as const;

export const SetGoalBudgetToolInputSchema = z
  .object({
    // Keep the provider-facing schema simple. Fractional turn/token budgets
    // are normalized during execution instead of rejected at schema validation.
    value: z.number().positive().describe('The positive numeric budget value.'),
    unit: z.enum(BUDGET_UNITS),
  })
  .strict();

export type SetGoalBudgetToolInput = z.infer<typeof SetGoalBudgetToolInputSchema>;

export class SetGoalBudgetTool implements BuiltinTool<SetGoalBudgetToolInput> {
  readonly name = 'SetGoalBudget' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SetGoalBudgetToolInputSchema);

  constructor(@IAgentGoalService private readonly goal: IAgentGoalService) {}

  resolveExecution(args: SetGoalBudgetToolInput): ToolExecution {
    const normalizedArgs = normalizeBudgetInput(args);
    const budget = budgetLimitsFromInput(normalizedArgs);
    const overBudgetAfterSet = budget !== null && this.wouldExceedBudget(budget);
    return {
      description: `Setting goal budget: ${formatBudget(
        normalizedArgs.value,
        normalizedArgs.unit,
      )}`,
      stopBatchAfterThis: overBudgetAfterSet,
      approvalRule: this.name,
      execute: async () => {
        if (this.goal.getGoal().goal === null) {
          return { output: 'Goal budget not set: no current goal.' };
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

  private wouldExceedBudget(newLimits: GoalBudgetLimits): boolean {
    const goal = this.goal.getGoal().goal;
    if (goal === null) return false;
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

registerTool(SetGoalBudgetTool, {
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});

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
