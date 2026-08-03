/**
 * SessionCronStore — in-memory cron task store for a single CLI session.
 *
 * The store itself is purely in-memory; cross-restart persistence is
 * layered on top by `CronManager.addTask` / `removeTasks`, which
 * mirror every mutation to `<sessionDir>/cron/<id>.json`. On resume
 * the manager calls {@link adopt} to put each persisted task back into
 * the store with its original id and `createdAt` preserved.
 *
 * The store is intentionally clock-agnostic: it does NOT call
 * `Date.now()` itself. Callers pass `nowMs` (which the cron manager
 * sources from `ClockSources.wallNow()`), so injected clocks in tests
 * and benches stay authoritative. The `no-date-now` guard does not
 * currently list this file, but the discipline matches.
 *
 * Insertion order is preserved by relying on `Map` iteration order —
 * callers (CronList, scheduler `source: () => CronTask[]`) want a
 * stable ordering that matches the user's mental model of "the one I
 * added first comes first".
 */

import { randomBytes } from 'node:crypto';

import type { CronTask } from './types';

/**
 * Input to {@link SessionCronStore.add}: everything the caller supplies,
 * minus `id` and `createdAt` which the store generates.
 */
export type SessionCronTaskInit = Omit<CronTask, 'id' | 'createdAt'>;

/** Matches the canonical cron task id shape (8 lower-hex chars). */
const ID_REGEX = /^[0-9a-f]{8}$/;

/**
 * Upper bound on id-collision retries. With 32 bits of entropy and at
 * most a few dozen live tasks per session, the probability of even one
 * collision is on the order of 1e-8. Eight attempts is a hard ceiling
 * to surface a real bug (e.g. PRNG degeneration) rather than silently
 * spinning.
 */
const MAX_ID_ATTEMPTS = 8;

export class SessionCronStore {
  /**
   * Backing map. `Map` preserves insertion order in JS, which we rely on
   * for {@link list}.
   */
  private readonly tasks = new Map<string, CronTask>();

  /**
   * Generate a fresh 8-hex id and add the task. `createdAt` is set to
   * the supplied `nowMs` — the store never reads its own clock.
   *
   * Throws if the PRNG fails to produce an unused id within
   * {@link MAX_ID_ATTEMPTS} attempts. That should be unreachable in
   * practice; surfacing it as a throw beats silently retrying forever.
   */
  add(init: SessionCronTaskInit, nowMs: number): CronTask {
    const id = this.generateUniqueId();
    const task: CronTask = {
      ...init,
      id,
      createdAt: nowMs,
    };
    this.tasks.set(id, task);
    return task;
  }

  /**
   * Insert a previously-persisted task verbatim — id and createdAt
   * stay as they are on disk. Used by `CronManager.loadFromDisk()` to
   * rehydrate the store on resume. Unlike {@link add}, this does NOT
   * generate a new id; the caller is responsible for ensuring the id
   * matches the expected shape (the persistence layer's regex /
   * shape-guard handle this upstream).
   *
   * Overwrites any existing in-memory task with the same id — reload
   * is a "replace" operation, not a "merge". Callers that want merge
   * semantics should clear the store first.
   */
  adopt(task: CronTask): void {
    this.tasks.set(task.id, task);
  }

  /**
   * Stamp `lastFiredAt` on the in-memory task. Used by the scheduler
   * cursor-advance callback so the value flows back to disk via the
   * manager's persistence path. Returns the updated record (so the
   * manager can hand it straight to the per-id JSON writer), or
   * `undefined` when no task with that id is present — the latter
   * happens harmlessly if a task was concurrently removed between the
   * scheduler's fire and the cursor callback.
   */
  markFired(id: string, lastFiredAt: number): CronTask | undefined {
    const existing = this.tasks.get(id);
    if (existing === undefined) return undefined;
    const updated: CronTask = { ...existing, lastFiredAt };
    this.tasks.set(id, updated);
    return updated;
  }

  /** Returns the task or `undefined`. */
  get(id: string): CronTask | undefined {
    return this.tasks.get(id);
  }

  /**
   * Snapshot in insertion order. Returns a fresh array on every call —
   * callers may mutate the returned array without affecting the store,
   * and successive calls return distinct array references.
   */
  list(): readonly CronTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Remove the given ids. Returns the subset that were actually present
   * (so the caller can detect already-missing ids and report them).
   * Order of the returned ids follows the input order, not insertion
   * order.
   */
  remove(ids: readonly string[]): readonly string[] {
    const removed: string[] = [];
    for (const id of ids) {
      if (this.tasks.delete(id)) {
        removed.push(id);
      }
    }
    return removed;
  }

  /** Empty the store. Convenience for tests / shutdown. */
  clear(): void {
    this.tasks.clear();
  }

  private generateUniqueId(): string {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const candidate = randomBytes(4).toString('hex');
      // randomBytes(4).toString('hex') is always 8 lowercase hex chars,
      // so the regex check is belt-and-braces against future refactors
      // that swap the id source.
      if (!ID_REGEX.test(candidate)) continue;
      if (!this.tasks.has(candidate)) return candidate;
    }
    throw new Error(
      `SessionCronStore: failed to generate a unique 8-hex id after ${MAX_ID_ATTEMPTS} attempts`,
    );
  }
}
