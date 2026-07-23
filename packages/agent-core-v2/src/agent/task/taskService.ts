/**
 * `task` domain (L5) — `AgentTaskService` implementation.
 *
 * Owns the agent's registry of running and restored tasks:
 * registers and drives tasks to completion, retains a bounded output ring,
 * persists task state and output through task persistence rooted at the
 * agent's own scope (v1's per-agent `<sessionDir>/agents/<id>/tasks/`
 * layout), lets only the main agent read through the previous v2
 * session-level task root without writing back to it, reads
 * limits through `config`, records lifecycle and broadcasts through `wire`
 * (persisted `task.started` / `task.terminated` Ops into `TaskModel`, the
 * terminated record carrying a bounded tail of the task's retained output as
 * `outputTail`, plus the matching signals), restores ghosts through a single
 * `wire.hooks.onDidRestore` hook
 * (wire replay -> disk load -> reconcile, in that order), delivers live
 * terminal notifications by enqueueing `TaskNotificationStepRequest`s onto
 * `loop` with `activeOrNewTurn` admission (mid-turn ones fold into the active turn's
 * following step; idle ones launch a fresh turn themselves, matching v1's
 * `turn.steer`, so the model consumes the notification without waiting for
 * the user), silently appends restored notifications through `contextMemory`,
 * re-surfaces active tasks through `contextInjector` after compaction, and
 * requests every owned task to stop on session close (`stopAllOnExit` — v1's
 * `stopBackgroundTasksOnExit`) with configurable SIGTERM grace and SIGKILL
 * escalation. `keepAliveOnExit` skips task-manager teardown so independently
 * living external work such as processes can continue; Session-scoped agents
 * remain governed by the Session lifecycle. Scope disposal paths that bypass
 * graceful close synchronously cancel/abort work and immediately attempt a
 * best-effort force-stop to reduce the risk of surviving child processes.
 * Bound at Agent scope.
 */

import { randomBytes } from 'node:crypto';
import { join } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import type { ContentPart } from '#/kosong/contract/message';

import { Disposable } from '#/_base/di/lifecycle';
import {
  abortable,
  userCancellationReason,
} from '#/_base/utils/abort';
import { escapeXml, escapeXmlAttr } from '#/_base/utils/xml-escape';
import { IEventBus } from '#/app/event/eventBus';
import type { ContextMessage, TaskOrigin } from '#/agent/contextMemory/types';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentLoopService } from '#/agent/loop/loop';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ITaskService, type ITaskHandle, TERMINAL_TASK_STATES } from '#/app/task/task';
import {
  TERMINAL_STATUSES,
  type AgentTaskInfoBase,
  type AgentTaskSettlement,
} from './types';
import { renderNotificationXml } from './notificationXml';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IConfigService } from '#/app/config/config';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { defineModel } from '#/wire/model';
import { IWireService } from '#/wire/wire';
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
import { resolveAgentTaskConfig } from './configSection';
import { AgentTaskPersistence } from './persist';
import { TaskModel, taskStarted, taskTerminated } from './taskOps';
import { formatTaskList } from '#/agent/task/tools/task-list';
import '#/agent/task/tools/task-output';
import '#/agent/task/tools/task-stop';

interface ForegroundRelease {
  readonly promise: Promise<ForegroundTaskReleaseReason>;
  resolve(reason: ForegroundTaskReleaseReason): void;
}

