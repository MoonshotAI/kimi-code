/**
 * Per-task deterministic jitter for cron fire times.
 *
 * Why this exists: if every user writes `0 9 * * *` ("every day at 9
 * am") then every CLI fires at the same instant and the upstream API
 * sees a thundering herd at :00. We soften that by shifting each
 * task's ideal fire time by a small, **deterministic** per-task
 * offset so a given task always lands at the same jittered point —
 * reschedules and restarts don't drift, and bench reproducibility
 * stays intact when {@link KIMI_CRON_NO_JITTER} is set.
 *
 * Two flavours:
 *
 *   - **Recurring**: shift *forward* by a fraction of the period
 *     (cap 10% of period, hard cap 15 min). Long-period jobs (`0 9 *
 *     * *`, period 1 day) hit the 15-minute cap; short-period jobs
 *     (`*` /5 * * * *`, period 5 min) are bounded by the 10% rule.
 *
 *   - **One-shot**: shift *earlier* (negative), but only when the
 *     ideal lands on `:00` or `:30` — that's the signal the model
 *     picked a round number with no specific intent. Cap 90 s
 *     earlier. Any other minute (`:07`, `:23`, …) passes through
 *     unchanged because the model presumably meant that exact time.
 *
 * The function is pure given its inputs — no module-level cache; the
 * hash is recomputed from `task.id` each call. That trades a handful
 * of cheap arithmetic ops for a guarantee that there is no hidden
 * state to invalidate when a task is rescheduled.
 */
import type { ParsedCronExpression } from './cron-expr';
import { computeNextCronRun } from './cron-expr';

/** Tunables for {@link jitteredNextCronRunMs} / {@link oneShotJitteredNextCronRunMs}. */
export interface JitterConfig {
  /** Recurring offset cap as a fraction of the cron period (0..1). */
  readonly recurringMaxFractionOfPeriod: number;
  /** Absolute cap on the recurring offset, in ms. */
  readonly recurringMaxMs: number;
  /** Absolute cap on the one-shot pull-forward, in ms. */
  readonly oneShotMaxMs: number;
}

export const DEFAULT_CRON_JITTER_CONFIG: JitterConfig = {
  recurringMaxFractionOfPeriod: 0.1,
  recurringMaxMs: 15 * 60_000,
  oneShotMaxMs: 90_000,
};

const MS_PER_DAY = 24 * 60 * 60_000;
const MS_PER_MINUTE = 60_000;

/**
 * Map a task id to a deterministic fraction in `[0, 1)`. Cron task
 * ids are 8 hex chars (`/^[0-9a-f]{8}$/`), so `parseInt(id, 16)` /
 * `2^32` lands neatly in range. For non-hex inputs we fall back to a
 * djb2-style reduction so callers passing test fixtures with
 * arbitrary string ids still get a stable spread.
 */
function fractionFromId(id: string): number {
  if (/^[0-9a-f]{8}$/i.test(id)) {
    const n = Number.parseInt(id, 16);
    if (Number.isFinite(n)) {
      // 2^32 keeps the result strictly < 1.
      return n / 0x1_0000_0000;
    }
  }
  // djb2 reduction — overflow-safe in JS (operates on int32) and
  // good enough spread for non-hex test ids.
  let hash = 5381;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) + hash + id.charCodeAt(i)) | 0;
  }
  // Map signed int32 to [0, 1).
  const unsigned = hash >>> 0;
  return unsigned / 0x1_0000_0000;
}

function jitterDisabledByEnv(): boolean {
  return process.env['KIMI_CRON_NO_JITTER'] === '1';
}

/**
 * Apply recurring-job jitter to an already-computed ideal fire time.
 *
 * The shift is **forward only** (≥ 0), bounded by both the relative
 * fraction-of-period cap and the absolute ms cap. We discover the
 * period by asking {@link computeNextCronRun} for the run *after*
 * `idealMs`; if that returns `null` (legal-but-never-fires
 * expression — should have been rejected upstream) we fall back to a
 * 24-hour assumption so we still produce some sensible offset rather
 * than spiking on the original `idealMs`.
 */
export function jitteredNextCronRunMs(
  task: { id: string; cron: string; recurring?: boolean },
  parsed: ParsedCronExpression,
  idealMs: number,
  config: JitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number {
  if (jitterDisabledByEnv()) {
    return idealMs;
  }
  const nextNext = computeNextCronRun(parsed, idealMs);
  const period =
    nextNext !== null && nextNext > idealMs ? nextNext - idealMs : MS_PER_DAY;
  const periodCap = period * config.recurringMaxFractionOfPeriod;
  const cap = Math.min(periodCap, config.recurringMaxMs);
  if (!(cap > 0)) {
    return idealMs;
  }
  const offset = cap * fractionFromId(task.id);
  return idealMs + offset;
}

/**
 * Apply one-shot pull-forward jitter to an ideal fire time.
 *
 * Only fires on `:00` and `:30` of the hour — the minute marks the
 * model is most likely to pick out of habit. Other minutes pass
 * through verbatim so a user who said "remind me at 2:07" gets
 * 2:07 exactly. The shift is in `[-oneShotMaxMs, 0)`; never exactly
 * 0 unless the deterministic hash happens to land on 0 (which is
 * fine — it just means this task is the unlucky one that pays the
 * full delay).
 *
 * The result is clamped to `task.createdAt` when provided so the
 * pull-forward can never produce a fire time strictly before the
 * task was scheduled (a one-shot created at 08:59:30 for `0 9 * * *`
 * with a high-hash id would otherwise jitter the 09:00 ideal back to
 * 08:58:30 — a past timestamp that the next scheduler tick treats
 * as immediately overdue). Callers that don't have a `createdAt`
 * (legacy test fixtures) get the unclamped value, which preserves
 * the previous behaviour for them.
 */
export function oneShotJitteredNextCronRunMs(
  task: { id: string; createdAt?: number | undefined },
  idealMs: number,
  config: JitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number {
  if (jitterDisabledByEnv()) {
    return idealMs;
  }
  // Only the minute-of-hour matters: did the model land on the round
  // number? Sub-minute granularity is filtered by the modulo check.
  if (idealMs % MS_PER_MINUTE !== 0) {
    return idealMs;
  }
  const minuteOfHour = new Date(idealMs).getMinutes();
  if (minuteOfHour !== 0 && minuteOfHour !== 30) {
    return idealMs;
  }
  if (!(config.oneShotMaxMs > 0)) {
    return idealMs;
  }
  const offset = -config.oneShotMaxMs * fractionFromId(task.id);
  const shifted = idealMs + offset;
  // Floor at `createdAt` so we never return a timestamp before the
  // task was scheduled. Without this floor a brand-new one-shot can
  // come out of `CronCreate` already overdue and fire on the very
  // next scheduler tick.
  if (task.createdAt !== undefined && shifted < task.createdAt) {
    return task.createdAt;
  }
  return shifted;
}
