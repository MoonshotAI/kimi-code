/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type { AgentTaskNotificationContext } from './task';
import type { AgentTaskInfo } from './types';

export type TaskModelState = Map<string, AgentTaskInfo>;

const taskStartedSchema = z.object({
  agentId: z.string(),
  info: z.custom<AgentTaskInfo>(),
});

export class TaskStarted extends AgentEvent2<z.infer<typeof taskStartedSchema>> {
  static override readonly type = 'task.started';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = taskStartedSchema;
}
export interface TaskStarted {
  readonly agentId: string;
  readonly info: AgentTaskInfo;
}

const taskTerminatedSchema = z.object({
  agentId: z.string(),
  info: z.custom<AgentTaskInfo>(),
  outputTail: z.string().optional(),
});

export class TaskTerminated extends AgentEvent2<z.infer<typeof taskTerminatedSchema>> {
  static override readonly type = 'task.terminated';
  static override readonly durable = true;
  static override readonly schema = taskTerminatedSchema;
}
export interface TaskTerminated {
  readonly agentId: string;
  readonly info: AgentTaskInfo;
  readonly outputTail?: string;
}

export interface TaskTerminatedNoticePayload {
  readonly agentId: string;
  readonly info: AgentTaskInfo;
}

export class TaskTerminatedNotice extends AgentEvent2<TaskTerminatedNoticePayload> {
  static override readonly type = 'task.terminated';
  static override readonly observable = true;
}
export interface TaskTerminatedNotice extends TaskTerminatedNoticePayload {}

export class TaskNotified extends AgentEvent2<AgentTaskNotificationContext> {
  static override readonly type = 'task.notified';
  static override readonly observable = true;
}
export interface TaskNotified extends AgentTaskNotificationContext {}

const taskWaitDeliveredSchema = z.object({
  agentId: z.string(),
  keys: z.array(z.string()),
});

export class TaskWaitDelivered extends AgentEvent2<z.infer<typeof taskWaitDeliveredSchema>> {
  static override readonly type = 'task.waitDelivered';
  static override readonly durable = true;
  static override readonly schema = taskWaitDeliveredSchema;
}
export interface TaskWaitDelivered {
  readonly agentId: string;
  readonly keys: string[];
}

export const taskKey = defineState('task', (): TaskModelState => new Map()).replayable({
  schema: z.custom<TaskModelState>(),
})
  .on(TaskStarted, (s, e) => {
    s.set(e.info.taskId, e.info);
  })
  .on(TaskTerminated, (s, e, ctx) => {
    s.set(e.info.taskId, e.info);
    if (e instanceof TaskTerminated) {
      ctx.emit(new TaskTerminatedNotice({ agentId: e.agentId, info: e.info }));
    }
  });
