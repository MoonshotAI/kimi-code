/**
 * BackgroundManager — manages background tasks for an agent.
 *
 * Tracks background bash tasks and background subagent tasks.
 *
 * Each task gets a unique ID, captures stdout+stderr to a ring buffer,
 * and supports status query / output retrieval / stop operations.
 *
 * Concrete task classes own execution details; the manager owns task
 * registration, lifecycle state, persistence, output, and notifications.
 */

import { randomBytes } from 'node:crypto';

import { createControlledPromise, type ControlledPromise } from '@antfu/utils';
import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '../..';
import { errorMessage } from '../../loop/errors';
import { resettableTimeoutOutcome, timeoutOutcome, type ResettableTimeoutPromise } from '../../utils/promise';
import { escapeXml, escapeXmlAttr } from '../../utils/xml-escape';
import type { BackgroundTaskOrigin } from '../context';
import { renderNotificationXml } from '../context/notification-xml';
import { type BackgroundTaskPersistence } from './persist';
import {
  TERMINAL_STATUSES,
  type BackgroundTask,
  type BackgroundTaskInfo,
  type BackgroundTaskInfoBase,
  type BackgroundTaskSettlement,
  type BackgroundTaskStatus,
} from './task';

// ── Types ────────────────────────────────────────────────────────────

/**
 * `'lost'` is a reconcile-only terminal state. Tasks loaded from disk
 * that were marked `running` at startup but have no live KaosProcess
 * (the previous CLI process died) are reclassified as lost.
 */
export function isBackgroundTaskTerminal(status: BackgroundTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export { AgentBackgroundTask } from './agent-task';
export type { AgentBackgroundTaskInfo } from './agent-task';
export { ProcessBackgroundTask } from './process-task';
export type { ProcessBackgroundTaskInfo } from './process-task';
export { QuestionBackgroundTask } from './question-task';
export type { QuestionBackgroundTaskInfo } from './question-task';
export { BackgroundTaskPersistence } from './persist';
export type {
  BackgroundTaskInfo,
  BackgroundTaskStatus,
} from './task';

interface ManagedTask {
  readonly taskId: string;
  readonly task: BackgroundTask;
  readonly outputChunks: string[];
  /** Total UTF-8 bytes observed, including chunks dropped from the live ring buffer. */
  outputSizeBytes: number;
  status: BackgroundTaskStatus;
  /** Normalized registration options. Current mutable state stays on ManagedTask. */
  readonly options: RegisterBackgroundTaskOptions;
  readonly startedAt: number;
  endedAt: number | null;
  /** Foreground tool call release signal, present only for non-detached starts. */
  foregroundRelease?: ControlledPromise<ForegroundTaskReleaseReason>;
  /** Resettable deadline timer; reset on detach to apply `detachTimeoutMs`. */
  timeoutHandle?: ResettableTimeoutPromise<TerminalOutcome>;
  /** User/tool stop request. */
  readonly stop: ControlledPromise<StopRequest>;
  /** Resolved once manager has finalized the task. */
  readonly terminal: ControlledPromise<void>;
  /** Human-readable reason for the terminal status, when available. */
  stopReason?: string | undefined;
  /** Suppress automatic terminal notifications/reminders for this task. */
  terminalNotificationSuppressed?: boolean | undefined;
  /** Cancellation signal owned by the manager and observed by the concrete task. */
  readonly abortController: AbortController;
  persistWriteQueue: Promise<void>;
  outputWriteQueue: Promise<void>;
  /**
   * Full output buffered in memory while a foreground task has not yet
   * persisted to disk. Flushed to `output.log` (in order, ahead of the live
   * stream) when the task detaches or spills, then released.
   */
  pendingOutput: string[];
  pendingOutputBytes: number;
  /**
   * Whether `output.log` writes have begun. True from the start for tasks
   * registered already-detached; flipped on detach or memory-bound spill for
   * foreground tasks. Until then output stays in `pendingOutput`.
   */
  outputPersistStarted: boolean;
}

/**
 * Maximum bytes of combined output kept in the in-memory ring buffer per
 * task. When exceeded, the oldest chunks are dropped.
 *
 * The ring buffer is a lightweight tail intended for the `/tasks` UI and
 * terminal notifications only — it deliberately discards old output to
 * cap memory. It is NOT the authoritative full output: the complete,
 * never-truncated log lives on disk at `<sessionDir>/tasks/<id>/output.log`.
 * Callers that need task output should use `getOutputSnapshot()`, which
 * reads the persisted log when available.
 */
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB
const NOTIFICATION_FALLBACK_PREVIEW_BYTES = 3_000;

const SIGTERM_GRACE_MS = 5_000;
const USER_INTERRUPT_REASON = 'Interrupted by user';

const _ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Generate `{prefix}-{8 base36 chars}`.
 *
 * `randomBytes(8) % 36` has a modest modulo bias (256 % 36 = 4) but
 * over an 8-char suffix yields ~36^8 ≈ 2.8e12 distinct ids which is
 * more than enough uniqueness for per-session task ids.
 */
function generateTaskId(kind: string): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let i = 0; i < 8; i++) {
    suffix += _ALPHABET[bytes[i]! % 36];
  }
  return `${kind}-${suffix}`;
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

