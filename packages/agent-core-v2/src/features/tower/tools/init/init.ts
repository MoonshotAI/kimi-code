import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerInitToolInputSchema = z
  .object({
    base: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Local branch that missions fork from and merge back into (e.g. "develop"). Defaults to the branch currently checked out in the main worktree. Remote-tracking refs (e.g. "origin/main") and tags are not accepted — create a local branch first.',
      ),
  })
  .strict();

export type TowerInitToolInput = z.infer<typeof TowerInitToolInputSchema>;

export interface ITowerInitTool extends AgentTool<TowerInitToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerInitTool = createDecorator<ITowerInitTool>('towerInitTool');
