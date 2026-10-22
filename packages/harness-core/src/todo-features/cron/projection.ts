import type { Projection } from '@moonshot-ai/agent-core/store/index';

import type { FeatureEvent } from '#/runtime/index';

import type { CronTask } from './cronTask';

export const CRON_ADD = 'cron.add' as const;
export const CRON_DELETE = 'cron.delete' as const;
export const CRON_CURSOR = 'cron.cursor' as const;

export interface CronAddedEvent extends FeatureEvent {
  readonly type: typeof CRON_ADD;
  readonly task: CronTask;
}

export interface CronDeletedEvent extends FeatureEvent {
  readonly type: typeof CRON_DELETE;
  readonly ids: readonly string[];
}

export interface CronCursorEvent extends FeatureEvent {
  readonly type: typeof CRON_CURSOR;
  readonly id: string;
  readonly lastFiredAt: number;
}

export type CronEvent = CronAddedEvent | CronDeletedEvent | CronCursorEvent;

export type CronState = ReadonlyMap<string, CronTask>;

export const cronProjection: Projection<CronState, CronEvent> = {
  initial: () => new Map(),
  reduce: (state, entry) => {
    const { event } = entry;
    if (event.type === CRON_ADD) {
      return new Map([...state, [event.task.id, event.task]]);
    }
    if (event.type === CRON_DELETE) {
      const ids = new Set(event.ids);
      return new Map([...state].filter(([id]) => !ids.has(id)));
    }
    if (event.type === CRON_CURSOR) {
      const task = state.get(event.id);
      if (task === undefined) return state;
      return new Map([...state, [event.id, { ...task, lastFiredAt: event.lastFiredAt }]]);
    }
    return state;
  },
};
