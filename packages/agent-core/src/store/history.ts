import type { Entry, Event, Projection } from './store';
import { replay } from './store';

export type HistorySelector<E extends Event, C> = (entries: readonly Entry<E, C>[]) => readonly Entry<E, C>[];

export function withHistory<S, E extends Event, C>(
  projection: Projection<S, E, C>,
  select: HistorySelector<E, C>,
): Projection<S, E, C> {
  return {
    initial: () => projection.initial(),
    reduce: (state, event, cursor) => projection.reduce(state, event, cursor),
    restore: (entries) => replay(projection, select(entries)),
  };
}
