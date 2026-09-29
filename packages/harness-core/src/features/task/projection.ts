import type { BranchRef, Projection, RecordEvent } from '@moonshot-ai/agent-core';

export const TASK_DETACHED = 'task.detached';
export const TASK_TERMINATED = 'task.terminated';
export const TASK_LOST = 'task.lost';

export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed' | 'lost';

export interface TaskRecord {
  readonly taskId: string;
  readonly toolName: string;
  readonly description?: string;
  readonly detachText?: string;
  readonly status: TaskStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly stopReason?: string;
  readonly output?: string;
}

export type TaskState = ReadonlyMap<string, TaskRecord>;

export const taskProjection: Projection<TaskState, RecordEvent, BranchRef> = {
  initial: () => new Map(),
  reduce: (state, event) => {
    if (event.type === TASK_DETACHED) {
      const taskId = event['taskId'] as string;
      if (state.has(taskId)) return state;
      const record: TaskRecord = {
        taskId,
        toolName: event['toolName'] as string,
        description: event['description'] as string | undefined,
        detachText: event['detachText'] as string | undefined,
        status: 'running',
        startedAt: event['startedAt'] as number,
      };
      return new Map([...state, [taskId, record]]);
    }
    if (event.type === TASK_TERMINATED) {
      const taskId = event['taskId'] as string;
      const record = state.get(taskId);
      if (record === undefined || record.status !== 'running') return state;
      const next: TaskRecord = {
        ...record,
        status: event['status'] as TaskStatus,
        endedAt: event['endedAt'] as number,
        stopReason: event['stopReason'] as string | undefined,
        output: event['output'] as string | undefined,
      };
      return new Map([...state, [taskId, next]]);
    }
    if (event.type === TASK_LOST) {
      const taskIds = event['taskIds'] as readonly string[];
      const endedAt = event['endedAt'] as number;
      let next: Map<string, TaskRecord> | undefined;
      for (const taskId of taskIds) {
        const record = (next ?? state).get(taskId);
        if (record === undefined || record.status !== 'running') continue;
        next = new Map(next ?? state);
        next.set(taskId, { ...record, status: 'lost', endedAt });
      }
      return next ?? state;
    }
    return state;
  },
};