type BackgroundTaskNotification = Record<string, unknown> & {
  readonly id: string;
  readonly category: 'task';
  readonly type: string;
  readonly source_kind: 'background_task';
  readonly source_id: string;
  /** Subagent id accepted by Agent(resume=...). Omitted for process tasks. */
  readonly agent_id?: string | undefined;
  readonly title: string;
  readonly severity: 'info' | 'warning';
  readonly body: string;
  readonly children?: readonly string[] | undefined;
};

interface BackgroundTaskNotificationContext {
  readonly content: readonly ContentPart[];
  readonly origin: BackgroundTaskOrigin;
  readonly notification: BackgroundTaskNotification;
}

export interface RegisterBackgroundTaskOptions {
  /**
   * When false, the task is tracked by the manager but a foreground tool call
   * is still waiting for it. It can later be detached through RPC.
   */
  readonly detached?: boolean;
  /** Deadline owned by BackgroundManager. `0` and `undefined` do not arm a timer. */
  readonly timeoutMs?: number;
  /**
   * When set, detaching a foreground task resets its deadline to this value
   * (counted from the detach moment). Lets a command started with a short
   * foreground timeout run longer once it is moved to the background.
   */
  readonly detachTimeoutMs?: number;
  /** Foreground caller signal. Ignored for tasks created already detached. */
  readonly signal?: AbortSignal;
}

export type ForegroundTaskReleaseReason = 'detached' | 'terminal';

interface StopRequest {
  readonly reason?: string;
  readonly abortReason?: unknown;
}

type TerminalOutcome =
  | { readonly kind: 'worker'; readonly settlement: BackgroundTaskSettlement }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'stop'; readonly request: StopRequest };

// ── Manager ──────────────────────────────────────────────────────────

export class BackgroundManager {
  private readonly tasks = new Map<string, ManagedTask>();
  /**
   * Ghosts: tasks loaded from disk during reconcile that have no live
   * KaosProcess. They appear in `list()` / `getTask()` with status
   * `lost` so users see what was running before the crash/restart.
   */
  private readonly ghosts = new Map<string, BackgroundTaskInfo>();

  private readonly scheduledNotificationKeys = new Set<string>();
  private readonly deliveredNotificationKeys = new Set<string>();

  constructor(
    private readonly agent: Agent,
    private readonly persistence?: BackgroundTaskPersistence,
  ) { }

  private fireTerminalEffects(entry: ManagedTask): void {
    if (!this.isDetached(entry)) return;
    const info = this.toInfo(entry);
    void this.notifyBackgroundTask(info).catch(() => { });
    this.emitTaskTerminated(info);
  }

  private emitTaskStarted(info: BackgroundTaskInfo): void {
    this.agent.emitEvent({ type: 'background.task.started', info });
    this.agent.telemetry.track('background_task_created', {
      kind: info.kind === 'process' ? 'bash' : info.kind,
    });
  }

  private emitTaskTerminated(info: BackgroundTaskInfo): void {
    this.agent.emitEvent({ type: 'background.task.terminated', info });
    this.agent.telemetry.track('background_task_completed', {
      kind: info.kind,
      duration_ms: info.endedAt !== null ? info.endedAt - info.startedAt : null,
      status: info.status,
    });
  }

