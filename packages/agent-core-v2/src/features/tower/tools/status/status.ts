import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerStatusToolInputSchema = z
  .object({
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum entries to return in each detail list (default 20), newest first'),
  })
  .strict();

export type TowerStatusToolInput = z.infer<typeof TowerStatusToolInputSchema>;

export interface ITowerStatusTool extends AgentTool<TowerStatusToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerStatusTool = createDecorator<ITowerStatusTool>('towerStatusTool');
