import { z } from 'zod';

import { MAIN_AGENT_ID, type ToolDefinition, type ToolResult } from '@moonshot-ai/agent-core';

import { GoalError } from '../errors';
import { GOAL_MAIN_AGENT_ONLY } from '../prompts';
import type { GoalActor, GoalBudgetLimits, GoalSnapshot, GoalToolResult } from '../types';

import DESCRIPTION from './set-goal-budget.md?raw';

const MIN_REASONABLE_TIME_BUDGET_MS = 1_000;

const BUDGET_UNITS = ['turns', 'tokens', 'milliseconds', 'seconds', 'minutes', 'hours'] as const;

export const SetGoalBudgetToolInputSchema = z
  .object({
    value: z.number().positive().describe('The positive numeric budget value.'),
    unit: z.enum(BUDGET_UNITS),
  })
  .strict();

export type SetGoalBudgetToolInput = z.infer<typeof SetGoalBudgetToolInputSchema>;

function errorText(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function failureText(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function createSetGoalBudgetTool(
  goal: {
    readonly getGoal: () => GoalToolResult;
    readonly setBudgetLimits: (
      input: { readonly budgetLimits: GoalBudgetLimits },
      actor?: GoalActor,
    ) => Promise<GoalSnapshot>;
  },
  agentId: string,
): ToolDefinition {
  return {
    name: 'SetGoalBudget',
    description: DESCRIPTION,
    parameters: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        value: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'The positive numeric budget value.',
        },
        unit: {
          type: 'string',
          enum: ['turns', 'tokens', 'milliseconds', 'seconds', 'minutes', 'hours'],
        },
      },
      required: ['value', 'unit'],
      additionalProperties: false,
    },
    async execute({ toolCall }) {
      if (agentId !== MAIN_AGENT_ID) return failureText(GOAL_MAIN_AGENT_ONLY);
      let rawArgs: unknown;
      try {
        rawArgs = JSON.parse(toolCall.arguments ?? '{}');
      } catch {
        return failureText(`Invalid SetGoalBudget arguments: ${toolCall.arguments ?? ''}`);
      }
      const args = SetGoalBudgetToolInputSchema.safeParse(rawArgs);
      if (!args.success) {
        return failureText(`Invalid SetGoalBudget arguments: ${args.error.issues[0]?.message ?? 'invalid input'}`);
      }
      const normalizedArgs = normalizeBudgetInput(args.data);
      const budget = budgetLimitsFromInput(normalizedArgs);
      if (goal.getGoal().goal === null) {
        return errorText('Goal budget not set: no current goal.');
      }
      if (budget === null) {
        return errorText(
          `Goal budget not set: ${formatBudget(normalizedArgs.value, normalizedArgs.unit)} is not a ` +
            'reasonable goal budget.',
        );
      }
      try {
        const snapshot = await goal.setBudgetLimits({ budgetLimits: budget }, 'model');
        if (snapshot.budget.overBudget) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `Goal budget set: ${formatBudget(normalizedArgs.value, normalizedArgs.unit)}. ` +
                  'The goal has already reached this budget and will stop now.',
              },
            ],
            stopTurn: true,
          };
        }
        return errorText(
          `Goal budget set: ${formatBudget(normalizedArgs.value, normalizedArgs.unit)}.`,
        );
      } catch (error) {
        if (error instanceof GoalError) return failureText(error.message);
        throw error;
      }
    },
  };
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
      if (wallClockBudgetMs < MIN_REASONABLE_TIME_BUDGET_MS || !Number.isFinite(wallClockBudgetMs)) {
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
