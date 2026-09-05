import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const CronListInputSchema = z.object({}).strict();
export type CronListInput = z.infer<typeof CronListInputSchema>;

export interface ICronListTool extends AgentTool<CronListInput> { readonly _serviceBrand: undefined }
export const ICronListTool = createDecorator<ICronListTool>('cronListTool');
