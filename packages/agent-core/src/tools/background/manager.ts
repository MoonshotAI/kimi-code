/**
 * BackgroundProcessManager — manages background tasks.
 *
 * Tracks background bash tasks and background subagent tasks.
 *
 * Each task gets a unique ID, captures stdout+stderr to a ring buffer,
 * and supports status query / output retrieval / stop operations.
 *
 * Accepts `KaosProcess` (not `ChildProcess`) so there is no unsafe cast
 * at the BashTool call site. Lifecycle detection uses `wait()` instead
 * of EventEmitter `on('exit')`.
 */

import { randomBytes } from 'node:crypto';

import type { KaosProcess } from '@moonshot-ai/kaos';

import {
  appendTaskOutput,
  listTasks,
  readTaskOutput,
  readTaskOutputBytes,
  removeTask,
  taskOutputExists,
  taskOutputExistsSync,
  taskOutputFile,
  taskOutputSizeBytes,
  writeTask,
  type PersistedTask,
} from './persist';
import { ProcessBackgroundTask } from './process-task';
import {
  TERMINAL_BACKGROUND_TASK_STATUSES,
  type BackgroundTask,
  type BackgroundTaskInfo,
  type BackgroundTaskInfoBase,
  type BackgroundTaskSink,
  type BackgroundTaskStatus,
} from './task';

// ── Types ────────────────────────────────────────────────────────────

/**
 * `'lost'` is a reconcile-only terminal state. Tasks loaded from disk
 * that were marked `running` at startup but have no live KaosProcess
 * (the previous CLI process died) are reclassified as lost.
 *
 * `'awaiting_approval'` is a non-terminal state entered when a background
 * agent task is paused waiting for tool-call approval from the root
 * agent. The BPM state machine is the single source of truth for "is
 * this task actively running vs. gated on approval" — UI reads from BPM
 * instead of reverse-querying the ApprovalRuntime. The loop boundary is
 * preserved because `awaiting_approval` in BPM does not leak permission
 * vocabulary into the loop.
 */
/** Terminal states tasks never leave once reached. */
const TERMINAL_STATUSES = TERMINAL_BACKGROUND_TASK_STATUSES;

export function isBackgroundTaskTerminal(status: BackgroundTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export type { AgentBackgroundTaskInfo } from './agent-task';
export type { ProcessBackgroundTaskInfo } from './process-task';
export type {
  BackgroundTaskInfo,
  BackgroundTaskKind, BackgroundTaskStatus
} from './task';

/** Lifecycle phases observed by `onLifecycle` subscribers. */
export type BackgroundLifecycleEvent = 'started' | 'updated' | 'terminated';

interface ManagedTask {
  readonly taskId: string;
  readonly task: BackgroundTask;
  readonly outputChunks: string[];
  /** Total UTF-8 bytes observed, including chunks dropped from the live ring buffer. */
  outputSizeBytes: number;
  status: BackgroundTaskStatus;
  readonly startedAt: number;
  endedAt: number | null;
  /** Listeners awaiting task completion. */
  readonly waiters: Array<() => void>;
  /** True once `fireTerminalCallbacks` has already run. */
  terminalFired: boolean;
  /** Reason carried while awaiting approval. */
  approvalReason?: string | undefined;
  /** Reason recorded when a task is explicitly stopped or aborted. */
  stopReason?: string | undefined;
  /** Deadline supplied at registration; surfaced via task info. */
  timeoutMs?: number | undefined;
  /** Non-terminal-reclassification reason (e.g. stale heartbeat). */
  failureReason?: string | undefined;
  /** Cancellation signal owned by the manager and observed by the concrete task. */
  readonly abortController: AbortController;
  /** Session dir captured at registration for output.log writes. */
  readonly outputSessionDir?: string | undefined;
  lifecyclePromise: Promise<void>;
  persistWriteQueue: Promise<void>;
  outputWriteQueue: Promise<void>;
}

/**
 * Maximum bytes of combined output kept in the in-memory ring buffer per
 * task. When exceeded, the oldest chunks are dropped.
 *
 * The ring buffer is a lightweight tail intended for the `/tasks` UI and
 * terminal notifications only — it deliberately discards old output to
 * cap memory. It is NOT the authoritative full output: the complete,
 * never-truncated log lives on disk at `<sessionDir>/tasks/<id>/output.log`.
 * Callers that need the full output (e.g. `TaskOutput`) must read the
 * disk log via `getOutputSizeBytes` / `readOutputBytesFromDisk`.
 */
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB

const SIGTERM_GRACE_MS = 5_000;
const EXIT_SETTLE_GRACE_MS = 10;

const _ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Generate `{prefix}-{8 base36 chars}`.
 *
 * `randomBytes(8) % 36` has a modest modulo bias (256 % 36 = 4) but
 * over an 8-char suffix yields ~36^8 ≈ 2.8e12 distinct ids which is
 * more than enough uniqueness for per-session task ids.
 */
export function generateTaskId(kind: string): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let i = 0; i < 8; i++) {
    suffix += _ALPHABET[bytes[i]! % 36];
  }
  return `${kind}-${suffix}`;
}

