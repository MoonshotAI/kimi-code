/**
 * `tools` domain (L7) — `ICronDeleteTool` contract.
 *
 * Public contract of the CronDelete tool: cancel a scheduled cron job by id.
 * The input is the cron job id (a ULID) returned by CronCreate / CronList; a
 * miss is reported as an error so the model corrects itself (typically by
 * calling CronList again) instead of learning that deletes are idempotent.
 * Bound at Agent scope.
 */

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
