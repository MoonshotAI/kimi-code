// src/maintenance.ts
//
// Unified maintenance scheduler (stage 6). Every heavy maintenance task of a
// MiniDb instance — a compaction, a persistent-generation build — runs
// through one scheduler, which enforces the resource budgets the plan calls
// for:
//
//   - at most ONE heavy maintenance task per database at a time (the rest
//     queue; a queued same-kind submission dedupes onto it);
//   - a process-wide CPU-worker slot cap (the workerized text build must
//     acquire a slot before spawning its worker thread);
//   - queue backpressure: a full queue rejects new submissions loudly;
//   - deadline/cancellation through an AbortSignal handed to the task;
//   - a disk free-space preflight before a task starts;
//   - shutdown drain/cancel: a task that reached its publishing critical
//     section is awaited; everything still queued or running is cancelled;
//   - observable states: queued/running/publishing/failed/complete.
//
// The business API stays at the MiniDb level ("compact", "rebuild the index
// generation"): callers never see workers, file paths, or thread details.
// Internal to the package — NOT re-exported from the root entry point; the
// public surface is MiniDb.maintenanceStatus().

import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { OpTracker } from './op-tracker.js';

export type MaintenanceKind = 'compact' | 'generation-build' | 'text-build';
export type MaintenanceState = 'queued' | 'running' | 'publishing' | 'failed' | 'complete';

/** Stable, serializable view of one task (MiniDb.maintenanceStatus()). */
export interface MaintenanceTaskInfo {
  id: number;
  kind: MaintenanceKind;
  state: MaintenanceState;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

/** The handle a running task gets: cancellation + phase reporting. */
export interface MaintenanceContext {
  /** Aborted on scheduler close (unless the task reported publishing) and on
   *  the task's deadline. Tasks must observe it (worker termination, scan
   *  cancellation). */
  readonly signal: AbortSignal;
  /** Mark the task as inside its publishing critical section: shutdown then
   *  WAITS for the task instead of cancelling it. One-way (a publish that
   *  started must finish or fail). */
  markPublishing(): void;
}

interface Task {
  id: number;
  kind: MaintenanceKind;
  state: MaintenanceState;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  run: (ctx: MaintenanceContext) => Promise<void>;
  controller: AbortController;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  promise?: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class MaintenanceBackpressureError extends Error {
  readonly code = 'MAINTENANCE_BACKPRESSURE';
  constructor(kind: MaintenanceKind) {
    super(`maintenance queue is full; cannot queue ${kind}`);
    this.name = 'MaintenanceBackpressureError';
  }
}

export class MaintenanceClosedError extends Error {
  readonly code = 'MAINTENANCE_CLOSED';
  constructor() {
    super('maintenance scheduler is closed');
    this.name = 'MaintenanceClosedError';
  }
}

export class MaintenanceCancelledError extends Error {
  readonly code = 'MAINTENANCE_CANCELLED';
  constructor(kind: MaintenanceKind | 'generation-build') {
    super(`maintenance task ${kind} was cancelled`);
    // Named AbortError so cancellation routes like other abort flows.
    this.name = 'AbortError';
  }
}

const HISTORY_LIMIT = 16;

export interface MaintenanceSchedulerOptions {
  /** Max queued tasks waiting for the running one; submissions beyond it are
   *  rejected with MaintenanceBackpressureError (same-kind submissions
   *  dedupe instead — see submit). Default 4. */
  maxQueue?: number;
  /** Free-space preflight: returns the bytes the task is expected to need,
   *  or null to skip the check. Wired by the owner (MiniDb knows the file
   *  sizes); the scheduler performs the statfs. */
  estimateBytes?: (kind: MaintenanceKind) => Promise<number | null>;
  /** statfs injection point (tests). Defaults to node:fs/promises.statfs. */
  statfs?: (dir: string) => Promise<{ bavail: number; bsize: number }>;
  /** The database directory (for the free-space preflight). */
  dir: string;
}

export class MaintenanceScheduler {
  private nextId = 1;
  private running: Task | null = null;
  private readonly queue: Task[] = [];
  private readonly history: MaintenanceTaskInfo[] = [];
  private closed = false;
  private readonly tracker = new OpTracker();
  private readonly maxQueue: number;
  private readonly estimateBytes?: (kind: MaintenanceKind) => Promise<number | null>;
  private readonly statfsFn: (dir: string) => Promise<{ bavail: number; bsize: number }>;
  private readonly dir: string;
  /** The task whose run() is currently on the stack: a NESTED submission
   *  from inside a task (compaction's onCompacted hook submitting a
   *  generation build) must not queue behind its own task — that
   *  self-deadlocks the one-at-a-time invariant. Nested submissions run
   *  inline within the submitting task instead. */
  private readonly als = new AsyncLocalStorage<Task>();

