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
 * When the deterministic offset would land before `task.createdAt`,
 * the jitter budget is too small to safely pull forward: a previous
 * version clamped to `createdAt` itself, but the scheduler condition
 * `now >= nextFireAt` then fires on the very next tick — for the
 * canonical 08:59:30-created `0 9 * * *` case, that means firing
 * ~29 s before the ideal 09:00 mark. We skip jitter instead and
 * return `idealMs` unchanged; the task fires at the ideal time, no
 * earlier. Callers without `createdAt` (legacy test fixtures) get
 * the unclamped pulled-forward value, preserving the previous
 * behaviour for them.
 */
export function oneShotJitteredNextCronRunMs(
  task: { id: string; createdAt?: number | undefined },
  idealMs: number,
  config: JitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number {
  if (jitterDisabledByEnv()) {
    return idealMs;
  }
  // `idealMs % MS_PER_MINUTE === 0` is a UTC minute-boundary check.
  // It coincides with a local minute boundary in every modern timezone
  // because all offsets are minute-aligned — there are no sub-minute
  // offsets in current use. Cron firings are always on the minute, so
  // this gate is almost always true; it remains as a guard against
  // synthetic idealMs values from tests that aren't on the minute.
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
  // Skip jitter when the budget is insufficient: the previous version
  // clamped to `createdAt`, but `now >= nextFireAt` then fired on the
  // very next tick — ~29 s before ideal for the 08:59:30 → 09:00 case.
  // Returning `idealMs` keeps the fire on schedule, never earlier.
  if (task.createdAt !== undefined && shifted < task.createdAt) {
    return idealMs;
  }
  return shifted;
}
