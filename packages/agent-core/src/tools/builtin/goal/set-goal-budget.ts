/**
 * SetGoalBudgetTool — lets the model record a user-stated hard runtime limit
 * for the current goal. The tool accepts one limit at a time, converts supported
 * time units to milliseconds, and rejects obviously unreasonable time limits.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { GoalBudgetLimits } from '../../../agent/goal';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { tryNativeGoalEngineValidateBudgetInput } from '../native-tools';
import DESCRIPTION from './set-goal-budget.md?raw';

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

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: SetGoalBudgetToolInput): ToolExecution {
    const goal = this.agent.goal;

    // Engine owns budget validation (unit conversion, rounding, time bounds).
    const validationResult = tryNativeGoalEngineValidateBudgetInput(
      JSON.stringify({ value: args.value, unit: args.unit }),
    );
    let budget: GoalBudgetLimits | null = null;
    let displayValue = args.value;
    let displayUnit = args.unit;
    if (validationResult !== undefined) {
      // Native available — use its result (or null if it rejected).
      budget = validationResult.ok ? enginePatchToBudgetLimits(validationResult.budgetLimits) : null;
      // Native returns normalized integer values; reflect them in display.
      if (validationResult.ok) {
        const patch = validationResult.budgetLimits;
        if (typeof patch['tokenBudget'] === 'number') {
          displayValue = patch['tokenBudget'] as number;
        } else if (typeof patch['turnBudget'] === 'number') {
          displayValue = patch['turnBudget'] as number;
        }
      }
    } else {
      // Native unavailable — fall back to TS validation.
      const normalizedArgs = normalizeBudgetInput(args);
      budget = budgetLimitsFromInput(normalizedArgs);
      displayValue = normalizedArgs.value;
      displayUnit = normalizedArgs.unit;
    }
    const overBudgetAfterSet = budget !== null && this.wouldExceedBudget(budget);
    return {
      description: `Setting goal budget: ${formatBudget(displayValue, displayUnit)}`,
      stopBatchAfterThis: overBudgetAfterSet,
      approvalRule: this.name,
      execute: async () => {
        if (goal.getGoal().goal === null) {
          return { output: 'Goal budget not set: no current goal.' };
        }
        if (budget === null) {
          return {
            output:
              `Goal budget not set: ${formatBudget(displayValue, displayUnit)} is not a ` +
              'reasonable goal budget.',
          };
        }
        const snapshot = await goal.setBudgetLimits({ budgetLimits: budget }, 'model');
        if (snapshot.budget.overBudget) {
          return {
            output:
              `Goal budget set: ${formatBudget(displayValue, displayUnit)}. ` +
              'The goal has already reached this budget and will stop now.',
            stopTurn: true,
          };
        }
        return {
          output: `Goal budget set: ${formatBudget(displayValue, displayUnit)}.`,
        };
      },
    };
  }

  /**
   * Predicts whether merging {@link newLimits} into the current goal's budget
   * would already be at or over budget, mirroring the reached-budget math in
   * `computeBudgetReport`. Used to stop the tool batch synchronously when a
   * just-set budget is exhausted. Returns false when there is no current goal
   * (the set itself will reject with GOAL_NOT_FOUND).
   */
  private wouldExceedBudget(newLimits: GoalBudgetLimits): boolean {
    const goal = this.agent.goal.getGoal().goal;
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

/** Converts an engine budget-limits patch into the TS GoalBudgetLimits shape. */
const MIN_REASONABLE_TIME_BUDGET_MS: number = 1_000;
const MAX_REASONABLE_TIME_BUDGET_MS: number = 24 * 60 * 60 * 1000;

function normalizeBudgetInput(input: SetGoalBudgetToolInput): SetGoalBudgetToolInput {
  switch (input.unit) {
    case 'turns':
    case 'tokens':
      return { ...input, value: Math.max(1, Math.round(input.value)) };
    default:
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

function enginePatchToBudgetLimits(patch: Record<string, unknown>): GoalBudgetLimits {
  const result: { tokenBudget?: number; turnBudget?: number; wallClockBudgetMs?: number } = {};
  if (typeof patch['tokenBudget'] === 'number') {
    result.tokenBudget = patch['tokenBudget'];
  }
  if (typeof patch['turnBudget'] === 'number') {
    result.turnBudget = patch['turnBudget'];
  }
  if (typeof patch['wallClockBudgetMs'] === 'number') {
    result.wallClockBudgetMs = patch['wallClockBudgetMs'];
  }
  return result;
}

function formatBudget(value: number, unit: SetGoalBudgetToolInput['unit']): string {
  const singular = unit.endsWith('s') ? unit.slice(0, -1) : unit;
  return `${String(value)} ${value === 1 ? singular : unit}`;
}
