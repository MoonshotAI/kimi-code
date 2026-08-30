import { randomBytes } from 'node:crypto';
import { join } from 'pathe';

import { assign, enqueueActions, fromCallback, setup, type Snapshot } from 'xstate';

import type { IDisposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { IEventBus } from '#/app/event/eventBus';
import { Error2, ErrorCodes, BugIndicatingError } from '#/errors';
import { ContextSpliced } from '#/actor/contextMemory/contextEvents';
import { AgentContextMemory, type ContextMemoryRuntime } from '#/actor/contextMemory/contextMemoryAgentRuntime';
import { activateReminderWhenReady } from '#/actor/reminder/internal/reminderActivation';
import { AgentUndo } from '#/actor/undo/undoAgentRuntime';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { IAgentHostService } from '#/agent/host/agentHost';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import type { AgentRuntimeContext, AgentRuntimeRestoreEvent } from '#/actor/agentRuntime';
import { IConfigService } from '#/app/config/config';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  notificationKey,
  taskNotificationDeliveryKey,
  taskNotificationId,
  type TaskNotificationOrigin,
} from '../notificationDelivery';
import { taskExecutionReviverFor } from '../revive';
import {
  TaskStarted,
  TaskTerminated,
  TaskWaitDelivered,
  type TaskModelState,
} from '../taskOps';
import {
  TERMINAL_STATUSES,
  type AgentTaskInfo,
  type AgentTaskWaitDelivery,
  type RegisterAgentTaskOptions,
  type TaskExecution,
} from '../types';
import { resolveAgentTaskConfig } from '../configSection';
import { formatTaskList } from './format';
import { AgentTaskPersistence, validateTaskId } from './persist';
import {
  entryInfoOf,
  isEntryTerminal,
  listTaskInfos,
  outputSnapshotOf,
  taskEntryLogic,
  type TaskEntryInput,
  type TaskEntryParentEvent,
  type TaskEntryRef,
  type TaskChildDetachedEvent,
  type TaskChildSettledEvent,
} from './taskEntryMachine';
import {
  createTaskNotificationLedger,
  markDeliveredMessageOrigins,
  markDeliveredNotification,
  notifyAgentTask,
  reconcileNotificationDeliveryAfterUndo,
  restoreAgentTaskNotifications,
  seedDeliveredNotificationKeys,
  type TaskNotificationHost,
  type TaskNotificationLedger,
} from './taskNotifications';

const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ACTIVE_BACKGROUND_TASK_INJECTION_VARIANT = 'background_task_status';
const ACTIVE_BACKGROUND_TASK_GUIDANCE = [
  'The conversation was compacted, so the earlier messages that started these background tasks are gone — but the tasks are still running from before.',
  'Do not start duplicates. Use TaskList to list them, TaskOutput for a non-blocking status/output snapshot, and TaskStop to cancel one — completion arrives via automatic notification.',
].join(' ');

export interface TaskDeps {
  readonly agent: AgentContext;
  readonly scopeContext: IAgentScopeContext;
  readonly telemetry: ITelemetryService;
  readonly config: IConfigService;
  readonly eventBus: IEventBus;
  readonly dispatcher: IEventDispatcher;
  readonly manager: IAgentLifecycleService;
  readonly log: ILogService;
  readonly states: IAgentStateService;
  readonly contextMemory: ContextMemoryRuntime;
  readonly persistence: AgentTaskPersistence;
}

