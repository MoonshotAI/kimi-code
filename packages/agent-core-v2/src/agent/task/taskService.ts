/**
 * `task` domain (L5) — `AgentTaskService` implementation.
 *
 * Owns the agent's registry of running and restored tasks:
 * registers and drives tasks to completion, retains a bounded output ring,
 * persists task state and output through task persistence, reads
 * limits through `config`, records lifecycle and broadcasts through `wire`
 * (`task.started` / `task.terminated` Ops into `TaskModel`, plus the matching
 * signals), restores ghosts through a single `wire.onRestored` handler (wire
 * replay -> disk load -> reconcile, in that order), and delivers terminal
 * notifications through `contextMemory`. Bound at Agent scope.
 */

import { randomBytes } from 'node:crypto';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import type { ContentPart } from '#/app/llmProtocol';

import { Disposable } from '#/_base/di';
import { escapeXml, escapeXmlAttr } from '#/_base/utils/xml-escape';
import type { TaskOrigin } from '#/agent/contextMemory';
import { ITaskService, type ITaskHandle, TERMINAL_TASK_STATES } from '#/app/task';
import {
  TERMINAL_STATUSES,
  type AgentTaskInfoBase,
  type AgentTaskSettlement,
} from './types';
import { renderNotificationXml } from './notificationXml';

import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IConfigService } from '#/app/config';
import { IAgentPromptService } from '#/agent/prompt';
import { ISessionContext } from '#/session/sessionContext';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ITelemetryService } from '#/app/telemetry';
import { IAgentWireService, type IWireService } from '#/wire';
import {
  IAgentTaskService,
  type AgentTaskNotificationContext,
  type AgentTaskLoadOptions,
  type AgentTask,
  type AgentTaskInfo,
  type AgentTaskOutputSnapshot,
  type AgentTaskStatus,
  type AgentTaskTrackOptions,
  type ForegroundTaskReleaseReason,
  type IAgentTaskEntry,
  type RegisterAgentTaskOptions,
} from './task';
import { LEGACY_BACKGROUND_SECTION, TASK_SECTION, type AgentTaskConfig } from './configSection';
import { AgentTaskPersistence } from './persist';
import { TaskModel, taskStarted, taskTerminated } from './taskOps';
import { TaskListTool } from '#/agent/task/tools/task-list';
import { TaskOutputTool } from '#/agent/task/tools/task-output';
import { TaskStopTool } from '#/agent/task/tools/task-stop';
import { OrderedHookSlot } from '#/hooks';

interface ForegroundRelease {
  readonly promise: Promise<ForegroundTaskReleaseReason>;
  resolve(reason: ForegroundTaskReleaseReason): void;
}

type AgentTaskNotification = Record<string, unknown> & {
  readonly id: string;
  readonly category: 'task';
  readonly type: string;
  readonly source_kind: 'task';
  readonly source_id: string;
  readonly agent_id?: string | undefined;
  readonly title: string;
  readonly severity: 'info' | 'warning';
  readonly body: string;
  readonly children?: readonly string[] | undefined;
};

interface AgentTaskNotificationBuildContext {
  readonly content: readonly ContentPart[];
  readonly origin: TaskOrigin;
  readonly notification: AgentTaskNotification;
}

interface ManagedTask {
  readonly taskId: string;
  readonly task: AgentTask | undefined;
  readonly handle: ITaskHandle | undefined;
  readonly toInfoFn?: (base: AgentTaskInfoBase) => AgentTaskInfo;
  readonly forceStopFn?: () => Promise<void>;
  readonly onDetachFn?: () => void;
  readonly outputChunks: string[];
  outputSizeBytes: number;
  retainedOutputBytes: number;
  status: AgentTaskStatus;
  options: RegisterAgentTaskOptions & { description?: string };
  readonly startedAt: number;
  endedAt: number | null;
  foregroundRelease?: ForegroundRelease;
  stopReason?: string;
  terminalNotificationSuppressed?: boolean;
  terminalFired: boolean;
  readonly abortController: AbortController;
  foregroundSignalCleanup?: () => void;
  lifecyclePromise: Promise<void>;
  persistWriteQueue: Promise<void>;
  outputWriteQueue: Promise<void>;
  pendingOutput: string[];
  pendingOutputBytes: number;
  outputPersistStarted: boolean;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  timedOut: boolean;
  readonly waiters: Array<() => void>;
  handleSubscription?: { dispose(): void };
}

