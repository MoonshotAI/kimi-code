/**
 * CronListTool — enumerate the cron tasks currently scheduled in this
 * session.
 *
 * Read-only and side-effect-free. The output mirrors the
 * `key: value\n---\n` shape used by `task/tools/task-list.ts` so
 * the LLM sees a consistent record layout across the "list scheduled
 * work" tools.
 *
 * What each record carries:
 *
 *   - `id`            — the task id (a ULID) (also accepted by CronDelete).
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
 *   - `stale`         — mirrors `ISessionCronService.isStale(task)`; see that
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

import type { ExecutableTool as BuiltinTool, ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { cronToHuman, parseCronExpression } from '#/app/cron/cron-expr';
import { type CronTask } from '#/app/cron/cronTask';
import { formatLocalIsoWithOffset } from '#/app/cron/format';
import CRON_LIST_DESCRIPTION from './cron-list.md?raw';


export const CronListInputSchema = z.object({}).strict();
export type CronListInput = z.infer<typeof CronListInputSchema>;


const MS_PER_DAY = 24 * 60 * 60 * 1000;

const PROMPT_PREVIEW_BYTES = 200;

function previewPrompt(prompt: string): string {
  const buf = Buffer.from(prompt, 'utf8');
  if (buf.byteLength <= PROMPT_PREVIEW_BYTES) return prompt;
  let end = PROMPT_PREVIEW_BYTES;
  while (end > 0 && (buf[end]! & 0b1100_0000) === 0b1000_0000) end--;
  return `${buf.subarray(0, end).toString('utf8')}…(truncated)`;
}


export class CronListTool implements BuiltinTool<CronListInput> {
  readonly name = 'CronList' as const;
  readonly description = CRON_LIST_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(
    CronListInputSchema,
  );

  constructor(@ISessionCronService private readonly cron: ISessionCronService) {}

  resolveExecution(_args: CronListInput): ToolExecution {
    return {
      description: 'Listing scheduled cron jobs',
      approvalRule: this.name,
      execute: async () => {
        const tasks = this.cron.list();
        const nowMs = this.cron.now();
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
    const recurring = task.recurring !== false;

    const ageMs = nowMs - task.createdAt;
    const ageDays = Number.isFinite(ageMs) ? ageMs / MS_PER_DAY : 0;

    const stale = this.cron.isStale(task);

    let humanSchedule = task.cron;
    let nextFireAtIso = 'null';
    try {
      const parsed = parseCronExpression(task.cron);
      humanSchedule = cronToHuman(parsed);
      const nextFireMs = this.cron.getNextFireForTask(task.id);
      if (nextFireMs !== null) {
        nextFireAtIso = formatLocalIsoWithOffset(nextFireMs);
      }
    } catch {
    }

    return [
      `id: ${task.id}`,
      `cron: ${task.cron}`,
      `humanSchedule: ${humanSchedule}`,
      `prompt: ${JSON.stringify(previewPrompt(task.prompt))}`,
      `nextFireAt: ${nextFireAtIso}`,
      `recurring: ${String(recurring)}`,
      `ageDays: ${ageDays.toFixed(2)}`,
      `stale: ${String(stale)}`,
    ].join('\n');
  }
}
