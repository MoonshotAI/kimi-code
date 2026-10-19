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
    include_read: z
      .boolean()
      .optional()
      .describe('Include previously acknowledged messages for history lookup; only returned messages are acknowledged'),
  })
  .strict();

export type TowerInboxToolInput = z.infer<typeof TowerInboxToolInputSchema>;

export interface ITowerInboxTool extends AgentTool<TowerInboxToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerInboxTool = createDecorator<ITowerInboxTool>('towerInboxTool');
