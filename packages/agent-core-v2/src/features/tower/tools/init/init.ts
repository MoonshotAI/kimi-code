import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerInitToolInputSchema = z.object({}).strict();

export type TowerInitToolInput = z.infer<typeof TowerInitToolInputSchema>;

export interface ITowerInitTool extends AgentTool<TowerInitToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerInitTool = createDecorator<ITowerInitTool>('towerInitTool');