/**
 * Terminal-state info for tasks reconciled as lost on resume. They
 * have no live KaosProcess and no captured output (the buffer died
 * with the previous process), so list/get returns this minimal record.
 */
export interface ReconcileResult {
  /** Task IDs that were marked `lost` because their process is gone. */
  readonly lost: readonly string[];
  /** Snapshot of each lost task's persisted info for terminal notifications. */
  readonly lostInfo: readonly BackgroundTaskInfo[];
}

export interface BackgroundProcessManagerOptions {
  readonly maxRunningTasks?: number;
  readonly sessionDir?: string;
}

export interface BackgroundTaskReservation {
  release(): void;
}

export interface BackgroundTaskOutputSnapshot {
  readonly outputPath?: string;
  readonly outputSizeBytes: number;
  readonly previewBytes: number;
  readonly truncated: boolean;
  readonly fullOutputAvailable: boolean;
  readonly preview: string;
}

function emptyOutputSnapshot(): BackgroundTaskOutputSnapshot {
  return {
    outputSizeBytes: 0,
    previewBytes: 0,
    truncated: false,
    fullOutputAvailable: false,
    preview: '',
  };
}

// ── Manager ──────────────────────────────────────────────────────────

export class BackgroundProcessManager {
  private readonly tasks = new Map<string, ManagedTask>();
  private reservedTaskSlots = 0;
  /**
   * Ghosts: tasks loaded from disk during reconcile that have no live
   * KaosProcess. They appear in `list()` / `getTask()` with status
   * `lost` so users see what was running before the crash/restart.
   */
  private readonly ghosts = new Map<string, BackgroundTaskInfo>();
  /** When set, register/lifecycle changes persist to disk. */
  private sessionDir: string | undefined;

  /**
   * Registered terminal-state callbacks. Fired once per task when the
   * task reaches a terminal state (completed / failed / timed_out / killed).
   */
  private readonly terminalCallbacks: Array<(info: BackgroundTaskInfo) => void | Promise<void>> =
    [];

  /**
   * Registered lifecycle callbacks. Fired for every observable
   * transition (started / updated / terminated). Errors thrown by
   * callbacks are silently swallowed so the BPM main flow never breaks
   * because of a buggy subscriber.
   */
  private readonly lifecycleCallbacks: Array<
    (event: BackgroundLifecycleEvent, info: BackgroundTaskInfo) => void
  > = [];

  constructor(private readonly options: BackgroundProcessManagerOptions = {}) {
    this.sessionDir = options.sessionDir;
  }

  /**
   * Register a callback that fires when any task reaches a terminal
   * state. The callback receives the task's `BackgroundTaskInfo`
   * snapshot. Multiple callbacks may be registered; they are invoked in
   * registration order. Errors thrown by callbacks are silently swallowed.
   */
  onTerminal(callback: (info: BackgroundTaskInfo) => void | Promise<void>): void {
    this.terminalCallbacks.push(callback);
  }

  /**
   * Register a callback that fires on every lifecycle transition:
   *   - 'started':    task just registered (either bash or agent)
   *   - 'updated':    awaiting_approval entered / cleared
   *   - 'terminated': task reached a terminal state (also triggers
   *                   onTerminal); fires exactly once per task.
   *
   * Synchronous callback. Errors are swallowed so the BPM lifecycle
   * machinery (status updates, persistence, waiters) cannot be blocked
   * by a buggy subscriber. Use it for fan-out to RPC events; do not put
   * heavy work in it (defer to microtask if needed).
   */
  onLifecycle(callback: (event: BackgroundLifecycleEvent, info: BackgroundTaskInfo) => void): void {
    this.lifecycleCallbacks.push(callback);
  }

