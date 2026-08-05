/**
 * `tools` domain — `ICronListTool` contract.
 *
 * Public contract of the CronList tool: a read-only, side-effect-free tool
 * that enumerates the cron tasks currently scheduled in this session. Takes
 * no arguments; each output record carries the task id, verbatim cron
 * expression, human-readable schedule, post-jitter next fire time, recurring
 * flag, age, and stale marker. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const CronListInputSchema = z.object({}).strict();
export type CronListInput = z.infer<typeof CronListInputSchema>;

export interface ICronListTool extends AgentTool<CronListInput> { readonly _serviceBrand: undefined }
export const ICronListTool = createDecorator<ICronListTool>('cronListTool');
