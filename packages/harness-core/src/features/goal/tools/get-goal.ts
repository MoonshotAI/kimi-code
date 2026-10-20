import { z } from 'zod';

import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';
import type { ToolDefinition } from '@moonshot-ai/agent-core/tool/index';

import { GOAL_MAIN_AGENT_ONLY } from '../prompts';
import { goalResultForModel } from '../serialize';
import type { GoalToolResult } from '../types';

import DESCRIPTION from './get-goal.md?raw';

export const GetGoalToolInputSchema = z.object({}).strict();

export type GetGoalToolInput = z.infer<typeof GetGoalToolInputSchema>;

export function createGetGoalTool(
  goal: { readonly getGoal: () => GoalToolResult },
  agentId: string,
): ToolDefinition {
  return {
    name: 'GetGoal',
    description: DESCRIPTION,
    parameters: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      if (agentId !== MAIN_AGENT_ID) {
        return { content: [{ type: 'text', text: GOAL_MAIN_AGENT_ONLY }], isError: true };
      }
      return {
        content: [
          { type: 'text', text: JSON.stringify(goalResultForModel(goal.getGoal()), null, 2) },
        ],
      };
    },
  };
}
