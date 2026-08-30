import { abortable, userCancellationReason } from '#/_base/utils/abort';
import { setClampedTimeout } from '#/_base/utils/timer';
import type { AgentRuntimeContext } from '#/actor/agentRuntime';

import type { TaskModelState } from '../taskOps';
import type {
  AgentTaskInfo,
  AgentTaskOutputSnapshot,
  AgentTaskWaitDelivery,
  ForegroundTaskReleaseReason,
  RegisterAgentTaskOptions,
  TaskExecution,
} from '../types';
import {
  entryInfoOf,
  isEntryTerminal,
  listTaskInfos,
  outputSnapshotOf,
  type TaskEntryRef,
  type TaskEntrySnapshot,
} from './taskEntryMachine';
import {
  taskMachineOf,
  type TaskMachineContext,
  type TaskRegisterEvent,
  type TaskReserveIdEvent,
  type TaskWaitDeliveredMarkEvent,
} from './taskMachine';

type TaskRuntimeHandle = AgentRuntimeContext<TaskModelState>;

function normalizeReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function whenEntryTerminal(ref: TaskEntryRef): Promise<void> {
  if (isEntryTerminal(ref.getSnapshot())) return Promise.resolve();
  return new Promise((resolve) => {
    const subscription = ref.subscribe((snapshot) => {
      if (!isEntryTerminal(snapshot)) return;
      subscription.unsubscribe();
      resolve();
    });
  });
}

export function registerTask(
  runtime: TaskRuntimeHandle,
  execution: TaskExecution,
  options: RegisterAgentTaskOptions = {},
): string {
  const reply: TaskRegisterEvent['reply'] = {};
  runtime.send({ type: 'task.register', execution, options, reply } satisfies TaskRegisterEvent);
  if (reply.error !== undefined) throw reply.error;
  return reply.taskId!;
}

export function getTask(runtime: TaskRuntimeHandle, taskId: string): AgentTaskInfo | undefined {
  const context = taskMachineOf(runtime);
  const ref = context.entries.get(taskId);
  return ref === undefined ? context.ghosts.get(taskId) : entryInfoOf(ref.getSnapshot());
}

export function listTasks(
  runtime: TaskRuntimeHandle,
  activeOnly = true,
  limit?: number,
): readonly AgentTaskInfo[] {
  const context = taskMachineOf(runtime);
  return listTaskInfos(context.entries, context.ghosts, activeOnly, limit);
}

export function persistTaskOutput(runtime: TaskRuntimeHandle, taskId: string): void {
  taskMachineOf(runtime).entries.get(taskId)?.send({ type: 'entry.persistOutput' });
}

export function taskOutputSnapshot(
  runtime: TaskRuntimeHandle,
  taskId: string,
  maxPreviewBytes: number,
): Promise<AgentTaskOutputSnapshot> {
  const context = taskMachineOf(runtime);
  return outputSnapshotOf(
    context.entries,
    context.ghosts,
    context.deps.persistence,
    taskId,
    maxPreviewBytes,
  );
}

export async function readTaskOutput(
  runtime: TaskRuntimeHandle,
  taskId: string,
  tail?: number,
): Promise<string> {
  const output = (await taskOutputSnapshot(runtime, taskId, Number.MAX_SAFE_INTEGER)).preview;
  if (tail === undefined) return output;
  return output.slice(-Math.max(0, Math.trunc(tail)));
}

export async function suppressTaskTerminalNotification(
  runtime: TaskRuntimeHandle,
  taskId: string,
): Promise<void> {
  taskMachineOf(runtime).entries.get(taskId)?.send({ type: 'entry.suppressNotification' });
}

export function markTasksDeliveredViaWait(
  runtime: TaskRuntimeHandle,
  tasks: readonly AgentTaskWaitDelivery[],
): void {
  if (tasks.length === 0) return;
  runtime.send({ type: 'task.waitDelivered', tasks } satisfies TaskWaitDeliveredMarkEvent);
}

export function detachTask(runtime: TaskRuntimeHandle, taskId: string): AgentTaskInfo | undefined {
  const context = taskMachineOf(runtime);
  const ref = context.entries.get(taskId);
  if (ref === undefined) return context.ghosts.get(taskId);
  ref.send({ type: 'entry.detach' });
  return entryInfoOf(ref.getSnapshot());
}

async function terminateTask(
  runtime: TaskRuntimeHandle,
  taskId: string,
  options: { readonly stopReason?: string; readonly abortReason: unknown },
): Promise<AgentTaskInfo | undefined> {
  const ref = taskMachineOf(runtime).entries.get(taskId);
  if (ref === undefined) return undefined;
  if (!isEntryTerminal(ref.getSnapshot())) {
    ref.send({
      type: 'entry.stop',
      stopReason: options.stopReason,
      abortReason: options.abortReason,
      finalStatus: 'killed',
    });
    await whenEntryTerminal(ref);
  }
  return entryInfoOf(ref.getSnapshot());
}