  constructor(opts: MaintenanceSchedulerOptions) {
    this.maxQueue = opts.maxQueue ?? 4;
    this.estimateBytes = opts.estimateBytes;
    this.statfsFn = opts.statfs ?? (async (dir: string) => (await import('node:fs/promises')).statfs(dir));
    this.dir = opts.dir;
  }

  /** Snapshot of every live task plus the most recent finished ones. */
  status(): MaintenanceTaskInfo[] {
    const out: MaintenanceTaskInfo[] = [];
    const push = (t: Task): void => {
      out.push({ id: t.id, kind: t.kind, state: t.state, queuedAt: t.queuedAt, startedAt: t.startedAt, finishedAt: t.finishedAt, error: t.error });
    };
    if (this.running) push(this.running);
    for (const t of this.queue) push(t);
    return [...out, ...this.history];
  }

  /** The currently running task's kind (diagnostics/tests). */
  get runningKind(): MaintenanceKind | null {
    return this.running?.kind ?? null;
  }

  /** Whether a task of this kind is waiting in the queue. */
  hasQueued(kind: MaintenanceKind): boolean {
    return this.queue.some((t) => t.kind === kind);
  }

  /**
   * Queue a heavy task. At most one task runs at a time; a same-kind task
   * already queued or running is NOT duplicated — the caller receives the
   * in-flight task's promise (dedupe backpressure). A full queue of
   * other-kind tasks rejects with MaintenanceBackpressureError.
   */
  submit(
    kind: MaintenanceKind,
    run: (ctx: MaintenanceContext) => Promise<void>,
    opts: { deadlineMs?: number } = {},
  ): Promise<void> {
    // Nested submission from inside a running task: queueing it behind the
    // current task would self-deadlock (the task awaits the submission, the
    // submission awaits the task). It runs INLINE, inside the submitter's
    // task, sharing its cancellation; it does not appear as a separate task
    // (it is part of the outer task's work, e.g. compaction's generation
    // publish hook).
    const current = this.als.getStore();
    if (current) {
      if (current.kind === kind) return current.promise ?? Promise.resolve();
      return run({
        signal: current.controller.signal,
        markPublishing: () => {
          if (current.state === 'running') current.state = 'publishing';
        },
      });
    }
    if (this.closed) return Promise.reject(new MaintenanceClosedError());
    if (this.running?.kind === kind) return this.promiseOf(this.running);
    const queued = this.queue.find((t) => t.kind === kind);
    if (queued) return this.promiseOf(queued);
    if (this.queue.length >= this.maxQueue) return Promise.reject(new MaintenanceBackpressureError(kind));
    if (!this.tracker.enter()) return Promise.reject(new MaintenanceClosedError());

    const task: Task = {
      id: this.nextId++,
      kind,
      state: 'queued',
      queuedAt: Date.now(),
      run,
      controller: new AbortController(),
      resolve: () => {},
      reject: () => {},
    };
    const promise = new Promise<void>((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
    });
    task.promise = promise;
    if (opts.deadlineMs !== undefined) {
      task.deadlineTimer = setTimeout(() => task.controller.abort(), opts.deadlineMs);
      task.deadlineTimer.unref?.();
    }
    this.queue.push(task);
    void this.pump();
    return promise;
  }

  private promiseOf(task: Task): Promise<void> {
    return task.promise!;
  }

