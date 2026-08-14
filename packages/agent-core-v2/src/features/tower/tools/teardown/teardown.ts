/**
 * `tools` domain — `ITowerTeardownTool` contract (the `TowerTeardown` tool).
 *
 * Public contract of the tower session ender: removes mission worktrees
 * (dirty ones are kept unless force), exits tower mode, and reports what
 * happened. The comms directory stays on disk as the audit trail. Exports
 * the model-facing `TowerTeardownToolInputSchema` /
 * `TowerTeardownToolInput` and the `ITowerTeardownTool` DI decorator. Bound
 * at Agent scope.
 */

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
