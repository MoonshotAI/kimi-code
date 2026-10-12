import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerRebaseToolInputSchema = z
  .object({
    mission: z
      .string()
      .describe('Mission id (e.g. "M3") whose branch should be rebased onto the current base'),
  })
  .strict();

export type TowerRebaseToolInput = z.infer<typeof TowerRebaseToolInputSchema>;

export interface ITowerRebaseTool extends AgentTool<TowerRebaseToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerRebaseTool = createDecorator<ITowerRebaseTool>('towerRebaseTool');
