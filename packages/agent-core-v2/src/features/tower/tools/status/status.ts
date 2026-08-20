import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerStatusToolInputSchema = z.object({}).strict();

export type TowerStatusToolInput = z.infer<typeof TowerStatusToolInputSchema>;

export interface ITowerStatusTool extends AgentTool<TowerStatusToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerStatusTool = createDecorator<ITowerStatusTool>('towerStatusTool');