export function stopTask(
  runtime: TaskRuntimeHandle,
  taskId: string,
  reason?: string,
): Promise<AgentTaskInfo | undefined> {
  const normalized = normalizeReason(reason);
  return terminateTask(runtime, taskId, { stopReason: normalized, abortReason: normalized });
}

export function stopTaskByUser(
  runtime: TaskRuntimeHandle,
  taskId: string,
): Promise<AgentTaskInfo | undefined> {
  const reason = userCancellationReason();
  return terminateTask(runtime, taskId, { stopReason: reason.message, abortReason: reason });
}

export async function stopAllTasks(
  runtime: TaskRuntimeHandle,
  reason?: string,
): Promise<readonly AgentTaskInfo[]> {
  const ids = [...taskMachineOf(runtime).entries.keys()];
  const results = await Promise.all(ids.map((taskId) => stopTask(runtime, taskId, reason)));
  return results.filter((info): info is AgentTaskInfo => info !== undefined);
}

function survivesSessionClose(context: TaskMachineContext, taskId: string): boolean {
  const ref = context.entries.get(taskId);
  return ref !== undefined && ref.getSnapshot().context.execution.survivesSessionClose?.() === true;
}

export async function stopAllTasksOnExit(
  runtime: TaskRuntimeHandle,
  reason: string,
): Promise<readonly AgentTaskInfo[]> {
  const context = taskMachineOf(runtime);
  const active = listTaskInfos(context.entries, context.ghosts, true);
  await Promise.all(
    active
      .filter((task) => task.detached === true && !survivesSessionClose(context, task.taskId))
      .map((task) => suppressTaskTerminalNotification(runtime, task.taskId)),
  );
  const results: AgentTaskInfo[] = [];
  for (const [taskId, ref] of context.entries) {
    if (ref.getSnapshot().context.execution.survivesSessionClose?.() === true) {
      results.push(entryInfoOf(ref.getSnapshot()));
      continue;
    }
    const info = await stopTask(runtime, taskId, reason);
    if (info !== undefined) results.push(info);
  }
  return results;
}

export async function waitForTask(
  runtime: TaskRuntimeHandle,
  taskId: string,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<AgentTaskInfo | undefined> {
  const context = taskMachineOf(runtime);
  const ref = context.entries.get(taskId);
  if (ref === undefined) return context.ghosts.get(taskId);
  if (isEntryTerminal(ref.getSnapshot())) return entryInfoOf(ref.getSnapshot());
  if (timeoutMs <= 0) return entryInfoOf(ref.getSnapshot());

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const pending = Promise.race([
      new Promise<void>((resolve) => {
        const subscription = ref.subscribe((snapshot) => {
          if (!isEntryTerminal(snapshot)) return;
          resolve();
        });
        unsubscribe = () => {
          subscription.unsubscribe();
        };
      }),
      new Promise<void>((resolve) => {
        timeout = setClampedTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
    await (signal === undefined ? pending : abortable(pending, signal));
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    unsubscribe?.();
  }

  return entryInfoOf(ref.getSnapshot());
}

export function waitForForegroundRelease(
  runtime: TaskRuntimeHandle,
  taskId: string,
): Promise<ForegroundTaskReleaseReason | undefined> {
  const ref = taskMachineOf(runtime).entries.get(taskId);
  if (ref === undefined) return Promise.resolve(undefined);
  const snapshot = ref.getSnapshot();
  if (isEntryTerminal(snapshot)) return Promise.resolve('terminal');
  if (snapshot.context.detached) return Promise.resolve('detached');

  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason: ForegroundTaskReleaseReason): void => {
      if (settled) return;
      settled = true;
      subscription.unsubscribe();
      resolve(reason);
    };
    const check = (current: TaskEntrySnapshot): void => {
      const reason =
        current.context.releaseReason ?? (isEntryTerminal(current) ? 'terminal' : undefined);
      if (reason !== undefined) finish(reason);
    };
    const subscription = ref.subscribe(check);
    check(ref.getSnapshot());
  });
}

export function reserveTaskId(runtime: TaskRuntimeHandle, idPrefix: string): string {
  const reply: TaskReserveIdEvent['reply'] = {};
  runtime.send({ type: 'task.reserveId', idPrefix, reply } satisfies TaskReserveIdEvent);
  return reply.taskId!;
}

export function releaseTaskId(runtime: TaskRuntimeHandle, taskId: string): void {
  runtime.send({ type: 'task.releaseId', taskId });
}

export function taskOutputPath(runtime: TaskRuntimeHandle, taskId: string): string {
  return taskMachineOf(runtime).deps.persistence.taskOutputFile(taskId);
}