  private assertCanRegister(startedInBackground: boolean): void {
    const maxRunningTasks = this.agent.kimiConfig?.background?.maxRunningTasks;
    if (maxRunningTasks === undefined) return;
    if (!startedInBackground) return;
    if (this.activeBackgroundAdmissionCount() < maxRunningTasks) return;
    throw new Error('Too many background tasks are already running.');
  }

  private activeBackgroundAdmissionCount(): number {
    let count = 0;
    for (const entry of this.tasks.values()) {
      if (!TERMINAL_STATUSES.has(entry.status) && this.startedInBackground(entry)) count++;
    }
    return count;
  }

  private startedInBackground(entry: ManagedTask): boolean {
    return entry.options.detached !== false;
  }

  private isDetached(entry: ManagedTask): boolean {
    return entry.foregroundRelease === undefined;
  }

  registerTask(task: BackgroundTask, options: RegisterBackgroundTaskOptions = {}): string {
    const detached = options.detached ?? true;
    const timeoutMs = options.timeoutMs ?? task.timeoutMs;
    const entryOptions: RegisterBackgroundTaskOptions = {
      detached,
      timeoutMs,
      detachTimeoutMs: options.detachTimeoutMs,
      signal: detached ? undefined : options.signal,
    };
    this.assertCanRegister(detached);
    const taskId = generateTaskId(task.idPrefix);
    const entry: ManagedTask = {
      taskId,
      task,
      outputChunks: [],
      outputSizeBytes: 0,
      status: 'running',
      options: entryOptions,
      startedAt: Date.now(),
      endedAt: null,
      foregroundRelease: detached ? undefined : createControlledPromise(),
      stop: createControlledPromise(),
      terminal: createControlledPromise(),
      abortController: new AbortController(),
      persistWriteQueue: Promise.resolve(),
      outputWriteQueue: Promise.resolve(),
      pendingOutput: [],
      pendingOutputBytes: 0,
      outputPersistStarted: detached,
    };
    this.tasks.set(taskId, entry);
    void this.runTaskLifecycle(entry);

    // Initial persistence (snapshot at start). Foreground tasks defer all
    // persistence until they detach (or spill) — see appendOutput / detach /
    // finalizeTask — so ordinary commands leave nothing undiscoverable on disk.
    if (this.isDetached(entry)) {
      void this.persistLive(entry);
      this.emitTaskStarted(this.toInfo(entry));
    }

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
   * List tasks, optionally filtering to active-only.
   *
   * When `activeOnly=false`, includes reconcile ghosts (lost tasks
   * from a prior CLI process) so the user sees what survived the
   * restart. Active-only mode never shows ghosts (they're terminal).
   */
  list(activeOnly = true, limit?: number): BackgroundTaskInfo[] {
    const result: BackgroundTaskInfo[] = [];
    for (const entry of this.tasks.values()) {
      const info = this.toInfo(entry);
      if (!this.shouldListTask(info, activeOnly)) continue;
      result.push(info);
      if (limit !== undefined && result.length >= limit) return result;
    }
    if (!activeOnly) {
      for (const ghost of this.ghosts.values()) {
        if (!this.shouldListTask(ghost, activeOnly)) continue;
        result.push(ghost);
        if (limit !== undefined && result.length >= limit) return result;
      }
    }
    return result;
  }

  private shouldListTask(info: BackgroundTaskInfo, activeOnly: boolean): boolean {
    if (!TERMINAL_STATUSES.has(info.status)) return true;
    if (activeOnly) return false;
    return info.detached !== false;
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

    await this.tasks.get(taskId)?.outputWriteQueue;

    const previewLimit = Math.max(0, Math.trunc(maxPreviewBytes));
    const persistence = this.persistence;
    if (persistence !== undefined && (await persistence.taskOutputExists(taskId))) {
      const outputSizeBytes = await persistence.taskOutputSizeBytes(taskId);
      const previewOffset = Math.max(0, outputSizeBytes - previewLimit);
      const previewBytes = outputSizeBytes - previewOffset;
      const preview = await persistence.readTaskOutputBytes(taskId, previewOffset, previewBytes);
      return {
        outputPath: persistence.taskOutputFile(taskId),
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

  async readOutput(taskId: string, tail?: number): Promise<string> {
    const output = (await this.getOutputSnapshot(taskId, Number.MAX_SAFE_INTEGER)).preview;
    if (tail !== undefined && tail < output.length) {
      return output.slice(-tail);
    }
    return output;
  }

  async suppressTerminalNotification(taskId: string): Promise<void> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined || entry.terminalNotificationSuppressed === true) return;
    entry.terminalNotificationSuppressed = true;
    await this.persistLive(entry);
  }

  detach(taskId: string): BackgroundTaskInfo | undefined {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return this.ghosts.get(taskId);
    if (TERMINAL_STATUSES.has(entry.status)) return this.toInfo(entry);
    const foregroundRelease = entry.foregroundRelease;
    if (foregroundRelease === undefined) return this.toInfo(entry);

    entry.foregroundRelease = undefined;
    if (entry.options.detachTimeoutMs !== undefined) {
      entry.timeoutHandle?.reset(entry.options.detachTimeoutMs);
    }
    try {
      entry.task.onDetach?.();
    } catch {
      /* detach has already succeeded; hooks must not make RPC fail */
    }
    // Flush buffered pre-detach output to disk before the live stream resumes,
    // so output.log stays the complete, in-order record.
    this.startOutputPersist(entry);
    void this.persistLive(entry);
    this.emitTaskStarted(this.toInfo(entry));
    foregroundRelease.resolve('detached');
    return this.toInfo(entry);
  }

  persistOutput(taskId: string): void {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return;
    this.startOutputPersist(entry);
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
    // Terminal tasks short-circuit.
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    entry.stopReason = stopReason;
    entry.abortController.abort(stopReason);
    entry.stop.resolve({ reason: stopReason });
    await entry.terminal;
    return this.toInfo(entry);
  }

  async stopAll(reason?: string): Promise<readonly BackgroundTaskInfo[]> {
    const taskIds = Array.from(this.tasks.keys());
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

    if (timeoutMs <= 0) {
      return this.toInfo(entry);
    }
    const timeout = timeoutOutcome(timeoutMs, undefined);
    await Promise.race([entry.terminal, timeout]).finally(() => timeout.clear());

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
    }
    return this.toInfo(entry);
  }

  /**
   * Wait until a foreground task either detaches from the current tool call or
   * reaches a terminal state. Detached tasks return immediately.
   */
  async waitForForegroundRelease(
    taskId: string,
  ): Promise<ForegroundTaskReleaseReason | undefined> {
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return 'terminal';
    }
    if (this.isDetached(entry)) return 'detached';

    const foregroundRelease = entry.foregroundRelease;
    const reason = await Promise.race([
      foregroundRelease,
      entry.terminal.then(() => 'terminal' as const),
    ]);
    if (reason === 'terminal') {
      await entry.persistWriteQueue;
    }
    return reason;
  }

  // ── persistence + reconcile ────────────────────────────────────────

  /**
   * Load persisted task records into the ghost map. Does NOT reconcile
   * (call `reconcile()` after `loadFromDisk()`). Idempotent; subsequent
   * calls overwrite the ghost map.
   */
  async loadFromDisk(): Promise<void> {
    const persistence = this.persistence;
    if (persistence === undefined) return;
    this.ghosts.clear();
    const persisted = await persistence.listTasks();
    for (const t of persisted) {
      // Skip ids that already exist as live processes — live wins.
      if (this.tasks.has(t.taskId)) continue;
      this.ghosts.set(t.taskId, t);
    }
  }

  /**
   * Reconcile loaded ghost tasks. Any ghost with status `running` is
   * reclassified as `lost` (its previous CLI process died without
   * writing a terminal state). Updates the on-disk record and returns
   * the lost task snapshots so the caller can emit user-facing notifications.
   */
  private async markLoadedTasksLost(): Promise<readonly BackgroundTaskInfo[]> {
    const lostInfo: BackgroundTaskInfo[] = [];
    const persistence = this.persistence;
    for (const [id, info] of this.ghosts) {
      // Any non-terminal ghost is lost.
      if (TERMINAL_STATUSES.has(info.status)) continue;
      const updated: BackgroundTaskInfo = {
        ...info,
        status: 'lost',
        endedAt: info.endedAt ?? Date.now(),
      };
      this.ghosts.set(id, updated);
      if (persistence !== undefined) {
        await persistence.writeTask(updated);
      }
      lostInfo.push(updated);
    }
    return lostInfo;
  }

  async reconcile(): Promise<void> {
    const lostInfo = await this.markLoadedTasksLost();
    for (const info of lostInfo) {
      this.emitTaskTerminated(info);
    }
    await this.restoreBackgroundTaskNotifications();
  }

  /**
   * Persist the current state of a live ManagedTask. Called from
   * `registerTask()` and the lifecycle finally block. No-op unless attached.
   */
  private persistLive(entry: ManagedTask): Promise<void> {
    const persistence = this.persistence;
    if (persistence === undefined) return Promise.resolve();
    const info = this.toInfo(entry);
    entry.persistWriteQueue = entry.persistWriteQueue
      .then(() => persistence.writeTask(info))
      .catch(() => { });
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

    if (this.persistence === undefined) return;

    // Foreground tasks keep their full output in memory and only touch disk
    // once they detach. A memory-bound spill begins disk persistence early so
    // a never-detached command can't grow the buffer without limit.
    if (!entry.outputPersistStarted) {
      entry.pendingOutput.push(chunk);
      entry.pendingOutputBytes += Buffer.byteLength(chunk, 'utf-8');
      if (entry.pendingOutputBytes > MAX_OUTPUT_BYTES) this.startOutputPersist(entry);
      return;
    }

    this.appendTaskOutput(entry, chunk);
  }

  /** Enqueue an `output.log` append, serialized per task. No-op when detached managers omit persistence. */
  private appendTaskOutput(entry: ManagedTask, chunk: string): void {
    const persistence = this.persistence;
    if (persistence === undefined) return;
    entry.outputWriteQueue = entry.outputWriteQueue
      .then(() => persistence.appendTaskOutput(entry.taskId, chunk))
      .catch(() => { });
  }

  /**
   * Begin persisting `output.log` for a task that buffered while foreground.
   * Flushes the buffered pre-detach output first (in order, ahead of the live
   * stream) so the on-disk log stays complete, then releases the buffer.
   * Idempotent.
   */
  private startOutputPersist(entry: ManagedTask): void {
    if (entry.outputPersistStarted) return;
    entry.outputPersistStarted = true;
    if (entry.pendingOutput.length > 0) {
      this.appendTaskOutput(entry, entry.pendingOutput.join(''));
    }
    entry.pendingOutput = [];
    entry.pendingOutputBytes = 0;
  }

  private async restoreBackgroundTaskNotifications(): Promise<void> {
    for (const info of this.list(false)) {
      if (!isBackgroundTaskTerminal(info.status)) continue;
      await this.restoreBackgroundTaskNotification(info);
    }
  }

  private async notifyBackgroundTask(info: BackgroundTaskInfo): Promise<void> {
    const context = await this.buildBackgroundTaskNotificationContext(info);
    if (context === undefined) return;
    this.agent.turn.steer(context.content, context.origin);
    this.fireNotificationHook(context.notification);
  }

  private async restoreBackgroundTaskNotification(info: BackgroundTaskInfo): Promise<void> {
    const context = await this.buildBackgroundTaskNotificationContext(info);
    if (context === undefined) return;
    this.agent.context.appendUserMessage(context.content, context.origin);
    this.fireNotificationHook(context.notification);
  }

  private async buildBackgroundTaskNotificationContext(
    info: BackgroundTaskInfo,
  ): Promise<BackgroundTaskNotificationContext | undefined> {
    if (info.detached === false) return undefined;
    if (this.isTerminalNotificationSuppressed(info.taskId)) return undefined;
    const origin: BackgroundTaskOrigin = {
      kind: 'background_task',
      taskId: info.taskId,
      status: info.status,
      notificationId: `task:${info.taskId}:${info.status}`,
    };
    const key = notificationKey(origin);
    if (this.scheduledNotificationKeys.has(key)) return;
    if (this.deliveredNotificationKeys.has(key)) return;

    this.scheduledNotificationKeys.add(key);
    let output = await this.getOutputSnapshot(info.taskId, 0);
    if (!output.fullOutputAvailable) {
      output = await this.getOutputSnapshot(info.taskId, NOTIFICATION_FALLBACK_PREVIEW_BYTES);
    }
    if (this.isTerminalNotificationSuppressed(info.taskId)) return undefined;
    const notification: BackgroundTaskNotification = {
      id: origin.notificationId,
      category: 'task',
      type: `task.${info.status}`,
      source_kind: 'background_task',
      source_id: info.taskId,
      agent_id: info.kind === 'agent' ? info.agentId : undefined,
      title: `Background ${info.kind} ${info.status}`,
      severity: info.status === 'completed' ? 'info' : 'warning',
      body: buildBackgroundTaskNotificationBody(info),
      children: backgroundTaskNotificationChildren(output),
    };
    const content = [
      {
        type: 'text',
        text: renderNotificationXml(notification),
      },
    ] as const;
    return { content, origin, notification };
  }

  private fireNotificationHook(notification: BackgroundTaskNotification): void {
    void this.agent.hooks?.fireAndForgetTrigger('Notification', {
      matcherValue: notification.type,
      inputData: {
        sink: 'context',
        notificationType: notification.type,
        title: notification.title,
        body: notification.body,
        severity: notification.severity,
        sourceKind: notification.source_kind,
        sourceId: notification.source_id,
      },
    });
  }

  markDeliveredNotification(origin: BackgroundTaskOrigin): void {
    this.deliveredNotificationKeys.add(notificationKey(origin));
  }

  private isTerminalNotificationSuppressed(taskId: string): boolean {
    return (
      this.tasks.get(taskId)?.terminalNotificationSuppressed === true ||
      this.ghosts.get(taskId)?.terminalNotificationSuppressed === true
    );
  }

  private async runTaskLifecycle(entry: ManagedTask): Promise<void> {
    const worker = createControlledPromise<BackgroundTaskSettlement>();
    let workerSettled = false;
    const settleWorker = (settlement: BackgroundTaskSettlement): boolean => {
      if (workerSettled) return false;
      workerSettled = true;
      worker.resolve(settlement);
      return true;
    };

    void Promise.resolve()
      .then(() => entry.task.start({
        signal: entry.abortController.signal,
        appendOutput: (chunk) => {
          this.appendOutput(entry, chunk);
        },
        settle: async (settlement) => settleWorker(settlement),
      }))
      .catch((error: unknown) => {
        settleWorker({
          status: entry.abortController.signal.aborted ? 'killed' : 'failed',
          stopReason: entry.abortController.signal.aborted ? undefined : errorMessage(error),
        });
      });

    const timeout = resettableTimeoutOutcome(entry.options.timeoutMs, { kind: 'timeout' as const });
    entry.timeoutHandle = timeout;
    const outcome = await Promise.race([
      worker.then((settlement): TerminalOutcome => ({ kind: 'worker', settlement })),
      timeout,
      entry.stop.then((request): TerminalOutcome => ({ kind: 'stop', request })),
      this.signalOutcome(entry),
    ]).finally(() => {
      timeout.clear();
      entry.timeoutHandle = undefined;
    });
    const settlement = await this.settlementForOutcome(entry, outcome, worker);
    await this.finalizeTask(entry, settlement);
  }

  private signalOutcome(entry: ManagedTask): Promise<TerminalOutcome> {
    const signal = entry.options.signal;
    if (signal === undefined) return new Promise<never>(() => {});
    const outcome = (): TerminalOutcome => ({
      kind: 'stop',
      request: { reason: USER_INTERRUPT_REASON, abortReason: signal.reason },
    });
    if (signal.aborted) return Promise.resolve(outcome());
    return new Promise((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          if (!this.isDetached(entry)) resolve(outcome());
        },
        { once: true },
      );
    });
  }

  private async settlementForOutcome(
    entry: ManagedTask,
    outcome: TerminalOutcome,
    worker: Promise<BackgroundTaskSettlement>,
  ): Promise<BackgroundTaskSettlement> {
    if (outcome.kind === 'worker') return outcome.settlement;

    const timedOut = outcome.kind === 'timeout';
    const stopReason = outcome.kind === 'stop' ? outcome.request.reason : undefined;
    let abortReason: unknown;
    if (timedOut) {
      abortReason = 'Timed out';
    } else if (outcome.kind === 'stop') {
      abortReason = outcome.request.abortReason ?? stopReason;
    }
    entry.stopReason = stopReason;
    entry.abortController.abort(abortReason);

    const graceTimeout = timeoutOutcome(SIGTERM_GRACE_MS, undefined);
    const workerAfterAbort = await Promise.race([
      worker,
      graceTimeout,
    ]).finally(() => graceTimeout.clear());

    if (
      outcome.kind === 'stop' &&
      workerAfterAbort !== undefined &&
      workerAfterAbort.status !== 'killed' &&
      workerAfterAbort.status !== 'timed_out'
    ) {
      return workerAfterAbort;
    }

    if (workerAfterAbort === undefined) {
      try {
        await entry.task.forceStop?.();
      } catch {
        /* ignore */
      }
    }

    return {
      status: timedOut ? 'timed_out' : 'killed',
      stopReason,
    };
  }

  private async finalizeTask(
    entry: ManagedTask,
    settlement: BackgroundTaskSettlement,
  ): Promise<void> {
    entry.status = settlement.status;
    entry.endedAt = Date.now();
    entry.stopReason =
      settlement.stopReason ?? (settlement.status === 'killed' ? entry.stopReason : undefined);
    // Persist the terminal record only when the task actually touched disk:
    // detached tasks, and foreground tasks that spilled past the in-memory
    // buffer. A foreground task whose output stayed in memory leaves nothing on
    // disk — release the buffer and skip persistence so it never accumulates as
    // an undiscoverable log.
    if (entry.outputPersistStarted) {
      await this.persistLive(entry);
    } else {
      entry.pendingOutput = [];
      entry.pendingOutputBytes = 0;
    }
    this.fireTerminalEffects(entry);
    entry.foregroundRelease?.resolve('terminal');
    entry.terminal.resolve();
  }

  private toInfo(entry: ManagedTask): BackgroundTaskInfo {
    const base: BackgroundTaskInfoBase = {
      taskId: entry.taskId,
      description: entry.task.description,
      status: entry.status,
      detached: this.isDetached(entry),
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      stopReason: entry.stopReason,
      terminalNotificationSuppressed: entry.terminalNotificationSuppressed,
      timeoutMs: entry.options.timeoutMs,
    };
    return entry.task.toInfo(base);
  }
}

