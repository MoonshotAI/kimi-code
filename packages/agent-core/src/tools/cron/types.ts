/**
 * Persistent representation of a cron task.
 *
 *   - `id` — 8-hex; jitter is keyed off this hash, so stable id == stable
 *     jitter across schedule rewrites.
 *   - `cron` — 5-field expression, evaluated in local time.
 *   - `createdAt` — wall-clock epoch ms at original scheduling. NOT updated
 *     when the scheduler fires; recurring uses `max(createdAt, now)` to
 *     re-derive `nextFireAt` after restart. `createdAt` is also the input
 *     to the 7-day stale judgment.
 *   - `recurring` — undefined / true means "fire repeatedly until deleted
 *     or auto-expired"; false means "fire once then auto-delete".
 *   - `durable` — runtime-only field that decides where the task lives
 *     (file vs session-store). It is stripped before writing to tasks.json.
 *
 * Notably absent: `lastFiredAt`. Persisting last-fire would let a fast
 * restart skip a legitimately-due fire because the stored timestamp says
 * "fired recently". Coalesce semantics make missing one fire across a
 * restart acceptable; missing one fire because of bad bookkeeping is not.
 */
export interface CronTask {
  readonly id: string;
  readonly cron: string;
  readonly prompt: string;
  readonly createdAt: number;
  readonly recurring?: boolean;
  readonly durable?: boolean;
}
