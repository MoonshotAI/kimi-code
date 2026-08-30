import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
} from '#/actor/agentRuntime';

import {
  loadTasksFromDisk,
  reconcileTasks,
  taskActorLogic,
  type TaskMachineSnapshot,
} from './internal/taskMachine';
import {
  detachTask,
  getTask,
  listTasks,
  markTasksDeliveredViaWait,
  persistTaskOutput,
  readTaskOutput,
  registerTask,
  releaseTaskId,
  reserveTaskId,
  stopAllTasks,
  stopAllTasksOnExit,
  stopTask,
  stopTaskByUser,
  suppressTaskTerminalNotification,
  taskOutputPath,
  taskOutputSnapshot,
  waitForForegroundRelease,
  waitForTask,
} from './internal/taskOperations';
import { TaskStarted, TaskTerminated, taskRegistryTransition, type TaskModelState } from './taskOps';
import type {
  AgentTaskInfo,
  AgentTaskOutputSnapshot,
  AgentTaskWaitDelivery,
  ForegroundTaskReleaseReason,
  RegisterAgentTaskOptions,
  TaskExecution,
} from './types';

export class TaskRuntime {
  constructor(private readonly context: AgentRuntimeContext<TaskModelState>) {}

  registerTask(task: TaskExecution, options: RegisterAgentTaskOptions = {}): string {
    return registerTask(this.context, task, options);
  }

  getTask(taskId: string): AgentTaskInfo | undefined {
    return getTask(this.context, taskId);
  }

  list(activeOnly = true, limit?: number): readonly AgentTaskInfo[] {
    return listTasks(this.context, activeOnly, limit);
  }

  persistOutput(taskId: string): void {
    persistTaskOutput(this.context, taskId);
  }

  loadFromDisk(options: { readonly replace?: boolean } = {}): Promise<void> {
    return loadTasksFromDisk(this.context, options);
  }

  reconcile(): Promise<readonly AgentTaskInfo[]> {
    return reconcileTasks(this.context);
  }

  getOutputSnapshot(taskId: string, maxPreviewBytes: number): Promise<AgentTaskOutputSnapshot> {
    return taskOutputSnapshot(this.context, taskId, maxPreviewBytes);
  }

  readOutput(taskId: string, tail?: number): Promise<string> {
    return readTaskOutput(this.context, taskId, tail);
  }

  suppressTerminalNotification(taskId: string): Promise<void> {
    return suppressTaskTerminalNotification(this.context, taskId);
  }

  markTasksDeliveredViaWait(tasks: readonly AgentTaskWaitDelivery[]): void {
    markTasksDeliveredViaWait(this.context, tasks);
  }

  detach(taskId: string): AgentTaskInfo | undefined {
    return detachTask(this.context, taskId);
  }

  stop(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined> {
    return stopTask(this.context, taskId, reason);
  }

  stopByUser(taskId: string): Promise<AgentTaskInfo | undefined> {
    return stopTaskByUser(this.context, taskId);
  }

  stopAll(reason?: string): Promise<readonly AgentTaskInfo[]> {
    return stopAllTasks(this.context, reason);
  }

  stopAllOnExit(reason: string): Promise<readonly AgentTaskInfo[]> {
    return stopAllTasksOnExit(this.context, reason);
  }

  wait(taskId: string, timeoutMs?: number, signal?: AbortSignal): Promise<AgentTaskInfo | undefined> {
    return waitForTask(this.context, taskId, timeoutMs, signal);
  }

  waitForForegroundRelease(taskId: string): Promise<ForegroundTaskReleaseReason | undefined> {
    return waitForForegroundRelease(this.context, taskId);
  }

  reserveTaskId(idPrefix: string): string {
    return reserveTaskId(this.context, idPrefix);
  }

  releaseTaskId(taskId: string): void {
    releaseTaskId(this.context, taskId);
  }

  taskOutputPath(taskId: string): string {
    return taskOutputPath(this.context, taskId);
  }
}

export const AgentTask = defineAgentRuntimeContract<TaskRuntime>('task');

export const taskAgentRuntimeProvider = defineAgentRuntimeProvider<TaskModelState, TaskRuntime>(
  AgentTask,
  {
    id: 'task',
    logic: taskActorLogic,
    durable: {
      events: [TaskStarted, TaskTerminated],
      undoable: false,
      transition: taskRegistryTransition,
      read: (snapshot) => (snapshot as TaskMachineSnapshot).context.registry,
      commit: (actor, registry) => {
        actor.send({ type: 'task.commit', registry });
      },
    },
    createApi: (context) => new TaskRuntime(context),
    inspect: (snapshot) => ({
      tasks: [...(snapshot as TaskMachineSnapshot).context.registry.values()],
    }),
  },
);
