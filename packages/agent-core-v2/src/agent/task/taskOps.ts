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
