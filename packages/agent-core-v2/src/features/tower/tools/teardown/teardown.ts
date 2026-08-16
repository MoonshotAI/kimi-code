import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerTeardownToolInputSchema = z
  .object({
    force: z
      .boolean()
      .optional()
      .describe('Remove worktrees even when they contain uncommitted changes'),
  })
  .strict();

export type TowerTeardownToolInput = z.infer<typeof TowerTeardownToolInputSchema>;

export interface ITowerTeardownTool extends AgentTool<TowerTeardownToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerTeardownTool = createDecorator<ITowerTeardownTool>('towerTeardownTool');
