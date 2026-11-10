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
  readonly events?: readonly Event2Class<any, any>[];
}

export const EventStateContribution = collection<EventStateContributionRecord>('event-state');

export interface StateFoldRegistration {
  readonly key: ReplayableStateKey<any>;
  readonly fold: StateFold<any, any>;
}

export interface FoldedEventStateRegistry {
  readonly events: ReadonlyMap<string, Event2Class<any, any>>;
  readonly folds: ReadonlyMap<string, readonly StateFoldRegistration[]>;
  readonly states: readonly ReplayableStateKey<any>[];
}

export function foldEventStateContributions(
  records: readonly EventStateContributionRecord[],
  replayableKeys: readonly ReplayableStateKey<any>[],
): FoldedEventStateRegistry {
  const events = new Map<string, Event2Class<any, any>>();
  const folds = new Map<string, StateFoldRegistration[]>();
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