const MAX_OUTPUT_BYTES = 1024 * 1024;
const SIGTERM_GRACE_MS = 5_000;
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const USER_INTERRUPT_REASON = 'Interrupted by user';
const NOTIFICATION_FALLBACK_PREVIEW_BYTES = 3_000;

export function isAgentTaskTerminal(status: AgentTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export class AgentTaskService extends Disposable implements IAgentTaskService {
  declare readonly _serviceBrand: undefined;
  readonly hooks: IAgentTaskService['hooks'] = {
    onDidNotify: new OrderedHookSlot<AgentTaskNotificationContext>(),
  };

  private readonly tasks = new Map<string, ManagedTask>();
  private readonly ghosts = new Map<string, AgentTaskInfo>();
  private readonly scheduledNotificationKeys = new Set<string>();
  private readonly deliveredNotificationKeys = new Set<string>();
  private readonly persistence: AgentTaskPersistence;

  constructor(
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IConfigService private readonly config: IConfigService,
    @IAtomicDocumentStore atomicDocs: IAtomicDocumentStore,
    @IFileSystemStorageService byteStore: IFileSystemStorageService,
    @ISessionContext session: ISessionContext,
    @ITaskService private readonly taskService: ITaskService,
    @IAgentWireService private readonly wire: IWireService,
  ) {
    super();
    this.persistence = new AgentTaskPersistence(
      session.sessionDir,
      session.metaScope.replace(/\/session-meta$/, ''),
      atomicDocs,
      byteStore,
    );
    this._register(this.wire.onRestored(() => this.restoreAfterReplay()));
    this._register(
      context.hooks.onSpliced.register('task-notification-delivery', async (ctx, next) => {
        await next();
        for (const message of ctx.messages) {
          if (isTaskOrigin(message.origin)) {
            this.markDeliveredNotification(message.origin);
          }
        }
      }),
    );
  }

  private restoreAfterReplay(): void {
    // `wire.replay` has rebuilt `TaskModel` from the persisted task.started /
    // task.terminated records. Seed the restored "ghosts" from it first (the
    // wire-replay contribution), THEN load from disk and reconcile — all inside
    // this single onRestored handler so the ordering (wire ghosts -> disk
    // ghosts -> reconcile) holds. loadFromDisk / reconcile are async (disk
    // I/O); they chain here and are never split across two hooks (splitting
    // would lose or duplicate tasks). They run fire-and-forget relative to the
    // synchronous `wire.replay`: there is no auto-started turn on resume, so
    // the local-disk reconciliation completes before the first RPC turn.
    this.restoreGhostsFromWire();
    void this.loadFromDisk({ replace: false }).then(() => this.reconcile());
  }

  private restoreGhostsFromWire(): void {
    for (const [taskId, info] of this.wire.getModel(TaskModel)) {
      if (this.tasks.has(taskId)) continue;
      this.ghosts.set(taskId, info);
    }
  }

  registerTask(task: AgentTask, options: RegisterAgentTaskOptions = {}): string {
    const detached = options.detached ?? true;
    const timeoutMs = options.timeoutMs ?? task.timeoutMs;
    const entryOptions: RegisterAgentTaskOptions = {
      detached,
      timeoutMs,
      detachTimeoutMs: options.detachTimeoutMs,
      signal: detached ? undefined : options.signal,
    };
    this.assertCanRegister(detached);
    const entry: ManagedTask = {
      taskId: generateTaskId(task.idPrefix),
      task,
      handle: undefined,
      outputChunks: [],
      outputSizeBytes: 0,
      retainedOutputBytes: 0,
      status: 'running',
      options: entryOptions,
      startedAt: Date.now(),
      endedAt: null,
      foregroundRelease: detached ? undefined : createForegroundRelease(),
      abortController: new AbortController(),
      lifecyclePromise: Promise.resolve(),
      persistWriteQueue: Promise.resolve(),
      outputWriteQueue: Promise.resolve(),
      pendingOutput: [],
      pendingOutputBytes: 0,
      outputPersistStarted: detached,
      waiters: [],
      terminalFired: false,
      timedOut: false,
    };
    this.tasks.set(entry.taskId, entry);
    this.ghosts.delete(entry.taskId);

    if (timeoutMs !== undefined && timeoutMs > 0) {
      entry.timeoutHandle = setTimeout(() => {
        entry.abortController.abort('Timed out');
        void this.settleTask(entry, { status: 'timed_out' });
      }, timeoutMs);
      entry.timeoutHandle.unref?.();
    }

    entry.lifecyclePromise = Promise.resolve()
      .then(() =>
        task.start({
          signal: entry.abortController.signal,
          appendOutput: (chunk) => {
            this.appendOutput(entry, chunk);
          },
          settle: (settlement) => this.settleTask(entry, settlement),
        }),
      )
      .catch(async (error: unknown) => {
        const status = entry.abortController.signal.aborted ? 'killed' : 'failed';
        await this.settleTask(entry, {
          status,
          stopReason: status === 'failed' ? errorMessage(error) : undefined,
        });
      });
    this.installForegroundSignal(entry);

    if (this.isDetached(entry)) {
      void this.persistLive(entry);
      this.recordTaskStarted(this.toInfo(entry));
    }
    return entry.taskId;
  }

  track(handle: ITaskHandle, options: AgentTaskTrackOptions): IAgentTaskEntry {
    const detached = options.detached ?? true;
    this.assertCanRegister(detached);

    const taskId = generateTaskId(options.idPrefix ?? 'task');
    const timeoutMs = options.timeoutMs;

    const entry: ManagedTask = {
      taskId,
      task: undefined,
      handle,
      toInfoFn: options.toInfo,
      forceStopFn: options.forceStop,
      onDetachFn: options.onDetach,
      outputChunks: [],
      outputSizeBytes: 0,
      retainedOutputBytes: 0,
      status: 'running',
      options: { detached, timeoutMs, detachTimeoutMs: options.detachTimeoutMs, signal: detached ? undefined : options.signal, description: options.description },
      startedAt: Date.now(),
      endedAt: null,
      foregroundRelease: detached ? undefined : createForegroundRelease(),
      abortController: new AbortController(),
      lifecyclePromise: Promise.resolve(),
      persistWriteQueue: Promise.resolve(),
      outputWriteQueue: Promise.resolve(),
      pendingOutput: [],
      pendingOutputBytes: 0,
      outputPersistStarted: detached,
      waiters: [],
      terminalFired: false,
      timedOut: false,
    };
    this.tasks.set(taskId, entry);
    this.ghosts.delete(taskId);

    if (timeoutMs !== undefined && timeoutMs > 0) {
      entry.timeoutHandle = setTimeout(() => {
        entry.timedOut = true;
        handle.cancel();
      }, timeoutMs);
      entry.timeoutHandle.unref?.();
    }

    const outputSub = handle.onDidOutput((chunk) => {
      this.appendOutput(entry, chunk);
    });

    const stateSub = handle.onDidChangeState((state) => {
      if (!TERMINAL_TASK_STATES.has(state)) return;
      const status = entry.timedOut ? 'timed_out' as const
        : state === 'cancelled' ? 'killed' as const
        : state === 'failed' ? 'failed' as const
        : 'completed' as const;
      void this.settleTask(entry, { status, stopReason: entry.stopReason });
    });

    entry.handleSubscription = {
      dispose() {
        outputSub.dispose();
        stateSub.dispose();
      },
    };

    entry.lifecyclePromise = handle.result.then(() => {}, () => {});

    this.installForegroundSignal(entry);

    if (this.isDetached(entry)) {
      void this.persistLive(entry);
      this.recordTaskStarted(this.toInfo(entry));
    }

    return {
      taskId,
      onDidDetach: entry.foregroundRelease?.promise ?? Promise.resolve('terminal' as const),
    };
  }

  getTask(taskId: string): AgentTaskInfo | undefined {
    const entry = this.tasks.get(taskId);
    return entry === undefined ? this.ghosts.get(taskId) : this.toInfo(entry);
  }

  list(activeOnly = true, limit?: number): readonly AgentTaskInfo[] {
    const result: AgentTaskInfo[] = [];
    for (const entry of this.tasks.values()) {
      const info = this.toInfo(entry);
      if (!shouldListTask(info, activeOnly)) continue;
      result.push(info);
      if (limit !== undefined && result.length >= limit) return result;
    }
    if (!activeOnly) {
      for (const ghost of this.ghosts.values()) {
        if (!shouldListTask(ghost, activeOnly)) continue;
        result.push(ghost);
        if (limit !== undefined && result.length >= limit) return result;
      }
    }
    return result;
  }

  persistOutput(taskId: string): void {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return;
    this.startOutputPersist(entry);
  }

  async loadFromDisk(options: AgentTaskLoadOptions = {}): Promise<void> {
    const persistence = this.persistence;
    if (options.replace !== false) {
      this.ghosts.clear();
    }
    const tasks = await persistence.listTasks();
    for (const task of tasks) {
      if (this.tasks.has(task.taskId)) continue;
      const existing = this.ghosts.get(task.taskId);
      if (existing !== undefined) {
        this.ghosts.set(task.taskId, newerRestoredTask(existing, task));
        continue;
      }
      this.ghosts.set(task.taskId, task);
    }
  }

  async reconcile(): Promise<readonly AgentTaskInfo[]> {
    const lostTasks = await this.markLoadedTasksLost();
    for (const info of lostTasks) {
      this.recordTaskTerminated(info);
    }
    await this.restoreAgentTaskNotifications();
    return lostTasks;
  }

  async getOutputSnapshot(
    taskId: string,
    maxPreviewBytes: number,
  ): Promise<AgentTaskOutputSnapshot> {
    if (this.getTask(taskId) === undefined) return emptyOutputSnapshot();

    await this.tasks.get(taskId)?.outputWriteQueue;

    const previewLimit = Math.max(0, Math.trunc(maxPreviewBytes));
    const persistence = this.persistence;
    if (await persistence.taskOutputExists(taskId)) {
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
    const previewOffset = Math.max(0, available.byteLength - previewBytes);
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
    if (tail === undefined) return output;
    return output.slice(-Math.max(0, Math.trunc(tail)));
  }

  async suppressTerminalNotification(taskId: string): Promise<void> {
    const entry = this.tasks.get(taskId);
    if (entry !== undefined) {
      if (entry.terminalNotificationSuppressed === true) return;
      entry.terminalNotificationSuppressed = true;
      await this.persistLive(entry);
      return;
    }

    const ghost = this.ghosts.get(taskId);
    if (ghost !== undefined) return;
  }

  detach(taskId: string): AgentTaskInfo | undefined {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return this.ghosts.get(taskId);
    if (TERMINAL_STATUSES.has(entry.status)) return this.toInfo(entry);

    const foregroundRelease = entry.foregroundRelease;
    if (foregroundRelease === undefined) return this.toInfo(entry);

    entry.foregroundRelease = undefined;
    entry.foregroundSignalCleanup?.();
    entry.foregroundSignalCleanup = undefined;
    this.applyDetachTimeout(entry);
    try {
      const onDetach = entry.onDetachFn ?? entry.task?.onDetach;
      onDetach?.();
    } catch {
      /* detach has already succeeded; hooks must not make RPC fail */
    }
    this.startOutputPersist(entry);
    void this.persistLive(entry);
    this.recordTaskStarted(this.toInfo(entry));
    foregroundRelease.resolve('detached');
    return this.toInfo(entry);
  }

  private applyDetachTimeout(entry: ManagedTask): void {
    const timeoutMs = entry.options.detachTimeoutMs;
    if (timeoutMs === undefined) return;
    entry.options = { ...entry.options, timeoutMs };
    if (entry.timeoutHandle !== undefined) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = undefined;
    }
    if (timeoutMs > 0) {
      entry.timeoutHandle = setTimeout(() => {
        entry.timedOut = true;
        if (entry.handle) {
          entry.handle.cancel();
        } else {
          entry.abortController.abort('Timed out');
          void this.settleTask(entry, { status: 'timed_out' });
        }
      }, timeoutMs);
      entry.timeoutHandle.unref?.();
    }
  }

  async stop(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return undefined;
    return this.stopEntry(entry, normalizeReason(reason), normalizeReason(reason));
  }

  private async stopEntry(
    entry: ManagedTask,
    stopReason: string | undefined,
    abortReason: unknown,
  ): Promise<AgentTaskInfo | undefined> {
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    entry.stopReason = stopReason;
    if (entry.handle) {
      entry.handle.cancel();
    } else {
      entry.abortController.abort(abortReason);
    }

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
        graceTimer.unref?.();
      }),
    ]);
    if (graceTimer !== undefined) clearTimeout(graceTimer);

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    if (!graceful) {
      try {
        const forceStop = entry.forceStopFn ?? entry.task?.forceStop;
        await forceStop?.();
      } catch {
        /* best effort */
      }
    }

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    await this.settleTask(entry, { status: 'killed', stopReason });
    await entry.persistWriteQueue;
    return this.toInfo(entry);
  }

  async stopAll(reason?: string): Promise<readonly AgentTaskInfo[]> {
    const results = await Promise.all(
      Array.from(this.tasks.keys()).map((taskId) => this.stop(taskId, reason)),
    );
    return results.filter((info): info is AgentTaskInfo => info !== undefined);
  }

  async wait(taskId: string, timeoutMs = 30_000): Promise<AgentTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return this.ghosts.get(taskId);
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    let waiter: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          waiter = resolve;
          entry.waiters.push(resolve);
        }),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (waiter !== undefined) {
        const index = entry.waiters.indexOf(waiter);
        if (index !== -1) entry.waiters.splice(index, 1);
      }
    }

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
    }
    return this.toInfo(entry);
  }

  async waitForForegroundRelease(
    taskId: string,
  ): Promise<ForegroundTaskReleaseReason | undefined> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return undefined;
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return 'terminal';
    }
    if (this.isDetached(entry)) return 'detached';

    const foregroundRelease = entry.foregroundRelease;
    if (foregroundRelease === undefined) return 'detached';
    const foregroundReleasePromise = foregroundRelease.promise;
    const reason = await Promise.race([
      foregroundReleasePromise,
      entry.lifecyclePromise.then(() => 'terminal' as const),
    ]);
    if (reason === 'terminal') {
      await entry.persistWriteQueue;
    }
    return reason;
  }

  private assertCanRegister(detached: boolean): void {
    const maxRunningTasks = this.taskConfig()?.maxRunningTasks;
    if (maxRunningTasks === undefined) return;
    if (!detached) return;
    if (this.activeTaskCount() < maxRunningTasks) return;
    throw new Error('Too many detached tasks are already running.');
  }

  private taskConfig(): AgentTaskConfig | undefined {
    return (
      this.config.get<AgentTaskConfig | undefined>(TASK_SECTION) ??
      this.config.get<AgentTaskConfig | undefined>(LEGACY_BACKGROUND_SECTION)
    );
  }

  private activeTaskCount(): number {
    let count = 0;
    for (const entry of this.tasks.values()) {
      if (!TERMINAL_STATUSES.has(entry.status) && this.startsDetached(entry)) count++;
    }
    return count;
  }

  private startsDetached(entry: ManagedTask): boolean {
    return entry.options.detached !== false;
  }

  private isDetached(entry: ManagedTask): boolean {
    return entry.foregroundRelease === undefined;
  }

  private async markLoadedTasksLost(): Promise<readonly AgentTaskInfo[]> {
    const lostTasks: AgentTaskInfo[] = [];
    const persistence = this.persistence;
    for (const [taskId, info] of this.ghosts) {
      if (TERMINAL_STATUSES.has(info.status)) continue;
      const updated: AgentTaskInfo = {
        ...info,
        status: 'lost',
        endedAt: info.endedAt ?? Date.now(),
      };
      this.ghosts.set(taskId, updated);
      await persistence.writeTask(updated);
      lostTasks.push(updated);
    }
    return lostTasks;
  }

  private persistLive(entry: ManagedTask): Promise<void> {
    const persistence = this.persistence;
    const info = this.toInfo(entry);
    entry.persistWriteQueue = entry.persistWriteQueue
      .then(() => persistence.writeTask(info))
      .catch(() => { });
    return entry.persistWriteQueue;
  }

  private appendOutput(entry: ManagedTask, chunk: string): void {
    const chunkBytes = Buffer.byteLength(chunk, 'utf-8');
    entry.outputSizeBytes += chunkBytes;
    this.appendRetainedOutput(entry, chunk, chunkBytes);

    if (!entry.outputPersistStarted) {
      entry.pendingOutput.push(chunk);
      entry.pendingOutputBytes += chunkBytes;
      if (entry.pendingOutputBytes > MAX_OUTPUT_BYTES) {
        this.startOutputPersist(entry);
      }
      return;
    }
    this.appendTaskOutput(entry, chunk);
  }

  private appendTaskOutput(entry: ManagedTask, chunk: string): void {
    const persistence = this.persistence;
    entry.outputWriteQueue = entry.outputWriteQueue
      .then(() => persistence.appendTaskOutput(entry.taskId, chunk))
      .catch(() => { });
  }

  private startOutputPersist(entry: ManagedTask): void {
    if (entry.outputPersistStarted) return;
    entry.outputPersistStarted = true;
    if (entry.pendingOutput.length > 0) {
      this.appendTaskOutput(entry, entry.pendingOutput.join(''));
    }
    entry.pendingOutput = [];
    entry.pendingOutputBytes = 0;
  }

  private appendRetainedOutput(entry: ManagedTask, chunk: string, chunkBytes: number): void {
    if (chunkBytes >= MAX_OUTPUT_BYTES) {
      const retained = Buffer.from(chunk, 'utf-8')
        .subarray(chunkBytes - MAX_OUTPUT_BYTES)
        .toString('utf-8');
      entry.outputChunks.length = 0;
      entry.outputChunks.push(retained);
      entry.retainedOutputBytes = Buffer.byteLength(retained, 'utf-8');
      return;
    }

    entry.outputChunks.push(chunk);
    entry.retainedOutputBytes += chunkBytes;
    while (entry.retainedOutputBytes > MAX_OUTPUT_BYTES) {
      const removed = entry.outputChunks.shift();
      if (removed === undefined) break;
      entry.retainedOutputBytes -= Buffer.byteLength(removed, 'utf-8');
    }
  }

  private async settleTask(
    entry: ManagedTask,
    settlement: AgentTaskSettlement,
  ): Promise<boolean> {
    if (TERMINAL_STATUSES.has(entry.status)) return false;
    entry.status = settlement.status;
    entry.endedAt = Date.now();
    entry.stopReason =
      settlement.stopReason ?? (settlement.status === 'killed' ? entry.stopReason : undefined);
    entry.foregroundSignalCleanup?.();
    entry.foregroundSignalCleanup = undefined;
    entry.handleSubscription?.dispose();
    entry.handleSubscription = undefined;
    if (entry.timeoutHandle !== undefined) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = undefined;
    }
    const foregroundRelease = entry.foregroundRelease;
    if (entry.outputPersistStarted) {
      await this.persistLive(entry);
    } else {
      entry.pendingOutput = [];
      entry.pendingOutputBytes = 0;
    }
    this.fireTerminalEffects(entry);
    foregroundRelease?.resolve('terminal');
    this.resolveWaiters(entry);
    return true;
  }

  private fireTerminalEffects(entry: ManagedTask): void {
    if (entry.terminalFired) return;
    if (!this.isDetached(entry)) return;
    entry.terminalFired = true;
    const info = this.toInfo(entry);
    void this.notifyAgentTask(info).catch(() => { });
    this.recordTaskTerminated(info);
  }

  private recordTaskStarted(info: AgentTaskInfo): void {
    this.wire.dispatch(taskStarted({ info }));
    this.telemetry.track('task_created', {
      kind: info.kind === 'process' ? 'bash' : info.kind,
    });
  }

  private recordTaskTerminated(info: AgentTaskInfo): void {
    this.wire.dispatch(taskTerminated({ info }));
    this.telemetry.track('task_completed', {
      kind: info.kind,
      duration: info.endedAt !== null ? info.endedAt - info.startedAt : null,
      status: info.status,
    });
  }

  private async notifyAgentTask(info: AgentTaskInfo): Promise<void> {
    const context = await this.buildAgentTaskNotificationContext(info);
    if (context === undefined) return;
    await this.prompt.steer({
      role: 'user',
      content: [...context.content],
      toolCalls: [],
      origin: context.origin,
    }).launched;
    this.fireNotificationHook(context.notification);
  }

  private async restoreAgentTaskNotifications(): Promise<void> {
    for (const info of this.list(false)) {
      if (!isAgentTaskTerminal(info.status)) continue;
      await this.restoreAgentTaskNotification(info);
    }
  }

  private async restoreAgentTaskNotification(info: AgentTaskInfo): Promise<void> {
    const context = await this.buildAgentTaskNotificationContext(info);
    if (context === undefined) return;
    this.context.append({
      role: 'user',
      content: [...context.content],
      toolCalls: [],
      origin: context.origin,
    });
    this.fireNotificationHook(context.notification);
  }

  private async buildAgentTaskNotificationContext(
    info: AgentTaskInfo,
  ): Promise<AgentTaskNotificationBuildContext | undefined> {
    if (info.detached === false) return undefined;
    if (info.terminalNotificationSuppressed === true) return undefined;
    const origin: TaskOrigin = {
      kind: 'task',
      taskId: info.taskId,
      status: info.status,
      notificationId: `task:${info.taskId}:${info.status}`,
    };
    const key = notificationKey(origin);
    if (this.scheduledNotificationKeys.has(key)) return undefined;
    if (this.deliveredNotificationKeys.has(key)) return undefined;
    if (this.hasDeliveredNotification(key)) return undefined;
    this.scheduledNotificationKeys.add(key);

    let output = await this.getOutputSnapshot(info.taskId, 0);
    if (!output.fullOutputAvailable) {
      output = await this.getOutputSnapshot(info.taskId, NOTIFICATION_FALLBACK_PREVIEW_BYTES);
    }
    if (this.isTerminalNotificationSuppressed(info.taskId)) return undefined;
    const notification: AgentTaskNotification = {
      id: origin.notificationId,
      category: 'task',
      type: `task.${info.status}`,
      source_kind: 'task',
      source_id: info.taskId,
      agent_id: info.kind === 'agent' ? info.agentId : undefined,
      title: `Task ${info.kind} ${info.status}`,
      severity: info.status === 'completed' ? 'info' : 'warning',
      body: buildAgentTaskNotificationBody(info),
      children: agentTaskNotificationChildren(output),
    };
    const content = [
      {
        type: 'text',
        text: renderNotificationXml(notification),
      },
    ] as const;
    return { content, origin, notification };
  }

  private fireNotificationHook(notification: AgentTaskNotification): void {
    void this.hooks.onDidNotify.run({
      notificationType: notification.type,
      title: notification.title,
      body: notification.body,
      severity: notification.severity,
      sourceKind: notification.source_kind,
      sourceId: notification.source_id,
    }).catch(() => undefined);
  }

  private isTerminalNotificationSuppressed(taskId: string): boolean {
    return (
      this.tasks.get(taskId)?.terminalNotificationSuppressed === true ||
      this.ghosts.get(taskId)?.terminalNotificationSuppressed === true
    );
  }

  private markDeliveredNotification(origin: TaskOrigin): void {
    this.deliveredNotificationKeys.add(notificationKey(origin));
  }

  private hasDeliveredNotification(key: string): boolean {
    return this.context.get().some((message) => {
      return isTaskOrigin(message.origin) && notificationKey(message.origin) === key;
    });
  }

  private resolveWaiters(entry: ManagedTask): void {
    const waiters = entry.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private installForegroundSignal(entry: ManagedTask): void {
    const signal = entry.options.signal;
    if (signal === undefined) return;

    const abortFromSignal = (): void => {
      if (this.isDetached(entry)) return;
      void this.stopEntry(entry, USER_INTERRUPT_REASON, signal.reason);
    };
    if (signal.aborted) {
      abortFromSignal();
      return;
    }
    signal.addEventListener('abort', abortFromSignal, { once: true });
    entry.foregroundSignalCleanup = () => {
      signal.removeEventListener('abort', abortFromSignal);
    };
  }

  private toInfo(entry: ManagedTask): AgentTaskInfo {
    const base: AgentTaskInfoBase = {
      taskId: entry.taskId,
      description: entry.task?.description ?? entry.options.description ?? '',
      status: entry.status,
      detached: this.isDetached(entry) ? true : false,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      stopReason: entry.stopReason,
      terminalNotificationSuppressed: entry.terminalNotificationSuppressed,
      timeoutMs: entry.options.timeoutMs,
    };
    if (entry.toInfoFn) return entry.toInfoFn(base);
    return entry.task!.toInfo(base);
  }
}

