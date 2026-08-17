/**
 * `state` domain — the `EventStateContribution` collection token, its
 * per-domain record shape, and the fold that collapses the built-in layer
 * plus live contribution records into the lookup tables the event dispatcher
 * consults.
 *
 * A unit contributes event vocabulary per domain with
 * `this.provide(EventStateContribution, …)`: `events` (extra durable `Event2`
 * classes without folds). Replayable state keys come from the built-in layer
 * only — the module-level `REPLAYABLE_STATE_KEYS` table filled by
 * `defineState(...).replayable(...)` at import time ("import = register");
 * each key carries its own folds, expanded through the undoable protocol at
 * fold time. The fold lives in the dispatcher (Agent scope): it refolds from
 * the built-in layer and the view's surviving records on every `onDidChange`
 * — the collection edge enters the dependency graph for introspection but
 * never rebuilds the service. A withdrawn record removes its vocabulary, so
 * replaying that domain's historical records lands on the generic
 * unknown-type path (skip + count): persisted facts stay readable when the
 * contributing unit is long gone.
 *
 * The built-in layer is drained at fold time: every table is filled at module
 * load — long before any scope constructs the dispatcher — and no event
 * module is ever imported lazily, so draining at fold time is equivalent to
 * the old live reads.
 *
 * Conflict semantics: durable event classes keep their module-load fail-fast
 * (`DuplicateEventError`). The fold is an event path and never throws — a
 * later record whose event type collides with an already-folded type is
 * skipped and reported through `onUnexpectedError`, and the built-in layer
 * always folds first so built-ins win every collision. Scope-agnostic.
 */

import { collection } from '#/_base/di/collection';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { EventError, EventErrors } from '#/app/event/errors';
import { EVENT2_REGISTRY, type Event2Class } from '#/app/event/event2';

import {
  expandedStateFolds,
  type ReplayableStateKey,
  type StateFold,
} from './state';

export interface EventStateContributionRecord {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly events?: readonly Event2Class<any, any>[];
}

export const EventStateContribution = collection<EventStateContributionRecord>('event-state');

export interface StateFoldRegistration {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly key: ReplayableStateKey<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly fold: StateFold<any, any>;
}

export interface FoldedEventStateRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly events: ReadonlyMap<string, Event2Class<any, any>>;
  readonly folds: ReadonlyMap<string, readonly StateFoldRegistration[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly states: readonly ReplayableStateKey<any>[];
}

export function foldEventStateContributions(
  records: readonly EventStateContributionRecord[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  replayableKeys: readonly ReplayableStateKey<any>[],
): FoldedEventStateRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events = new Map<string, Event2Class<any, any>>();
  const folds = new Map<string, StateFoldRegistration[]>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const states: ReplayableStateKey<any>[] = [];
  const foldBuiltinLayer = (): void => {
    for (const cls of EVENT2_REGISTRY.values()) {
      events.set(cls.type, cls);
    }
    for (const key of replayableKeys) {
      states.push(key);
      for (const [cls, fold] of expandedStateFolds(key)) {
        let list = folds.get(cls.type);
        if (list === undefined) {
          list = [];
          folds.set(cls.type, list);
        }
        list.push({ key, fold });
        if (cls.durable && !events.has(cls.type)) {
          events.set(cls.type, cls);
        }
      }
    }
  };
  foldBuiltinLayer();
  for (const record of records) {
    for (const cls of record.events ?? []) {
      if (events.has(cls.type)) {
        onUnexpectedError(
          new EventError(
            EventErrors.codes.EVENT_DUPLICATE_EVENT,
            `Duplicate event type contributed: '${cls.type}'; keeping the already-folded registration`,
            { details: { type: cls.type } },
          ),
        );
        continue;
      }
      events.set(cls.type, cls);
    }
  }
  return { events, folds, states };
}
