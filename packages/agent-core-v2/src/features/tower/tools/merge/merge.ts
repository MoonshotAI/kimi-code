import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerMergeToolInputSchema = z
  .object({
    branch: z
      .string()
      .describe('The mission branch to merge into the base branch (e.g. "feat/vulkan-build")'),
  })
  .strict();

export type TowerMergeToolInput = z.infer<typeof TowerMergeToolInputSchema>;

export interface ITowerMergeTool extends AgentTool<TowerMergeToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerMergeTool = createDecorator<ITowerMergeTool>('towerMergeTool');
