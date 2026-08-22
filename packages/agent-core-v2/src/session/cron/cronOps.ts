/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import type { CronJobOrigin } from '#/agent/contextMemory/types';
import type { CronTask } from '#/app/cron/cronTask';
import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

export type CronModelState = Map<string, CronTask>;

const cronTaskSchema = z.object({
  id: z.string(),
  cron: z.string(),
  prompt: z.string(),
  createdAt: z.number(),
  recurring: z.boolean().optional(),
  lastFiredAt: z.number().optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

const cronAddSchema = z.object({ task: cronTaskSchema });
const cronDeleteSchema = z.object({ ids: z.array(z.string()) });
const cronCursorSchema = z.object({ id: z.string(), lastFiredAt: z.number() });

export interface CronAddPayload {
  readonly task: CronTask;
}

export class CronAdd extends Event2<CronAddPayload> {
  static override readonly type = 'cron.add';
  static override readonly durable = true;
  static override readonly schema = cronAddSchema;
}
export interface CronAdd extends CronAddPayload {}

export interface CronDeletePayload {
  readonly ids: readonly string[];
}

export class CronDelete extends Event2<CronDeletePayload> {
  static override readonly type = 'cron.delete';
  static override readonly durable = true;
  static override readonly schema = cronDeleteSchema;
}
export interface CronDelete extends CronDeletePayload {}

export interface CronCursorPayload {
  readonly id: string;
  readonly lastFiredAt: number;
}

export class CronCursor extends Event2<CronCursorPayload> {
  static override readonly type = 'cron.cursor';
  static override readonly durable = true;
  static override readonly schema = cronCursorSchema;
}
export interface CronCursor extends CronCursorPayload {}

export interface CronFiredPayload {
  readonly origin: CronJobOrigin;
  readonly prompt: string;
}

export class CronFired extends Event2<CronFiredPayload> {
  static override readonly type = 'cron.fired';
  static override readonly observable = true;
}
export interface CronFired extends CronFiredPayload {}

export const cronKey = defineState('cron', (): CronModelState => new Map()).replayable({
  schema: z.custom<CronModelState>(),
})
  .on(CronAdd, (s, e) => {
    s.set(e.task.id, e.task);
  })
  .on(CronDelete, (s, e) => {
    for (const id of e.ids) {
      s.delete(id);
    }
  })
  .on(CronCursor, (s, e) => {
    const task = s.get(e.id);
    if (task === undefined) return;
    s.set(e.id, { ...task, lastFiredAt: e.lastFiredAt });
  });
