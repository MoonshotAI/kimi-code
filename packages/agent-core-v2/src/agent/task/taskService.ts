import { randomBytes } from 'node:crypto';
import { join } from 'pathe';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import type { ContentPart } from '#human/llm/message';

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { codePointBoundaryStart } from '#/_base/text/code-points';
import { defineState } from '#/state/state';
import {
  abortable,
  userCancellationReason,
} from '#/_base/utils/abort';
import { setClampedTimeout } from '#/_base/utils/timer';
import { escapeXml, escapeXmlAttr, escapeXmlTags } from '#/_base/utils/xml-escape';
import { IEventBus, ISessionEventBus } from '#/app/event/eventBus';
import { Error2, ErrorCodes } from '#/errors';
import { z } from 'zod';
import {
  ContextAppendMessage,
  ContextSpliced,
} from '#/agent/contextMemory/contextEvents';
import '#/agent/loop/turnOps';
import { IAgentConversationUndoParticipantRegistry } from '#/agent/contextMemory/conversationUndoParticipants';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { TaskOrigin } from '#/agent/contextMemory/types';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentLoopService, type LoopNotifyHandle } from '#/agent/loop/loop';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { environmentTempTarget, IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { WAIT_FOR_FLAG_ID } from '#/agent/tools/task/task-wait/flag';
import { IFlagService } from '#/app/flag/flag';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import {
  TERMINAL_STATUSES,
  type AgentTaskInfoBase,
  type AgentTaskSettlement,
} from './types';
import { renderNotificationXml } from './notificationXml';
import { formatTaskWallTime } from './wallTime';

import { historyEntryFromContext } from '#/agent/loop/history';
import { IConfigService } from '#/app/config/config';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { event2FromRecord } from '#/app/event/event2';
import { IWireService } from '#/wire/wire';
import {
  IAgentTaskService,
  type AgentTask,
  type AgentTaskInfo,
  type AgentTaskOutputChunk,
  type AgentTaskOutputSnapshot,
  type AgentTaskOutputTail,
  type AgentTaskStatus,
  type AgentTaskWaitDelivery,
  type RegisterAgentTaskOptions,
} from './task';
import { resolveAgentTaskConfig } from './configSection';
import { AgentTaskPersistence } from './persist';
import { taskKey, TaskNotified, TaskStarted, TaskTerminated, TaskWaitDelivered } from './taskOps';
import { formatTaskList } from '#/agent/tools/task/task-list/taskListTool';
import '#/agent/tools/task/task-output/taskOutputTool';
import '#/agent/tools/task/task-stop/taskStopTool';
import '#/agent/tools/task/task-wait/taskWaitTool';

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

export const taskNotificationDeliveryKey = defineState(
  'task.notificationDelivery',
  (): readonly string[] => [],
)
  .replayable({ schema: z.custom<readonly string[]>() })
  .undoable()
  .on(ContextAppendMessage, (s, e) => {
    const origin = taskOriginFromMessage(e.message);
    if (origin === undefined) return;
    const key = notificationKey(origin);
    if (!s.includes(key)) {
      s.push(key);
    }
  })
  .on(TaskWaitDelivered, (s, e) => {
    for (const key of e.keys) {
      if (!s.includes(key)) {
        s.push(key);
      }
    }
  });

interface ManagedTask {
  readonly taskId: string;
  readonly task: AgentTask;
  detached: boolean;
  coreDetached: boolean;
  startedTracked: boolean;
  readonly outputChunks: string[];
  outputSizeBytes: number;
  retainedOutputBytes: number;
  outputLimitTripped: boolean;
  status: AgentTaskStatus;
  options: RegisterAgentTaskOptions;
  readonly startedAt: number;
  endedAt: number | null;
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
}

const MAX_OUTPUT_BYTES = 1024 * 1024;

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
const QUESTION_ANSWER_INLINE_BYTES = 16_000;
const ACTIVE_BACKGROUND_TASK_INJECTION_VARIANT = 'background_task_status';
const TASK_RESUME_TERMINATION_VARIANT = 'task_resume_termination';
const ACTIVE_BACKGROUND_TASK_GUIDANCE = [
  'The conversation was compacted, so the earlier messages that started these background tasks are gone — but the tasks are still running from before.',
  'Do not start duplicates. Use TaskList to list them, TaskOutput for a non-blocking status/output snapshot, and TaskStop to cancel one — completion arrives via automatic notification.',
].join(' ');

export const SUBAGENT_BACKGROUND_TASK_NOTICE =
  'You are running as a subagent: ending your turn is your final hand-off to the parent agent, and completion notifications that arrive after it reach no one. Do not end your turn while a background task whose result you need is still running. Keep waiting for it with WaitFor, calling it again after a timeout if needed, or run the command in the foreground with a suitable timeout instead. Still use the waiting time for other useful work on your task when you can.';

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

export const taskScheduledNotificationKeysKey = defineState<Set<string>>(
  'task.scheduledNotificationKeys',
  () => new Set(),
);
export const taskDeliveredNotificationKeysKey = defineState<Set<string>>(
  'task.deliveredNotificationKeys',
  () => new Set(),
);
export const taskActiveTaskReminderPendingKey = defineState<boolean>(
  'task.activeTaskReminderPending',
  () => false,
);

export class AgentTaskService extends Disposable implements IAgentTaskService {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidAppendOutput = this._register(new Emitter<AgentTaskOutputChunk>());
  readonly onDidAppendOutput: Event<AgentTaskOutputChunk> = this._onDidAppendOutput.event;
  private readonly _onDidChangeTask = this._register(new Emitter<AgentTaskInfo>());
  readonly onDidChangeTask: Event<AgentTaskInfo> = this._onDidChangeTask.event;

  private readonly tasks = new Map<string, ManagedTask>();
  private readonly history = new Map<string, AgentTaskInfo>();
  private readonly previousSessionReminderMarks = new Set<string>();
  private exitSuppressionArmed = false;
  private readonly buildingNotificationKeys = new Set<string>();
  private readonly pendingNotificationRequests = new Map<string, LoopNotifyHandle>();
  private readonly persistence: AgentTaskPersistence;
  private notificationRestoreQueue: Promise<void> = Promise.resolve();

  constructor(
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IConfigService private readonly config: IConfigService,
    @IFileSystemStorageService byteStore: IFileSystemStorageService,
    @ISessionContext session: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IEventBus private readonly eventBus: IEventBus,
    @ISessionEventBus private readonly sessionEventBus: ISessionEventBus,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IWireService private readonly wire: IWireService,
    @IAgentReminderService private readonly reminder: IAgentReminderService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentConversationUndoParticipantRegistry
    undoParticipants: IAgentConversationUndoParticipantRegistry,
    @ILogService private readonly log: ILogService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
    @IFlagService flags: IFlagService,
    @IAgentToolRegistryService tools: IAgentToolRegistryService,
    @IAgentToolPolicyService policy: IAgentToolPolicyService,
  ) {
    super();
    this.states.contributeState(taskKey);
    this.states.contributeState(taskNotificationDeliveryKey);
    this.states.contributeState(taskScheduledNotificationKeysKey);
    this.states.contributeState(taskDeliveredNotificationKeysKey);
    this.states.contributeState(taskActiveTaskReminderPendingKey);
    const fallbackRoot =
      this.scopeContext.agentId === 'main'
        ? { dir: session.sessionDir, scope: session.scope() }
        : undefined;
    this.persistence = new AgentTaskPersistence(
      join(session.sessionDir, 'agents', this.scopeContext.agentId),
      this.scopeContext.scope(),
      byteStore,
      fallbackRoot,
      () => environmentTempTarget(this.environment, 'task-output'),
    );
    this._register(
      undoParticipants.register({
        id: 'task.notificationDelivery',
        reconcileAfterUndo: () => this.reconcileNotificationDeliveryAfterUndo(),
      }),
    );
    this._register(
      this.dispatcher.hooks.onDidRestore.register('task', async (_ctx, next) => {
        for (const key of this.states.get(taskNotificationDeliveryKey)) {
          this.deliveredNotificationKeys.add(key);
        }
        await this.restoreAfterReplay();
        await next();
      }),
    );
    this._register(
      this.eventBus.subscribe(ContextSpliced, (e) => {
        if (isCompactionSplice(e)) {
          this.activeTaskReminderPending = true;
        }
        for (const message of e.messages) {
          if (isTaskOrigin(message.origin)) {
            this.markDeliveredNotification(message.origin);
            void this.dispatcher.dispatch(new TaskWaitDelivered({
              agentId: this.scopeContext.agentId,
              keys: [notificationKey(message.origin)],
            }));
          }
        }
      }),
    );
    this._register(
      this.reminder.register(ACTIVE_BACKGROUND_TASK_INJECTION_VARIANT, () =>
        this.activeBackgroundTaskReminder(),
      ),
    );
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) {
      this._register(
        this.reminder.register('subagent_background_task', ({ lastInjectedAt }) => {
          if (
            lastInjectedAt !== null ||
            !flags.enabled(WAIT_FOR_FLAG_ID) ||
            tools.resolve('WaitFor') === undefined ||
            !policy.isToolActive('WaitFor')
          ) return undefined;
          return SUBAGENT_BACKGROUND_TASK_NOTICE;
        }),
      );
    }
  }

  private get scheduledNotificationKeys(): Set<string> {
    return this.states.get(taskScheduledNotificationKeysKey);
  }

  private get deliveredNotificationKeys(): Set<string> {
    return this.states.get(taskDeliveredNotificationKeysKey);
  }

  private get activeTaskReminderPending(): boolean {
    return this.states.get(taskActiveTaskReminderPendingKey);
  }

  private set activeTaskReminderPending(value: boolean) {
    this.states.set(taskActiveTaskReminderPendingKey, value);
  }

  private async restoreAfterReplay(): Promise<void> {
    const { journal } = await this.wire.readRestoreChains();
    this.history.clear();
    for (const record of journal) {
      if (record['agentId'] !== this.scopeContext.agentId) continue;
      const cls = record.type === TaskStarted.type ? TaskStarted : record.type === TaskTerminated.type ? TaskTerminated : undefined;
      if (cls === undefined) continue;
      const event = event2FromRecord(cls, record);
      if (!(event instanceof TaskStarted) && !(event instanceof TaskTerminated)) continue;
      const info = event.info.status === 'running' ? { ...event.info, status: 'lost' as const } : event.info;
      this.history.set(info.taskId, info);
    }
    this.appendPreviousSessionTasksReminder();
    await this.restoreAgentTaskNotifications();
  }

  private activeBackgroundTaskReminder(): string | undefined {
    if (!this.activeTaskReminderPending) return undefined;
    this.activeTaskReminderPending = false;
    const tasks = this.list(true);
    if (tasks.length === 0) return undefined;
    return `${ACTIVE_BACKGROUND_TASK_GUIDANCE}\n\n${formatTaskList(tasks, true)}`;
  }

  registerTask(task: AgentTask, options: RegisterAgentTaskOptions = {}): string {
    const detached = options.detached ?? true;
    const timeoutMs = options.timeoutMs ?? task.timeoutMs;
    const entryOptions: RegisterAgentTaskOptions = {
      detached,
      detachable: options.detachable,
      timeoutMs,
      detachTimeoutMs: options.detachTimeoutMs,
      autoBackgroundOnTimeout: options.autoBackgroundOnTimeout,
      signal: detached ? undefined : options.signal,
      coreDetachedTool: options.coreDetachedTool,
      detachText: options.detachText,
      onDetach: options.onDetach,
    };
    this.assertCanRegister(detached);
    const entry: ManagedTask = {
      taskId: generateTaskId(task.idPrefix),
      task,
      detached,
      coreDetached: false,
      startedTracked: false,
      outputChunks: [],
      outputSizeBytes: 0,
      retainedOutputBytes: 0,
      outputLimitTripped: false,
      status: 'running',
      options: entryOptions,
      startedAt: Date.now(),
      endedAt: null,
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

    if (this.isDetached(entry)) this.trackTaskStarted(entry);
    this.fireChange(entry);
    return entry.taskId;
  }

  getTask(taskId: string): AgentTaskInfo | undefined {
    const entry = this.tasks.get(taskId);
    return entry === undefined ? this.history.get(taskId) : this.toInfo(entry);
  }

  refresh(taskId: string): void {
    const entry = this.tasks.get(taskId);
    if (entry === undefined || TERMINAL_STATUSES.has(entry.status)) return;
    this.fireChange(entry);
  }

  private fireChange(entry: ManagedTask): void {
    this._onDidChangeTask.fire(this.toInfo(entry));
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
      for (const [taskId, info] of this.history) {
        if (this.tasks.has(taskId) || !shouldListTask(info, activeOnly)) continue;
        result.push(info);
        if (limit !== undefined && result.length >= limit) return result;
      }
    }
    return result;
  }

  private async reconcileNotificationDeliveryAfterUndo(): Promise<void> {
    const restoredKeys = new Set(this.states.get(taskNotificationDeliveryKey));
    for (const [key, request] of this.pendingNotificationRequests) {
      if (request.dropped) this.clearPendingNotification(key, request);
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

  async readOutputTail(taskId: string, maxBytes: number): Promise<AgentTaskOutputTail> {
    if (this.getTask(taskId) === undefined) return { offset: 0, data: new Uint8Array() };

    await this.tasks.get(taskId)?.outputWriteQueue;

    const persisted = await this.persistence.readTaskOutputTail(taskId, maxBytes);
    if (persisted !== undefined) return persisted;

    const entry = this.tasks.get(taskId);
    if (entry === undefined) return { offset: 0, data: new Uint8Array() };

    const available = Buffer.from(entry.outputChunks.join(''), 'utf-8');
    const tailBytes = Math.min(Math.max(0, Math.trunc(maxBytes)), available.byteLength);
    return {
      offset: entry.outputSizeBytes - tailBytes,
      data: available.subarray(available.byteLength - tailBytes),
    };
  }

  async readOutput(taskId: string, tail?: number): Promise<string> {
    const output = (await this.getOutputSnapshot(taskId, Number.MAX_SAFE_INTEGER)).preview;
    if (tail === undefined) return output;
    const tailChars = Math.max(0, Math.trunc(tail));
    if (tailChars === 0) return output;
    return output.slice(codePointBoundaryStart(output, Math.max(0, output.length - tailChars)));
  }

  async suppressTerminalNotification(taskId: string): Promise<void> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined || entry.terminalNotificationSuppressed === true) return;
    entry.terminalNotificationSuppressed = true;
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
      this.pendingNotificationRequests.get(key)?.drop();
      this.markDeliveredNotification(origin);
      keys.push(key);
    }
    void this.dispatcher.dispatch(
      new TaskWaitDelivered({ agentId: this.scopeContext.agentId, keys }),
    );
  }

  detach(taskId: string, text?: string): AgentTaskInfo | undefined {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return this.history.get(taskId);
    return this.detachEntry(entry, false, text);
  }

  private detachEntry(entry: ManagedTask, viaTimeout: boolean, text?: string): AgentTaskInfo | undefined {
    if (TERMINAL_STATUSES.has(entry.status)) return this.toInfo(entry);
    if (entry.options.detachable === false) return this.toInfo(entry);
    if (entry.detached && (entry.coreDetached || entry.options.coreDetachedTool !== true)) return this.toInfo(entry);

    entry.detached = true;
    entry.foregroundSignalCleanup?.();
    entry.foregroundSignalCleanup = undefined;
    this.applyDetachTimeout(entry);
    try {
      entry.options.onDetach?.(viaTimeout);
      entry.task.onDetach?.();
    } catch {
    }
    this.startOutputPersist(entry);
    this.trackTaskStarted(entry);
    if (entry.options.coreDetachedTool === true) {
      entry.coreDetached = true;
      const info = this.toInfo(entry);
      const toolCallId = taskToolCallId(info);
      if (toolCallId !== undefined) {
        this.loop.detachTool({
          taskId: entry.taskId,
          toolCallId,
          info: () => this.toInfo(entry),
        }, text ?? entry.options.detachText?.(viaTimeout) ?? `task_id: ${entry.taskId}`);
      }
    }
    this.fireChange(entry);
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
      await entry.outputWriteQueue;
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
      await entry.outputWriteQueue;
      return this.toInfo(entry);
    }

    if (!graceful) {
      try {
        await entry.task.forceStop?.();
      } catch {
      }
    }

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.outputWriteQueue;
      return this.toInfo(entry);
    }

    await this.settleTask(entry, {
      status: options.finalStatus,
      stopReason: options.stopReason,
    });
    await entry.outputWriteQueue;
    return this.toInfo(entry);
  }

  async stopAll(reason?: string): Promise<readonly AgentTaskInfo[]> {
    const results = await Promise.all(
      Array.from(this.tasks.keys()).map((taskId) => this.stop(taskId, reason)),
    );
    return results.filter((info): info is AgentTaskInfo => info !== undefined);
  }

  async suppressAllTerminalNotifications(): Promise<void> {
    this.exitSuppressionArmed = true;
    for (const [, request] of Array.from(this.pendingNotificationRequests)) {
      request.drop();
    }
  }

  async stopAllOnExit(reason: string): Promise<readonly AgentTaskInfo[]> {
    await this.suppressAllTerminalNotifications();
    if (this.keepAliveOnExit()) return [];
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
        entry.abortController.abort(SESSION_CLOSED_REASON);
        this.forceStopOnDispose(entry);
      }
    }
    super.dispose();
  }

  private forceStopOnDispose(entry: ManagedTask): void {
    const forceStop = entry.task.forceStop;
    if (forceStop === undefined) return;
    try {
      void forceStop.call(entry.task).catch(() => {});
    } catch {}
  }

  private keepAliveOnExit(): boolean {
    return resolveAgentTaskConfig(this.config)?.keepAliveOnExit === true;
  }

  private lifecycleActive(): boolean {
    return this.sessionEventBus.isAgentActive(this.scopeContext.agentContext);
  }

  private marksTerminalNotificationSuppressed(entry: ManagedTask): boolean {
    return this.exitSuppressionArmed && !this.keepAliveOnExit() && this.isDetached(entry);
  }

  async wait(
    taskId: string,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<AgentTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return this.history.get(taskId);
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.outputWriteQueue;
      return this.toInfo(entry);
    }
    if (timeoutMs <= 0) {
      return this.toInfo(entry);
    }

    let waiter: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const completion = new Promise<void>((resolve) => {
        waiter = resolve;
        entry.waiters.push(resolve);
      });
      const pending = Number.isFinite(timeoutMs) ? Promise.race([
        completion,
        new Promise<void>((resolve) => {
          timeout = setClampedTimeout(resolve, timeoutMs);
          timeout.unref?.();
        }),
      ]) : completion;
      await (signal === undefined ? pending : abortable(pending, signal));
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (waiter !== undefined) {
        const index = entry.waiters.indexOf(waiter);
        if (index !== -1) entry.waiters.splice(index, 1);
      }
    }

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.outputWriteQueue;
    }
    return this.toInfo(entry);
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
    return entry.detached;
  }

  private appendOutput(entry: ManagedTask, chunk: string): void {
    const chunkBytes = Buffer.byteLength(chunk, 'utf-8');
    const offset = entry.outputSizeBytes;
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
    this._onDidAppendOutput.fire({ taskId: entry.taskId, offset, text: chunk });

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
    if (this.marksTerminalNotificationSuppressed(entry)) {
      entry.terminalNotificationSuppressed = true;
    }
    if (!entry.outputPersistStarted) {
      entry.pendingOutput = [];
      entry.pendingOutputBytes = 0;
    }
    this.fireTerminalEffects(entry);
    this.resolveWaiters(entry);
    this.fireChange(entry);
    return true;
  }

  private fireTerminalEffects(entry: ManagedTask): void {
    if (entry.terminalFired) return;
    if (!this.isDetached(entry)) return;
    entry.terminalFired = true;
    const info = this.toInfo(entry);
    if (entry.options.coreDetachedTool !== true) {
      void this.notifyAgentTask(info).catch((error) => {
        this.log.error('task notification delivery failed', { taskId: info.taskId, error });
      });
    }
    this.telemetry.track2('background_task_completed', {
      task_id: info.taskId,
      kind: info.kind,
      duration_ms: info.endedAt !== null ? info.endedAt - info.startedAt : null,
      status: info.status,
    });
  }

  private trackTaskStarted(entry: ManagedTask): void {
    if (entry.startedTracked) return;
    entry.startedTracked = true;
    const info = this.toInfo(entry);
    this.telemetry.track2('background_task_created', {
      task_id: info.taskId,
      kind: info.kind === 'process' ? 'bash' : info.kind,
    });
  }

  private async notifyAgentTask(info: AgentTaskInfo): Promise<void> {
    if (!this.lifecycleActive()) {
      this.log.warn('task notification skipped: agent lifecycle inactive', {
        taskId: info.taskId,
        status: info.status,
      });
      return;
    }
    const context = await this.buildAgentTaskNotificationContext(info);
    if (context === undefined) return;
    if (!this.lifecycleActive() || this.isTerminalNotificationSuppressed(info.taskId)) {
      this.log.warn('task notification dropped before scheduling', { taskId: info.taskId });
      return;
    }
    const key = notificationKey(context.origin);
    if (this.deliveredNotificationKeys.has(key)) return;
    const handle = this.loop.notify({
      message: {
        role: 'user',
        content: [...context.content],
        origin: context.origin,
      },
      turnScoped: false,
      onConsume: () => {
        this.pendingNotificationRequests.delete(key);
        this.fireNotificationHook(context.notification);
      },
      onDrop: () => this.clearPendingNotification(key, handle),
    });
    this.pendingNotificationRequests.set(key, handle);
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
      if (info.status === 'lost') continue;
      await this.restoreAgentTaskNotification(info);
    }
  }

  private appendPreviousSessionTasksReminder(): void {
    const tasks: AgentTaskInfo[] = [];
    for (const info of this.history.values()) {
      if (info.resumeReminded === true || this.previousSessionReminderMarks.has(info.taskId)) continue;
      if (!isPreviousSessionTermination(info)) continue;
      if (
        this.hasPreviousSessionReminder(info.taskId) ||
        (info.status === 'lost' && this.hasDeliveredTaskOrigin(info))
      ) {
        this.markPreviousSessionReminder(info);
        continue;
      }
      tasks.push(info);
    }
    if (tasks.length === 0) return;
    const lines = tasks.map((info) => previousSessionTaskLine(info));
    this.reminder.notify(
      [
        'The user exited the application after your last turn, so your background tasks from the previous session lost contact:',
        ...lines,
        "Don't assume any of them completed; check current state (they may still be running), then re-run or resume only what you still need.",
      ].join('\n'),
      { variant: TASK_RESUME_TERMINATION_VARIANT },
    );
    for (const info of tasks) {
      this.firePreviousSessionLostTaskNotificationHook(info);
      this.markPreviousSessionReminder(info);
    }
  }

  private hasPreviousSessionReminder(taskId: string): boolean {
    const taskLinePrefix = `- ${taskId} "`;
    return this.loop.history().some((message) => {
      if (
        message.origin?.kind !== 'injection' ||
        message.origin.variant !== TASK_RESUME_TERMINATION_VARIANT
      ) {
        return false;
      }
      return message.content.some(
        (part) =>
          part.type === 'text' &&
          part.text.split('\n').some((line) => line.startsWith(taskLinePrefix)),
      );
    });
  }

  private hasDeliveredTaskOrigin(info: AgentTaskInfo): boolean {
    const origin: TaskNotificationOrigin = {
      taskId: info.taskId,
      status: info.status,
      notificationId: taskNotificationId(info.taskId, info.status),
    };
    const key = notificationKey(origin);
    return (
      this.states.get(taskNotificationDeliveryKey).includes(key) ||
      this.deliveredNotificationKeys.has(key) ||
      this.hasDeliveredNotification(key)
    );
  }

  private markPreviousSessionReminder(info: AgentTaskInfo): void {
    this.previousSessionReminderMarks.add(info.taskId);
  }

  private firePreviousSessionLostTaskNotificationHook(info: AgentTaskInfo): void {
    if (info.status !== 'lost') return;
    if (info.detached === false) return;
    if (info.terminalNotificationSuppressed === true) return;
    const origin: TaskNotificationOrigin = {
      taskId: info.taskId,
      status: info.status,
      notificationId: taskNotificationId(info.taskId, info.status),
    };
    const key = notificationKey(origin);
    if (this.scheduledNotificationKeys.has(key)) return;
    if (this.deliveredNotificationKeys.has(key)) return;
    if (this.hasDeliveredNotification(key)) return;
    this.fireNotificationHook(buildAgentTaskNotification(info));
  }

  private async restoreAgentTaskNotification(info: AgentTaskInfo): Promise<void> {
    const context = await this.buildAgentTaskNotificationContext(info);
    if (context === undefined) return;
    this.loop.remind(historyEntryFromContext({
      role: 'user',
      content: [...context.content],
      origin: context.origin,
    }));
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
    if (this.scheduledNotificationKeys.has(key)) {
      this.log.debug('task notification already scheduled; in-process redelivery suppressed', {
        taskId: info.taskId,
      });
      return undefined;
    }
    if (this.deliveredNotificationKeys.has(key)) return undefined;
    if (this.hasDeliveredNotification(key)) return undefined;
    this.buildingNotificationKeys.add(key);
    try {
      let output = emptyOutputSnapshot();
      try {
        output = await this.notificationOutputSnapshot(info);
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
      const notification = buildAgentTaskNotification(info, output);
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

  private async notificationOutputSnapshot(info: AgentTaskInfo): Promise<AgentTaskOutputSnapshot> {
    if (info.kind === 'question') {
      return this.getOutputSnapshot(info.taskId, QUESTION_ANSWER_INLINE_BYTES);
    }
    const persisted = await this.getOutputSnapshot(info.taskId, 0);
    if (persisted.fullOutputAvailable) return persisted;
    return this.getOutputSnapshot(info.taskId, NOTIFICATION_FALLBACK_PREVIEW_BYTES);
  }

  private fireNotificationHook(notification: AgentTaskNotification): void {
    if (!this.lifecycleActive()) {
      this.log.warn('task notification hook skipped: agent lifecycle inactive', {
        sourceId: notification.source_id,
      });
      return;
    }
    void this.dispatcher.dispatch(
      new TaskNotified({
        agentId: this.scopeContext.agentId,
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
      this.exitSuppressionArmed ||
      this.tasks.get(taskId)?.terminalNotificationSuppressed === true ||
      this.history.get(taskId)?.terminalNotificationSuppressed === true
    );
  }

  private markDeliveredNotification(origin: TaskNotificationOrigin): void {
    const key = notificationKey(origin);
    this.scheduledNotificationKeys.delete(key);
    this.pendingNotificationRequests.delete(key);
    this.deliveredNotificationKeys.add(key);
  }

  private clearPendingNotification(key: string, request: LoopNotifyHandle): void {
    if (this.pendingNotificationRequests.get(key) !== request) return;
    this.pendingNotificationRequests.delete(key);
    if (!this.deliveredNotificationKeys.has(key) && !this.hasDeliveredNotification(key)) {
      this.scheduledNotificationKeys.delete(key);
    }
  }

  private hasDeliveredNotification(key: string): boolean {
    return this.loop.history().some((message) => {
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

function taskToolCallId(info: AgentTaskInfo): string | undefined {
  return info.kind === 'question' ? info.toolCallId : info.parentToolCallId;
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
  info: AgentTaskInfo,
  output: AgentTaskOutputSnapshot | undefined,
): readonly string[] | undefined {
  if (output === undefined) return undefined;
  if (inlinesQuestionAnswer(info, output)) {
    return output.preview.length === 0 ? undefined : [renderAnswerBlock(output.preview)];
  }
  if (output.fullOutputAvailable && output.outputPath !== undefined) {
    return [renderOutputFileBlock(output.outputPath, output.outputSizeBytes)];
  }
  if (output.preview.length === 0) return undefined;
  return [renderOutputPreviewBlock(output)];
}

function inlinesQuestionAnswer(info: AgentTaskInfo, output: AgentTaskOutputSnapshot): boolean {
  return info.kind === 'question' && !output.truncated;
}

function renderAnswerBlock(answer: string): string {
  return ['<answer>', escapeXmlTags(answer), '</answer>'].join('\n');
}

function questionNotificationText(
  info: AgentTaskInfo,
  output: AgentTaskOutputSnapshot | undefined,
): { readonly title: string; readonly body: string } | undefined {
  if (info.status !== 'completed' || output === undefined || !inlinesQuestionAnswer(info, output)) {
    return undefined;
  }
  const outcome = questionOutcome(output.preview);
  if (outcome === 'answered') {
    return {
      title: 'Background question answered',
      body: `The user answered "${info.description}".`,
    };
  }
  if (outcome === 'dismissed') {
    return {
      title: 'Background question dismissed',
      body: `The user dismissed "${info.description}" without answering.`,
    };
  }
  return undefined;
}

function questionOutcome(output: string): 'answered' | 'dismissed' | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const answers = (parsed as { readonly answers?: unknown }).answers;
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return undefined;
  return Object.keys(answers).length > 0 ? 'answered' : 'dismissed';
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

function taskNotificationId(taskId: string, status: string): string {
  return `task:${taskId}:${status}`;
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
  const timed = `Wall time: ${formatTaskWallTime(info)}\n${baseLine}`;

  if (info.kind !== 'agent') return timed;
  if (info.status === 'completed') return timed;
  const agentId = info.agentId;
  if (agentId === undefined || agentId === info.taskId) return timed;

  const recovery = [
    '',
    `To recover or continue this subagent, call Agent(resume="${agentId}", prompt="Pick up where you left off; redo the last tool call if its result was never observed.").`,
    `Use agent_id ("${agentId}"), NOT source_id / task_id ("${info.taskId}") — the two look alike but only agent_id is accepted by the resume parameter.`,
    'Add run_in_background=true to keep it backgrounded, or omit it to take the result inline in the current turn.',
    'The subagent retains its full prior context across the restart, but any in-flight tool call lost its result and may need to be redone.',
  ].join('\n');

  return `${timed}${recovery}`;
}

function buildAgentTaskNotification(
  info: AgentTaskInfo,
  output?: AgentTaskOutputSnapshot,
): AgentTaskNotification {
  const question = questionNotificationText(info, output);
  return {
    id: taskNotificationId(info.taskId, info.status),
    category: 'task',
    type: `task.${info.status}`,
    source_kind: 'background_task',
    source_id: info.taskId,
    agent_id: info.kind === 'agent' ? info.agentId : undefined,
    title: question?.title ?? `Background ${info.kind} ${info.status}`,
    severity: info.status === 'completed' ? 'info' : 'warning',
    body: question?.body ?? buildAgentTaskNotificationBody(info),
    children: agentTaskNotificationChildren(info, output),
  };
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function previousSessionTaskLine(info: AgentTaskInfo): string {
  if (info.kind === 'agent' && info.agentId !== undefined) {
    return `- ${info.taskId} "${info.description}" (subagent) — resume it with Agent(resume="${info.agentId}", prompt="Pick up where you left off; redo the last tool call if its result was never observed.") to continue from its prior context.`;
  }
  return `- ${info.taskId} "${info.description}" (${info.kind === 'process' ? 'bash' : info.kind})`;
}

function isPreviousSessionTermination(info: AgentTaskInfo): boolean {
  if (info.status === 'lost') return true;
  return (
    info.status === 'killed' &&
    info.terminalNotificationSuppressed === true &&
    info.stopReason === SESSION_CLOSED_REASON
  );
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTaskService,
  AgentTaskService,
  ScopeActivation.OnScopeCreated,
  'task',
);
