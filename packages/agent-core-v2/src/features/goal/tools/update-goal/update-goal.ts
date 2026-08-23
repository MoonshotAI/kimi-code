import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

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

export interface IUpdateGoalTool extends AgentTool<UpdateGoalToolInput> { readonly _serviceBrand: undefined }
export const IUpdateGoalTool = createDecorator<IUpdateGoalTool>('updateGoalTool');
