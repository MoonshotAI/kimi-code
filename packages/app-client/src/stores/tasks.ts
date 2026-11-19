import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { KimiEventConnection, SessionTask, TaskCommandResult } from '@moonshot-ai/app-core/api';
import { shallowEqualRecord } from '@moonshot-ai/app-core/api';
import { clientPinia } from './pinia';
import { getEventConn } from './connection';
import { sessionsStore } from './sessions';

const MAIN_AGENT_ID = 'main';
const TASK_NOT_FOUND_CODE = 40406;
const NO_TASKS: readonly SessionTask[] = Object.freeze([]);

export interface TasksHooks {
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
}

let tasksHooks: TasksHooks | null = null;

export function setTasksHooks(next: TasksHooks | null): void {
  tasksHooks = next;
}

export const useTasksStore = defineStore('kimi.tasks', () => {
  const tasksBySession = ref<Record<string, Record<string, readonly SessionTask[]>>>({});
  const pendingTaskCancellations = ref<Record<string, true>>({});
  const pendingTaskDetachments = ref<Record<string, true>>({});

  function tasksOf(sessionId: string, agentId: string): readonly SessionTask[] {
    return tasksBySession.value[sessionId]?.[agentId] ?? NO_TASKS;
  }

  function setTasks(sessionId: string, agentId: string, tasks: readonly SessionTask[]): void {
    const agents = tasksBySession.value[sessionId];
    if (agents === undefined) tasksBySession.value[sessionId] = { [agentId]: tasks };
    else agents[agentId] = tasks;
  }

  function replaceRunningTasks(sessionId: string, agentId: string, running: readonly SessionTask[]): void {
    const listed = new Set(running.map((task) => task.taskId));
    const ended = tasksOf(sessionId, agentId).filter(
      (task) => task.state !== 'running' && !listed.has(task.taskId),
    );
    setTasks(sessionId, agentId, [...ended, ...running]);
  }

  function upsertTask(sessionId: string, agentId: string, task: SessionTask): void {
    const tasks = tasksOf(sessionId, agentId);
    const index = tasks.findIndex((existing) => existing.taskId === task.taskId);
    if (index !== -1 && shallowEqualRecord<unknown>({ ...tasks[index]! }, { ...task })) return;
    setTasks(
      sessionId,
      agentId,
      index === -1 ? [...tasks, task] : tasks.map((existing, i) => (i === index ? task : existing)),
    );
  }

  async function runTaskCommand(
    operation: 'cancelTask' | 'detachTask',
    sessionId: string,
    send: (connection: KimiEventConnection) => Promise<TaskCommandResult>,
  ): Promise<void> {
    try {
      const connection = getEventConn();
      if (connection === null) throw new Error('WebSocket is not connected');
      const result = await send(connection);
      if (result.code === 0 || result.code === TASK_NOT_FOUND_CODE) return;
      tasksHooks?.pushOperationFailure(operation, new Error(result.msg ?? `code ${result.code}`), {
        sessionId,
      });
    } catch (err) {
      tasksHooks?.pushOperationFailure(operation, err, { sessionId });
    }
  }

  async function cancelTask(taskId: string): Promise<void> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return;
    if (pendingTaskCancellations.value[taskId]) return;
    pendingTaskCancellations.value[taskId] = true;
    try {
      await runTaskCommand('cancelTask', sid, (connection) =>
        connection.stopTask(sid, MAIN_AGENT_ID, taskId),
      );
    } finally {
      delete pendingTaskCancellations.value[taskId];
    }
  }

  async function detachTask(toolCallId: string): Promise<void> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return;
    if (pendingTaskDetachments.value[toolCallId]) return;
    const target = tasksOf(sid, MAIN_AGENT_ID).find(
      (task) => task.parentToolCallId === toolCallId && task.state === 'running' && !task.detached,
    );
    if (target === undefined) return;
    pendingTaskDetachments.value[toolCallId] = true;
    try {
      await runTaskCommand('detachTask', sid, (connection) =>
        connection.backgroundTask(sid, MAIN_AGENT_ID, target.taskId),
      );
    } finally {
      delete pendingTaskDetachments.value[toolCallId];
    }
  }

  function forgetSessionTasks(sessionId: string): void {
    delete tasksBySession.value[sessionId];
  }

  function resetTasks(): void {
    tasksBySession.value = {};
    pendingTaskCancellations.value = {};
    pendingTaskDetachments.value = {};
  }

  return {
    tasksBySession,
    pendingTaskCancellations,
    pendingTaskDetachments,
    tasksOf,
    replaceRunningTasks,
    upsertTask,
    cancelTask,
    detachTask,
    forgetSessionTasks,
    resetTasks,
  };
});

export function tasksStore() {
  return useTasksStore(clientPinia);
}