function backgroundTaskNotificationChildren(
  output: BackgroundTaskOutputSnapshot,
): readonly string[] | undefined {
  if (output.fullOutputAvailable && output.outputPath !== undefined) {
    return [renderOutputFileBlock(output.outputPath, output.outputSizeBytes)];
  }
  if (output.preview.length === 0) return undefined;
  return [renderOutputPreviewBlock(output)];
}

function renderOutputFileBlock(outputPath: string, outputSizeBytes: number): string {
  return [
    `<output-file path="${escapeXmlAttr(outputPath)}" bytes="${String(outputSizeBytes)}">`,
    `Read the output file to retrieve the result: ${escapeXml(outputPath)}`,
    '</output-file>',
  ].join('\n');
}

function renderOutputPreviewBlock(output: BackgroundTaskOutputSnapshot): string {
  return [
    `<output-preview bytes="${String(output.previewBytes)}" total_bytes="${String(output.outputSizeBytes)}" truncated="${String(output.truncated)}">`,
    output.truncated
      ? `Showing the last ${String(output.previewBytes)} bytes. No persisted full output is available.`
      : 'No persisted full output is available; this preview is the currently buffered task output.',
    escapeXml(output.preview),
    '</output-preview>',
  ].join('\n');
}

function notificationKey(origin: BackgroundTaskOrigin): string {
  return `${origin.taskId}\0${origin.status}\0${origin.notificationId}`;
}

function buildBackgroundTaskNotificationBody(info: BackgroundTaskInfo): string {
  const baseLine =
    info.status === 'timed_out'
      ? `${info.description} timed out.`
      : info.stopReason
        ? `${info.description} ${info.status === 'killed' ? 'was killed' : info.status}: ${info.stopReason
        }.`
        : `${info.description} ${info.status}.`;

  if (info.kind !== 'agent') return baseLine;
  if (info.status === 'completed') return baseLine;
  const agentId = info.agentId;
  if (agentId === undefined || agentId === info.taskId) return baseLine;

  const recovery = [
    '',
    `To recover or continue this subagent, call Agent(resume="${agentId}", prompt="Pick up where you left off; redo the last tool call if its result was never observed.").`,
    `Use agent_id ("${agentId}"), NOT source_id / task_id ("${info.taskId}") — the two look alike but only agent_id is accepted by the resume parameter.`,
    'Add run_in_background=true to keep it backgrounded, or omit it to take the result inline in the current turn.',
    'The subagent retains its full prior context across the restart, but any in-flight tool call lost its result and may need to be redone.',
  ].join('\n');

  return `${baseLine}${recovery}`;
}
