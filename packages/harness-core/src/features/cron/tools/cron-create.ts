import { z } from 'zod';

import { MAIN_AGENT_ID, type ToolDefinition, type ToolResult } from '@moonshot-ai/agent-core';

import type { CronTask, CronTaskInit } from '../cronTask';
import {
  computeNextCronRun,
  cronToHuman,
  hasFireWithinYears,
  parseCronExpression,
  type ParsedCronExpression,
} from '../internal/cron-expr';
import { formatLocalIsoWithOffset } from '../internal/format';

import CRON_CREATE_DESCRIPTION from './cron-create.md?raw';

export const MAX_CRON_JOBS_PER_SESSION = 50;

export const MAX_PROMPT_BYTES = 8 * 1024;

export const CRON_MAIN_AGENT_ONLY = 'Cron tools are only supported by the main agent.';

const ONE_SHOT_MAX_FUTURE_MS = 350 * 24 * 60 * 60 * 1000;

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

export type CronCreateInput = z.infer<typeof CronCreateInputSchema>;

function errorText(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function createCronCreateTool(
  cron: {
    readonly isDisabled: () => boolean;
    readonly now: () => number;
    readonly list: () => readonly CronTask[];
    readonly addTask: (init: CronTaskInit) => Promise<CronTask>;
    readonly computeDisplayNextFire: (
      task: CronTask,
      parsed: ParsedCronExpression,
      idealMs: number,
    ) => number | null;
  },
  agentId: string,
): ToolDefinition {
  return {
    name: 'CronCreate',
    description: CRON_CREATE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        cron: {
          type: 'string',
          description:
            '5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes; "30 14 28 2 *" = Feb 28 at 2:30pm local — a pinned date like this repeats yearly unless you also pass recurring: false).',
        },
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_PROMPT_BYTES,
          description: 'The prompt to enqueue at each fire time. Limited to 8 KiB (UTF-8).',
        },
        recurring: {
          type: 'boolean',
          default: true,
          description:
            'true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.',
        },
      },
      required: ['cron', 'prompt'],
      additionalProperties: false,
    },
    async execute({ toolCall }) {
      if (agentId !== MAIN_AGENT_ID) return errorText(CRON_MAIN_AGENT_ONLY);
      if (cron.isDisabled()) {
        return errorText('Cron scheduling is disabled (KIMI_DISABLE_CRON=1).');
      }
      let rawArgs: unknown;
      try {
        rawArgs = JSON.parse(toolCall.arguments ?? '{}');
      } catch {
        return errorText(`Invalid CronCreate arguments: ${toolCall.arguments ?? ''}`);
      }
      const args = CronCreateInputSchema.safeParse(rawArgs);
      if (!args.success) {
        return errorText(`Invalid CronCreate arguments: ${args.error.issues[0]?.message ?? 'invalid input'}`);
      }
      const normalizedCron = args.data.cron.trim().split(/\s+/).join(' ');

      let parsed: ParsedCronExpression;
      try {
        parsed = parseCronExpression(normalizedCron);
      } catch (error) {
        return errorText(
          `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const nowAtPrepare = cron.now();
      if (!hasFireWithinYears(parsed, 5, nowAtPrepare)) {
        return errorText(
          `Cron expression ${JSON.stringify(normalizedCron)} has no fire within 5 years; refusing to schedule.`,
        );
      }

      if (cron.list().length >= MAX_CRON_JOBS_PER_SESSION) {
        return errorText(`Cron job cap reached (max ${String(MAX_CRON_JOBS_PER_SESSION)} per session).`);
      }

      const byteLen = Buffer.byteLength(args.data.prompt, 'utf8');
      if (byteLen > MAX_PROMPT_BYTES) {
        return errorText(`Prompt exceeds ${String(MAX_PROMPT_BYTES)} bytes (got ${String(byteLen)}).`);
      }

      const recurring = args.data.recurring;

      if (!recurring) {
        const firstFire = computeNextCronRun(parsed, nowAtPrepare);
        if (firstFire !== null && firstFire - nowAtPrepare > ONE_SHOT_MAX_FUTURE_MS) {
          return errorText(
            `One-shot cron ${JSON.stringify(normalizedCron)} would not fire until ${formatLocalIsoWithOffset(
              firstFire,
            )} (more than a year out). If you meant "today" or a near date, the pinned day/month has already passed this year — pick a future date or use wildcards.`,
          );
        }
      }

      const task = await cron.addTask({
        cron: normalizedCron,
        prompt: args.data.prompt,
        recurring,
      });

      const ideal = computeNextCronRun(parsed, cron.now());
      const nextFireAt = ideal === null ? null : cron.computeDisplayNextFire(task, parsed, ideal);

      const humanSchedule = cronToHuman(parsed);

      const lines = [
        `id: ${task.id}`,
        `cron: ${normalizedCron}`,
        `humanSchedule: ${humanSchedule}`,
        `recurring: ${String(recurring)}`,
        `nextFireAt: ${nextFireAt === null ? 'null' : formatLocalIsoWithOffset(nextFireAt)}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  };
}
