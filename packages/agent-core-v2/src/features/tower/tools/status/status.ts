/**
 * `tools` domain — `ITowerStatusTool` contract (the `TowerStatus` tool).
 *
 * Public contract of the shared tower dashboard: mission table, roster,
 * per-branch review-gate state (latest review round/status and whether it
 * still matches the branch tip), the caller's inbox count, and the recent
 * activity log. Exports the model-facing `TowerStatusToolInputSchema` /
 * `TowerStatusToolInput` and the `ITowerStatusTool` DI decorator. Bound at
 * Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerStatusToolInputSchema = z.object({}).strict();

export type TowerStatusToolInput = z.infer<typeof TowerStatusToolInputSchema>;

export interface ITowerStatusTool extends AgentTool<TowerStatusToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerStatusTool = createDecorator<ITowerStatusTool>('towerStatusTool');
