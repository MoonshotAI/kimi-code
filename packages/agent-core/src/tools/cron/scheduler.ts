/**
 * CronScheduler — the scheduling engine.
 *
 * This is the bottom of the cron stack: it knows about tasks, clocks,
 * jitter, and "is the REPL idle?", but nothing about agents, tools,
 * persistence, locks, or the file system. Persistence is layered on
 * top by `CronManager` writing through to per-id JSON files; the
 * scheduler stays oblivious so its tick-loop tests can run with a
 * pure in-memory `source()`.
 *
 * Design notes worth keeping near the code:
 *
 *   - **No direct wall-clock reads.** Every wall-clock read goes
 *     through `clocks.wallNow()`. The companion `no-date-now.test.ts`
 *     enforces this at the file level; bypassing the abstraction
 *     here would break bench / test clock injection.
 *
 *   - **`source()` is called every tick.** It returns the *current*
 *     task list. Callers (the manager) typically wire it to
 *     `() => store.list()`, so creating / deleting tasks between ticks
 *     is picked up automatically. Keep `source()` cheap.
 *
 *   - **`isIdle()` gates fires, not state updates.** When the REPL is
 *     mid-turn we skip firing — but we do NOT advance `lastSeenAt`. The
 *     next idle tick will see the tasks as still due and fire them,
 *     with `coalescedCount` reflecting the gap (so the LLM knows it
 *     missed N ideal fires while the user was talking).
 *
 *   - **`coalescedCount` semantics.** When a sleep / busy turn / system
 *     pause causes the scheduler to miss multiple ideal fires, we
 *     deliver exactly ONE `onFire` call and tell the caller how many
 *     ideal fires we collapsed into it. Floor at 1 — every fire that
 *     happens counts as at least one occurrence.
 *
 *   - **`inFlight` is cleared at end of tick.** `onFire` is synchronous
 *     (the manager's steer is fire-and-forget). The set exists only to
 *     defend against re-entrant ticks within the same call stack — a
 *     theoretical concern, but cheap insurance.
 *
 *   - **Bad tasks do not poison the loop.** Each task's processing is
 *     wrapped in try/catch; failures are swallowed (with an optional
 *     stderr trace gated on `KIMI_CRON_DEBUG=1`) so one busted cron
 *     expression cannot starve the other tasks.
 */

import type { ParsedCronExpression } from './cron-expr';
import { computeNextCronRun, parseCronExpression } from './cron-expr';
import type { ClockSources } from './clock';
import { jitteredNextCronRunMs, oneShotJitteredNextCronRunMs } from './jitter';
import type { CronTask } from './types';

export interface CronSchedulerOptions {
  /** Required. Wall + monotonic clock source. */
  readonly clocks: ClockSources;

  /**
   * Required. Returns the live task list (e.g. `() => store.list()`).
   * Called every tick — keep cheap.
   */
  readonly source: () => readonly CronTask[];

  /**
   * Required. Called when a task fires. `coalescedCount >= 1`; > 1
   * when the scheduler slept past multiple ideal fires.
   */
  readonly onFire: (task: CronTask, ctx: { readonly coalescedCount: number }) => void;

  /**
   * Required. Returns true when the REPL is idle and the scheduler
   * may deliver a fire NOW. False during an active turn so we don't
   * dump a cron fire mid-stream. When false, the tick returns without
   * firing but does not lose tasks — the next idle tick fires them
   * with coalescedCount reflecting the gap.
   */
  readonly isIdle: () => boolean;

  /**
   * Optional. Returns true when the global killswitch is on; tick()
   * short-circuits to no-op.
   */
  readonly isKilled?: () => boolean;

  /**
   * Optional. Called when a one-shot task fires and must be removed
   * from the store. Defaults to a no-op (manager is responsible).
   */
  readonly removeOneShot?: (id: string) => void;

  /**
   * Optional. Called after a recurring task fires successfully, with
   * the wall-clock timestamp of the last ideal occurrence whose
   * jittered delivery has just been delivered. The manager wires this
   * to `store.markFired(id, ts)` + a per-id JSON write so a
   * `kimi resume` does not replay the fire.
   *
   * Fire-and-forget: the scheduler does not wait for persistence to
   * settle. One-shot tasks do not invoke this callback (the
   * `removeOneShot` path handles them).
   */
  readonly onAdvanceCursor?: (taskId: string, lastFiredAt: number) => void;

