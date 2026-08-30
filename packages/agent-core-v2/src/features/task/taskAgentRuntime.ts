import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
} from '#/agent/runtime/agentRuntime';

import { taskActorLogic, type TaskActorContext, type TaskActorSnapshot } from './internal/taskActor';
import type { TaskLifecycle } from './internal/taskLifecycle';
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

  private get lifecycle(): TaskLifecycle {
    return this.context.getLogicState<TaskActorContext>().lifecycle;
  }

  registerTask(task: TaskExecution, options: RegisterAgentTaskOptions = {}): string {
    return this.lifecycle.registerTask(task, options);
  }

  getTask(taskId: string): AgentTaskInfo | undefined {
    return this.lifecycle.getTask(taskId);
  }

  list(activeOnly = true, limit?: number): readonly AgentTaskInfo[] {
    return this.lifecycle.list(activeOnly, limit);
  }

  persistOutput(taskId: string): void {
    this.lifecycle.persistOutput(taskId);
  }

  loadFromDisk(options: { readonly replace?: boolean } = {}): Promise<void> {
    return this.lifecycle.loadFromDisk(options);
  }

  reconcile(): Promise<readonly AgentTaskInfo[]> {
    return this.lifecycle.reconcile();
  }

  getOutputSnapshot(taskId: string, maxPreviewBytes: number): Promise<AgentTaskOutputSnapshot> {
    return this.lifecycle.getOutputSnapshot(taskId, maxPreviewBytes);
  }

  readOutput(taskId: string, tail?: number): Promise<string> {
    return this.lifecycle.readOutput(taskId, tail);
  }

  suppressTerminalNotification(taskId: string): Promise<void> {
    return this.lifecycle.suppressTerminalNotification(taskId);
  }

  markTasksDeliveredViaWait(tasks: readonly AgentTaskWaitDelivery[]): void {
    this.lifecycle.markTasksDeliveredViaWait(tasks);
  }

  detach(taskId: string): AgentTaskInfo | undefined {
    return this.lifecycle.detach(taskId);
  }

  stop(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined> {
    return this.lifecycle.stop(taskId, reason);
  }

  stopByUser(taskId: string): Promise<AgentTaskInfo | undefined> {
    return this.lifecycle.stopByUser(taskId);
  }

  stopAll(reason?: string): Promise<readonly AgentTaskInfo[]> {
    return this.lifecycle.stopAll(reason);
  }

  stopAllOnExit(reason: string): Promise<readonly AgentTaskInfo[]> {
    return this.lifecycle.stopAllOnExit(reason);
  }

  wait(taskId: string, timeoutMs?: number, signal?: AbortSignal): Promise<AgentTaskInfo | undefined> {
    return this.lifecycle.wait(taskId, timeoutMs, signal);
  }

  waitForForegroundRelease(taskId: string): Promise<ForegroundTaskReleaseReason | undefined> {
    return this.lifecycle.waitForForegroundRelease(taskId);
  }

  reserveTaskId(idPrefix: string): string {
    return this.lifecycle.reserveTaskId(idPrefix);
  }

  releaseTaskId(taskId: string): void {
    this.lifecycle.releaseTaskId(taskId);
  }

  taskOutputPath(taskId: string): string {
    return this.lifecycle.taskOutputPath(taskId);
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
      read: (snapshot) => (snapshot as TaskActorSnapshot).context.registry,
      commit: (actor, registry) => {
        actor.send({ type: 'task.commit', registry });
      },
    },
    createApi: (context) => new TaskRuntime(context),
    inspect: (snapshot) => ({
      tasks: [...(snapshot as TaskActorSnapshot).context.registry.values()],
    }),
  },
);