  /** Fan out a lifecycle event to subscribers. */
  private fireLifecycle(event: BackgroundLifecycleEvent, info: BackgroundTaskInfo): void {
    for (const cb of this.lifecycleCallbacks) {
      try {
        cb(event, info);
      } catch {
        /* swallow callback errors */
      }
    }
  }

  /**
   * Subclasses can react to live task completion here. Restored disk
   * tasks reconciled as lost do not call this hook.
   */
  protected onLiveTaskTerminal(_info: BackgroundTaskInfo): void | Promise<void> {}

  /**
   * Fire all registered terminal callbacks for a task. Idempotent: the
   * second invocation for the same task is a no-op so `reconcile()` /
   * a lagging `wait()` resolver / a race between `stop()` and natural
   * exit cannot yield duplicate notifications. This is the manager-side
   * half of the dedupe pact with `NotificationManager.dedupe_key`.
   */
  private fireTerminalCallbacks(entry: ManagedTask): void {
    if (entry.terminalFired) return;
    entry.terminalFired = true;
    const info = this.toInfo(entry);
    try {
      const result = this.onLiveTaskTerminal(info);
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    } catch {
      /* swallow */
    }
    this.fireTerminalSubscribers(info);
  }

  private fireTerminalSubscribers(info: BackgroundTaskInfo): void {
    for (const cb of this.terminalCallbacks) {
      try {
        const result = cb(info);
        if (result && typeof result.catch === 'function') {
          result.catch(() => {});
        }
      } catch {
        /* swallow callback errors */
      }
    }
    this.fireLifecycle('terminated', info);
  }