function emptyOutputSnapshot(): AgentTaskOutputSnapshot {
  return {
    outputSizeBytes: 0,
    previewBytes: 0,
    truncated: false,
    fullOutputAvailable: false,
    preview: '',
  };
}

function agentTaskNotificationChildren(
  output: AgentTaskOutputSnapshot,
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

function renderOutputPreviewBlock(output: AgentTaskOutputSnapshot): string {
  return [
    `<output-preview bytes="${String(output.previewBytes)}" total_bytes="${String(output.outputSizeBytes)}" truncated="${String(output.truncated)}">`,
    output.truncated
      ? `Showing the last ${String(output.previewBytes)} bytes. No persisted full output is available.`
      : 'No persisted full output is available; this preview is the currently buffered task output.',
    escapeXml(output.preview),
    '</output-preview>',
  ].join('\n');
}

function shouldListTask(info: AgentTaskInfo, activeOnly: boolean): boolean {
  if (!TERMINAL_STATUSES.has(info.status)) return true;
  if (activeOnly) return false;
  return info.detached !== false;
}

function newerRestoredTask(
  existing: AgentTaskInfo,
  loaded: AgentTaskInfo,
): AgentTaskInfo {
  const existingTerminal = isAgentTaskTerminal(existing.status);
  const loadedTerminal = isAgentTaskTerminal(loaded.status);
  if (existingTerminal && !loadedTerminal) return existing;
  if (!existingTerminal && loadedTerminal) return loaded;
  if (existing.endedAt !== null && loaded.endedAt !== null) {
    return loaded.endedAt >= existing.endedAt ? loaded : existing;
  }
  if (existing.endedAt !== null) return existing;
  if (loaded.endedAt !== null) return loaded;
  return loaded;
}

function isTaskOrigin(origin: unknown): origin is TaskOrigin {
  if (typeof origin !== 'object' || origin === null) return false;
  const kind = (origin as { kind?: unknown }).kind;
  return kind === 'task';
}

function notificationKey(origin: TaskOrigin): string {
  return `${origin.taskId}\0${origin.status}\0${origin.notificationId}`;
}

function buildAgentTaskNotificationBody(info: AgentTaskInfo): string {
  const baseLine =
    info.status === 'timed_out'
      ? `${info.description} timed out.`
      : info.stopReason
        ? `${info.description} ${info.status === 'killed' ? 'was killed' : info.status}: ${info.stopReason}.`
        : `${info.description} ${info.status}.`;

  if (info.kind !== 'agent') return baseLine;
  if (info.status === 'completed') return baseLine;
  const agentId = info.agentId;
  if (agentId === undefined || agentId === info.taskId) return baseLine;

  const recovery = [
    '',
    `To recover or continue this subagent, call Agent(resume="${agentId}", prompt="Pick up where you left off; redo the last tool call if its result was never observed.").`,
    `Use agent_id ("${agentId}"), NOT source_id / task_id ("${info.taskId}") because the two look alike but only agent_id is accepted by the resume parameter.`,
    'Add run_in_background=true to keep it backgrounded, or omit it to take the result inline in the current turn.',
    'The subagent retains its full prior context across the restart, but any in-flight tool call lost its result and may need to be redone.',
  ].join('\n');

  return `${baseLine}${recovery}`;
}

function generateTaskId(kind: string): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let index = 0; index < 8; index++) {
    suffix += TASK_ID_ALPHABET[bytes[index]! % TASK_ID_ALPHABET.length];
  }
  return `${kind}-${suffix}`;
}

function normalizeReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function createForegroundRelease(): ForegroundRelease {
  let resolve!: (reason: ForegroundTaskReleaseReason) => void;
  const promise = new Promise<ForegroundTaskReleaseReason>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTaskService,
  AgentTaskService,
  InstantiationType.Delayed,
  'task',
);
