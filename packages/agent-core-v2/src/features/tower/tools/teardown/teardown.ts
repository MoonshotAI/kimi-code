import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerTeardownToolInputSchema = z
  .object({
    force: z
      .boolean()
      .optional()
      .describe(
        'Remove worktrees even when they contain uncommitted changes — a worktree whose roster agent is still running is kept regardless',
      ),
    exclude: z
      .array(z.string())
      .optional()
      .describe(
        'Worktree names to keep — they are skipped and reported, whatever their state',
      ),
    dry_run: z
      .boolean()
      .optional()
      .describe(
        'Print the would-remove / would-keep list with reasons without changing anything on disk or in state',
      ),
  })
  .strict();

export type TowerTeardownToolInput = z.infer<typeof TowerTeardownToolInputSchema>;

export interface ITowerTeardownTool extends AgentTool<TowerTeardownToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerTeardownTool = createDecorator<ITowerTeardownTool>('towerTeardownTool');