  private async pump(): Promise<void> {
    if (this.running !== null) return;
    const task = this.queue.shift();
    if (!task) return;
    this.running = task;
    task.state = 'running';
    task.startedAt = Date.now();
    try {
      await this.preflight(task.kind);
    } catch (e) {
      this.finish(task, e);
      void this.pump();
      return;
    }
    const ctx: MaintenanceContext = {
      signal: task.controller.signal,
      markPublishing: () => {
        if (task.state === 'running') task.state = 'publishing';
      },
    };
    try {
      await this.als.run(task, () => task.run(ctx));
      this.finish(task, null);
    } catch (e) {
      this.finish(task, e);
    }
    void this.pump();
  }

  /** Disk free-space preflight: a task whose estimated footprint exceeds the
   *  filesystem's available bytes fails BEFORE doing any work (the ENOSPC
   *  surfaces as a clean task failure, never a half-written artifact). A
   *  statfs failure or a null estimate skips the check — the preflight must
   *  never block maintenance on platforms without statfs. */
  private async preflight(kind: MaintenanceKind): Promise<void> {
    if (!this.estimateBytes) return;
    const need = await this.estimateBytes(kind);
    if (need === null || need <= 0) return;
    let free: number;
    try {
      const st = await this.statfsFn(this.dir);
      free = st.bavail * st.bsize;
    } catch {
      return;
    }
    if (free < need) {
      const err = new Error(`insufficient disk space for ${kind}: need ~${need} bytes, have ${free} bytes`);
      (err as { code?: string }).code = 'ENOSPC_PREFLIGHT';
      throw err;
    }
  }

  private finish(task: Task, error: unknown): void {
    if (task.deadlineTimer) clearTimeout(task.deadlineTimer);
    task.state = error ? 'failed' : 'complete';
    task.finishedAt = Date.now();
    if (error) {
      task.error = error instanceof Error ? error.message : `non-Error thrown: ${Object.prototype.toString.call(error)}`;
      task.reject(error);
    } else {
      task.resolve();
    }
    this.history.unshift({ id: task.id, kind: task.kind, state: task.state, queuedAt: task.queuedAt, startedAt: task.startedAt, finishedAt: task.finishedAt, error: task.error });
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
    if (this.running === task) this.running = null;
    this.tracker.leave();
  }

  /**
   * Shutdown (plan 12's drain/cancel): cancel every queued task and every
   * running task that has NOT reached its publishing critical section;
   * publishing tasks are awaited. Resolves once every task settled.
   * Idempotent; after close() new submissions reject with
   * MaintenanceClosedError.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.queue.splice(0)) {
      if (t.deadlineTimer) clearTimeout(t.deadlineTimer);
      t.state = 'failed';
      t.finishedAt = Date.now();
      t.error = 'cancelled by shutdown';
      t.reject(new MaintenanceCancelledError(t.kind));
      this.history.unshift({ id: t.id, kind: t.kind, state: t.state, queuedAt: t.queuedAt, startedAt: t.startedAt, finishedAt: t.finishedAt, error: t.error });
      this.tracker.leave();
    }
    const running = this.running;
    if (running && running.state !== 'publishing') running.controller.abort();
    await this.tracker.close();
  }
}

/** Process-wide cap on concurrently spawned maintenance worker threads
 * (stage 6's CPU-worker budget). A worker build acquires a slot before
 * spawning and releases it when the worker exits; additional builds wait (or
 * the caller falls back to the in-thread path). */
export class WorkerSlots {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(readonly total: number) {
    this.available = total;
  }

  /** Try to take a slot without waiting. */
  tryAcquire(): (() => void) | null {
    if (this.available <= 0) return null;
    this.available--;
    return () => this.release();
  }

  /** Wait for a slot (observing the optional abort signal). */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    const immediate = this.tryAcquire();
    if (immediate) return immediate;
    if (signal?.aborted) throw new MaintenanceCancelledError('generation-build');
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new MaintenanceCancelledError('generation-build'));
      };
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve(() => this.release());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(grant);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available++;
  }
}

/** The process-wide default worker slot pool: half the CPUs, at least one,
 *  capped at two — one worker build already saturates a core for seconds,
 *  and the main thread must stay responsive. */
export const defaultWorkerSlots = new WorkerSlots(Math.max(1, Math.min(2, Math.floor(os.cpus().length / 2))));
