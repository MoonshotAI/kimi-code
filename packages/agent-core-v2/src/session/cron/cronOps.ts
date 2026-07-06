/**
 * `cron` domain (L5) — wire Model (`CronModel`) and the `cron.add`
 * (`cronAdd`) / `cron.delete` (`cronDelete`) / `cron.cursor` (`cronCursor`)
 * Ops for the session-level scheduling engine, plus the `cron.fired` edge
 * event declared on `DomainEventMap`.
 *
 * The Model is the replayable map of `taskId -> CronTask` (initial empty). The
 * cursor (`lastFiredAt`) lives on the task itself, so there is no separate
 * cursor map — `cron.cursor` folds into the same map by updating the matching
 * task's `lastFiredAt`. Each `apply` returns a new `Map` on a real change and
 * the same reference on a no-op (a `cron.delete` of absent ids, or a
 * `cron.cursor` for an unknown id) so the wire's reference-equality gate stays
 * quiet. The Op types (`cron.add` / `cron.delete` / `cron.cursor`) match the
 * legacy record types, so `wire.replay` rebuilds the Model from the existing
 * shared append log. The cron engine's authoritative store remains the
 * App-scoped `ICronTaskPersistence`; the wire Model is the replay seed copied
 * back into the in-memory task map by the service's `wire.onRestored` handler
 * before the store load + timer start. Consumed cross-scope by the
 * Session-scope `SessionCronService`, which dispatches to the MAIN agent's
 * wire. The Ops register into the global `OP_REGISTRY` at import time.
 */

import type { CronJobOrigin } from '@moonshot-ai/protocol';

import { defineModel, defineOp } from '#/wire';

import type { CronTask } from '#/app/cron';

export type CronModelState = Map<string, CronTask>;

export const CronModel = defineModel<CronModelState>('cron', () => new Map());

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'cron.fired': { readonly origin: CronJobOrigin; readonly prompt: string };
  }
}

export interface CronAddPayload {
  readonly task: CronTask;
}

export const cronAdd = defineOp(CronModel, 'cron.add', {
  apply: (s, p: CronAddPayload): CronModelState => {
    const next = new Map(s);
    next.set(p.task.id, p.task);
    return next;
  },
});

export interface CronDeletePayload {
  readonly ids: readonly string[];
}

export const cronDelete = defineOp(CronModel, 'cron.delete', {
  apply: (s, p: CronDeletePayload): CronModelState => {
    let next: Map<string, CronTask> | undefined;
    for (const id of p.ids) {
      if (s.has(id)) {
        next = next ?? new Map(s);
        next.delete(id);
      }
    }
    return next ?? s;
  },
});

export interface CronCursorPayload {
  readonly id: string;
  readonly lastFiredAt: number;
}

export const cronCursor = defineOp(CronModel, 'cron.cursor', {
  apply: (s, p: CronCursorPayload): CronModelState => {
    const task = s.get(p.id);
    if (task === undefined) return s;
    const next = new Map(s);
    next.set(p.id, { ...task, lastFiredAt: p.lastFiredAt });
    return next;
  },
});