  private resolveWaiters(entry: ManagedTask): void {
    const waiters = entry.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private createTaskSink(entry: ManagedTask): BackgroundTaskSink {
    return {
      signal: entry.abortController.signal,
      appendOutput: (chunk) => {
        this.appendOutput(entry, chunk);
      },
      settle: (settlement) => this.settleTask(entry, settlement),
    };
  }

  assertCanRegister(): void {
    const maxRunningTasks = this.options.maxRunningTasks;
    if (maxRunningTasks === undefined) return;
    if (this.activeTaskCount() + this.reservedTaskSlots < maxRunningTasks) return;
    throw new Error('Too many background tasks are already running.');
  }

  reserveSlot(): BackgroundTaskReservation {
    const maxRunningTasks = this.options.maxRunningTasks;
    if (maxRunningTasks === undefined) {
      return { release: () => {} };
    }
    this.assertCanRegister();
    this.reservedTaskSlots++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.reservedTaskSlots--;
      },
    };
  }

  private activeTaskCount(): number {
    let count = 0;
    for (const entry of this.tasks.values()) {
      if (!TERMINAL_STATUSES.has(entry.status)) count++;
    }
    return count;
  }

  /**
   * Register a KaosProcess as a background task.
   * Starts capturing stdout/stderr and monitors lifecycle via `wait()`.
   * Returns the assigned task ID.
   *
   * `opts.kind` picks the id prefix. Defaults to `'bash'` because bash
   * subprocess registration is the only caller on the process path today.
   * Agent tasks are constructed by their caller and registered through
   * `registerTask`.
   */
  register(
    proc: KaosProcess,
    command: string,
    description: string,
    opts:
      | {
          kind?: string;
          /**
           * Optional shell metadata. Carried so the `/task` UI and the
           * background persist snapshot can surface which dialect a
           * task was launched under. Legacy callers omitting this
           * field keep the implicit 'bash' default.
           */
          shellInfo?: {
            shellName: string;
            shellPath: string;
            cwd: string;
          };
          reservation?: BackgroundTaskReservation;
        }
      | undefined = undefined,
  ): string {
    return this.registerTask(
      new ProcessBackgroundTask(proc, command, description, { idPrefix: opts?.kind }),
      opts?.reservation,
    );
  }

  registerTask(
    task: BackgroundTask,
    reservation?: BackgroundTaskReservation,
  ): string {
    if (reservation) {
      reservation.release();
    } else {
      this.assertCanRegister();
    }
    const taskId = generateTaskId(task.idPrefix);
    const entry: ManagedTask = {
      taskId,
      task,
      outputChunks: [],
      outputSizeBytes: 0,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      waiters: [],
      terminalFired: false,
      abortController: new AbortController(),
      timeoutMs: task.timeoutMs,
      outputSessionDir: this.sessionDir,
      lifecyclePromise: Promise.resolve(),
      persistWriteQueue: Promise.resolve(),
      outputWriteQueue: Promise.resolve(),
    };
    this.tasks.set(taskId, entry);

    const sink = this.createTaskSink(entry);
    try {
      entry.lifecyclePromise = Promise.resolve(task.start(sink)).catch(async () => {
        await this.settleTask(entry, {
          status: entry.abortController.signal.aborted ? 'killed' : 'failed',
        });
      });
    } catch {
      entry.lifecyclePromise = this.settleTask(entry, {
        status: entry.abortController.signal.aborted ? 'killed' : 'failed',
      }).then(() => {});
    }

    // Initial persistence (snapshot at start).
    void this.persistLive(entry);
    this.fireLifecycle('started', this.toInfo(entry));

    void entry.lifecyclePromise;

    return taskId;
  }

  /** Get info about a specific task. Falls back to reconcile ghosts. */
  getTask(taskId: string): BackgroundTaskInfo | undefined {
    const entry = this.tasks.get(taskId);
    if (entry !== undefined) {
      return this.toInfo(entry);
    }
    return this.ghosts.get(taskId);
  }

  /**
   * Give just-ended processes a short grace period to settle their `wait()`
   * promise, then return with whatever lifecycle state has been finalized.
   */
  async settlePendingExits(): Promise<void> {
    const pendingCompletions = this.observedExitCompletions();
    if (pendingCompletions.length === 0) return;
    await Promise.race([
      Promise.allSettled(pendingCompletions).then(() => {}),
      new Promise<void>((resolve) => {
        setTimeout(resolve, EXIT_SETTLE_GRACE_MS);
      }),
    ]);
  }

  /**
   * List tasks, optionally filtering to active-only.
   *
   * When `activeOnly=false`, includes reconcile ghosts (lost tasks
   * from a prior CLI process) so the user sees what survived the
   * restart. Active-only mode never shows ghosts (they're terminal).
   */
  list(activeOnly = true, limit?: number): BackgroundTaskInfo[] {
    const result: BackgroundTaskInfo[] = [];
    for (const entry of this.tasks.values()) {
      // An awaiting_approval task is non-terminal and therefore counts
      // as active in listings (UI needs to show it alongside plain
      // running tasks).
      if (activeOnly && TERMINAL_STATUSES.has(entry.status)) continue;
      result.push(this.toInfo(entry));
      if (limit !== undefined && result.length >= limit) return result;
    }
    if (!activeOnly) {
      for (const ghost of this.ghosts.values()) {
        result.push(ghost);
        if (limit !== undefined && result.length >= limit) return result;
      }
    }
    return result;
  }

  /**
   * Await all pending `output.log` appends for a task to settle.
   *
   * Output chunks are persisted to disk on an async queue, so a task can
   * reach a terminal state before its final chunks have landed on disk.
   * Callers that read the on-disk log (`getOutputSizeBytes` /
   * `readOutputBytesFromDisk`) should `await flushOutput()` first so they
   * observe the complete log. No-op for unknown/ghost tasks.
   */
  async flushOutput(taskId: string): Promise<void> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return;
    await entry.outputWriteQueue;
  }

  /**
   * Total byte size of a task's full output as stored on disk.
   *
   * Reads `<sessionDir>/tasks/<id>/output.log`, which is the complete,
   * never-truncated log — unlike the in-memory ring buffer it never drops
   * old chunks. Returns 0 when the manager is detached, the task is
   * unknown, or the task has produced no output yet.
   */
  async getOutputSizeBytes(taskId: string): Promise<number> {
    const outputSessionDir = this.outputSessionDirFor(taskId);
    if (outputSessionDir === undefined) return 0;
    return taskOutputSizeBytes(outputSessionDir, taskId);
  }

  /**
   * Read a byte range of a task's full output from the on-disk log.
   *
   * Reads up to `maxBytes` bytes starting at `offset` of `output.log`,
   * straight from disk so it never loses the head of a large task the way
   * the in-memory ring buffer would. Callers derive `offset` and `maxBytes`
   * from a single `getOutputSizeBytes` snapshot, so the bytes returned stay
   * consistent with the size used for metadata even when a still-running
   * task keeps growing its log. Returns an empty string when the manager
   * is detached, the task is unknown, or the log is absent.
   */
  async readOutputBytesFromDisk(
    taskId: string,
    offset: number,
    maxBytes: number,
  ): Promise<string> {
    const outputSessionDir = this.outputSessionDirFor(taskId);
    if (outputSessionDir === undefined) return '';
    return readTaskOutputBytes(outputSessionDir, taskId, offset, maxBytes);
  }

  /**
   * Return the output snapshot used by TaskOutput.
   *
   * Persisted logs are preferred when the task was registered with an
   * output session directory and `output.log` has actually been created,
   * because they are the complete, never-truncated source. Detached managers,
   * tasks registered before a session dir was attached, and silent tasks with
   * no persisted log fall back to the live ring buffer.
   */
  async getOutputSnapshot(
    taskId: string,
    maxPreviewBytes: number,
  ): Promise<BackgroundTaskOutputSnapshot> {
    if (this.getTask(taskId) === undefined) return emptyOutputSnapshot();

    await this.flushOutput(taskId);

    const previewLimit = Math.max(0, Math.trunc(maxPreviewBytes));
    const outputSessionDir = this.outputSessionDirFor(taskId);
    if (outputSessionDir !== undefined && (await taskOutputExists(outputSessionDir, taskId))) {
      const outputSizeBytes = await taskOutputSizeBytes(outputSessionDir, taskId);
      const previewOffset = Math.max(0, outputSizeBytes - previewLimit);
      const previewBytes = outputSizeBytes - previewOffset;
      const preview = await readTaskOutputBytes(
        outputSessionDir,
        taskId,
        previewOffset,
        previewBytes,
      );
      return {
        outputPath: taskOutputFile(outputSessionDir, taskId),
        outputSizeBytes,
        previewBytes,
        truncated: previewOffset > 0,
        fullOutputAvailable: true,
        preview,
      };
    }

    const entry = this.tasks.get(taskId);
    if (entry === undefined) return emptyOutputSnapshot();

    const available = Buffer.from(entry.outputChunks.join(''), 'utf-8');
    const previewBytes = Math.min(previewLimit, available.byteLength, entry.outputSizeBytes);
    const previewOffset = available.byteLength - previewBytes;
    return {
      outputSizeBytes: entry.outputSizeBytes,
      previewBytes,
      truncated: entry.outputSizeBytes > previewBytes,
      fullOutputAvailable: false,
      preview: available.subarray(previewOffset).toString('utf-8'),
    };
  }

  /** Get the combined output of a task (tail of the ring buffer). */
  getOutput(taskId: string, tail?: number): string {
    const entry = this.tasks.get(taskId);
    if (!entry) return '';
    const full = entry.outputChunks.join('');
    if (tail !== undefined && tail < full.length) {
      return full.slice(-tail);
    }
    return full;
  }

  async readOutput(taskId: string, tail?: number): Promise<string> {
    const entry = this.tasks.get(taskId);
    const outputSessionDir = this.outputSessionDirFor(taskId);
    if (outputSessionDir !== undefined) {
      await entry?.outputWriteQueue;
      const persisted = await readTaskOutput(outputSessionDir, taskId);
      if (persisted.length > 0) {
        if (tail !== undefined && tail < persisted.length) {
          return persisted.slice(-tail);
        }
        return persisted;
      }
    }
    return this.getOutput(taskId, tail);
  }

  getOutputPath(taskId: string): string | undefined {
    const outputSessionDir = this.outputSessionDirFor(taskId);
    if (outputSessionDir === undefined) return undefined;
    if (!taskOutputExistsSync(outputSessionDir, taskId)) return undefined;
    return taskOutputFile(outputSessionDir, taskId);
  }

  /** Stop a running task. SIGTERM → 5s grace → SIGKILL. */
  async stop(taskId: string, reason?: string): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
    // Normalize at this shared boundary: every public stop path (the TaskStop
    // tool, SDK/RPC) funnels through here, so a blank or whitespace-only
    // reason must never be recorded as an empty stopReason.
    const trimmedReason = reason?.trim();
    const stopReason =
      trimmedReason === undefined || trimmedReason.length === 0 ? undefined : trimmedReason;
    // Terminal tasks short-circuit. awaiting_approval tasks can still
    // be stopped (the approval gate is lifted when we transition to
    // 'killed').
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    entry.approvalReason = undefined;
    entry.stopReason = stopReason;
    entry.abortController.abort(stopReason);

    // Wait up to 5s for the lifecycle path to settle, then SIGKILL.
    // Waiting on lifecyclePromise, rather than the task directly, lets a
    // natural completion win the race instead of being overwritten here.
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const graceful = await Promise.race([
      entry.lifecyclePromise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        graceTimer = setTimeout(() => {
          resolve(false);
        }, SIGTERM_GRACE_MS);
      }),
    ]);
    if (graceTimer !== undefined) clearTimeout(graceTimer);

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    if (!graceful) {
      try {
        await entry.task.forceStop?.();
      } catch {
        /* ignore */
      }
    }

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    // Tasks whose lifecycle promise never settles need an explicit terminal
    // finalize here after their stop/force-stop hooks have had a chance.
    await this.settleTask(entry, { status: 'killed', stopReason });

    return this.toInfo(entry);
  }

  async stopAll(reason?: string): Promise<readonly BackgroundTaskInfo[]> {
    const taskIds = Array.from(this.tasks.values())
      .filter((entry) => !TERMINAL_STATUSES.has(entry.status))
      .map((entry) => entry.taskId);
    const results = await Promise.all(taskIds.map((taskId) => this.stop(taskId, reason)));
    return results.filter((info): info is BackgroundTaskInfo => info !== undefined);
  }

  /**
   * Wait for a task to reach a terminal state.
   * Returns immediately if already terminal. Times out after `timeoutMs`.
   */
  async wait(taskId: string, timeoutMs = 30_000): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    let terminalWaiter: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          terminalWaiter = resolve;
          entry.waiters.push(resolve);
        }),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (terminalWaiter !== undefined) {
        const index = entry.waiters.indexOf(terminalWaiter);
        if (index !== -1) entry.waiters.splice(index, 1);
      }
    }

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
    }
    return this.toInfo(entry);
  }

  // ── awaiting_approval state transitions ────────────────────────────

  /**
   * Mark a running task as paused pending approval. The approval reason
   * (tool call description) is retained until the task either returns
   * to `'running'` via `clearAwaitingApproval()` or reaches a terminal
   * state. Calls on terminal or unknown tasks are silently ignored so
   * the ApprovalRuntime callback path is race-safe.
   */
  markAwaitingApproval(taskId: string, reason: string): void {
    const entry = this.tasks.get(taskId);
    if (!entry) return;
    if (TERMINAL_STATUSES.has(entry.status)) return;
    entry.status = 'awaiting_approval';
    entry.approvalReason = reason;
    void this.persistLive(entry);
    this.fireLifecycle('updated', this.toInfo(entry));
  }

  /**
   * Drop the approval gate and return to `'running'`. Clears the stored
   * reason so stale text cannot leak into a future `awaiting_approval`
   * cycle. No-op unless the task is currently in the awaiting_approval
   * state.
   */
  clearAwaitingApproval(taskId: string): void {
    const entry = this.tasks.get(taskId);
    if (!entry) return;
    if (entry.status !== 'awaiting_approval') return;
    entry.status = 'running';
    entry.approvalReason = undefined;
    void this.persistLive(entry);
    this.fireLifecycle('updated', this.toInfo(entry));
  }

  // ── completion event (await lifecycle end) ────────────────────────

  /**
   * Resolve when the task reaches a terminal state. If the task is
   * already terminal, resolves synchronously on the next microtask.
   * Intended for integration code that wants to `await` a specific
   * task's exit without installing a full `onTerminal` subscriber.
   * Returns `undefined` for unknown ids (matching `getTask`). Ghost
   * (reconciled-lost) entries are considered terminal from the
   * manager's perspective.
   */
  async waitForTerminal(taskId: string): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return this.ghosts.get(taskId);
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }
    await new Promise<void>((resolve) => {
      entry.waiters.push(resolve);
    });
    await entry.persistWriteQueue;
    return this.toInfo(entry);
  }

  /** Reset internal state (for testing). */
  _reset(): void {
    this.tasks.clear();
    this.ghosts.clear();
    this.sessionDir = undefined;
  }

  // ── persistence + reconcile ────────────────────────────────────────

  /**
   * Attach the manager to a session directory for persistence. Tasks
   * created via `register()` after this call are written to
   * `<sessionDir>/tasks/<task_id>.json` and updated on lifecycle change.
   * Tasks created before attach are NOT retroactively persisted.
   */
  attachSessionDir(sessionDir: string): void {
    this.sessionDir = sessionDir;
  }

  /**
   * Load persisted task records into the ghost map. Does NOT reconcile
   * (call `reconcile()` after `loadFromDisk()`). Idempotent; subsequent
   * calls overwrite the ghost map.
   *
   * Requires `attachSessionDir()` first; no-op otherwise.
   */
  async loadFromDisk(): Promise<void> {
    if (this.sessionDir === undefined) return;
    this.ghosts.clear();
    const persisted = await listTasks(this.sessionDir);
    for (const t of persisted) {
      // Skip ids that already exist as live processes — live wins.
      if (this.tasks.has(t.task_id)) continue;
      this.ghosts.set(t.task_id, persistedToInfo(t));
    }
  }

  /**
   * Reconcile loaded ghost tasks. Any ghost with status `running` is
   * reclassified as `lost` (its previous CLI process died without
   * writing a terminal state). Updates the on-disk record and returns
   * the lost task ids so the caller can emit user-facing notifications.
   */
  protected async markLoadedTasksLost(): Promise<ReconcileResult> {
    const lost: string[] = [];
    const lostInfo: BackgroundTaskInfo[] = [];
    for (const [id, info] of this.ghosts) {
      // Any non-terminal ghost is lost. Includes `awaiting_approval`
      // (the approval context died with the previous process so it
      // cannot be resumed).
      if (TERMINAL_STATUSES.has(info.status)) continue;
      const updated: BackgroundTaskInfo = {
        ...info,
        status: 'lost',
        endedAt: info.endedAt ?? Date.now(),
        approvalReason: undefined,
        failureReason: 'Background worker heartbeat expired',
      };
      this.ghosts.set(id, updated);
      if (this.sessionDir !== undefined) {
        await writeTask(this.sessionDir, infoToPersisted(updated));
      }
      lost.push(id);
      lostInfo.push(updated);
    }
    return { lost, lostInfo };
  }

  async reconcile(): Promise<ReconcileResult> {
    const result = await this.markLoadedTasksLost();
    // Fire onTerminal for newly-lost ghosts so NotificationManager
    // receives a `task.lost` notification. Dedupe on the consumer side
    // is by `dedupe_key`; a second reconcile() on the same ghost is a
    // no-op because the status flips to `lost` above and we guard on
    // TERMINAL_STATUSES on the next pass.
    for (const info of result.lostInfo) {
      this.fireTerminalSubscribers(info);
    }
    return result;
  }

  /** Drop a persisted task from disk and ghost map. */
  async forgetTask(taskId: string): Promise<void> {
    this.ghosts.delete(taskId);
    if (this.sessionDir !== undefined) {
      await removeTask(this.sessionDir, taskId);
    }
  }

  /**
   * Persist the current state of a live ManagedTask. Called from
   * `register()` and the lifecycle finally block. No-op unless attached.
   */
  private persistLive(entry: ManagedTask): Promise<void> {
    if (this.sessionDir === undefined) return Promise.resolve();
    const sessionDir = this.sessionDir;
    const info = this.toInfo(entry);
    const task: PersistedTask = infoToPersisted(info);
    entry.persistWriteQueue = entry.persistWriteQueue
      .then(() => writeTask(sessionDir, task))
      .catch(() => {});
    return entry.persistWriteQueue;
  }

  private appendOutput(entry: ManagedTask, chunk: string): void {
    entry.outputSizeBytes += Buffer.byteLength(chunk, 'utf-8');
    entry.outputChunks.push(chunk);
    // Enforce output cap: drop oldest chunks when over budget.
    let total = entry.outputChunks.reduce((s, c) => s + c.length, 0);
    while (total > MAX_OUTPUT_BYTES && entry.outputChunks.length > 1) {
      const removed = entry.outputChunks.shift();
      if (removed === undefined) break;
      total -= removed.length;
    }

    const outputSessionDir = entry.outputSessionDir;
    if (outputSessionDir === undefined) return;
    entry.outputWriteQueue = entry.outputWriteQueue
      .then(() => appendTaskOutput(outputSessionDir, entry.taskId, chunk))
      .catch(() => {});
  }

  private outputSessionDirFor(taskId: string): string | undefined {
    const entry = this.tasks.get(taskId);
    if (entry !== undefined) return entry.outputSessionDir;
    if (this.ghosts.has(taskId)) return this.sessionDir;
    return undefined;
  }

  private async settleTask(
    entry: ManagedTask,
    settlement: {
      readonly status: 'completed' | 'failed' | 'timed_out' | 'killed';
      readonly stopReason?: string;
    },
  ): Promise<boolean> {
    if (TERMINAL_STATUSES.has(entry.status)) {
      if (entry.status === 'killed' && settlement.status === 'killed') {
        entry.endedAt = Math.max(Date.now(), (entry.endedAt ?? 0) + 1);
        await this.persistLive(entry);
        this.fireTerminalCallbacks(entry);
        this.resolveWaiters(entry);
      }
      return false;
    }
    entry.status = settlement.status;
    entry.endedAt = Date.now();
    entry.stopReason =
      settlement.stopReason ?? (settlement.status === 'killed' ? entry.stopReason : undefined);
    // A task that ended while still in awaiting_approval (e.g. crashed
    // mid-prompt, deadline fired, or got killed) must not leak the
    // stale approvalReason onto the terminal record. The awaiting →
    // running path (clearAwaitingApproval) already clears it; mirror
    // that here for the awaiting → terminal path.
    entry.approvalReason = undefined;
    await this.persistLive(entry);
    this.fireTerminalCallbacks(entry);
    this.resolveWaiters(entry);
    return true;
  }

  private observedExitCompletions(): Promise<void>[] {
    const completions: Promise<void>[] = [];
    for (const entry of this.tasks.values()) {
      if (!TERMINAL_STATUSES.has(entry.status) && entry.task.hasObservedTerminal?.() === true) {
        completions.push(entry.lifecyclePromise);
      }
    }
    return completions;
  }

  private toInfo(entry: ManagedTask): BackgroundTaskInfo {
    const base: BackgroundTaskInfoBase = {
      taskId: entry.taskId,
      kind: entry.task.kind,
      description: entry.task.description,
      status: entry.status,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      approvalReason: entry.approvalReason,
      stopReason: entry.stopReason,
      timeoutMs: entry.timeoutMs,
      failureReason: entry.failureReason,
    };
    return entry.task.toInfo(base);
  }

}

