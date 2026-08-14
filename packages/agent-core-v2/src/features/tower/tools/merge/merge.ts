/**
 * `tools` domain — `ITowerMergeTool` contract (the `TowerMerge` tool).
 *
 * Public contract of the tower's merge lever: the store is the hard gate —
 * it refuses when the branch has no review, the latest review is not clean,
 * the branch tip moved since the clean review, dependencies are unmerged, or
 * the branch changed files outside its mission scope. Exports the
 * model-facing `TowerMergeToolInputSchema` / `TowerMergeToolInput` and the
 * `ITowerMergeTool` DI decorator. Bound at Agent scope.
 */

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
