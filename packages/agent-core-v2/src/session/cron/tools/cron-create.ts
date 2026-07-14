/**
 * CronCreateTool — schedule a prompt to be re-injected into this session
 * at a future wall-clock time, either once (`recurring: false`) or on a
 * cron cadence (`recurring: true`, the default).
 *
 * Tasks live in `ISessionCronService` (Session scope) and are persisted
 * through the App-scoped `ICronTaskPersistence` under the project's cron
 * scope, so a `kimi resume` of the same session reloads them and the
 * scheduler picks up where it left off (fires that fell during downtime
 * are collapsed into a single delivery with `coalescedCount`). Tasks do
 * NOT carry over into a brand-new session.
 *
 * The tool itself is pure validation + bookkeeping; the firing /
 * coalesce / jitter / persistence logic lives in `SessionCronService`.
 * This file only knows how to:
 *
 *   1. validate the request (killswitch, cron parse, 5-year window,
 *      session cap, byte-length cap);
 *   2. add it to the service (which writes through to the store);
 *   3. report back the post-jitter `nextFireAt` and a human-readable
 *      schedule for the model's benefit;
 *   4. emit `cron_scheduled` telemetry through the service (the tool
 *      does **not** reach into `ITelemetryService` directly).
 */

import { z } from 'zod';

import type { ExecutableTool as BuiltinTool, ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern } from '#/tool/rule-match';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { computeNextCronRun, cronToHuman, hasFireWithinYears, parseCronExpression, type ParsedCronExpression } from '#/app/cron/cron-expr';
import { formatLocalIsoWithOffset } from '#/app/cron/format';
import CRON_CREATE_DESCRIPTION from './cron-create.md?raw';


export const MAX_CRON_JOBS_PER_SESSION = 50;

const MAX_PROMPT_BYTES = 8 * 1024;

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

export type CronCreateInput = z.Infer<typeof CronCreateInputSchema>;


interface CronCreateOutput {
  readonly id: string;
  readonly cron: string;
  readonly humanSchedule: string;
  readonly recurring: boolean;
  readonly nextFireAt: number | null;
}


export class CronCreateTool implements BuiltinTool<CronCreateInput> {
  readonly name = 'CronCreate' as const;
  readonly description = CRON_CREATE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(
    CronCreateInputSchema,
  );

  constructor(@ISessionCronService private readonly cron: ISessionCronService) {}

  resolveExecution(args: CronCreateInput): ToolExecution {
    if (this.cron.isDisabled()) {
      return {
        isError: true,
        output: 'Cron scheduling is disabled (KIMI_DISABLE_CRON=1).',
      };
    }

    const normalizedCron = args.cron.trim().split(/\s+/).join(' ');

    let parsed: ParsedCronExpression;
    try {
      parsed = parseCronExpression(normalizedCron);
    } catch (err) {
      return {
        isError: true,
        output: `Invalid cron expression: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    const nowAtPrepare = this.cron.now();
    if (!hasFireWithinYears(parsed, 5, nowAtPrepare)) {
      return {
        isError: true,
        output: `Cron expression ${JSON.stringify(
          normalizedCron,
        )} has no fire within 5 years; refusing to schedule.`,
      };
    }

    if (this.cron.list().length >= MAX_CRON_JOBS_PER_SESSION) {
      return {
        isError: true,
        output: `Cron job cap reached (max ${String(
          MAX_CRON_JOBS_PER_SESSION,
        )} per session).`,
      };
    }

    const byteLen = Buffer.byteLength(args.prompt, 'utf8');
    if (byteLen > MAX_PROMPT_BYTES) {
      return {
        isError: true,
        output: `Prompt exceeds ${String(
          MAX_PROMPT_BYTES,
        )} bytes (got ${String(byteLen)}).`,
      };
    }

    const recurring = args.recurring !== false;

    if (!recurring) {
      const firstFire = computeNextCronRun(parsed, nowAtPrepare);
      if (
        firstFire !== null &&
        firstFire - nowAtPrepare > ONE_SHOT_MAX_FUTURE_MS
      ) {
        return {
          isError: true,
          output: `One-shot cron ${JSON.stringify(
            normalizedCron,
          )} would not fire until ${formatLocalIsoWithOffset(
            firstFire,
          )} (more than a year out). If you meant "today" or a near date, the pinned day/month has already passed this year — pick a future date or use wildcards.`,
        };
      }
    }

    return {
      description: recurring
        ? `Scheduling cron ${normalizedCron}`
        : `Scheduling one-shot ${normalizedCron}`,
      approvalRule: literalRulePattern(
        this.name,
        JSON.stringify({
          cron: normalizedCron,
          prompt: args.prompt,
          recurring,
        }),
      ),
      execute: async () => {
        const nowMs = this.cron.now();

        if (this.cron.list().length >= MAX_CRON_JOBS_PER_SESSION) {
          return {
            isError: true,
            output: `Cron job cap reached (max ${String(
              MAX_CRON_JOBS_PER_SESSION,
            )} per session).`,
          };
        }

        const task = this.cron.addTask({
          cron: normalizedCron,
          prompt: args.prompt,
          recurring,
        });

        const ideal = computeNextCronRun(parsed, nowMs);
        const nextFireAt =
          ideal === null ? null : this.cron.computeDisplayNextFire(task, parsed, ideal);

        const humanSchedule = cronToHuman(parsed);

        this.cron.emitScheduled(task);

        const output: CronCreateOutput = {
          id: task.id,
          cron: normalizedCron,
          humanSchedule,
          recurring,
          nextFireAt,
        };

        return {
          output: formatOutput(output),
          isError: false,
          message: `Scheduled cron ${task.id}`,
        };
      },
    };
  }
}

function formatOutput(o: CronCreateOutput): string {
  const lines = [
    `id: ${o.id}`,
    `cron: ${o.cron}`,
    `humanSchedule: ${o.humanSchedule}`,
    `recurring: ${String(o.recurring)}`,
    `nextFireAt: ${
      o.nextFireAt === null ? 'null' : formatLocalIsoWithOffset(o.nextFireAt)
    }`,
  ];
  return lines.join('\n');
}
