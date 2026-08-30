import { randomBytes } from 'node:crypto';
import { join } from 'pathe';

import type { ContentPart } from '#/kosong/contract/message';

import { DisposableStore } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import {
  abortable,
  userCancellationReason,
} from '#/_base/utils/abort';
import { setClampedTimeout } from '#/_base/utils/timer';
import { escapeXml, escapeXmlAttr } from '#/_base/utils/xml-escape';
import { IEventBus } from '#/app/event/eventBus';
import { Error2, ErrorCodes, BugIndicatingError } from '#/errors';
import {
  ContextSpliced,
} from '#/features/contextMemory/contextEvents';
import '#/features/contextMemory/conversationTime';
import { AgentContextMemory, type ContextMemoryRuntime } from '#/features/contextMemory/contextMemoryAgentRuntime';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { ContextMessage, TaskOrigin } from '#/features/contextMemory/types';
import { activateReminderWhenReady } from '#/features/reminder/internal/reminderActivation';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentUndo } from '#/features/undo/undoAgentRuntime';
import { getLoopControl } from '#/features/loop/internal/access';
import { MessageStepRequest } from '#/features/loop/internal/stepRequest';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentHostService } from '#/agent/host/agentHost';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { AgentRuntimeContext } from '#/agent/runtime/agentRuntime';
import { IConfigService } from '#/app/config/config';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ITelemetryService } from '#/app/telemetry/telemetry';

import {
  isTaskOrigin,
  notificationKey,
  taskNotificationId,
  taskNotificationDeliveryKey,
  type TaskNotificationOrigin,
} from '../notificationDelivery';
import { taskExecutionReviverFor } from '../revive';
import { TaskStarted, TaskTerminated, TaskNotified, TaskWaitDelivered, type TaskModelState } from '../taskOps';
import {
  TERMINAL_STATUSES,
  type AgentTaskInfo,
  type AgentTaskInfoBase,
  type AgentTaskOutputSnapshot,
  type AgentTaskSettlement,
  type AgentTaskStatus,
  type AgentTaskWaitDelivery,
  type ForegroundTaskReleaseReason,
  type RegisterAgentTaskOptions,
  type TaskExecution,
} from '../types';
import { resolveAgentTaskConfig } from '../configSection';
import { AgentTaskPersistence, validateTaskId } from './persist';
import { renderNotificationXml } from './notificationXml';
import { formatTaskList } from './format';

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

export interface ManagedTask {
  readonly taskId: string;
  readonly task: TaskExecution;
  outputSizeBytes: number;
  retainedOutputBytes: number;
  outputLimitTripped: boolean;
  status: AgentTaskStatus;
  options: RegisterAgentTaskOptions;
  readonly startedAt: number;
  endedAt: number | null;
  foregroundRelease?: ForegroundRelease;
  stopReason?: string;
  terminalNotificationSuppressed?: boolean;
  terminalFired: boolean;
  readonly abortController: AbortController;
  foregroundSignalCleanup?: () => void;
  lifecyclePromise: Promise<void>;
  outputWriteQueue: Promise<void>;
  pendingOutput: string[];
  pendingOutputBytes: number;
  outputPersistStarted: boolean;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  timedOut: boolean;
  readonly waiters: Array<() => void>;
  readonly outputChunks: string[];
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
  'Do not start duplicates. Use TaskList to list them, TaskOutput for a non-blocking status/output snapshot, and TaskStop to cancel one — completion arrives via automatic notification.',
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

export class TaskNotificationStepRequest extends MessageStepRequest {
  constructor(
    message: ContextMessage,
    private readonly onWillDeliver?: () => void,
  ) {
    super(message, {
      kind: 'task_notification',
      mergeable: true,
      turnScoped: false,
      admission: 'activeOrNewTurn',
    });
  }

