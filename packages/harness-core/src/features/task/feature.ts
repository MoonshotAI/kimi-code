import { createFeature, useAgent, type Feature } from '@moonshot-ai/agent-core/app/index';
import { extractText } from '@moonshot-ai/agent-core/llm/message';
import {
  createFacadeToken,
  shallowRef,
  useCleanup,
  useExpose,
  useFire,
  type RuntimeEvent,
  type ShallowRef,
} from '@moonshot-ai/agent-core/kernel/index';
import type { Agent } from '@moonshot-ai/agent-core/session/index';

import { useAgentTools, useLoopEvent } from '#/runtime/index';

import { describeToolArguments } from './format';
import {
  settleFromAsync,
  taskProjection,
  type TaskFoldState,
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
  readonly detach: (
    taskId: string,
  ) => Promise<{ readonly record: TaskRecord; readonly detached: boolean } | undefined>;
}

export const TaskRef = createFacadeToken<TaskFace>('task');

interface TaskTracker {
  readonly records: ShallowRef<TaskState>;
  folded: TaskState;
  readonly overlay: Map<string, TaskRecord>;
}

function merge(tracker: TaskTracker): TaskState {
  const merged = new Map(tracker.folded);
  for (const [taskId, record] of tracker.overlay) {
    const folded = tracker.folded.get(taskId);
    if (folded !== undefined && (folded.status !== 'running' || record.status === 'running')) {
      tracker.overlay.delete(taskId);
      continue;
    }
    merged.set(taskId, record);
  }
  return merged;
}

function adoptFold(tracker: TaskTracker, foldState: TaskFoldState): void {
  tracker.folded = foldState.records;
  tracker.records.value = merge(tracker);
}

function setOverlay(tracker: TaskTracker, record: TaskRecord): void {
  tracker.overlay.set(record.taskId, record);
  tracker.records.value = merge(tracker);
}

export function createTask(): Feature<void, TaskEvent> {
  const trackers = new WeakMap<Agent, TaskTracker>();
  return createFeature<TaskEvent>('task', {
    agent() {
      const agent = useAgent();
      const fire = useFire();
      let tracker = trackers.get(agent);
      if (tracker === undefined) {
        tracker = {
          records: shallowRef(new Map<string, TaskRecord>()) as ShallowRef<TaskState>,
          folded: new Map(),
          overlay: new Map(),
        };
        trackers.set(agent, tracker);
      }
      const current = tracker;

      const view = agent.log.replica.view(taskProjection);
      adoptFold(current, view.getState());
      const unsubscribe = view.subscribe((state) => {
        adoptFold(current, state);
      });
      useCleanup(() => {
        unsubscribe();
        view.dispose();
      });

      const isLiveDetached = (taskId: string): boolean =>
        agent.loop.state.tools.some((tool) => tool.detached && tool.toolCall.id === taskId);

      useLoopEvent('tool.ended', (event) => {
        if (!event.detached) return;
        const taskId = event.toolCallId;
        if (current.records.value.has(taskId)) return;
        const call = agent.loop.state.tools.find((tool) => tool.toolCall.id === taskId)?.toolCall;
        const record: TaskRecord = {
          taskId,
          toolName: call?.name ?? 'unknown',
          description: describeToolArguments(call?.arguments ?? null),
          detachText: extractText(event.outcome.entry.message),
          status: 'running',
          startedAt: Date.now(),
        };
        setOverlay(current, record);
        fire({ type: 'task.started', record });
      });

      useLoopEvent('tool.async_ended', (event) => {
        const existing = current.records.value.get(event.toolCallId);
        if (existing === undefined || existing.status !== 'running') return;
        const record: TaskRecord = {
          ...existing,
          ...settleFromAsync(event.outcome, event.entry),
          endedAt: Date.now(),
        };
        setOverlay(current, record);
        fire({ type: 'task.settled', record });
      });

      let disposed = false;
      useCleanup(() => {
        disposed = true;
      });
      void agent.flush().then(() => {
        if (disposed) return;
        const stale = [...current.records.value.values()].filter(
          (record) => record.status === 'running' && !isLiveDetached(record.taskId),
        );
        if (stale.length === 0) return;
        const endedAt = Date.now();
        for (const record of stale) {
          setOverlay(current, { ...record, status: 'lost', endedAt });
        }
      });

      const stop: TaskFace['stop'] = async (taskId, reason) => {
        const record = current.records.value.get(taskId);
        if (record === undefined || record.status !== 'running') return record;
        if (!isLiveDetached(taskId)) {
          const lost: TaskRecord = { ...record, status: 'lost', endedAt: Date.now() };
          setOverlay(current, lost);
          return lost;
        }
        agent.loop.abortTool(taskId, reason);
        const killed: TaskRecord = { ...record, status: 'killed', stopReason: reason, endedAt: Date.now() };
        setOverlay(current, killed);
        fire({ type: 'task.settled', record: killed });
        return killed;
      };

      const detach: TaskFace['detach'] = async (taskId) => {
        const record = current.records.value.get(taskId);
        if (record === undefined) return undefined;
        const detached = record.status === 'running' && !isLiveDetached(taskId);
        if (detached) agent.loop.detachTool(taskId);
        return { record, detached };
      };

      useAgentTools(
        createTaskListTool(current.records),
        createTaskOutputTool(current.records),
        createTaskStopTool(current.records, stop),
      );
      useExpose(TaskRef, { records: current.records, stop, detach });
    },
  });
}