export function taskDepsOf(runtime: AgentRuntimeContext<TaskModelState>): TaskDeps {
  const host = runtime.get(IAgentHostService).of(runtime.agent);
  const session = runtime.get(ISessionContext);
  const manager = runtime.get(IAgentLifecycleService);
  const agent = runtime.agent;
  return {
    agent,
    scopeContext: host.scopeContext,
    telemetry: host.telemetry,
    config: runtime.get(IConfigService),
    eventBus: host.eventBus,
    dispatcher: host.dispatcher,
    manager,
    log: runtime.get(ILogService),
    states: host.state,
    get contextMemory() {
      return manager.resolve(agent, AgentContextMemory);
    },
    persistence: new AgentTaskPersistence(
      join(session.sessionDir, 'agents', agent.agentId),
      host.scopeContext.scope(),
      runtime.get(IAtomicDocumentStore),
      runtime.get(IFileSystemStorageService),
      agent.agentId === 'main'
        ? { dir: session.sessionDir, scope: session.scope() }
        : undefined,
    ),
  };
}

export interface TaskMachineContext {
  readonly runtime: AgentRuntimeContext<TaskModelState>;
  readonly deps: TaskDeps;
  registry: TaskModelState;
  readonly entries: Map<string, TaskEntryRef>;
  readonly ghosts: Map<string, AgentTaskInfo>;
  readonly reservedTaskIds: Set<string>;
  readonly notifications: TaskNotificationLedger;
  reminderPending: boolean;
}

export type TaskMachineSnapshot = Snapshot<unknown> & {
  readonly context: TaskMachineContext;
};

interface TaskCommitEvent {
  readonly type: 'task.commit';
  readonly registry: TaskModelState;
}

export interface TaskRegisterEvent {
  readonly type: 'task.register';
  readonly execution: TaskExecution;
  readonly options: RegisterAgentTaskOptions;
  readonly reply: { taskId?: string; error?: unknown };
}

export interface TaskReserveIdEvent {
  readonly type: 'task.reserveId';
  readonly idPrefix: string;
  readonly reply: { taskId?: string };
}

export interface TaskReleaseIdEvent {
  readonly type: 'task.releaseId';
  readonly taskId: string;
}

export interface TaskMergeGhostsEvent {
  readonly type: 'task.mergeGhosts';
  readonly tasks: readonly AgentTaskInfo[];
  readonly replace: boolean;
}

export interface TaskMarkGhostsLostEvent {
  readonly type: 'task.markGhostsLost';
  readonly reply: { readonly lost: AgentTaskInfo[] };
}

export interface TaskReattachEvent {
  readonly type: 'task.reattach';
  readonly taskId: string;
  readonly info: AgentTaskInfo;
  readonly execution: TaskExecution;
}

export interface TaskWaitDeliveredMarkEvent {
  readonly type: 'task.waitDelivered';
  readonly tasks: readonly AgentTaskWaitDelivery[];
}

interface TaskMessagesDeliveredEvent {
  readonly type: 'task.messagesDelivered';
  readonly messages: readonly { readonly origin?: unknown }[];
}

interface TaskReminderArmEvent {
  readonly type: 'task.reminderArm';
}

export interface TaskReminderConsumeEvent {
  readonly type: 'task.reminderConsume';
  readonly reply: { text?: string };
}

interface TaskRestoredEvent {
  readonly type: 'task.restored';
}

export type TaskMachineEvent =
  | TaskCommitEvent
  | TaskRegisterEvent
  | TaskReserveIdEvent
  | TaskReleaseIdEvent
  | TaskMergeGhostsEvent
  | TaskMarkGhostsLostEvent
  | TaskReattachEvent
  | TaskWaitDeliveredMarkEvent
  | TaskMessagesDeliveredEvent
  | TaskReminderArmEvent
  | TaskReminderConsumeEvent
  | TaskRestoredEvent
  | TaskEntryParentEvent
  | AgentRuntimeRestoreEvent;

export function taskMachineOf(runtime: AgentRuntimeContext<TaskModelState>): TaskMachineContext {
  return runtime.getLogicState<TaskMachineContext>();
}

