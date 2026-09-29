import {
  createFeature,
  extractText,
  useAgent,
  useAgentStore,
  useAgentTools,
  type FeatureSpec,
  type RecordEvent,
} from '@moonshot-ai/agent-core';
import {
  createToken,
  useExpose,
  useFire,
  type RuntimeEvent,
  type ShallowRef,
} from '@moonshot-ai/agent-core/kernel/index';

import { describeToolArguments } from './format';
import {
  TASK_DETACHED,
  TASK_LOST,
  TASK_TERMINATED,
  taskProjection,
  type TaskRecord,
  type TaskState,
} from './projection';
import { createTaskListTool } from './tools/task-list';
import { createTaskOutputTool } from './tools/task-output';
import { createTaskStopTool } from './tools/task-stop';

export interface TaskStartedEvent extends RuntimeEvent {
  readonly type: 'task.started';
  readonly record: TaskRecord;
}

export interface TaskSettledEvent extends RuntimeEvent {
  readonly type: 'task.settled';
  readonly record: TaskRecord;
}

export type TaskEvent = TaskStartedEvent | TaskSettledEvent;

export interface TaskFace {
  readonly records: ShallowRef<TaskState>;
  readonly stop: (taskId: string, reason: string) => Promise<TaskRecord | undefined>;
}

export const TaskRef = createToken<TaskFace>('task');

export function createTask(): FeatureSpec<TaskEvent> {
  return createFeature<TaskEvent>('task', {
    agent() {
      const agent = useAgent();
      const store = useAgentStore();
      const state = store.fold(taskProjection);
      const fire = useFire();
      const live = new Set<string>();
      let writes: Promise<unknown> = Promise.resolve();
      const write = (event: RecordEvent): Promise<unknown> => {
        const run = writes.then(() => store.dispatch(event)).catch(() => {});
        writes = run;
        return run;
      };
      const fireSettled = (taskId: string): void => {
        const record = state.value.get(taskId);
        if (record !== undefined) fire({ type: 'task.settled', record });
      };
      agent.on('tool.detached', (event) => {
        live.add(event.toolCallId);
        void write({
          type: TASK_DETACHED,
          taskId: event.toolCallId,
          toolName: event.toolCall.name,
          description: describeToolArguments(event.toolCall.arguments),
          detachText: event.text,
          startedAt: Date.now(),
        }).then(() => {
          const record = state.value.get(event.toolCallId);
          if (record !== undefined) fire({ type: 'task.started', record });
        });
      });
      agent.on('tool.done', (event) => {
        if (!live.delete(event.toolCallId)) return;
        const { outcome } = event;
        const message =
          outcome.type === 'failed'
            ? outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error)
            : outcome.type === 'aborted' && outcome.reason !== undefined
              ? outcome.reason instanceof Error
                ? outcome.reason.message
                : String(outcome.reason)
              : undefined;
        void write({
          type: TASK_TERMINATED,
          taskId: event.toolCallId,
          status: outcome.type === 'succeeded' ? 'completed' : outcome.type === 'failed' ? 'failed' : 'killed',
          stopReason: message,
          output: outcome.type === 'succeeded' ? extractText(outcome.result) : message,
          endedAt: Date.now(),
        }).then(() => {
          fireSettled(event.toolCallId);
        });
      });
      const stale = [...state.value.values()]
        .filter((record) => record.status === 'running')
        .map((record) => record.taskId);
      if (stale.length > 0) {
        void write({ type: TASK_LOST, taskIds: stale, endedAt: Date.now() });
      }
      const stop: TaskFace['stop'] = async (taskId, reason) => {
        await writes;
        const current = state.value.get(taskId);
        if (current === undefined || current.status !== 'running') return current;
        if (!live.has(taskId)) {
          await write({ type: TASK_LOST, taskIds: [taskId], endedAt: Date.now() });
          return state.value.get(taskId);
        }
        live.delete(taskId);
        agent.abortTool(taskId, reason);
        await write({
          type: TASK_TERMINATED,
          taskId,
          status: 'killed',
          stopReason: reason,
          endedAt: Date.now(),
        });
        const record = state.value.get(taskId);
        if (record !== undefined) fire({ type: 'task.settled', record });
        return record;
      };
      useAgentTools(
        createTaskListTool(state),
        createTaskOutputTool(state),
        createTaskStopTool(state, stop),
      );
      useExpose(TaskRef, { records: state, stop });
    },
  });
}
