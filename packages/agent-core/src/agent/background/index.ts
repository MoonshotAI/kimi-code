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

import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '../..';
import { errorMessage } from '../../loop/errors';
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
export { BackgroundTaskPersistence, VALID_TASK_ID } from './persist';
export type {
  BackgroundTaskInfo,
  BackgroundTaskKind,
  BackgroundTaskStatus,
} from './task';

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
  /** True once terminal notification/event side effects have already run. */
  terminalFired: boolean;
  /** Human-readable reason for the terminal status, when available. */
  stopReason?: string | undefined;
  /** Deadline supplied at registration; surfaced via task info. */
  timeoutMs?: number | undefined;
  /** Cancellation signal owned by the manager and observed by the concrete task. */
  readonly abortController: AbortController;
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
 * Callers that need task output should use `getOutputSnapshot()`, which
 * reads the persisted log when available.
 */
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB

const SIGTERM_GRACE_MS = 5_000;

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
  readonly tail_output: string;
};

interface BackgroundTaskNotificationContext {
  readonly content: readonly ContentPart[];
  readonly origin: BackgroundTaskOrigin;
  readonly notification: BackgroundTaskNotification;
}

const NOTIFICATION_TAIL_BYTES = 3_000;

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

  /**
   * Fire terminal side effects for a live task. Idempotent: the second
   * invocation for the same task is a no-op so a lagging `wait()`
   * resolver or a race between `stop()` and natural exit cannot yield
   * duplicate notifications/events.
   */
  private fireTerminalEffects(entry: ManagedTask): void {
    if (entry.terminalFired) return;
    entry.terminalFired = true;
    const info = this.toInfo(entry);
    void this.notifyBackgroundTask(info).catch(() => { });
    this.emitTaskTerminated(info);
  }

  private emitTaskStarted(info: BackgroundTaskInfo): void {
    this.agent.emitEvent({ type: 'background.task.started', info });
    this.agent.telemetry.track('background_task_created', {
      kind: info.kind === 'agent' ? 'agent' : 'bash',
    });
  }

  private emitTaskUpdated(info: BackgroundTaskInfo): void {
    this.agent.emitEvent({ type: 'background.task.updated', info });
  }

  private emitTaskTerminated(info: BackgroundTaskInfo): void {
    this.agent.emitEvent({ type: 'background.task.terminated', info });
    this.agent.telemetry.track('background_task_completed', {
      kind: info.kind,
      duration: info.endedAt !== null ? info.endedAt - info.startedAt : null,
      status: info.status,
    });
  }

  private resolveWaiters(entry: ManagedTask): void {
    const waiters = entry.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private assertCanRegister(): void {
    const maxRunningTasks = this.agent.kimiConfig?.background?.maxRunningTasks;
    if (maxRunningTasks === undefined) return;
    if (this.activeTaskCount() < maxRunningTasks) return;
    throw new Error('Too many background tasks are already running.');
  }

  private activeTaskCount(): number {
    let count = 0;
    for (const entry of this.tasks.values()) {
      if (!TERMINAL_STATUSES.has(entry.status)) count++;
    }
    return count;
  }

  registerTask(task: BackgroundTask): string {
    this.assertCanRegister();
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
      lifecyclePromise: Promise.resolve(),
      persistWriteQueue: Promise.resolve(),
      outputWriteQueue: Promise.resolve(),
    };
    this.tasks.set(taskId, entry);

    entry.lifecyclePromise = Promise.resolve()
      .then(() => task.start({
        signal: entry.abortController.signal,
        appendOutput: (chunk) => {
          this.appendOutput(entry, chunk);
        },
        settle: (settlement) => this.settleTask(entry, settlement),
      }))
      .catch(async (error: unknown) => {
        const aborted = entry.abortController.signal.aborted;
        await this.settleTask(entry, {
          status: aborted ? 'killed' : 'failed',
          stopReason: aborted ? undefined : errorMessage(error),
        });
      });

    // Initial persistence (snapshot at start).
    void this.persistLive(entry);
    this.emitTaskStarted(this.toInfo(entry));

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
    const persistence = this.persistenceFor(taskId);
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
   * the lost task ids so the caller can emit user-facing notifications.
   */
  protected async markLoadedTasksLost(): Promise<ReconcileResult> {
    const lost: string[] = [];
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
      lost.push(id);
      lostInfo.push(updated);
    }
    return { lost, lostInfo };
  }

  async reconcile(): Promise<ReconcileResult> {
    const result = await this.markLoadedTasksLost();
    for (const info of result.lostInfo) {
      this.emitTaskTerminated(info);
    }
    await this.restoreBackgroundTaskNotifications();
    return result;
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

    const persistence = this.persistence;
    if (persistence === undefined) return;
    entry.outputWriteQueue = entry.outputWriteQueue
      .then(() => persistence.appendTaskOutput(entry.taskId, chunk))
      .catch(() => { });
  }

  private persistenceFor(taskId: string): BackgroundTaskPersistence | undefined {
    if (this.tasks.has(taskId)) return this.persistence;
    if (this.ghosts.has(taskId)) return this.persistence;
    return undefined;
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
    const origin: BackgroundTaskOrigin = {
      kind: 'background_task',
      taskId: info.taskId,
      status: info.status,
      notificationId: `task:${info.taskId}:${info.status}`,
    };
    const notificationId = origin.notificationId;
    const key = notificationKey(origin);
    if (this.scheduledNotificationKeys.has(key)) return;
    if (this.hasDeliveredNotification(origin)) return;

    this.scheduledNotificationKeys.add(key);
    const tailOutput = (await this.getOutputSnapshot(info.taskId, NOTIFICATION_TAIL_BYTES))
      .preview;
    if (this.hasDeliveredNotification(origin)) return;
    const isAgentTask = info.kind === 'agent';
    const label = isAgentTask ? 'agent' : 'task';
    const notification: BackgroundTaskNotification = {
      id: notificationId,
      category: 'task',
      type: `task.${info.status}`,
      source_kind: 'background_task',
      source_id: info.taskId,
      agent_id: info.kind === 'agent' ? info.agentId : undefined,
      title: `Background ${label} ${info.status}`,
      severity: info.status === 'completed' ? 'info' : 'warning',
      body: buildBackgroundTaskNotificationBody(info),
      tail_output: tailOutput,
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

  private hasDeliveredNotification(origin: BackgroundTaskOrigin): boolean {
    return this.deliveredNotificationKeys.has(notificationKey(origin));
  }

  private async settleTask(
    entry: ManagedTask,
    settlement: BackgroundTaskSettlement,
  ): Promise<boolean> {
    if (TERMINAL_STATUSES.has(entry.status)) {
      if (entry.status === 'killed' && settlement.status === 'killed') {
        entry.endedAt = Math.max(Date.now(), (entry.endedAt ?? 0) + 1);
        await this.persistLive(entry);
        this.fireTerminalEffects(entry);
        this.resolveWaiters(entry);
      }
      return false;
    }
    entry.status = settlement.status;
    entry.endedAt = Date.now();
    entry.stopReason =
      settlement.stopReason ?? (settlement.status === 'killed' ? entry.stopReason : undefined);
    await this.persistLive(entry);
    this.fireTerminalEffects(entry);
    this.resolveWaiters(entry);
    return true;
  }

  private toInfo(entry: ManagedTask): BackgroundTaskInfo {
    const base: BackgroundTaskInfoBase = {
      taskId: entry.taskId,
      kind: entry.task.kind,
      description: entry.task.description,
      status: entry.status,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      stopReason: entry.stopReason,
      timeoutMs: entry.timeoutMs,
    };
    return entry.task.toInfo(base);
  }
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
