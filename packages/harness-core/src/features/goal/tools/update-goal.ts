import { z } from 'zod';

import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';
import type { ToolDefinition, ToolResult } from '@moonshot-ai/agent-core/tool/index';

import { GoalError } from '../errors';
import { buildGoalBlockedReasonPrompt, buildGoalCompletionSummaryPrompt } from '../outcome-prompts';
import { GOAL_MAIN_AGENT_ONLY } from '../prompts';
import type { GoalActor, GoalReasonInput, GoalSnapshot, GoalToolResult } from '../types';

import DESCRIPTION from './update-goal.md?raw';

export const UpdateGoalToolInputSchema = z
  .object({
    status: z
      .enum(['active', 'complete', 'blocked'])
      .describe(
        'The lifecycle status to set for the current goal. Use `blocked` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns.',
      ),
  })
  .strict();

export type UpdateGoalToolInput = z.infer<typeof UpdateGoalToolInputSchema>;

function errorText(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function failureText(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function isUpdateGoalStatus(status: unknown): status is UpdateGoalToolInput['status'] {
  return status === 'active' || status === 'complete' || status === 'blocked';
}

function missingGoalOutput(status: UpdateGoalToolInput['status']): string {
  if (status === 'active') return 'Goal not resumed: no current goal.';
  if (status === 'complete') return 'Goal not completed: no active goal.';
  return 'Goal not blocked: no active goal.';
}

export function createUpdateGoalTool(
  goal: {
    readonly getGoal: () => GoalToolResult;
    readonly resumeGoal: (input?: GoalReasonInput, actor?: GoalActor) => Promise<GoalSnapshot>;
    readonly markComplete: (
      input?: GoalReasonInput,
      actor?: GoalActor,
    ) => Promise<GoalSnapshot | null>;
    readonly markBlocked: (
      input?: GoalReasonInput,
      actor?: GoalActor,
    ) => Promise<GoalSnapshot | null>;
  },
  agentId: string,
): ToolDefinition {
  return {
    name: 'UpdateGoal',
    description: DESCRIPTION,
    parameters: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'complete', 'blocked'],
          description:
            'The lifecycle status to set for the current goal. Use `blocked` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns.',
        },
      },
      required: ['status'],
      additionalProperties: false,
    },
    async execute({ toolCall }) {
      if (agentId !== MAIN_AGENT_ID) return failureText(GOAL_MAIN_AGENT_ONLY);
      let rawArgs: unknown;
      try {
        rawArgs = JSON.parse(toolCall.arguments ?? '{}');
      } catch {
        return failureText(`Invalid UpdateGoal arguments: ${toolCall.arguments ?? ''}`);
      }
      const status = (rawArgs as Record<string, unknown>)?.['status'];
      if (!isUpdateGoalStatus(status)) {
        return failureText('Invalid goal status. Use `active`, `complete`, or `blocked`.');
      }
      if (goal.getGoal().goal === null) return errorText(missingGoalOutput(status));
      try {
        if (status === 'active') {
          await goal.resumeGoal({}, 'model');
          return errorText('Goal resumed.');
        }
        if (status === 'complete') {
          const completed = await goal.markComplete({}, 'model');
          if (completed === null) return errorText('Goal not completed: no active goal.');
          return {
            content: [{ type: 'text', text: buildGoalCompletionSummaryPrompt(completed) }],
            stopTurn: true,
          };
        }
        const blocked = await goal.markBlocked({}, 'model');
        if (blocked === null) return errorText('Goal not blocked: no active goal.');
        return {
          content: [{ type: 'text', text: buildGoalBlockedReasonPrompt(blocked) }],
          stopTurn: true,
        };
      } catch (error) {
        if (error instanceof GoalError) return failureText(error.message);
        throw error;
      }
    },
  };
}