type AgentTaskNotification = Record<string, unknown> & {
  readonly id: string;
  readonly category: 'task';
  readonly type: string;
  readonly source_kind: 'background_task';
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

const TaskNotificationDeliveryModel = defineModel<readonly string[]>(
  'task.notificationDelivery',
  () => [],
  {
    reducers: {
      'context.append_message': (state, payload: { message?: unknown }) => {
        const origin = taskOriginFromMessage(payload.message);
        if (origin === undefined) return state;
        const key = notificationKey(origin);
        return state.includes(key) ? state : [...state, key];
      },
    },
  },
);

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
  outputLimitTripped: boolean;
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

const TERMINAL_OUTPUT_TAIL_BYTES = 4 * 1024;

const MAX_TASK_OUTPUT_BYTES = 16 * 1024 * 1024;

function outputLimitReason(): string {
  const mib = Math.floor(MAX_TASK_OUTPUT_BYTES / (1024 * 1024));
  return (
    `Output limit exceeded: the command produced more than ${mib} MiB and was ` +
    'terminated. Redirect large output to a file (e.g. `command > out.txt`) and ' +
    'inspect it in slices instead.'
  );
}

const SIGTERM_GRACE_MS = 5_000;
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const SESSION_CLOSED_REASON = 'Session closed';
const NOTIFICATION_FALLBACK_PREVIEW_BYTES = 3_000;
const ACTIVE_BACKGROUND_TASK_INJECTION_VARIANT = 'background_task_status';
const ACTIVE_BACKGROUND_TASK_GUIDANCE = [
  'The conversation was compacted, so the earlier messages that started these background tasks are gone — but the tasks are still running from before.',
  'Do not start duplicates. Use TaskOutput to fetch a task’s result, TaskList to list them, and TaskStop to cancel one.',
].join(' ');

export function isAgentTaskTerminal(status: AgentTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function coerceTimeoutSettlement(
  entry: ManagedTask,
  settlement: AgentTaskSettlement,
): AgentTaskSettlement {
  if (entry.timedOut && settlement.status === 'killed') {
    return { ...settlement, status: 'timed_out' };
  }
  return settlement;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'task.notified': AgentTaskNotificationContext;
  }
}

export class TaskNotificationStepRequest extends MessageStepRequest {
  constructor(message: ContextMessage) {
    super(message, {
      kind: 'task_notification',
      mergeable: true,
      turnScoped: false,
      admission: 'activeOrNewTurn',
    });
  }
}

export class AgentTaskService extends Disposable implements IAgentTaskService {
  declare readonly _serviceBrand: undefined;

  private readonly tasks = new Map<string, ManagedTask>();
  private readonly ghosts = new Map<string, AgentTaskInfo>();
  private readonly scheduledNotificationKeys = new Set<string>();
  private readonly deliveredNotificationKeys = new Set<string>();
  private readonly persistence: AgentTaskPersistence;
  private activeTaskReminderPending = false;

  constructor(
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IConfigService private readonly config: IConfigService,
    @IAtomicDocumentStore atomicDocs: IAtomicDocumentStore,
    @IFileSystemStorageService byteStore: IFileSystemStorageService,
    @ISessionContext session: ISessionContext,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @ITaskService private readonly taskService: ITaskService,
    @IWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
  ) {
    super();
    const fallbackRoot =
      scopeContext.agentId === 'main'
        ? { dir: session.sessionDir, scope: session.scope() }
        : undefined;
    this.persistence = new AgentTaskPersistence(
      join(session.sessionDir, 'agents', scopeContext.agentId),
      scopeContext.scope(),
      atomicDocs,
      byteStore,
      fallbackRoot,
    );
    this._register(
      this.wire.hooks.onDidRestore.register('task', async (_ctx, next) => {
        for (const key of this.wire.getModel(TaskNotificationDeliveryModel)) {
          this.deliveredNotificationKeys.add(key);
        }
        await this.restoreAfterReplay();
        await next();
      }),
    );
    this._register(
      this.eventBus.subscribe('context.spliced', (e) => {
        if (isCompactionSplice(e)) {
          this.activeTaskReminderPending = true;
        }
        for (const message of e.messages) {
          if (isTaskOrigin(message.origin)) {
            this.markDeliveredNotification(message.origin);
          }
        }
      }),
    );
    this._register(
      injector.register(ACTIVE_BACKGROUND_TASK_INJECTION_VARIANT, () =>
        this.activeBackgroundTaskReminder(),
      ),
    );
  }

  private async restoreAfterReplay(): Promise<void> {
    this.restoreGhostsFromWire();
    await this.loadFromDisk({ replace: false });
    await this.reconcile();
  }

  private activeBackgroundTaskReminder(): string | undefined {
    if (!this.activeTaskReminderPending) return undefined;
    this.activeTaskReminderPending = false;
    const tasks = this.list(true);
    if (tasks.length === 0) return undefined;
    return `${ACTIVE_BACKGROUND_TASK_GUIDANCE}\n\n${formatTaskList(tasks, true)}`;
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
      autoBackgroundOnTimeout: options.autoBackgroundOnTimeout,
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
      outputLimitTripped: false,
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
      this.armManagerTimeout(entry, timeoutMs);
    }

    entry.lifecyclePromise = Promise.resolve()
      .then(() =>
        task.start({
          signal: entry.abortController.signal,
          appendOutput: (chunk) => {
            this.appendOutput(entry, chunk);
          },
          settle: (settlement) =>
            this.settleTask(entry, coerceTimeoutSettlement(entry, settlement)),
        }),
      )
      .catch(async (error: unknown) => {
        const aborted = entry.abortController.signal.aborted;
        let status: AgentTaskStatus;
        if (entry.timedOut) {
          status = 'timed_out';
        } else if (aborted) {
          status = 'killed';
        } else {
          status = 'failed';
        }
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
      outputLimitTripped: false,
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
      this.armManagerTimeout(entry, timeoutMs);
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

    entry.lifecyclePromise = handle.result.then(() => { }, () => { });

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
    const persisted = await persistence.readTaskOutputSnapshot(taskId, previewLimit);
    if (persisted !== undefined) {
      return {
        ...persisted,
        fullOutputAvailable: true,
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
    return this.detachEntry(entry, false);
  }

  private detachEntry(entry: ManagedTask, viaTimeout: boolean): AgentTaskInfo | undefined {
    if (TERMINAL_STATUSES.has(entry.status)) return this.toInfo(entry);

    const foregroundRelease = entry.foregroundRelease;
    if (foregroundRelease === undefined) return this.toInfo(entry);

    entry.foregroundRelease = undefined;
    entry.foregroundSignalCleanup?.();
    entry.foregroundSignalCleanup = undefined;
    this.applyDetachTimeout(entry);
    try {
      const onDetach =
        entry.onDetachFn ??
        (entry.task === undefined ? undefined : entry.task.onDetach?.bind(entry.task));
      onDetach?.();
    } catch {
    }
    this.startOutputPersist(entry);
    void this.persistLive(entry);
    this.recordTaskStarted(this.toInfo(entry));
    foregroundRelease.resolve(viaTimeout ? 'timeout_detached' : 'detached');
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
      this.armManagerTimeout(entry, timeoutMs);
    }
  }

  private armManagerTimeout(entry: ManagedTask, timeoutMs: number): void {
    entry.timeoutHandle = setTimeout(() => {
      entry.timeoutHandle = undefined;
      if (this.canAutoBackgroundOnTimeout(entry)) {
        this.detachEntry(entry, true);
        return;
      }
      void this.terminateWithGrace(entry, {
        abortReason: 'Timed out',
        finalStatus: 'timed_out',
      });
    }, timeoutMs);
    entry.timeoutHandle.unref?.();
  }

  private canAutoBackgroundOnTimeout(entry: ManagedTask): boolean {
    return entry.options.autoBackgroundOnTimeout === true && !this.isDetached(entry);
  }

  async stop(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return undefined;
    const normalized = normalizeReason(reason);
    return this.terminateWithGrace(entry, {
      stopReason: normalized,
      abortReason: normalized,
      finalStatus: 'killed',
    });
  }

  async stopByUser(taskId: string): Promise<AgentTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return undefined;
    const reason = userCancellationReason();
    return this.terminateWithGrace(entry, {
      stopReason: reason.message,
      abortReason: reason,
      finalStatus: 'killed',
    });
  }

  private async terminateWithGrace(
    entry: ManagedTask,
    options: {
      readonly stopReason?: string;
      readonly abortReason: unknown;
      readonly finalStatus: 'killed' | 'timed_out';
    },
  ): Promise<AgentTaskInfo | undefined> {
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    if (entry.timeoutHandle !== undefined) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = undefined;
    }
    if (options.finalStatus === 'timed_out') {
      entry.timedOut = true;
    }
    entry.stopReason = options.stopReason;
    if (entry.handle) {
      entry.handle.cancel();
    } else {
      entry.abortController.abort(options.abortReason);
    }

    const graceMs = resolveAgentTaskConfig(this.config)?.killGracePeriodMs ?? SIGTERM_GRACE_MS;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const graceful = await Promise.race([
      entry.lifecyclePromise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        graceTimer = setTimeout(() => {
          resolve(false);
        }, graceMs);
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
        const forceStop =
          entry.forceStopFn ??
          (entry.task === undefined ? undefined : entry.task.forceStop?.bind(entry.task));
        await forceStop?.();
      } catch {
      }
    }

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    await this.settleTask(entry, {
      status: options.finalStatus,
      stopReason: options.stopReason,
    });
    await entry.persistWriteQueue;
    return this.toInfo(entry);
  }

  async stopAll(reason?: string): Promise<readonly AgentTaskInfo[]> {
    const results = await Promise.all(
      Array.from(this.tasks.keys()).map((taskId) => this.stop(taskId, reason)),
    );
    return results.filter((info): info is AgentTaskInfo => info !== undefined);
  }

  async stopAllOnExit(reason: string): Promise<readonly AgentTaskInfo[]> {
    if (this.keepAliveOnExit()) return [];
    const active = this.list(true);
    await Promise.all(
      active
        .filter((task) => task.detached === true)
        .map((task) => this.suppressTerminalNotification(task.taskId)),
    );
    return this.stopAll(reason);
  }

  override dispose(): void {
    if (!this.keepAliveOnExit()) {
      for (const entry of this.tasks.values()) {
        if (TERMINAL_STATUSES.has(entry.status)) continue;
        if (entry.timeoutHandle !== undefined) {
          clearTimeout(entry.timeoutHandle);
          entry.timeoutHandle = undefined;
        }
        if (entry.handle !== undefined) {
          entry.handle.cancel();
        } else {
          entry.abortController.abort(SESSION_CLOSED_REASON);
        }
        this.forceStopOnDispose(entry);
      }
    }
    super.dispose();
  }

  private forceStopOnDispose(entry: ManagedTask): void {
    const forceStop =
      entry.forceStopFn ??
      (entry.task === undefined ? undefined : entry.task.forceStop?.bind(entry.task));
    if (forceStop === undefined) return;
    try {
      void forceStop().catch(() => {});
    } catch {}
  }

  private keepAliveOnExit(): boolean {
    return resolveAgentTaskConfig(this.config)?.keepAliveOnExit === true;
  }

  async wait(
    taskId: string,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<AgentTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return this.ghosts.get(taskId);
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }
    if (timeoutMs <= 0) {
      return this.toInfo(entry);
    }

    let waiter: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = Promise.race([
        new Promise<void>((resolve) => {
          waiter = resolve;
          entry.waiters.push(resolve);
        }),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMs);
          timeout.unref?.();
        }),
      ]);
      await (signal === undefined ? pending : abortable(pending, signal));
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
    const maxRunningTasks = resolveAgentTaskConfig(this.config)?.maxRunningTasks;
    if (maxRunningTasks === undefined) return;
    if (!detached) return;
    if (this.activeTaskCount() < maxRunningTasks) return;
    throw new Error('Too many background tasks are already running.');
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

    if (
      !entry.outputLimitTripped &&
      entry.task?.kind === 'process' &&
      entry.outputSizeBytes > MAX_TASK_OUTPUT_BYTES
    ) {
      entry.outputLimitTripped = true;
      void this.stop(entry.taskId, outputLimitReason());
    }

    if (entry.outputLimitTripped) return;

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
    this.recordTaskTerminated(info, this.retainedOutputTail(entry));
  }

  private retainedOutputTail(entry: ManagedTask): string | undefined {
    if (entry.outputChunks.length === 0) return undefined;
    const retained = Buffer.from(entry.outputChunks.join(''), 'utf-8');
    const offset = Math.max(0, retained.byteLength - TERMINAL_OUTPUT_TAIL_BYTES);
    return retained.subarray(offset).toString('utf-8');
  }

  private recordTaskStarted(info: AgentTaskInfo): void {
    this.wire.dispatch(taskStarted({ info }));
    this.telemetry.track2('background_task_created', {
      task_id: info.taskId,
      kind: info.kind === 'process' ? 'bash' : info.kind,
    });
  }

  private recordTaskTerminated(info: AgentTaskInfo, outputTail?: string): void {
    this.wire.dispatch(taskTerminated({ info, outputTail }));
    this.telemetry.track2('background_task_completed', {
      task_id: info.taskId,
      kind: info.kind,
      duration_ms: info.endedAt !== null ? info.endedAt - info.startedAt : null,
      status: info.status,
    });
  }

  private async notifyAgentTask(info: AgentTaskInfo): Promise<void> {
    const context = await this.buildAgentTaskNotificationContext(info);
    if (context === undefined) return;
    const request = new TaskNotificationStepRequest({
      role: 'user',
      content: [...context.content],
      toolCalls: [],
      origin: context.origin,
    });
    this.loop.enqueue(request);
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
      source_kind: 'background_task',
      source_id: info.taskId,
      agent_id: info.kind === 'agent' ? info.agentId : undefined,
      title: `Background ${info.kind} ${info.status}`,
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
    this.eventBus.publish({
      type: 'task.notified',
      notificationType: notification.type,
      title: notification.title,
      body: notification.body,
      severity: notification.severity,
      sourceKind: notification.source_kind,
      sourceId: notification.source_id,
    });
  }

  private isTerminalNotificationSuppressed(taskId: string): boolean {
    return (
      this.tasks.get(taskId)?.terminalNotificationSuppressed === true ||
      this.ghosts.get(taskId)?.terminalNotificationSuppressed === true
    );
  }

  private markDeliveredNotification(origin: TaskNotificationOrigin): void {
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
      const userReason = userCancellationReason();
      void this.terminateWithGrace(entry, {
        stopReason: userReason.message,
        abortReason: signal.reason,
        finalStatus: 'killed',
      });
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

function isCompactionSplice(splice: {
  readonly deleteCount: number;
  readonly messages: readonly { readonly origin?: { readonly kind: string } | undefined }[];
}): boolean {
  return (
    splice.deleteCount > 0 &&
    splice.messages.some((message) => message.origin?.kind === 'compaction_summary')
  );
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

type TaskNotificationOrigin = Pick<TaskOrigin, 'taskId' | 'status' | 'notificationId'>;

function isTaskOrigin(origin: unknown): origin is TaskNotificationOrigin {
  if (typeof origin !== 'object' || origin === null) return false;
  const value = origin as Record<string, unknown>;
  return (
    (value['kind'] === 'background_task' || value['kind'] === 'task') &&
    typeof value['taskId'] === 'string' &&
    typeof value['status'] === 'string' &&
    typeof value['notificationId'] === 'string'
  );
}

function notificationKey(origin: TaskNotificationOrigin): string {
  return `${origin.taskId}\0${origin.status}\0${origin.notificationId}`;
}

function taskOriginFromMessage(message: unknown): TaskNotificationOrigin | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const origin = (message as { readonly origin?: unknown }).origin;
  return isTaskOrigin(origin) ? origin : undefined;
}

function buildAgentTaskNotificationBody(info: AgentTaskInfo): string {
  const baseLine =
    info.status === 'timed_out'
      ? `${info.description} timed out.`
      : info.status === 'killed' && isSerializedUserCancellation(info.stopReason)
        ? `${info.description} was stopped by user.`
        : info.stopReason
          ? `${info.description} ${info.status === 'killed' ? 'was stopped' : info.status}. Reason: ${info.stopReason}`
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

function isSerializedUserCancellation(reason: string | undefined): boolean {
  return reason === userCancellationReason().message;
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
  InstantiationType.Eager,
  'task',
);
