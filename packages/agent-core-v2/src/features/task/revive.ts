import type { AgentTaskInfo, AgentTaskKind, TaskExecution } from './types';

export type TaskExecutionReviver = (
  info: AgentTaskInfo,
) => Promise<TaskExecution | undefined>;

const revivers = new Map<AgentTaskKind, TaskExecutionReviver>();

export function registerTaskExecutionReviver(
  kind: AgentTaskKind,
  reviver: TaskExecutionReviver,
): void {
  revivers.set(kind, reviver);
}

export function taskExecutionReviverFor(kind: AgentTaskKind): TaskExecutionReviver | undefined {
  return revivers.get(kind);
}