  override onWillMaterialize(): void {
    this.onWillDeliver?.();
  }
}

export interface TaskLifecycleDeps {
  readonly agent: AgentContext;
  readonly scopeContext: IAgentScopeContext;
  readonly telemetry: ITelemetryService;
  readonly config: IConfigService;
  readonly atomicDocs: IAtomicDocumentStore;
  readonly byteStore: IFileSystemStorageService;
  readonly session: ISessionContext;
  readonly eventBus: IEventBus;
  readonly dispatcher: IEventDispatcher;
  readonly manager: IAgentLifecycleService;
  readonly log: ILogService;
  readonly states: IAgentStateService;
  readonly context: ContextMemoryRuntime;
  readonly registry: () => TaskModelState;
}

export class TaskLifecycle {
  private readonly tasks = new Map<string, ManagedTask>();
  private readonly ghosts = new Map<string, AgentTaskInfo>();
  private readonly reservedTaskIds = new Set<string>();
  private readonly scheduledNotificationKeys = new Set<string>();
  private readonly deliveredNotificationKeys = new Set<string>();
  private readonly buildingNotificationKeys = new Set<string>();
  private readonly pendingNotificationRequests = new Map<string, TaskNotificationStepRequest>();
  private activeTaskReminderPending = false;
  private persistenceInstance: AgentTaskPersistence | undefined;
  private notificationRestoreQueue: Promise<void> = Promise.resolve();
  private readonly disposables = new DisposableStore();

  private disposed = false;

