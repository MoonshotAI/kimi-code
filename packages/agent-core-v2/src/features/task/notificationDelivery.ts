import { z } from 'zod';

import { ContextAppendMessage } from '#/features/contextMemory/contextEvents';
import '#/features/contextMemory/conversationTime';
import { defineState } from '#/state/state';

import { TaskWaitDelivered } from './taskOps';

export interface TaskNotificationOrigin {
  readonly taskId: string;
  readonly status: string;
  readonly notificationId: string;
}

export const taskNotificationDeliveryKey = defineState(
  'task.notificationDelivery',
  (): readonly string[] => [],
)
  .replayable({ schema: z.custom<readonly string[]>() })
  .undoable()
  .on(ContextAppendMessage, (s, e) => {
    const origin = taskOriginFromMessage(e.message);
    if (origin === undefined) return;
    const key = notificationKey(origin);
    if (!s.includes(key)) {
      s.push(key);
    }
  })
  .on(TaskWaitDelivered, (s, e) => {
    for (const key of e.keys) {
      if (!s.includes(key)) {
        s.push(key);
      }
    }
  });

export function isTaskOrigin(origin: unknown): origin is TaskNotificationOrigin {
  if (typeof origin !== 'object' || origin === null) return false;
  const value = origin as Record<string, unknown>;
  return (
    (value['kind'] === 'background_task' || value['kind'] === 'task') &&
    typeof value['taskId'] === 'string' &&
    typeof value['status'] === 'string' &&
    typeof value['notificationId'] === 'string'
  );
}

export function taskNotificationId(taskId: string, status: string): string {
  return `task:${taskId}:${status}`;
}

export function notificationKey(origin: TaskNotificationOrigin): string {
  return `${origin.taskId}\0${origin.status}\0${origin.notificationId}`;
}

export function taskOriginFromMessage(message: unknown): TaskNotificationOrigin | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const origin = (message as { readonly origin?: unknown }).origin;
  return isTaskOrigin(origin) ? origin : undefined;
}