  /**
   * Optional. Poll interval for the auto-tick setInterval, in ms.
   *   - undefined (default) → 1000ms.
   *   - 0 or null → no automatic polling. Caller drives tick()
   *     manually.
   *
   * Used by P1.8 to wire `KIMI_CRON_MANUAL_TICK=1` to disable the
   * timer.
   */
  readonly pollIntervalMs?: number | null;
}

export interface CronScheduler {
  /** Begin the auto-tick loop. Idempotent — calling twice is a no-op. */
  start(): void;

  /**
   * Stop the auto-tick loop and clear any in-flight bookkeeping.
   * Idempotent.
   */
  stop(): Promise<void>;

  /**
   * Run one check cycle synchronously. Safe to call before start() or
   * after stop().
   */
  tick(): void;

  /**
   * Earliest theoretical (post-jitter) next fire across all current
   * tasks, or null if there are no tasks or none have a future fire.
   * Used by /cron and by external monitoring.
   */
  getNextFireTime(): number | null;

  /**
   * Post-jitter next-fire for a single task using the scheduler's
   * internal `lastSeenAt` baseline. Returns null if the task isn't in
   * the current `source()` snapshot or its expression yields no future
   * fire. Used by CronList so its rendered `nextFireAt` matches what
   * the scheduler will actually deliver, including the in-flight
   * jittered slot of the current period.
   */
  getNextFireForTask(taskId: string): number | null;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * Cap on how many ideal fires we attempt to enumerate when computing
 * coalescedCount. With a 1-minute cron, this still covers 10 000
 * minutes (~7 days). Beyond that we'd rather report 10 000 than spin —
 * the LLM only needs the order of magnitude.
 */
const MAX_COALESCE_ITERATIONS = 10_000;

export function createCronScheduler(opts: CronSchedulerOptions): CronScheduler {
  const {
    clocks,
    source,
    onFire,
    isIdle,
    isKilled,
    removeOneShot,
    onAdvanceCursor,
    pollIntervalMs,
  } = opts;

  // Cached parsed cron expressions. Keyed by the raw expression
  // string. Per-session task counts are tiny, so we never evict.
  const parsedCache = new Map<string, ParsedCronExpression>();

  // Per-task wall-clock baseline for "where did we last look from".
  // Now persisted across `kimi resume` via `task.lastFiredAt`: when
  // the scheduler first sees a task whose `lastFiredAt` is set and
  // not in the future, that timestamp seeds this map so resume does
  // not coalesce-replay already-delivered recurring fires. A bogus
  // `lastFiredAt > now` (clock skew / corrupt store) is ignored and
  // the scheduler falls back to `createdAt`, matching pre-persistence
  // behaviour for that task.
  const lastSeenAt = new Map<string, number>();

  // Tracks which task ids have already had `lastFiredAt` consulted
  // during this scheduler's lifetime, so the seeding above happens
  // exactly once per task per scheduler instance. Without this, a
  // task whose cursor was advanced *during* the session would have
  // its in-memory map entry silently overwritten back to the
  // persisted (older) value on the next tick.
  const seededFromDisk = new Set<string>();

  // Defensive re-entry guard for the duration of a single tick.
  const inFlight = new Set<string>();

  let timerHandle: ReturnType<typeof setInterval> | null = null;

  function getParsed(expr: string): ParsedCronExpression {
    const cached = parsedCache.get(expr);
    if (cached !== undefined) return cached;
    const parsed = parseCronExpression(expr);
    parsedCache.set(expr, parsed);
    return parsed;
  }

  function debugLog(message: string): void {
    if (process.env['KIMI_CRON_DEBUG'] === '1') {
      process.stderr.write(`[cron/scheduler] ${message}\n`);
    }
  }

  /**
   * Compute the jittered next-fire for a task, starting from `baseMs`.
   * Returns null when the cron expression has no future fire within
   * the search budget (legal-but-never-fires expression).
   */
  function computeJitteredNext(
    task: CronTask,
    parsed: ParsedCronExpression,
    baseMs: number,
  ): number | null {
    const ideal = computeNextCronRun(parsed, baseMs);
    if (ideal === null) return null;
    if (task.recurring === false) {
      return oneShotJitteredNextCronRunMs(task, ideal);
    }
    return jitteredNextCronRunMs(task, parsed, ideal);
  }

  /**
   * Count how many ideal fires fall in `(firstFireMs, nowMs]` whose
   * **jittered delivery time** is also ≤ `nowMs`. Returns the count
   * plus the timestamp of the last ideal occurrence that satisfied the
   * jittered-due test — used by the caller as the new `lastSeenAt`
   * baseline so the next scheduler pass still sees any later
   * occurrence whose jittered delivery slipped past `nowMs`.
   *
   * Counting against `nowMs` alone (without re-applying jitter) over-
   * counted on jobs whose jitter offset pushed the next ideal fire
   * past the scheduler wake-up window; the caller would then advance
   * `lastSeenAt` past that occurrence and the jittered delivery would
   * never happen. The fix is to gate the counting loop on the same
   * jitter the delivery path uses.
   *
   * Always returns at least 1 — every actual fire is one occurrence.
   * Capped at MAX_COALESCE_ITERATIONS as a defence against runaway
   * loops; an expression that produces more than 10 000 fires in the
   * gap is degenerate and the LLM only needs the order of magnitude.
   */
  function countCoalesced(
    task: CronTask,
    parsed: ParsedCronExpression,
    firstFireMs: number,
    nowMs: number,
  ): { count: number; lastDueMs: number } {
    let count = 1;
    let cursor = firstFireMs;
    let lastDueMs = firstFireMs;
    while (count < MAX_COALESCE_ITERATIONS) {
      const next = computeNextCronRun(parsed, cursor);
      if (next === null) break;
      if (next > nowMs) break;
      // The scheduler delivers at the jittered time, not the ideal
      // one. Counting an ideal fire whose jitter pushes its delivery
      // past `nowMs` would leak the occurrence — the caller advances
      // `lastSeenAt` past it and the next tick can never re-pick it.
      const jitteredNext =
        task.recurring === false
          ? oneShotJitteredNextCronRunMs(task, next)
          : jitteredNextCronRunMs(task, parsed, next);
      if (jitteredNext > nowMs) break;
      count++;
      cursor = next;
      lastDueMs = next;
    }
    return { count, lastDueMs };
  }

  function tick(): void {
    if (isKilled?.() === true) return;
    if (!isIdle()) return;

    const tasks = source();
    if (tasks.length === 0) return;

    const now = clocks.wallNow();

    // We clear inFlight at the end of the tick; entry-time defence
    // against re-entry handled by the `inFlight.has(id)` skip below.
    try {
      for (const task of tasks) {
        try {
          if (inFlight.has(task.id)) continue;

          const parsed = getParsed(task.cron);

          // First time we see this task in this scheduler instance,
          // seed `lastSeenAt` from the persisted `task.lastFiredAt`
          // (when present and sane). This is the one-line fix for
          // "resume replays yesterday's already-fired 09:00 cron":
          // without seeding, the baseline below would fall back to
          // `task.createdAt` and `countCoalesced` would treat every
          // ideal fire since creation as still due. A `lastFiredAt`
          // strictly greater than `now` is treated as corrupt (clock
          // skew, mis-set bench env) and ignored — never trust a
          // stored cursor enough to *skip* a legitimately-due fire.
          if (
            !seededFromDisk.has(task.id) &&
            task.lastFiredAt !== undefined &&
            Number.isFinite(task.lastFiredAt) &&
            task.lastFiredAt <= now &&
            !lastSeenAt.has(task.id)
          ) {
            lastSeenAt.set(task.id, task.lastFiredAt);
          }
          seededFromDisk.add(task.id);

          // Base from which to compute the next ideal fire. For a
          // freshly-added task this is its createdAt; once we've fired
          // (or seen it pass), bump to the wall clock at that moment
          // so we don't double-count the same fire on the next tick.
          const seen = lastSeenAt.get(task.id);
          const baseFromMs =
            seen !== undefined && seen > task.createdAt ? seen : task.createdAt;

          const nextFireAt = computeJitteredNext(task, parsed, baseFromMs);
          if (nextFireAt === null) continue;

          if (now < nextFireAt) continue;

          // Due — compute coalescedCount starting from the first
          // ideal fire (not the jittered one — jitter only shifts the
          // delivery point, not the underlying schedule). One-shot
          // tasks are removed after a single delivery and must always
          // report `coalescedCount: 1`; multi-occurrence semantics
          // make no sense for "remind me at X" reminders that were
          // simply slept-through.
          const ideal = computeNextCronRun(parsed, baseFromMs);
          let coalescedCount = 1;
          let lastDueMs: number | null = null;
          if (task.recurring !== false && ideal !== null) {
            const result = countCoalesced(task, parsed, ideal, now);
            coalescedCount = Math.max(1, result.count);
            lastDueMs = result.lastDueMs;
          }

          inFlight.add(task.id);
          let delivered = false;
          try {
            onFire(task, { coalescedCount });
            delivered = true;
          } catch (error) {
            debugLog(
              `onFire threw for task ${task.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }

          if (!delivered) {
            // Leave lastSeenAt/store untouched — next tick will
            // re-detect this task as due. A persistently-throwing
            // onFire becomes loud retry rather than silent loss; the
            // manager is the layer responsible for ironing out
            // persistence-level failures so they don't reach here.
            continue;
          }

          if (task.recurring === false) {
            // One-shot: ask the caller to remove and drop our memory of it.
            try {
              removeOneShot?.(task.id);
            } catch (error) {
              debugLog(
                `removeOneShot threw for task ${task.id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
            lastSeenAt.delete(task.id);
            seededFromDisk.delete(task.id);
          } else {
            // Recurring: advance the baseline to the last ideal fire
            // whose jittered delivery has actually completed (or to
            // `now` if no ideal fires were enumerated). Using the
            // *delivered* timestamp — rather than `now` — keeps any
            // later ideal fire whose jitter pushes its delivery past
            // `now` reachable on the next tick. If `lastDueMs` is
            // null (degenerate cron / no enumerated ideal) we fall
            // back to `now`, matching the original behaviour.
            const advancedTo = lastDueMs ?? now;
            lastSeenAt.set(task.id, advancedTo);
            // Mirror the cursor to the manager so it can persist
            // through to disk. Fire-and-forget — the callback is
            // expected to schedule the write asynchronously; throws
            // are swallowed here so a flaky writer never poisons the
            // tick loop. The persistence path is the manager's
            // responsibility (consistent with addTask / removeTasks).
            try {
              onAdvanceCursor?.(task.id, advancedTo);
            } catch (error) {
              debugLog(
                `onAdvanceCursor threw for task ${task.id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        } catch (error) {
          // A single bad task must not stop the rest of the loop.
          debugLog(
            `tick failed for task ${task.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } finally {
      // onFire is synchronous so re-entrant ticks within the same
      // call stack are the only thing inFlight defends against. Clear
      // at end-of-tick to keep the invariant simple.
      inFlight.clear();
    }
  }

  function start(): void {
    if (timerHandle !== null) return;

    const interval =
      pollIntervalMs === undefined ? DEFAULT_POLL_INTERVAL_MS : pollIntervalMs;
    // 0 and null both mean "no automatic polling".
    if (interval === null || interval === 0) return;

    const handle = setInterval(tick, interval);
    // Don't keep the event loop alive on the scheduler alone — the
    // user's REPL / agent owns lifetime.
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      (handle as { unref: () => void }).unref();
    }
    timerHandle = handle;
  }

  async function stop(): Promise<void> {
    if (timerHandle !== null) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
    inFlight.clear();
    lastSeenAt.clear();
    seededFromDisk.clear();
    parsedCache.clear();
    // Async signature for forward compatibility with Phase 2 (file
    // I/O cleanup, lock release). Session-only resolves immediately.
  }

  function nextFireFor(task: CronTask): number | null {
    try {
      const parsed = getParsed(task.cron);
      const seen = lastSeenAt.get(task.id);
      // Mirror tick()'s seeding: when the scheduler has not yet ticked
      // this session, consult `task.lastFiredAt` so CronList renders
      // the resume-corrected nextFireAt instead of a value re-derived
      // from `createdAt`. Bogus values (future timestamp) are ignored,
      // identical to tick()'s sanity gate.
      const persistedCursor =
        task.lastFiredAt !== undefined &&
        Number.isFinite(task.lastFiredAt) &&
        task.lastFiredAt <= clocks.wallNow()
          ? task.lastFiredAt
          : undefined;
      const cursor =
        seen !== undefined
          ? seen
          : persistedCursor !== undefined
            ? persistedCursor
            : undefined;
      const baseFromMs =
        cursor !== undefined && cursor > task.createdAt ? cursor : task.createdAt;
      return computeJitteredNext(task, parsed, baseFromMs);
    } catch (error) {
      debugLog(
        `getNextFireFor skipping task ${task.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  function getNextFireTime(): number | null {
    const tasks = source();
    if (tasks.length === 0) return null;

    let min: number | null = null;
    for (const task of tasks) {
      const next = nextFireFor(task);
      if (next === null) continue;
      if (min === null || next < min) min = next;
    }
    return min;
  }

  function getNextFireForTask(taskId: string): number | null {
    const tasks = source();
    const task = tasks.find((t) => t.id === taskId);
    if (task === undefined) return null;
    return nextFireFor(task);
  }

  return {
    start,
    stop,
    tick,
    getNextFireTime,
    getNextFireForTask,
  };
}
