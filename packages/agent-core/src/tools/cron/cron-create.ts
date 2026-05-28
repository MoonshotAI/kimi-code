/**
 * CronCreateTool — schedule a prompt to be re-injected into this session
 * at a future wall-clock time, either once (`recurring: false`) or on a
 * cron cadence (`recurring: true`, the default).
 *
 * Phase 1 / P1.4 is session-only — tasks live in `SessionCronStore` and
 * die when the process exits. A durable / file-backed branch is planned
 * for Phase 2 but is intentionally absent from the public surface until
 * the storage layer exists; exposing a `durable` flag now would mislead
 * the model into promising persistence we can't yet deliver.
 *
 * The tool itself is pure validation + bookkeeping; the firing /
 * coalesce / jitter logic lives in `CronScheduler` (one layer below)
 * and `CronManager` (one layer up). This file only knows how to:
 *
 *   1. validate the request (killswitch, cron parse, 5-year window,
 *      session cap, byte-length cap);
 *   2. add it to the manager's session store;
 *   3. report back the post-jitter `nextFireAt` and a human-readable
 *      schedule for the model's benefit;
 *   4. emit `cron_scheduled` telemetry through the manager (the tool
 *      does **not** reach into `manager.agent.telemetry` directly).
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../agent/tool';
import type { CronManager } from '../../agent/cron';
import type { ToolExecution } from '../../loop/types';
import { toInputJsonSchema } from '../support/input-schema';
import {
  computeNextCronRun,
  cronToHuman,
  hasFireWithinYears,
  parseCronExpression,
  type ParsedCronExpression,
} from './cron-expr';
import {
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
} from './jitter';
import CRON_CREATE_DESCRIPTION from './cron-create.md';

// ── Constants ────────────────────────────────────────────────────────

/**
 * Session-level cap on the number of live cron tasks. Exported so tests
 * can pre-fill the store without re-deriving the magic number.
 */
export const MAX_CRON_JOBS_PER_SESSION = 50;

/**
 * Hard ceiling on `prompt` byte length (UTF-8). The zod `.max(...)`
 * upstream is in code units, which underflows multi-byte input
 * (`'汉'.length === 1` even though it is 3 bytes); we re-check using
 * `Buffer.byteLength` so the budget reflects the actual on-the-wire
 * size the model will eventually see.
 */
const MAX_PROMPT_BYTES = 8 * 1024;

// ── Input schema ─────────────────────────────────────────────────────

export const CronCreateInputSchema = z.object({
  cron: z
    .string()
    .describe(
      '5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once).',
    ),
  prompt: z
    .string()
    .min(1)
    .max(MAX_PROMPT_BYTES)
    .describe('The prompt to enqueue at each fire time.'),
  recurring: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.',
    ),
});

export type CronCreateInput = z.Infer<typeof CronCreateInputSchema>;

// ── Output shape (internal) ─────────────────────────────────────────

interface CronCreateOutput {
  readonly id: string;
  readonly cron: string;
  readonly humanSchedule: string;
  readonly recurring: boolean;
  readonly nextFireAt: number | null;
}

// ── Implementation ───────────────────────────────────────────────────

export class CronCreateTool implements BuiltinTool<CronCreateInput> {
  readonly name = 'CronCreate' as const;
  readonly description = CRON_CREATE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(
    CronCreateInputSchema,
  );

  constructor(private readonly manager: CronManager) {}

