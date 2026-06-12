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
 *   - `nextFireAt`    — post-jitter local ISO timestamp with offset,
 *                       or the literal
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
  cronToHuman,
  parseCronExpression,
} from './cron-expr';
import { formatLocalIsoWithOffset } from './time-format';
import type { CronTask } from './types';
import CRON_LIST_DESCRIPTION from './cron-list.md?raw';

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

// Cap each rendered prompt at 200 UTF-8 bytes so a 50-task list with
// kilobyte-scale prompts can't blow up the context window.
const PROMPT_PREVIEW_BYTES = 200;

function previewPrompt(prompt: string): string {
  const buf = Buffer.from(prompt, 'utf8');
  if (buf.byteLength <= PROMPT_PREVIEW_BYTES) return prompt;
  // Slice to PROMPT_PREVIEW_BYTES. If that lands inside a multi-byte
  // sequence, walk back to the nearest UTF-8 char boundary (continuation
  // bytes start with 10xxxxxx).
  let end = PROMPT_PREVIEW_BYTES;
  while (end > 0 && (buf[end]! & 0b1100_0000) === 0b1000_0000) end--;
  return `${buf.subarray(0, end).toString('utf8')}…(truncated)`;
}

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
      approvalRule: this.name,
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
      // Delegate to the scheduler so the rendered ISO matches what the
      // scheduler will actually deliver — including a pending jittered
      // slot in the current period.
      const nextFireMs = this.manager.getNextFireForTask(task.id);
      if (nextFireMs !== null) {
        nextFireAtIso = formatLocalIsoWithOffset(nextFireMs);
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
      // JSON-stringify so embedded newlines become `\n` escapes and
      // the record stays one `key: value` per line — otherwise a
      // multi-line prompt would corrupt the per-record parser.
      `prompt: ${JSON.stringify(previewPrompt(task.prompt))}`,
      `nextFireAt: ${nextFireAtIso}`,
      `recurring: ${String(recurring)}`,
      `ageDays: ${ageDays.toFixed(2)}`,
      `stale: ${String(stale)}`,
    ].join('\n');
  }
}
