/**
 * `tools` domain (L7) — `ICronCreateTool` contract.
 *
 * Public contract of the CronCreate tool: the input zod schema (5-field cron
 * expression + prompt + recurring flag), the output record shape reported
 * back to the model, and the per-session job cap shared with the session cron
 * service. The tool schedules a prompt to be re-injected into this session at
 * a future wall-clock time, either once (`recurring: false`) or on a cron
 * cadence (`recurring: true`, the default). Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const MAX_CRON_JOBS_PER_SESSION = 50;

export const MAX_PROMPT_BYTES = 8 * 1024;

export const CronCreateInputSchema = z.object({
  cron: z
    .string()
    .describe(
      '5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes; "30 14 28 2 *" = Feb 28 at 2:30pm local — a pinned date like this repeats yearly unless you also pass recurring: false).',
    ),
  prompt: z
    .string()
    .min(1)
    .max(MAX_PROMPT_BYTES)
    .describe('The prompt to enqueue at each fire time. Limited to 8 KiB (UTF-8).'),
  recurring: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.',
    ),
});

export type CronCreateInput = z.Infer<typeof CronCreateInputSchema>;

export interface CronCreateOutput {
  readonly id: string;
  readonly cron: string;
  readonly humanSchedule: string;
  readonly recurring: boolean;
  readonly nextFireAt: number | null;
}

export interface ICronCreateTool extends AgentTool<CronCreateInput> { readonly _serviceBrand: undefined }
export const ICronCreateTool = createDecorator<ICronCreateTool>('cronCreateTool');
