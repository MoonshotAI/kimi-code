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
 * quiet. The Ops are live-only because cron records are not v1 wire types; the
 * authoritative store is the App-scoped `ICronTaskPersistence`, reloaded on
 * resume. Consumed cross-scope by the Session-scope `SessionCronService`,
 * which dispatches to the MAIN agent's wire. The Ops register into the global
 * `OP_REGISTRY` at import time.
 */

import type { CronJobOrigin } from '@moonshot-ai/protocol';
import { z } from 'zod';

import { defineModel } from '#/wire/model';

import type { CronTask } from '#/app/cron/cronTask';

export type CronModelState = Map<string, CronTask>;

export const CronModel = defineModel<CronModelState>('cron', () => new Map());

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'cron.fired': { readonly origin: CronJobOrigin; readonly prompt: string };
  }
}

declare module '#/wire/types' {
  interface TransientOpMap {
    'cron.add': typeof cronAdd;
    'cron.delete': typeof cronDelete;
    'cron.cursor': typeof cronCursor;
  }
}

export const cronAdd = CronModel.defineOp('cron.add', {
  schema: z.object({ task: z.custom<CronTask>() }),
  persist: false,
  apply: (s, p) => {
    const next = new Map(s);
    next.set(p.task.id, p.task);
    return next;
  },
});

export const cronDelete = CronModel.defineOp('cron.delete', {
  schema: z.object({ ids: z.array(z.string()).readonly() }),
  persist: false,
  apply: (s, p) => {
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

export const cronCursor = CronModel.defineOp('cron.cursor', {
  schema: z.object({ id: z.string(), lastFiredAt: z.number() }),
  persist: false,
  apply: (s, p) => {
    const task = s.get(p.id);
    if (task === undefined) return s;
    const next = new Map(s);
    next.set(p.id, { ...task, lastFiredAt: p.lastFiredAt });
    return next;
  },
});
