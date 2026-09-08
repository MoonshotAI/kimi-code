import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const CronDeleteInputSchema = z.object({
  id: z
    .string()
    .describe('The cron job id (ULID) returned by CronCreate / CronList.'),
});
export type CronDeleteInput = z.infer<typeof CronDeleteInputSchema>;

export interface ICronDeleteTool extends AgentTool<CronDeleteInput> { readonly _serviceBrand: undefined }
export const ICronDeleteTool = createDecorator<ICronDeleteTool>('cronDeleteTool');
