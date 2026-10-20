import { z } from 'zod';

import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';
import type { ToolDefinition, ToolResult } from '@moonshot-ai/agent-core/tool/index';

import { GoalError } from '../errors';
import { GOAL_MAIN_AGENT_ONLY } from '../prompts';
import { goalForModel } from '../serialize';
import type { CreateGoalInput, GoalActor, GoalSnapshot } from '../types';

import DESCRIPTION from './create-goal.md?raw';

export const CreateGoalToolInputSchema = z
  .object({
    objective: z.string().min(1).describe('The objective to pursue. Must have a verifiable end state.'),
    completionCriterion: z
      .string()
      .optional()
      .describe('How to verify the goal is complete. Include when the user provides one.'),
    replace: z
      .boolean()
      .optional()
      .describe('Replace an existing active, paused, or blocked goal instead of failing.'),
  })
  .strict();

export type CreateGoalToolInput = z.infer<typeof CreateGoalToolInputSchema>;

function failureText(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function createCreateGoalTool(
  goal: {
    readonly createGoal: (input: CreateGoalInput, actor?: GoalActor) => Promise<GoalSnapshot>;
  },
  agentId: string,
): ToolDefinition {
  return {
    name: 'CreateGoal',
    description: DESCRIPTION,
    parameters: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          minLength: 1,
          description: 'The objective to pursue. Must have a verifiable end state.',
        },
        completionCriterion: {
          description: 'How to verify the goal is complete. Include when the user provides one.',
          type: 'string',
        },
        replace: {
          description: 'Replace an existing active, paused, or blocked goal instead of failing.',
          type: 'boolean',
        },
      },
      required: ['objective'],
      additionalProperties: false,
    },
    async execute({ toolCall }) {
      if (agentId !== MAIN_AGENT_ID) return failureText(GOAL_MAIN_AGENT_ONLY);
      let rawArgs: unknown;
      try {
        rawArgs = JSON.parse(toolCall.arguments ?? '{}');
      } catch {
        return failureText(`Invalid CreateGoal arguments: ${toolCall.arguments ?? ''}`);
      }
      const args = CreateGoalToolInputSchema.safeParse(rawArgs);
      if (!args.success) {
        return failureText(`Invalid CreateGoal arguments: ${args.error.issues[0]?.message ?? 'invalid input'}`);
      }
      try {
        const snapshot = await goal.createGoal(
          {
            objective: args.data.objective,
            completionCriterion: args.data.completionCriterion,
            replace: args.data.replace,
          },
          'model',
        );
        return {
          content: [{ type: 'text', text: JSON.stringify({ goal: goalForModel(snapshot) }, null, 2) }],
        };
      } catch (error) {
        if (error instanceof GoalError) return failureText(error.message);
        throw error;
      }
    },
  };
}