export function hostOf(runtime: AgentRuntimeContext<TaskModelState>): TaskNotificationHost {
  return {
    get agent() {
      return taskMachineOf(runtime).deps.agent;
    },
    get dispatcher() {
      return taskMachineOf(runtime).deps.dispatcher;
    },
    get log() {
      return taskMachineOf(runtime).deps.log;
    },
    get states() {
      return taskMachineOf(runtime).deps.states;
    },
    get contextMemory() {
      return taskMachineOf(runtime).deps.contextMemory;
    },
    get ledger() {
      return taskMachineOf(runtime).notifications;
    },
    listInfos: (activeOnly) => {
      const context = taskMachineOf(runtime);
      return listTaskInfos(context.entries, context.ghosts, activeOnly);
    },
    isSuppressed: (taskId) => {
      const context = taskMachineOf(runtime);
      return (
        context.entries.get(taskId)?.getSnapshot().context.terminalNotificationSuppressed ===
          true || context.ghosts.get(taskId)?.terminalNotificationSuppressed === true
      );
    },
    outputSnapshot: (taskId, maxPreviewBytes) => {
      const context = taskMachineOf(runtime);
      return outputSnapshotOf(
        context.entries,
        context.ghosts,
        context.deps.persistence,
        taskId,
        maxPreviewBytes,
      );
    },
  };
}

export function recordTaskStarted(deps: TaskDeps, info: AgentTaskInfo): void {
  void deps.dispatcher.dispatch(new TaskStarted({ agentId: deps.agent.agentId, info }));
  deps.telemetry.track2('background_task_created', {
    task_id: info.taskId,
    kind: info.kind === 'process' ? 'bash' : info.kind,
  });
}

export function recordTaskTerminated(
  deps: TaskDeps,
  info: AgentTaskInfo,
  outputTail?: string,
): void {
  void deps.dispatcher.dispatch(
    new TaskTerminated({ agentId: deps.agent.agentId, info, outputTail }),
  );
  deps.telemetry.track2('background_task_completed', {
    task_id: info.taskId,
    kind: info.kind,
    duration_ms: info.endedAt !== null ? info.endedAt - info.startedAt : null,
    status: info.status,
  });
}

function generateTaskId(kind: string): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let index = 0; index < 8; index++) {
    suffix += TASK_ID_ALPHABET[bytes[index]! % TASK_ID_ALPHABET.length];
  }
  return `${kind}-${suffix}`;
}

function activeTaskCount(context: TaskMachineContext): number {
  let count = 0;
  for (const ref of context.entries.values()) {
    const snapshot = ref.getSnapshot();
    if (!isEntryTerminal(snapshot) && snapshot.context.startedDetached) count++;
  }
  return count;
}

function assertCanRegister(context: TaskMachineContext, detached: boolean): void {
  const maxRunningTasks = resolveAgentTaskConfig(context.deps.config)?.maxRunningTasks;
  if (maxRunningTasks === undefined) return;
  if (!detached) return;
  const running = activeTaskCount(context);
  if (running < maxRunningTasks) return;
  throw new Error2(ErrorCodes.TASK_LIMIT_EXCEEDED, 'Too many background tasks are already running.', {
    details: { running, max: maxRunningTasks },
  });
}

function claimTaskId(
  context: TaskMachineContext,
  idPrefix: string,
  explicit: string | undefined,
): string {
  if (explicit === undefined) return generateTaskId(idPrefix);
  validateTaskId(explicit);
  if (context.entries.has(explicit) || context.ghosts.has(explicit)) {
    throw new BugIndicatingError(`Duplicate task id: "${explicit}"`);
  }
  context.reservedTaskIds.delete(explicit);
  return explicit;
}

