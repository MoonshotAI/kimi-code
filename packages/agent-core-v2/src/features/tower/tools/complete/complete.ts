import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerCompleteToolInputSchema = z
  .object({
    report: z
      .string()
      .refine((value) => value.trim().length > 0, { message: 'report must not be empty' })
      .describe('Full completion report for the tower and the next review round'),
  })
  .strict();

export type TowerCompleteToolInput = z.infer<typeof TowerCompleteToolInputSchema>;

export interface ITowerCompleteTool extends AgentTool<TowerCompleteToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerCompleteTool = createDecorator<ITowerCompleteTool>('towerCompleteTool');
