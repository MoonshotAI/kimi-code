/**
 * `tools` domain — `ITowerInboxTool` contract (the `TowerInbox` tool).
 *
 * Public contract of the tower inbox reader: messages addressed to the
 * caller (or broadcast), newest first; the tower sees every message. Exports
 * the model-facing `TowerInboxToolInputSchema` / `TowerInboxToolInput` and
 * the `ITowerInboxTool` DI decorator. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerInboxToolInputSchema = z
  .object({
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Max messages to return (default 20), newest first'),
  })
  .strict();

export type TowerInboxToolInput = z.infer<typeof TowerInboxToolInputSchema>;

export interface ITowerInboxTool extends AgentTool<TowerInboxToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerInboxTool = createDecorator<ITowerInboxTool>('towerInboxTool');