function newerRestoredTask(existing: AgentTaskInfo, loaded: AgentTaskInfo): AgentTaskInfo {
  const existingTerminal = TERMINAL_STATUSES.has(existing.status);
  const loadedTerminal = TERMINAL_STATUSES.has(loaded.status);
  if (existingTerminal && !loadedTerminal) return existing;
  if (!existingTerminal && loadedTerminal) return loaded;
  if (existing.endedAt !== null && loaded.endedAt !== null) {
    return loaded.endedAt >= existing.endedAt ? loaded : existing;
  }
  if (existing.endedAt !== null) return existing;
  if (loaded.endedAt !== null) return loaded;
  return loaded;
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

export async function loadTasksFromDisk(
  runtime: AgentRuntimeContext<TaskModelState>,
  options: { readonly replace?: boolean } = {},
): Promise<void> {
  const tasks = await taskMachineOf(runtime).deps.persistence.listTasks();
  runtime.send({
    type: 'task.mergeGhosts',
    tasks,
    replace: options.replace !== false,
  } satisfies TaskMergeGhostsEvent);
}

async function reviveGhostTasks(runtime: AgentRuntimeContext<TaskModelState>): Promise<void> {
  const ghosts = [...taskMachineOf(runtime).ghosts];
  for (const [taskId, info] of ghosts) {
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
    runtime.send({ type: 'task.reattach', taskId, info, execution } satisfies TaskReattachEvent);
  }
}

export async function reconcileTasks(
  runtime: AgentRuntimeContext<TaskModelState>,
): Promise<readonly AgentTaskInfo[]> {
  const reply: { lost: AgentTaskInfo[] } = { lost: [] };
  runtime.send({ type: 'task.markGhostsLost', reply } satisfies TaskMarkGhostsLostEvent);
  await restoreAgentTaskNotifications(hostOf(runtime));
  return reply.lost;
}

async function runTaskRestore(runtime: AgentRuntimeContext<TaskModelState>): Promise<void> {
  await loadTasksFromDisk(runtime, { replace: false });
  await reviveGhostTasks(runtime);
  await reconcileTasks(runtime);
  runtime.send({ type: 'task.restored' } satisfies TaskRestoredEvent);
}

const taskEffects = fromCallback(
  ({ input }: { input: AgentRuntimeContext<TaskModelState> }) => {
    const runtime = input;
    const contextOf = (): TaskMachineContext => taskMachineOf(runtime);
    const deps = contextOf().deps;
    deps.states.contributeState(taskNotificationDeliveryKey);
    const subscriptions: IDisposable[] = [
      deps.eventBus.subscribe(ContextSpliced, (e) => {
        if (isCompactionSplice(e)) {
          runtime.send({ type: 'task.reminderArm' } satisfies TaskReminderArmEvent);
        }
        runtime.send({
          type: 'task.messagesDelivered',
          messages: e.messages,
        } satisfies TaskMessagesDeliveredEvent);
      }),
      deps.manager.resolve(deps.agent, AgentUndo).registerUndoParticipant({
        id: 'task.notificationDelivery',
        reconcileAfterUndo: () => reconcileNotificationDeliveryAfterUndo(hostOf(runtime)),
      }),
      activateReminderWhenReady(deps.manager, deps.scopeContext, (reminder) =>
        reminder.register(ACTIVE_BACKGROUND_TASK_INJECTION_VARIANT, () => {
          const reply: { text?: string } = {};
          runtime.send({ type: 'task.reminderConsume', reply } satisfies TaskReminderConsumeEvent);
          return reply.text;
        }),
      ),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
      contextOf().notifications.disposed = true;
    };
  },
);

export const taskActorLogic = setup({
  types: {} as {
    context: TaskMachineContext;
    input: AgentRuntimeContext<TaskModelState>;
    events: TaskMachineEvent;
  },
  actors: { taskEffects, taskEntry: taskEntryLogic },
  actions: {
    commitRegistry: assign({
      registry: ({ event }) => (event as TaskCommitEvent).registry,
    }),
    handleRegister: enqueueActions(({ context, event, enqueue }) => {
      const e = event as TaskRegisterEvent;
      const options = e.options;
      const detached = options.detached ?? true;
      const timeoutMs = options.timeoutMs ?? e.execution.timeoutMs;
      let taskId: string;
      try {
        assertCanRegister(context, detached);
        taskId = claimTaskId(context, e.execution.idPrefix, options.taskId);
      } catch (error) {
        e.reply.error = error;
        return;
      }
      e.reply.taskId = taskId;
      enqueue.assign(({ spawn }) => {
        const ref = spawn('taskEntry', {
          id: `taskEntry-${taskId}`,
          input: {
            persistence: context.deps.persistence,
            config: context.deps.config,
            taskId,
            execution: e.execution,
            detached,
            timeoutMs,
            detachTimeoutMs: options.detachTimeoutMs,
            autoBackgroundOnTimeout: options.autoBackgroundOnTimeout,
            signal: detached ? undefined : options.signal,
            startedAt: Date.now(),
            initialTimerDelayMs:
              timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : undefined,
            persistStarted: detached,
            stopReason: undefined,
            terminalNotificationSuppressed: undefined,
          } satisfies TaskEntryInput,
        });
        context.entries.set(taskId, ref as TaskEntryRef);
        context.ghosts.delete(taskId);
        return {};
      });
      enqueue(() => {
        if (!detached) return;
        const ref = context.entries.get(taskId);
        if (ref !== undefined) recordTaskStarted(context.deps, entryInfoOf(ref.getSnapshot()));
      });
    }),
    handleReattach: enqueueActions(({ context, event, enqueue }) => {
      const e = event as TaskReattachEvent;
      const ghost = context.ghosts.get(e.taskId);
      if (ghost === undefined || context.entries.has(e.taskId)) return;
      if (TERMINAL_STATUSES.has(ghost.status)) return;
      const timeoutMs = e.info.timeoutMs;
      enqueue.assign(({ spawn }) => {
        context.ghosts.delete(e.taskId);
        const ref = spawn('taskEntry', {
          id: `taskEntry-${e.taskId}`,
          input: {
            persistence: context.deps.persistence,
            config: context.deps.config,
            taskId: e.taskId,
            execution: e.execution,
            detached: true,
            timeoutMs,
            detachTimeoutMs: undefined,
            autoBackgroundOnTimeout: undefined,
            signal: undefined,
            startedAt: e.info.startedAt,
            initialTimerDelayMs:
              timeoutMs !== undefined && timeoutMs > 0
                ? Math.max(0, timeoutMs - (Date.now() - e.info.startedAt))
                : undefined,
            persistStarted: true,
            stopReason: e.info.stopReason,
            terminalNotificationSuppressed: e.info.terminalNotificationSuppressed,
          } satisfies TaskEntryInput,
        });
        context.entries.set(e.taskId, ref as TaskEntryRef);
        return {};
      });
    }),
    handleReserveId: ({ context, event }) => {
      const e = event as TaskReserveIdEvent;
      let taskId = generateTaskId(e.idPrefix);
      while (
        context.entries.has(taskId) ||
        context.ghosts.has(taskId) ||
        context.reservedTaskIds.has(taskId)
      ) {
        taskId = generateTaskId(e.idPrefix);
      }
      context.reservedTaskIds.add(taskId);
      e.reply.taskId = taskId;
    },
    handleReleaseId: ({ context, event }) => {
      context.reservedTaskIds.delete((event as TaskReleaseIdEvent).taskId);
    },
    handleMergeGhosts: ({ context, event }) => {
      const e = event as TaskMergeGhostsEvent;
      if (e.replace) context.ghosts.clear();
      for (const task of e.tasks) {
        if (context.entries.has(task.taskId)) continue;
        const existing = context.ghosts.get(task.taskId);
        context.ghosts.set(
          task.taskId,
          existing === undefined ? task : newerRestoredTask(existing, task),
        );
      }
    },
    handleMarkGhostsLost: ({ context, event }) => {
      const e = event as TaskMarkGhostsLostEvent;
      for (const [taskId, info] of context.ghosts) {
        if (TERMINAL_STATUSES.has(info.status)) continue;
        const updated: AgentTaskInfo = {
          ...info,
          status: 'lost',
          endedAt: info.endedAt ?? Date.now(),
        };
        context.ghosts.set(taskId, updated);
        e.reply.lost.push(updated);
        recordTaskTerminated(context.deps, updated);
      }
    },
    handleWaitDelivered: ({ context, event }) => {
      const e = event as TaskWaitDeliveredMarkEvent;
      const keys: string[] = [];
      for (const { taskId, status } of e.tasks) {
        const origin: TaskNotificationOrigin = {
          taskId,
          status,
          notificationId: taskNotificationId(taskId, status),
        };
        const key = notificationKey(origin);
        context.notifications.pendingRequests.get(key)?.abort();
        markDeliveredNotification(context.notifications, origin);
        keys.push(key);
      }
      void context.deps.dispatcher.dispatch(
        new TaskWaitDelivered({ agentId: context.deps.agent.agentId, keys }),
      );
    },
    handleMessagesDelivered: ({ context, event }) => {
      markDeliveredMessageOrigins(
        context.notifications,
        (event as TaskMessagesDeliveredEvent).messages,
      );
    },
    armReminder: assign({ reminderPending: true }),
    consumeReminder: enqueueActions(({ context, event, enqueue }) => {
      const e = event as TaskReminderConsumeEvent;
      if (!context.reminderPending) return;
      enqueue.assign({ reminderPending: false });
      const tasks = listTaskInfos(context.entries, context.ghosts, true);
      if (tasks.length === 0) return;
      e.reply.text = `${ACTIVE_BACKGROUND_TASK_GUIDANCE}\n\n${formatTaskList(tasks, true)}`;
    }),
    handleChildDetached: ({ context, event }) => {
      recordTaskStarted(context.deps, (event as TaskChildDetachedEvent).info);
    },
    handleChildSettled: ({ context, event }) => {
      const e = event as TaskChildSettledEvent;
      void notifyAgentTask(hostOf(context.runtime), e.info).catch((error: unknown) => {
        context.deps.log.error('task notification delivery failed', {
          taskId: e.info.taskId,
          error,
        });
      });
      recordTaskTerminated(context.deps, e.info, e.outputTail);
    },
    beginRestoreSeed: ({ context, event }) => {
      const e = event as AgentRuntimeRestoreEvent;
      seedDeliveredNotificationKeys(hostOf(context.runtime));
      for (const [taskId, info] of context.runtime.getState()) {
        if (context.entries.has(taskId)) continue;
        context.ghosts.set(taskId, info);
      }
      e.waitUntil(runTaskRestore(context.runtime));
    },
  },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    deps: taskDepsOf(input),
    registry: new Map(),
    entries: new Map(),
    ghosts: new Map(),
    reservedTaskIds: new Set(),
    notifications: createTaskNotificationLedger(),
    reminderPending: false,
  }),
  invoke: {
    src: 'taskEffects',
    input: ({ context }) => context.runtime,
  },
  initial: 'beforeRestore',
  states: {
    beforeRestore: {
      on: {
        'runtime.restore': { target: 'restoring', actions: 'beginRestoreSeed' },
      },
    },
    restoring: {
      on: {
        'task.restored': { target: 'active' },
      },
    },
    active: {},
  },
  on: {
    'task.commit': { actions: 'commitRegistry' },
    'task.register': { actions: 'handleRegister' },
    'task.reattach': { actions: 'handleReattach' },
    'task.reserveId': { actions: 'handleReserveId' },
    'task.releaseId': { actions: 'handleReleaseId' },
    'task.mergeGhosts': { actions: 'handleMergeGhosts' },
    'task.markGhostsLost': { actions: 'handleMarkGhostsLost' },
    'task.waitDelivered': { actions: 'handleWaitDelivered' },
    'task.messagesDelivered': { actions: 'handleMessagesDelivered' },
    'task.reminderArm': { actions: 'armReminder' },
    'task.reminderConsume': { actions: 'consumeReminder' },
    'task.child.detached': { actions: 'handleChildDetached' },
    'task.child.settled': { actions: 'handleChildSettled' },
  },
});
