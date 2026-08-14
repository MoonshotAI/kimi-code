/**
 * `tools` domain — `ITowerInitTool` contract (the `TowerInit` tool).
 *
 * Public contract of the tower workspace initializer: creates the `.tower/`
 * workspace, enters tower mode, and activates the rest of the tower tool
 * set. Exports the model-facing `TowerInitToolInputSchema` /
 * `TowerInitToolInput` and the `ITowerInitTool` DI decorator. Bound at Agent
 * scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerInitToolInputSchema = z.object({}).strict();

export type TowerInitToolInput = z.infer<typeof TowerInitToolInputSchema>;

export interface ITowerInitTool extends AgentTool<TowerInitToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerInitTool = createDecorator<ITowerInitTool>('towerInitTool');
