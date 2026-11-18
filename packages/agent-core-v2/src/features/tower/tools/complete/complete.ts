import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerCompleteToolInputSchema = z
  .object({
    report: z
      .string()
      .refine((value) => value.trim().length > 0, { message: 'report must not be empty' })
      .describe('Full completion report for the tower and the next review round'),
    key_artifacts: z
      .array(z.string())
      .optional()
      .describe('Required for artifact missions: committed paths of the key deliverables for human acceptance. Approval covers the entire completion tip, not only these paths'),
  })
  .strict();

export type TowerCompleteToolInput = z.infer<typeof TowerCompleteToolInputSchema>;

export interface ITowerCompleteTool extends AgentTool<TowerCompleteToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerCompleteTool = createDecorator<ITowerCompleteTool>('towerCompleteTool');