  constructor(private readonly deps: TaskLifecycleDeps) {
    this.states.contributeState(taskNotificationDeliveryKey);
    this.disposables.add(
      this.eventBus.subscribe(ContextSpliced, (e) => {
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
    this.disposables.add(
      this.manager
        .resolve(this.agent, AgentUndo)
        .registerUndoParticipant({
          id: 'task.notificationDelivery',
          reconcileAfterUndo: () => this.reconcileNotificationDeliveryAfterUndo(),
        }),
    );
    this.disposables.add(
      activateReminderWhenReady(this.manager, this.scopeContext, (reminder) =>
        reminder.register(ACTIVE_BACKGROUND_TASK_INJECTION_VARIANT, () =>
          this.activeBackgroundTaskReminder(),
        ),
      ),
    );
  }

  private get agent(): AgentContext {
    return this.deps.agent;
  }

  private get agentId(): string {
    return this.deps.agent.agentId;
  }

  private get scopeContext(): IAgentScopeContext {
    return this.deps.scopeContext;
  }

  private get manager(): IAgentLifecycleService {
    return this.deps.manager;
  }

  private get states(): IAgentStateService {
    return this.deps.states;
  }

  private get eventBus(): IEventBus {
    return this.deps.eventBus;
  }

  private get dispatcher(): IEventDispatcher {
    return this.deps.dispatcher;
  }

  private get config(): IConfigService {
    return this.deps.config;
  }

  private get telemetry(): ITelemetryService {
    return this.deps.telemetry;
  }

  private get log(): ILogService {
    return this.deps.log;
  }

  private get context(): ContextMemoryRuntime {
    return this.deps.context;
  }

  private get persistence(): AgentTaskPersistence {
    return (this.persistenceInstance ??= new AgentTaskPersistence(
      join(this.deps.session.sessionDir, 'agents', this.agentId),
      this.scopeContext.scope(),
      this.deps.atomicDocs,
      this.deps.byteStore,
      this.agentId === 'main'
        ? { dir: this.deps.session.sessionDir, scope: this.deps.session.scope() }
        : undefined,
    ));
  }

  beginRestore(): Promise<void> {
    for (const key of this.states.get(taskNotificationDeliveryKey)) {
      this.deliveredNotificationKeys.add(key);
    }
    return this.restoreAfterReplay();
  }

  async restoreAfterReplay(): Promise<void> {
    this.restoreGhostsFromWire();
    await this.loadFromDisk({ replace: false });
    await this.reviveGhostTasks();
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
    for (const [taskId, info] of this.deps.registry()) {
      if (this.tasks.has(taskId)) continue;
      this.ghosts.set(taskId, info);
    }
  }

  registerTask(task: TaskExecution, options: RegisterAgentTaskOptions = {}): string {
    void this.persistence;
    const detached = options.detached ?? true;
    const timeoutMs = options.timeoutMs ?? task.timeoutMs;
    const entryOptions: RegisterAgentTaskOptions = {
      taskId: options.taskId,
      detached,
      timeoutMs,
      detachTimeoutMs: options.detachTimeoutMs,
      autoBackgroundOnTimeout: options.autoBackgroundOnTimeout,
      signal: detached ? undefined : options.signal,
    };
    this.assertCanRegister(detached);
    const taskId =
      options.taskId === undefined
        ? generateTaskId(task.idPrefix)
        : this.claimTaskId(options.taskId);
    const entry: ManagedTask = {
      taskId,
      task,
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

    entry.lifecyclePromise = this.startExecution(entry, task);

    this.installForegroundSignal(entry);

    if (this.isDetached(entry)) {
      this.recordTaskStarted(this.toInfo(entry));
    }
    return entry.taskId;
  }

  private startExecution(entry: ManagedTask, task: TaskExecution): Promise<void> {
    return Promise.resolve()
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
  }

  private claimTaskId(taskId: string): string {
    validateTaskId(taskId);
    if (this.tasks.has(taskId) || this.ghosts.has(taskId)) {
      throw new BugIndicatingError(`Duplicate task id: "${taskId}"`);
    }
    this.reservedTaskIds.delete(taskId);
    return taskId;
  }

  reserveTaskId(idPrefix: string): string {
    let taskId = generateTaskId(idPrefix);
    while (
      this.tasks.has(taskId) ||
      this.ghosts.has(taskId) ||
      this.reservedTaskIds.has(taskId)
    ) {
      taskId = generateTaskId(idPrefix);
    }
    this.reservedTaskIds.add(taskId);
    return taskId;
  }

  releaseTaskId(taskId: string): void {
    this.reservedTaskIds.delete(taskId);
  }

  taskOutputPath(taskId: string): string {
    return this.persistence.taskOutputFile(taskId);
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

  private async reconcileNotificationDeliveryAfterUndo(): Promise<void> {
    const restoredKeys = new Set(this.states.get(taskNotificationDeliveryKey));
    for (const [key, request] of this.pendingNotificationRequests) {
      if (request.aborted) this.clearPendingNotification(key, request);
    }
    this.deliveredNotificationKeys.clear();
    for (const key of restoredKeys) this.deliveredNotificationKeys.add(key);
    for (const key of this.scheduledNotificationKeys) {
      if (restoredKeys.has(key) || !this.pendingNotificationRequests.has(key)) {
        this.scheduledNotificationKeys.delete(key);
      }
    }
    await this.restoreAgentTaskNotifications();
  }

  persistOutput(taskId: string): void {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return;
    this.startOutputPersist(entry);
  }

  async loadFromDisk(options: { readonly replace?: boolean } = {}): Promise<void> {
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

  private async reviveGhostTasks(): Promise<void> {
    for (const [taskId, info] of this.ghosts) {
      if (TERMINAL_STATUSES.has(info.status)) continue;
      const reviver = taskExecutionReviverFor(info.kind);
      if (reviver === undefined) continue;
      let execution: TaskExecution | undefined;
      try {
        execution = await reviver(info);
      } catch {
        execution = undefined;
      }
      if (execution === undefined) continue;
      this.reattachGhost(taskId, info, execution);
    }
  }

  private reattachGhost(taskId: string, info: AgentTaskInfo, task: TaskExecution): void {
    this.ghosts.delete(taskId);
    const entry: ManagedTask = {
      taskId,
      task,
      outputChunks: [],
      outputSizeBytes: 0,
      retainedOutputBytes: 0,
      outputLimitTripped: false,
      status: 'running',
      options: {
        detached: true,
        timeoutMs: info.timeoutMs,
        detachTimeoutMs: undefined,
        autoBackgroundOnTimeout: undefined,
        signal: undefined,
      },
      startedAt: info.startedAt,
      endedAt: null,
      foregroundRelease: undefined,
      stopReason: info.stopReason,
      terminalNotificationSuppressed: info.terminalNotificationSuppressed,
      abortController: new AbortController(),
      lifecyclePromise: Promise.resolve(),
      outputWriteQueue: Promise.resolve(),
      pendingOutput: [],
      pendingOutputBytes: 0,
      outputPersistStarted: true,
      waiters: [],
      terminalFired: false,
      timedOut: false,
    };
    this.tasks.set(taskId, entry);
    const timeoutMs = info.timeoutMs;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      this.armManagerTimeout(entry, Math.max(0, timeoutMs - (Date.now() - info.startedAt)));
    }
    entry.lifecyclePromise = this.startExecution(entry, task);
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
      return;
    }

    const ghost = this.ghosts.get(taskId);
    if (ghost !== undefined) return;
  }

  markTasksDeliveredViaWait(tasks: readonly AgentTaskWaitDelivery[]): void {
    if (tasks.length === 0) return;
    const keys: string[] = [];
    for (const { taskId, status } of tasks) {
      const origin: TaskNotificationOrigin = {
        taskId,
        status,
        notificationId: taskNotificationId(taskId, status),
      };
      const key = notificationKey(origin);
      this.pendingNotificationRequests.get(key)?.abort();
      this.markDeliveredNotification(origin);
      keys.push(key);
    }
    void this.dispatcher.dispatch(
      new TaskWaitDelivered({ agentId: this.agentId, keys }),
    );
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
      entry.task.onDetach?.();
    } catch {
    }
    this.startOutputPersist(entry);
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
    entry.timeoutHandle = setClampedTimeout(() => {
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
    entry.abortController.abort(options.abortReason);

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
      return this.toInfo(entry);
    }

    if (!graceful) {
      try {
        await entry.task.forceStop?.();
      } catch {
      }
    }

    if (TERMINAL_STATUSES.has(entry.status)) {
      return this.toInfo(entry);
    }

    await this.settleTask(entry, {
      status: options.finalStatus,
      stopReason: options.stopReason,
    });
    return this.toInfo(entry);
  }

  async stopAll(reason?: string): Promise<readonly AgentTaskInfo[]> {
    const results = await Promise.all(
      Array.from(this.tasks.keys()).map((taskId) => this.stop(taskId, reason)),
    );
    return results.filter((info): info is AgentTaskInfo => info !== undefined);
  }

  async stopAllOnExit(reason: string): Promise<readonly AgentTaskInfo[]> {
    const active = this.list(true);
    await Promise.all(
      active
        .filter((task) => task.detached === true && !this.survivesSessionClose(task.taskId))
        .map((task) => this.suppressTerminalNotification(task.taskId)),
    );
    const results: AgentTaskInfo[] = [];
    for (const entry of this.tasks.values()) {
      if (this.survivesSessionCloseEntry(entry)) {
        results.push(this.toInfo(entry));
        continue;
      }
      const info = await this.stop(entry.taskId, reason);
      if (info !== undefined) results.push(info);
    }
    return results;
  }

  shutdown(): void {
    this.disposed = true;
    for (const entry of this.tasks.values()) {
      if (this.survivesSessionCloseEntry(entry)) {
        try {
          entry.task.releaseOnSessionClose?.();
        } catch {
        }
        continue;
      }
      if (TERMINAL_STATUSES.has(entry.status)) continue;
      if (entry.timeoutHandle !== undefined) {
        clearTimeout(entry.timeoutHandle);
        entry.timeoutHandle = undefined;
      }
      entry.abortController.abort(SESSION_CLOSED_REASON);
      this.forceStopOnDispose(entry);
    }
    this.disposables.dispose();
  }

  private survivesSessionClose(taskId: string): boolean {
    const entry = this.tasks.get(taskId);
    return entry !== undefined && this.survivesSessionCloseEntry(entry);
  }

  private survivesSessionCloseEntry(entry: ManagedTask): boolean {
    return entry.task.survivesSessionClose?.() === true;
  }

  private forceStopOnDispose(entry: ManagedTask): void {
    const forceStop = entry.task.forceStop?.bind(entry.task);
    if (forceStop === undefined) return;
    try {
      void forceStop().catch(() => {});
    } catch {}
  }

  async wait(
    taskId: string,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<AgentTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return this.ghosts.get(taskId);
    if (TERMINAL_STATUSES.has(entry.status)) {
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
          timeout = setClampedTimeout(resolve, timeoutMs);
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

    return this.toInfo(entry);
  }

  async waitForForegroundRelease(
    taskId: string,
  ): Promise<ForegroundTaskReleaseReason | undefined> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return undefined;
    if (TERMINAL_STATUSES.has(entry.status)) {
      return 'terminal';
    }
    if (this.isDetached(entry)) return 'detached';

    const foregroundRelease = entry.foregroundRelease;
    if (foregroundRelease === undefined) return 'detached';
    const foregroundReleasePromise = foregroundRelease.promise;
    return Promise.race([
      foregroundReleasePromise,
      entry.lifecyclePromise.then(() => 'terminal' as const),
    ]);
  }

  private assertCanRegister(detached: boolean): void {
    const maxRunningTasks = resolveAgentTaskConfig(this.config)?.maxRunningTasks;
    if (maxRunningTasks === undefined) return;
    if (!detached) return;
    if (this.activeTaskCount() < maxRunningTasks) return;
    throw new Error2(ErrorCodes.TASK_LIMIT_EXCEEDED, 'Too many background tasks are already running.', {
      details: { running: this.activeTaskCount(), max: maxRunningTasks },
    });
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
    for (const [taskId, info] of this.ghosts) {
      if (TERMINAL_STATUSES.has(info.status)) continue;
      const updated: AgentTaskInfo = {
        ...info,
        status: 'lost',
        endedAt: info.endedAt ?? Date.now(),
      };
      this.ghosts.set(taskId, updated);
      lostTasks.push(updated);
    }
    return lostTasks;
  }

  private appendOutput(entry: ManagedTask, chunk: string): void {
    const chunkBytes = Buffer.byteLength(chunk, 'utf-8');
    entry.outputSizeBytes += chunkBytes;
    this.appendRetainedOutput(entry, chunk, chunkBytes);

    if (
      !entry.outputLimitTripped &&
      entry.task.kind === 'process' &&
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
    if (entry.timeoutHandle !== undefined) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = undefined;
    }
    const foregroundRelease = entry.foregroundRelease;
    if (!entry.outputPersistStarted) {
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
    void this.notifyAgentTask(info).catch((error) => {
      this.log.error('task notification delivery failed', { taskId: info.taskId, error });
    });
    this.recordTaskTerminated(info, this.retainedOutputTail(entry));
  }

  private retainedOutputTail(entry: ManagedTask): string | undefined {
    if (entry.outputChunks.length === 0) return undefined;
    const retained = Buffer.from(entry.outputChunks.join(''), 'utf-8');
    const offset = Math.max(0, retained.byteLength - TERMINAL_OUTPUT_TAIL_BYTES);
    return retained.subarray(offset).toString('utf-8');
  }

  private recordTaskStarted(info: AgentTaskInfo): void {
    void this.dispatcher.dispatch(
      new TaskStarted({ agentId: this.agentId, info }),
    );
    this.telemetry.track2('background_task_created', {
      task_id: info.taskId,
      kind: info.kind === 'process' ? 'bash' : info.kind,
    });
  }

  private recordTaskTerminated(info: AgentTaskInfo, outputTail?: string): void {
    void this.dispatcher.dispatch(
      new TaskTerminated({ agentId: this.agentId, info, outputTail }),
    );
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
    const key = notificationKey(context.origin);
    if (this.deliveredNotificationKeys.has(key)) return;
    const request = new TaskNotificationStepRequest(
      {
        role: 'user',
        content: [...context.content],
        toolCalls: [],
        origin: context.origin,
      },
      () => this.fireNotificationHook(context.notification),
    );
    this.pendingNotificationRequests.set(key, request);
    try {
      const receipt = getLoopControl(this.agent).enqueue(request);
      void receipt.assigned
        .then(({ step }) => step.result)
        .then(
          () => {
            if (request.aborted) this.clearPendingNotification(key, request);
          },
          () => this.clearPendingNotification(key, request),
        );
    } catch (error) {
      this.clearPendingNotification(key, request);
      throw error;
    }
  }

  private restoreAgentTaskNotifications(): Promise<void> {
    const restore = this.notificationRestoreQueue.then(() =>
      this.restoreAgentTaskNotificationsNow(),
    );
    this.notificationRestoreQueue = restore.catch(() => {});
    return restore;
  }

  private async restoreAgentTaskNotificationsNow(): Promise<void> {
    for (const info of this.list(false)) {
      if (!isAgentTaskTerminal(info.status)) continue;
      await this.restoreAgentTaskNotification(info);
    }
  }

  private async restoreAgentTaskNotification(info: AgentTaskInfo): Promise<void> {
    const context = await this.buildAgentTaskNotificationContext(info);
    if (context === undefined) return;
    void this.context.append({
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
      notificationId: taskNotificationId(info.taskId, info.status),
    };
    const key = notificationKey(origin);
    if (this.buildingNotificationKeys.has(key)) return undefined;
    if (this.scheduledNotificationKeys.has(key)) return undefined;
    if (this.deliveredNotificationKeys.has(key)) return undefined;
    if (this.hasDeliveredNotification(key)) return undefined;
    this.buildingNotificationKeys.add(key);
    try {
      let output = emptyOutputSnapshot();
      try {
        output = await this.getOutputSnapshot(info.taskId, 0);
        if (!output.fullOutputAvailable) {
          output = await this.getOutputSnapshot(info.taskId, NOTIFICATION_FALLBACK_PREVIEW_BYTES);
        }
      } catch (error) {
        this.log.error('task notification output read failed; delivering without output', {
          taskId: info.taskId,
          error,
        });
      }
      if (this.isTerminalNotificationSuppressed(info.taskId)) return undefined;
      if (this.scheduledNotificationKeys.has(key)) return undefined;
      if (this.deliveredNotificationKeys.has(key)) return undefined;
      if (this.hasDeliveredNotification(key)) return undefined;
      this.scheduledNotificationKeys.add(key);
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
    } finally {
      this.buildingNotificationKeys.delete(key);
    }
  }

  private fireNotificationHook(notification: AgentTaskNotification): void {
    void this.dispatcher.dispatch(
      new TaskNotified({
        agentId: this.agentId,
        notificationType: notification.type,
        title: notification.title,
        body: notification.body,
        severity: notification.severity,
        sourceKind: notification.source_kind,
        sourceId: notification.source_id,
      }),
    );
  }

  private isTerminalNotificationSuppressed(taskId: string): boolean {
    return (
      this.tasks.get(taskId)?.terminalNotificationSuppressed === true ||
      this.ghosts.get(taskId)?.terminalNotificationSuppressed === true
    );
  }

  private markDeliveredNotification(origin: TaskNotificationOrigin): void {
    const key = notificationKey(origin);
    this.scheduledNotificationKeys.delete(key);
    this.pendingNotificationRequests.delete(key);
    this.deliveredNotificationKeys.add(key);
  }

  private clearPendingNotification(key: string, request: TaskNotificationStepRequest): void {
    if (this.pendingNotificationRequests.get(key) !== request) return;
    this.pendingNotificationRequests.delete(key);
    if (!this.deliveredNotificationKeys.has(key) && !this.hasDeliveredNotification(key)) {
      this.scheduledNotificationKeys.delete(key);
    }
  }

  private hasDeliveredNotification(key: string): boolean {
    if (this.disposed) return false;
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
      description: entry.task.description,
      status: entry.status,
      detached: this.isDetached(entry) ? true : false,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      stopReason: entry.stopReason,
      terminalNotificationSuppressed: entry.terminalNotificationSuppressed,
      timeoutMs: entry.options.timeoutMs,
    };
    return entry.task.toInfo(base);
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

export function createTaskLifecycle(
  runtime: AgentRuntimeContext<TaskModelState>,
): TaskLifecycle {
  const host = runtime.get(IAgentHostService).of(runtime.agent);
  const manager = runtime.get(IAgentLifecycleService);
  return new TaskLifecycle({
    agent: runtime.agent,
    scopeContext: host.scopeContext,
    telemetry: host.telemetry,
    config: runtime.get(IConfigService),
    atomicDocs: runtime.get(IAtomicDocumentStore),
    byteStore: runtime.get(IFileSystemStorageService),
    session: runtime.get(ISessionContext),
    eventBus: host.eventBus,
    dispatcher: host.dispatcher,
    manager,
    log: runtime.get(ILogService),
    states: host.state,
    context: manager.resolve(runtime.agent, AgentContextMemory),
    registry: () => runtime.getState(),
  });
}