  resolveExecution(args: CronCreateInput): ToolExecution {
    // 1. Global killswitch — checked first so a flipped env stops all
    //    further work, including the cron parse which can throw on
    //    legitimately-malformed input.
    if (process.env['KIMI_DISABLE_CRON'] === '1') {
      return {
        isError: true,
        output: 'Cron scheduling is disabled (KIMI_DISABLE_CRON=1).',
      };
    }

    // 2. Normalize whitespace BEFORE parsing so `parsed.raw` (which
    //    `cronToHuman` falls back to for non-template shapes) is the
    //    single-line form. Otherwise tabs/newlines from the raw input
    //    leak into the rendered `humanSchedule:` row and break the
    //    one-key-per-line tool output format. Parse errors still report
    //    against canonical field positions; only whitespace is
    //    degraded, not semantics.
    const normalizedCron = args.cron.trim().split(/\s+/).join(' ');

    // 3. Parse the cron expression. Any parse failure is a user error
    //    rather than an internal one, so we surface the message
    //    verbatim — the parser is already careful to name the
    //    offending field.
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

    // 4. Reject "legal but never fires within 5 years" — the same
    //    bound the scheduler uses internally to refuse to spin.
    //    `0 0 31 2 *` is the canonical example. The exact `nowMs` does
    //    not matter for this judgment (it only changes the search
    //    window by < 5 years), so we read it here at prepare time and
    //    re-read inside `execute()` for the actual schedule anchor.
    const nowAtPrepare = this.manager.clocks.wallNow();
    if (!hasFireWithinYears(parsed, 5, nowAtPrepare)) {
      return {
        isError: true,
        output: `Cron expression ${JSON.stringify(
          normalizedCron,
        )} has no fire within 5 years; refusing to schedule.`,
      };
    }

    // 5. Session-level cap — preliminary check. We re-check inside
    //    `execute()` because manual-approval mode can delay execution
    //    long enough for parallel CronCreate calls to all pass this
    //    gate and then collectively breach the cap on insert.
    if (this.manager.store.list().length >= MAX_CRON_JOBS_PER_SESSION) {
      return {
        isError: true,
        output: `Cron job cap reached (max ${String(
          MAX_CRON_JOBS_PER_SESSION,
        )} per session).`,
      };
    }

    // 6. Byte-length cap. zod's `.max()` counts code units, which is
    //    not the budget we actually want for a multi-byte prompt; the
    //    Buffer.byteLength check makes the 8 KiB intent literal.
    const byteLen = Buffer.byteLength(args.prompt, 'utf8');
    if (byteLen > MAX_PROMPT_BYTES) {
      return {
        isError: true,
        output: `Prompt exceeds ${String(
          MAX_PROMPT_BYTES,
        )} bytes (got ${String(byteLen)}).`,
      };
    }

    // `recurring` is defaulted to true upstream; we re-derive the
    // boolean (rather than trusting the post-default arg) to match the
    // canonical "recurring iff not explicitly false" convention used
    // everywhere else in the cron stack.
    const recurring = args.recurring !== false;

    return {
      description: recurring
        ? `Scheduling cron ${normalizedCron}`
        : `Scheduling one-shot ${normalizedCron}`,
      approvalRule: this.name,
      execute: async () => {
        // Anchor the schedule to the moment of execution, not the
        // moment of preparation. Manual-approval mode can leave
        // resolveExecution() and execute() minutes apart; inserting
        // with a stale `nowMs` would let the scheduler treat a fresh
        // one-shot as already overdue and fire it on the next tick
        // with a phantom `coalescedCount > 1`.
        const nowMs = this.manager.clocks.wallNow();

        // Re-check the session cap against the live store size so two
        // concurrently-prepared CronCreate calls cannot collectively
        // breach it after both passed the prepare-time check.
        if (this.manager.store.list().length >= MAX_CRON_JOBS_PER_SESSION) {
          return {
            isError: true,
            output: `Cron job cap reached (max ${String(
              MAX_CRON_JOBS_PER_SESSION,
            )} per session).`,
          };
        }

        const task = this.manager.store.add(
          {
            cron: normalizedCron,
            prompt: args.prompt,
            recurring,
          },
          nowMs,
        );

        // Post-jitter next-fire for the response. `computeNextCronRun`
        // returns `null` if there's no fire in the 5-year window (we
        // already rejected that above, but be defensive — the jitter
        // helper would then have nothing to shift).
        const ideal = computeNextCronRun(parsed, nowMs);
        const nextFireAt =
          ideal === null
            ? null
            : recurring
              ? jitteredNextCronRunMs(task, parsed, ideal)
              : oneShotJitteredNextCronRunMs(task, ideal);

        const humanSchedule = cronToHuman(parsed);

        // Telemetry goes through the manager so the tool stays out of
        // `manager.agent.telemetry`. CronDelete (P1.6) will use the
        // symmetric `emitDeleted`.
        this.manager.emitScheduled(task);

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
      o.nextFireAt === null ? 'null' : new Date(o.nextFireAt).toISOString()
    }`,
  ];
  return lines.join('\n');
}
