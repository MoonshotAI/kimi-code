/**
 * BackgroundProcessManager — manages background shell processes.
 *
 * Tracks background bash tasks spawned by `BashTool` when
 * `run_in_background=true`.
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

import { isAbortError } from '../../loop/errors';
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
export type BackgroundTaskStatus =
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'lost';

/** Terminal states tasks never leave once reached. */
const TERMINAL_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set<BackgroundTaskStatus>([
  'completed',
  'failed',
  'killed',
  'lost',
]);

export function isBackgroundTaskTerminal(status: BackgroundTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Task kinds with distinct id prefixes. */
export type BackgroundTaskKind = 'bash' | 'agent';

/** Lifecycle phases observed by `onLifecycle` subscribers. */
export type BackgroundLifecycleEvent = 'started' | 'updated' | 'terminated';

export interface BackgroundTaskInfo {
  readonly taskId: string;
  readonly command: string;
  readonly description: string;
  readonly status: BackgroundTaskStatus;
  readonly pid: number;
  readonly exitCode: number | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** Populated only while `status === 'awaiting_approval'`. */
  readonly approvalReason?: string | undefined;
  /** True when an agent task was aborted by its deadline. */
  readonly timedOut?: boolean | undefined;
  /** Reason recorded when a task is explicitly stopped. */
  readonly stopReason?: string | undefined;
  /**
   * Deadline (ms) supplied to `registerAgentTask`. Surfaced so shutdown
   * wait-caps and UI can read the originally-requested timeout without
   * round-tripping the call site. `undefined` means no deadline.
   */
  readonly timeoutMs?: number | undefined;
  /** Identifier of the spawned subagent (agent tasks only). */
  readonly agentId?: string | undefined;
  /** Profile name of the spawned subagent (agent tasks only). */
  readonly subagentType?: string | undefined;
  /**
   * Human-readable reason recorded when a non-terminal task is reclassified
   * via reconcile (e.g. a stale heartbeat → lost).
   */
  readonly failureReason?: string | undefined;
}

interface ManagedProcess {
  readonly taskId: string;
  readonly command: string;
  readonly description: string;
  readonly proc: KaosProcess;
  readonly outputChunks: string[];
  /** Total UTF-8 bytes observed, including chunks dropped from the live ring buffer. */
  outputSizeBytes: number;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  readonly startedAt: number;
  endedAt: number | null;
  /** Listeners awaiting task completion. */
  readonly waiters: Array<() => void>;
  /** True once `fireTerminalCallbacks` has already run. */
  terminalFired: boolean;
  /** Reason carried while awaiting approval. */
  approvalReason?: string | undefined;
  /** Set when a deadline fires before natural completion. */
  timedOut?: boolean | undefined;
  /** Reason recorded when a task is explicitly stopped. */
  stopReason?: string | undefined;
  /** Deadline supplied at registration; surfaced via task info. */
  timeoutMs?: number | undefined;
  /** Subagent identifier (agent tasks only). */
  agentId?: string | undefined;
  /** Subagent profile name (agent tasks only). */
  subagentType?: string | undefined;
  /** Non-terminal-reclassification reason (e.g. stale heartbeat). */
  failureReason?: string | undefined;
  /** True after stop() has requested cancellation but before terminal status is chosen. */
  stopRequested: boolean;
  /** Session dir captured at registration for output.log writes. */
  readonly outputSessionDir?: string | undefined;
  /** Run once from `finalizeTerminal` (every terminal path) to release an
   *  agent task's output subscription so its progress listener cannot leak. */
  onTerminalCleanup?: (() => void) | undefined;
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
export function generateTaskId(kind: BackgroundTaskKind): string {
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
  private readonly processes = new Map<string, ManagedProcess>();
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
   * task reaches a terminal state (completed / failed / killed).
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
  private fireTerminalCallbacks(entry: ManagedProcess): void {
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

  private resolveWaiters(entry: ManagedProcess): void {
    const waiters = entry.waiters.splice(0);
    for (const resolve of waiters) resolve();
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
    for (const entry of this.processes.values()) {
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
   * subprocess registration is the only caller on the process path
   * today; agent tasks go through `registerAgentTask` which forces
   * `'agent'`.
   */
  register(
    proc: KaosProcess,
    command: string,
    description: string,
    opts:
      | {
          kind?: BackgroundTaskKind;
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
    if (opts?.reservation) {
      opts.reservation.release();
    } else {
      this.assertCanRegister();
    }
    const kind = opts?.kind;
    const taskId = generateTaskId(kind ?? 'bash');
    const entry: ManagedProcess = {
      taskId,
      command,
      description,
      proc,
      outputChunks: [],
      outputSizeBytes: 0,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      waiters: [],
      terminalFired: false,
      stopRequested: false,
      outputSessionDir: this.sessionDir,
      lifecyclePromise: Promise.resolve(),
      persistWriteQueue: Promise.resolve(),
      outputWriteQueue: Promise.resolve(),
    };
    this.processes.set(taskId, entry);

    // Capture stdout + stderr into the ring buffer.
    for (const stream of [proc.stdout, proc.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        this.appendOutput(entry, chunk);
      });
    }

    // Initial persistence (snapshot at start).
    void this.persistLive(entry);
    this.fireLifecycle('started', this.toInfo(entry));

    // Monitor lifecycle via wait() — no EventEmitter dependency.
    entry.lifecyclePromise = proc
      .wait()
      .then((exitCode) => this.settleProcessExit(entry, exitCode))
      .catch(async (_err: unknown) => {
        // When `proc.wait()` rejects (launch failed / stream error),
        // still drive the task through the same terminal finalizer.
        await this.finalizeTerminal(entry, entry.stopRequested ? 'killed' : 'failed', null);
      });
    void entry.lifecyclePromise;

    return taskId;
  }

  /** Get info about a specific task. Falls back to reconcile ghosts. */
  getTask(taskId: string): BackgroundTaskInfo | undefined {
    const entry = this.processes.get(taskId);
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
    for (const entry of this.processes.values()) {
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
    const entry = this.processes.get(taskId);
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

    const entry = this.processes.get(taskId);
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
    const entry = this.processes.get(taskId);
    if (!entry) return '';
    const full = entry.outputChunks.join('');
    if (tail !== undefined && tail < full.length) {
      return full.slice(-tail);
    }
    return full;
  }

  async readOutput(taskId: string, tail?: number): Promise<string> {
    const entry = this.processes.get(taskId);
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
    const entry = this.processes.get(taskId);
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
    entry.stopRequested = true;
    entry.stopReason = stopReason;

    try {
      await entry.proc.kill('SIGTERM');
    } catch {
      /* process already gone */
    }

    // Wait up to 5s for the lifecycle path to settle, then SIGKILL.
    // Waiting on lifecyclePromise, rather than proc.wait() directly, lets a
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

    if (!graceful && entry.proc.exitCode === null) {
      try {
        await entry.proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    // Agent tasks whose completion promise never settles (no timeoutMs,
    // or a truly hung coroutine) need an explicit terminal finalize here.
    await this.finalizeTerminal(entry, 'killed', null, { stopReason });

    return this.toInfo(entry);
  }

  async stopAll(reason?: string): Promise<readonly BackgroundTaskInfo[]> {
    const taskIds = Array.from(this.processes.values())
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
    const entry = this.processes.get(taskId);
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

  /**
   * Register a Promise-based agent task (no KaosProcess). Used by
   * AgentTool for background subagent dispatch. Agent tasks appear in
   * `list()` / `getTask()` with pid=0. Because there is no live
   * `proc.stdout`, intermediate output is streamed via the optional
   * `opts.outputSource` (the subagent's formatted progress); without it
   * the only output is the final summary appended on completion.
   *
   * `opts.timeoutMs` wraps the completion in an external deadline. On
   * deadline fire, the task is marked `failed` with `timedOut=true`
   * (distinct from a caller-driven `stop()` which uses `killed`, and
   * distinct from an internal `TimeoutError` rejection which is a
   * generic `failed` with `timedOut` left unset).
   */
  registerAgentTask(
    completion: Promise<{ result: string }>,
    description: string,
    opts: {
      timeoutMs?: number;
      abort?: () => void;
      reservation?: BackgroundTaskReservation;
      /** Subagent identifier; surfaced on task info. */
      agentId?: string;
      /** Subagent profile name; surfaced on task info. */
      subagentType?: string;
      /** Live progress source; subscribed immediately, unsubscribed at terminal state. */
      outputSource?: (onChunk: (chunk: string) => void) => () => void;
    } = {},
  ): string {
    if (opts.reservation) {
      opts.reservation.release();
    } else {
      this.assertCanRegister();
    }
    const taskId = generateTaskId('agent');
    const entry: ManagedProcess = {
      taskId,
      command: `[agent] ${description}`,
      description,
      timeoutMs: opts.timeoutMs,
      // Fall back to defaults that satisfy callers reading these fields
      // without forcing every call site to supply them. The dedicated
      // dispatch path in AgentTool passes the real handle.agentId /
      // handle.profileName.
      agentId: opts.agentId ?? taskId,
      subagentType: opts.subagentType ?? 'agent',
      // Dummy KaosProcess — agent tasks are Promise-based, not process-based
      proc: {
        stdin: { write: () => false, end: () => {} } as never,
        stdout: { setEncoding: () => {}, on: () => {} } as never,
        stderr: { setEncoding: () => {}, on: () => {} } as never,
        pid: 0,
        exitCode: null,
        wait: () => completion.then(() => 0),
        kill: async () => {
          opts.abort?.();
        },
      } as unknown as KaosProcess,
      outputChunks: [],
      outputSizeBytes: 0,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      waiters: [],
      terminalFired: false,
      stopRequested: false,
      outputSessionDir: this.sessionDir,
      lifecyclePromise: Promise.resolve(),
      persistWriteQueue: Promise.resolve(),
      outputWriteQueue: Promise.resolve(),
    };
    this.processes.set(taskId, entry);
    // Pipe progress into the ring buffer + output.log, like register() does for
    // bash stdout; chunks after terminal are dropped, and finalizeTerminal owns
    // the unsubscribe so it fires even on the direct stop() path.
    entry.onTerminalCleanup = opts.outputSource?.((chunk) => {
      if (!TERMINAL_STATUSES.has(entry.status)) this.appendOutput(entry, chunk);
    });
    void this.persistLive(entry);
    this.fireLifecycle('started', this.toInfo(entry));

    // Deadline symbol distinguishes "external timeout fired" from "the
    // agent promise itself rejected with TimeoutError" (which must
    // remain a generic failure, not a deadline timeout).
    const deadlineTimeout = Symbol('deadline-timeout');
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    const raceInputs: Array<Promise<unknown>> = [completion];
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      raceInputs.push(
        new Promise((resolve) => {
          deadlineTimer = setTimeout(() => {
            resolve(deadlineTimeout);
          }, opts.timeoutMs);
        }),
      );
    }

    const settleLifecycle = Promise.race(raceInputs)
      .then(async (outcome) => {
        if (outcome === deadlineTimeout) {
          // External deadline fired before the agent resolved.
          if (TERMINAL_STATUSES.has(entry.status)) return;
          opts.abort?.();
          await this.finalizeTerminal(entry, 'failed', 1, { timedOut: true });
          return;
        }
        // `completion` resolved before deadline.
        const r = outcome as { result: string };
        if (TERMINAL_STATUSES.has(entry.status)) return;
        // A streaming task already logged the assistant's prose (its tail is the
        // final message), so re-appending the result would just duplicate it —
        // only fall back to the result when nothing streamed. Non-streaming
        // tasks have no other output, so the result is their whole log.
        if (opts.outputSource === undefined || entry.outputSizeBytes === 0) {
          this.appendOutput(entry, r.result);
        }
        await this.finalizeTerminal(entry, 'completed', 0);
      })
      .catch(async (error: unknown) => {
        // Caller-driven stop() that ran to completion through our own
        // abort callback: the rejection is an AbortError-shaped object.
        // Treat as `killed` so user-initiated cancellation is recorded
        // as a cancellation, not a failure. The shape check is
        // load-bearing — if a non-AbortError rejection arrives while
        // `stopRequested` is set, it means a real failure (e.g. a
        // model error) won the race against the in-flight stop, and we
        // must record that failure rather than hide it behind the
        // user's cancellation.
        if (entry.stopRequested && isAbortError(error)) {
          await this.finalizeTerminal(entry, 'killed', null);
          return;
        }
        // Runner-initiated cancellation: the background agent runner
        // raises `RunCancelled` to signal "abort this run" (e.g. on a
        // Ctrl+C path with no BPM-side stop()). Map to `killed`
        // because cancellation is not a failure.
        if (error instanceof Error && error.name === 'RunCancelled') {
          await this.finalizeTerminal(entry, 'killed', null);
          return;
        }
        // Internal rejection (including TimeoutError, model errors,
        // and stopRequested cases where a non-abort failure won the
        // race): generic failure. `timedOut` stays unset so consumers
        // can distinguish this from a true external deadline.
        await this.finalizeTerminal(entry, 'failed', 1);
      })
      .finally(() => {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      });

    entry.lifecyclePromise = settleLifecycle;
    void entry.lifecyclePromise;

    return taskId;
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
    const entry = this.processes.get(taskId);
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
    const entry = this.processes.get(taskId);
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
    const entry = this.processes.get(taskId);
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
    this.processes.clear();
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
      if (this.processes.has(t.task_id)) continue;
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
   * Persist the current state of a live ManagedProcess. Called from
   * `register()` and the lifecycle finally block. No-op unless attached.
   */
  private persistLive(entry: ManagedProcess): Promise<void> {
    if (this.sessionDir === undefined) return Promise.resolve();
    const sessionDir = this.sessionDir;
    const isAgentTask = entry.taskId.startsWith('agent-');
    const task: PersistedTask = {
      task_id: entry.taskId,
      command: entry.command,
      description: entry.description,
      pid: entry.proc.pid,
      started_at: entry.startedAt,
      ended_at: entry.endedAt,
      exit_code: entry.exitCode,
      status: entry.status,
      approval_reason: entry.approvalReason,
      timed_out: entry.timedOut,
      stop_reason: entry.stopReason,
      // Only persist subagent identifiers for agent tasks. The base-class
      // fallback `agentId ?? taskId` (registerAgentTask) makes them equal
      // for tasks registered without an explicit id — skip those too so the
      // disk record stays honest about whether we know a real agent_id.
      agent_id: isAgentTask && entry.agentId !== entry.taskId ? entry.agentId : undefined,
      subagent_type: isAgentTask ? entry.subagentType : undefined,
    };
    entry.persistWriteQueue = entry.persistWriteQueue
      .then(() => writeTask(sessionDir, task))
      .catch(() => {});
    return entry.persistWriteQueue;
  }

  private appendOutput(entry: ManagedProcess, chunk: string): void {
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
    const entry = this.processes.get(taskId);
    if (entry !== undefined) return entry.outputSessionDir;
    if (this.ghosts.has(taskId)) return this.sessionDir;
    return undefined;
  }

  private async settleProcessExit(entry: ManagedProcess, exitCode: number): Promise<void> {
    if (TERMINAL_STATUSES.has(entry.status)) {
      if (entry.status === 'killed' && entry.exitCode === null) {
        entry.exitCode = exitCode;
        entry.endedAt = Date.now();
        await this.persistLive(entry);
        this.fireTerminalCallbacks(entry);
        this.resolveWaiters(entry);
      }
      return;
    }
    const status = entry.stopRequested ? 'killed' : exitCode === 0 ? 'completed' : 'failed';
    await this.finalizeTerminal(entry, status, exitCode);
  }

  private observedExitCompletions(): Promise<void>[] {
    const completions: Promise<void>[] = [];
    for (const entry of this.processes.values()) {
      if (!TERMINAL_STATUSES.has(entry.status) && entry.proc.exitCode !== null) {
        completions.push(entry.lifecyclePromise);
      }
    }
    return completions;
  }

  private toInfo(entry: ManagedProcess): BackgroundTaskInfo {
    return {
      taskId: entry.taskId,
      command: entry.command,
      description: entry.description,
      status: entry.status,
      pid: entry.proc.pid,
      exitCode: entry.exitCode,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      approvalReason: entry.approvalReason,
      timedOut: entry.timedOut,
      stopReason: entry.stopReason,
      timeoutMs: entry.timeoutMs,
      agentId: entry.agentId,
      subagentType: entry.subagentType,
      failureReason: entry.failureReason,
    };
  }

  private async finalizeTerminal(
    entry: ManagedProcess,
    status: BackgroundTaskStatus,
    exitCode: number | null,
    options: { readonly timedOut?: boolean; readonly stopReason?: string } = {},
  ): Promise<boolean> {
    if (TERMINAL_STATUSES.has(entry.status)) return false;
    entry.status = status;
    entry.exitCode = exitCode;
    entry.endedAt = Date.now();
    entry.timedOut = options.timedOut;
    entry.stopReason = status === 'killed' ? (options.stopReason ?? entry.stopReason) : undefined;
    // A task that ended while still in awaiting_approval (e.g. crashed
    // mid-prompt, deadline fired, or got killed) must not leak the
    // stale approvalReason onto the terminal record. The awaiting →
    // running path (clearAwaitingApproval) already clears it; mirror
    // that here for the awaiting → terminal path.
    entry.approvalReason = undefined;
    entry.stopRequested = false;
    // Runs once (guarded above): release any output subscription.
    entry.onTerminalCleanup?.();
    entry.onTerminalCleanup = undefined;
    await this.persistLive(entry);
    this.fireTerminalCallbacks(entry);
    this.resolveWaiters(entry);
    return true;
  }
}

// ── persistence shape <-> in-memory shape ──────────────────────────────

function persistedToInfo(t: PersistedTask): BackgroundTaskInfo {
  return {
    taskId: t.task_id,
    command: t.command,
    description: t.description,
    status: t.status,
    pid: t.pid,
    exitCode: t.exit_code,
    startedAt: t.started_at,
    endedAt: t.ended_at,
    approvalReason: t.approval_reason,
    timedOut: t.timed_out,
    stopReason: t.stop_reason,
    agentId: t.agent_id,
    subagentType: t.subagent_type,
  };
}

function infoToPersisted(info: BackgroundTaskInfo): PersistedTask {
  return {
    task_id: info.taskId,
    command: info.command,
    description: info.description,
    pid: info.pid,
    started_at: info.startedAt,
    ended_at: info.endedAt,
    exit_code: info.exitCode,
    status: info.status,
    approval_reason: info.approvalReason,
    timed_out: info.timedOut,
    stop_reason: info.stopReason,
    agent_id: info.agentId === info.taskId ? undefined : info.agentId,
    subagent_type: info.subagentType,
  };
}
