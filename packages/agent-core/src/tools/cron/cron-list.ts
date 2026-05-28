/**
 * CronListTool — enumerate the cron tasks currently scheduled in this
 * session.
 *
 * Read-only and side-effect-free. The output mirrors the
 * `key: value\n---\n` shape used by `tools/background/task-list.ts` so
 * the LLM sees a consistent record layout across the "list scheduled
 * work" tools.
 *
 * What each record carries:
 *
 *   - `id`            — the 8-hex task id (also accepted by CronDelete).
 *   - `cron`          — verbatim 5-field expression as scheduled.
 *   - `humanSchedule` — best-effort plain-English rendering via
 *                       `cronToHuman`; falls back to the raw `cron`
 *                       string if the expression can't be parsed.
 *   - `nextFireAt`    — post-jitter ISO timestamp, or the literal
 *                       string `null` when there is no fire in the
 *                       5-year window (or the expression is malformed).
 *                       This is the same jittered value `CronCreate`
 *                       reports, so the LLM can reason about herd-
 *                       avoidance offsets without surprise.
 *   - `recurring`     — `true` unless the task was explicitly created
 *                       with `recurring: false`.
 *   - `ageDays`       — `(wallNow - createdAt) / day`, formatted to two
 *                       decimal places. Useful context for the `stale`
 *                       flag and for the LLM's "should I still be
 *                       running?" judgement.
 *   - `stale`         — mirrors `CronManager.isStale(task)`; see that
 *                       method for the precise rules
 *                       (`recurring && age >= 7 days`, gated by
 *                       `KIMI_CRON_NO_STALE`).
 *
 * The tool never throws on malformed cron strings. A defensive
 * try/catch around the parse path lets the record render with the raw
 * `cron`, a `humanSchedule` fallback equal to `cron`, and
 * `nextFireAt: null` — that should never happen for tasks that went
 * through `CronCreate` (which validates), but guards against future
 * direct `store.add(...)` inserts.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../agent/tool';
import type { CronManager } from '../../agent/cron';
import type { ToolExecution } from '../../loop/types';
import { toInputJsonSchema } from '../support/input-schema';
import {
  computeNextCronRun,
  cronToHuman,
  parseCronExpression,
} from './cron-expr';
import {
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
} from './jitter';
import type { CronTask } from './types';
import CRON_LIST_DESCRIPTION from './cron-list.md';

// ── Input schema ─────────────────────────────────────────────────────

/**
 * No arguments. Strict so the loop's AJV validator rejects accidental
 * extras (e.g. an `active_only` borrowed from `TaskList`) instead of
 * silently ignoring them.
 */
export const CronListInputSchema = z.object({}).strict();
export type CronListInput = z.infer<typeof CronListInputSchema>;

// ── Constants ────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Implementation ───────────────────────────────────────────────────

export class CronListTool implements BuiltinTool<CronListInput> {
  readonly name = 'CronList' as const;
  readonly description = CRON_LIST_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(
    CronListInputSchema,
  );

  constructor(private readonly manager: CronManager) {}

  resolveExecution(_args: CronListInput): ToolExecution {
    return {
      description: 'Listing scheduled cron jobs',
      execute: async () => {
        // Snapshot the store once and pin "now" from the manager's
        // clock — keeping both reads inside the same execute() call
        // guarantees the `ageDays` and `nextFireAt` columns are
        // computed against the same instant even if the bench-injected
        // clock advances between the two.
        const tasks = this.manager.store.list();
        const nowMs = this.manager.clocks.wallNow();
        const records = tasks.map((t) => this.renderRecord(t, nowMs));
        const header = `cron_jobs: ${String(tasks.length)}`;
        if (records.length === 0) {
          return {
            output: `${header}\nNo cron jobs scheduled.`,
            isError: false,
          };
        }
        return {
          output: `${header}\n${records.join('\n---\n')}`,
          isError: false,
        };
      },
    };
  }

  private renderRecord(task: CronTask, nowMs: number): string {
    // `recurring: undefined` is the canonical "repeat by default"
    // shape across the cron stack; only an explicit `false` opts out.
    const recurring = task.recurring !== false;

    // `ageDays` is purely informational — a non-finite age (e.g.
    // wallNow returned NaN from a misconfigured bench clock) is
    // reported as 0.00 so the column stays parseable rather than
    // emitting the string "NaN".
    const ageMs = nowMs - task.createdAt;
    const ageDays = Number.isFinite(ageMs) ? ageMs / MS_PER_DAY : 0;

    const stale = this.manager.isStale(task);

    let humanSchedule = task.cron;
    let nextFireAtIso = 'null';
    try {
      const parsed = parseCronExpression(task.cron);
      humanSchedule = cronToHuman(parsed);
      const ideal = computeNextCronRun(parsed, nowMs);
      if (ideal !== null) {
        // Match the jitter path CronCreate took when scheduling the
        // task. Recurring jobs shift forward; one-shots only shift
        // earlier when they land on a round minute. Either way the
        // ISO timestamp we render here is the time the scheduler
        // will actually compare against.
        const jittered = recurring
          ? jitteredNextCronRunMs(task, parsed, ideal)
          : oneShotJitteredNextCronRunMs(task, ideal);
        nextFireAtIso = new Date(jittered).toISOString();
      }
    } catch {
      // Malformed cron string — leave humanSchedule as the raw
      // expression and nextFireAt as `null`. Should never happen for
      // tasks that went through CronCreate (which validates), but
      // defends against direct store inserts (tests).
    }

    return [
      `id: ${task.id}`,
      `cron: ${task.cron}`,
      `humanSchedule: ${humanSchedule}`,
      `nextFireAt: ${nextFireAtIso}`,
      `recurring: ${String(recurring)}`,
      `ageDays: ${ageDays.toFixed(2)}`,
      `stale: ${String(stale)}`,
    ].join('\n');
  }
}
