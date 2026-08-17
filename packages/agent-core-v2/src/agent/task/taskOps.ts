/**
 * `task` domain — the `taskKey` state, the durable `task.started`
 * (`TaskStarted`) / `task.terminated` (`TaskTerminated`) events that record
 * the durable task-info registry, the live-only `task.terminated` notice
 * (`TaskTerminatedNotice`), and the transient observable `task.notified`
 * (`TaskNotified`) hook signal.
 *
 * The state is the replayable map of `taskId -> AgentTaskInfo` (initial empty)
 * that rebuilds the restored "ghost" tasks from the persisted `task.*` records
 * on dispatcher restore. Each fold sets one lifecycle entry into the map by
 * task id (a later `task.terminated` overwrites an earlier `task.started` for
 * the same id, so the final state is the last known info) — task records are
 * inherently events (never a no-op) — and carries no non-determinism. The
 * live `ManagedTask` (the running process, its `AbortController`, output
 * ring, timers) stays OUT of the state (live-only); the state is the restore
 * seed for `ghosts`, applied by the service's single
 * `dispatcher.hooks.onDidRestore` hook before disk load + reconcile. The
 * durable classes are the wire-protocol record vocabulary: their
 * `serialize()` output is the on-disk record (flat payload, epoch-ms `time`),
 * byte-compatible with the retired op encoding. Replay rebuilds the state as
 * the ghost seed, and a cold transcript fold can rebuild task entities
 * straight from the records. `task.terminated` additionally carries an
 * optional bounded `outputTail` snapshot of the task's retained output for
 * that fold; the tail is record-only and never enters the state or the bus —
 * `TaskStarted` merges op and bus fact (payloads are the same `{ info }`),
 * while `TaskTerminated` stays non-observable and its fold emits the
 * transient `TaskTerminatedNotice` (`{ info }`, the exact retired bus shape)
 * so the record-only `outputTail` never reaches subscribers.
 * `AgentTaskPersistence` (per-task JSON documents + output logs) stays the
 * full-fidelity registry and is reconciled on resume.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type { AgentTaskNotificationContext } from './task';
import type { AgentTaskInfo } from './types';

export type TaskModelState = Map<string, AgentTaskInfo>;

const taskStartedSchema = z.object({ info: z.custom<AgentTaskInfo>() });

export class TaskStarted extends Event2<z.infer<typeof taskStartedSchema>> {
  static override readonly type = 'task.started';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = taskStartedSchema;
}
export interface TaskStarted extends z.infer<typeof taskStartedSchema> {}

const taskTerminatedSchema = z.object({
  info: z.custom<AgentTaskInfo>(),
  outputTail: z.string().optional(),
});

export class TaskTerminated extends Event2<z.infer<typeof taskTerminatedSchema>> {
  static override readonly type = 'task.terminated';
  static override readonly durable = true;
  static override readonly schema = taskTerminatedSchema;
}
export interface TaskTerminated extends z.infer<typeof taskTerminatedSchema> {}

export interface TaskTerminatedNoticePayload {
  readonly info: AgentTaskInfo;
}

export class TaskTerminatedNotice extends Event2<TaskTerminatedNoticePayload> {
  static override readonly type = 'task.terminated';
  static override readonly observable = true;
}
export interface TaskTerminatedNotice extends TaskTerminatedNoticePayload {}

export class TaskNotified extends Event2<AgentTaskNotificationContext> {
  static override readonly type = 'task.notified';
  static override readonly observable = true;
}
export interface TaskNotified extends AgentTaskNotificationContext {}

export const taskKey = defineState('task', (): TaskModelState => new Map()).replayable({
  schema: z.custom<TaskModelState>(),
})
  .on(TaskStarted, (s, e) => {
    s.set(e.info.taskId, e.info);
  })
  .on(TaskTerminated, (s, e, ctx) => {
    s.set(e.info.taskId, e.info);
    if (e instanceof TaskTerminated) {
      ctx.emit(new TaskTerminatedNotice({ info: e.info }));
    }
  });
