/**
 * SetGoalBudgetTool — lets the model record a user-stated hard runtime limit
 * for the current goal. The tool accepts one limit at a time, converts supported
 * time units to milliseconds, and rejects obviously unreasonable time limits.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { GoalBudgetLimits } from '../../../session/goal';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { goalErrorResult, isGoalToolError, requireGoalStore } from './shared';
import DESCRIPTION from './set-goal-budget.md';

const MIN_REASONABLE_TIME_BUDGET_MS = 1_000;
const MAX_REASONABLE_TIME_BUDGET_MS = 24 * 60 * 60 * 1000;

const WholeNumberBudgetValueSchema = z
  .number()
  .int()
  .positive()
  .describe('The positive whole-number budget value.');
const TimeBudgetValueSchema = z.number().positive().describe('The positive numeric time budget value.');

export const SetGoalBudgetToolInputSchema = z.discriminatedUnion('unit', [
  z.object({ value: WholeNumberBudgetValueSchema, unit: z.literal('turns') }).strict(),
  z.object({ value: WholeNumberBudgetValueSchema, unit: z.literal('tokens') }).strict(),
  z.object({ value: TimeBudgetValueSchema, unit: z.literal('milliseconds') }).strict(),
  z.object({ value: TimeBudgetValueSchema, unit: z.literal('seconds') }).strict(),
  z.object({ value: TimeBudgetValueSchema, unit: z.literal('minutes') }).strict(),
  z.object({ value: TimeBudgetValueSchema, unit: z.literal('hours') }).strict(),
]);

export type SetGoalBudgetToolInput = z.infer<typeof SetGoalBudgetToolInputSchema>;

export class SetGoalBudgetTool implements BuiltinTool<SetGoalBudgetToolInput> {
  readonly name = 'SetGoalBudget' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SetGoalBudgetToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: SetGoalBudgetToolInput): ToolExecution {
    const store = requireGoalStore(this.agent, this.name);
    if (isGoalToolError(store)) return store;

    return {
      description: `Setting goal budget: ${formatBudget(args.value, args.unit)}`,
      approvalRule: this.name,
      execute: async () => {
        try {
          const budget = budgetLimitsFromInput(args);
          if (budget === null) {
            return {
              output:
                `Goal budget not set: ${formatBudget(args.value, args.unit)} is not a ` +
                'reasonable goal budget.',
            };
          }
          await store.setBudgetLimits({ budgetLimits: budget, actor: 'model' });
          return { output: `Goal budget set: ${formatBudget(args.value, args.unit)}.` };
        } catch (error) {
          return goalErrorResult(error);
        }
      },
    };
  }
}

function budgetLimitsFromInput(input: SetGoalBudgetToolInput): GoalBudgetLimits | null {
  switch (input.unit) {
    case 'turns':
      return { turnBudget: input.value };
    case 'tokens':
      return { tokenBudget: input.value };
    default: {
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