// ── persistence shape <-> in-memory shape ──────────────────────────────

function persistedToInfo(t: PersistedTask): BackgroundTaskInfo {
  const status = t.timed_out === true ? 'timed_out' : t.status;
  const base: BackgroundTaskInfoBase = {
    taskId: t.task_id,
    kind: t.kind ?? (t.task_id.startsWith('agent-') ? 'agent' : 'process'),
    description: t.description,
    status,
    startedAt: t.started_at,
    endedAt: t.ended_at,
    approvalReason: t.approval_reason,
    stopReason: t.stop_reason,
  };
  if (base.kind === 'agent') {
    return {
      ...base,
      kind: 'agent',
      agentId: t.agent_id,
      subagentType: t.subagent_type,
    };
  }
  return {
    ...base,
    kind: 'process',
    command: t.command,
    pid: t.pid,
    exitCode: t.exit_code,
  };
}

function infoToPersisted(info: BackgroundTaskInfo): PersistedTask {
  const command = info.kind === 'process' ? info.command : `[agent] ${info.description}`;
  const pid = info.kind === 'process' ? info.pid : 0;
  return {
    task_id: info.taskId,
    kind: info.kind,
    command,
    description: info.description,
    pid,
    started_at: info.startedAt,
    ended_at: info.endedAt,
    exit_code: info.kind === 'process' ? info.exitCode : null,
    status: info.status,
    approval_reason: info.approvalReason,
    stop_reason: info.stopReason,
    agent_id: info.kind === 'agent' ? info.agentId : undefined,
    subagent_type: info.kind === 'agent' ? info.subagentType : undefined,
  };
}
