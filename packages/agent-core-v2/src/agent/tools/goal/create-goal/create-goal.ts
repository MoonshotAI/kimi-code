/**
 * `tools` domain — `ICreateGoalTool` contract.
 *
 * Public contract of the CreateGoal tool: the input schema the model calls
 * with and the Agent-scope identifier used to resolve the implementation
 * through the container. The tool lets the main agent start an explicit goal
 * on the user's behalf; the goal becomes durable, structured state owned by
 * the agent's goal service, not text parsed from a slash command. Bound at
 * Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

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

export interface ICreateGoalTool extends AgentTool<CreateGoalToolInput> { readonly _serviceBrand: undefined }
export const ICreateGoalTool = createDecorator<ICreateGoalTool>('createGoalTool');
