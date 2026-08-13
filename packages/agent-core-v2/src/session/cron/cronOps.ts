/**
 * `cron` domain — the `cronKey` state, the transient `cron.add` (`CronAdd`)
 * / `cron.delete` (`CronDelete`) / `cron.cursor` (`CronCursor`) events for the
 * session-level scheduling engine, plus the transient observable `cron.fired`
 * (`CronFired`) edge event.
 *
 * The state is the live map of `taskId -> CronTask` (initial empty). The
 * cursor (`lastFiredAt`) lives on the task itself, so there is no separate
 * cursor map — `CronCursor` folds into the same map by updating the matching
 * task's `lastFiredAt`. The folds mutate the draft map in place (immer
 * MapSet), so a no-op (a `cron.delete` of absent ids, or a `cron.cursor` for
 * an unknown id) keeps the same reference and the state's reference-equality
 * stays quiet. The events are live-only (`durable: false`) because cron
 * records are not v1 wire types; the authoritative store is the App-scoped
 * `ICronTaskPersistence`, reloaded on resume.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { z } from 'zod';

import type { CronJobOrigin } from '#/agent/contextMemory/types';
import type { CronTask } from '#/app/cron/cronTask';
import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

export type CronModelState = Map<string, CronTask>;

export interface CronAddPayload {
  readonly task: CronTask;
}

export class CronAdd extends Event2<CronAddPayload> {
  static override readonly type = 'cron.add';
}
export interface CronAdd extends CronAddPayload {}

export interface CronDeletePayload {
  readonly ids: readonly string[];
}

export class CronDelete extends Event2<CronDeletePayload> {
  static override readonly type = 'cron.delete';
}
export interface CronDelete extends CronDeletePayload {}

export interface CronCursorPayload {
  readonly id: string;
  readonly lastFiredAt: number;
}

export class CronCursor extends Event2<CronCursorPayload> {
  static override readonly type = 'cron.cursor';
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
  durable: false,
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
