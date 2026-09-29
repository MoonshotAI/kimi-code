import type { BranchRef, Projection, RecordEvent } from '@moonshot-ai/agent-core';

import type { CronTask } from './cronTask';

export const CRON_ADD = 'cron.add';
export const CRON_DELETE = 'cron.delete';
export const CRON_CURSOR = 'cron.cursor';

export type CronState = ReadonlyMap<string, CronTask>;

export const cronProjection: Projection<CronState, RecordEvent, BranchRef> = {
  initial: () => new Map(),
  reduce: (state, event) => {
    if (event.type === CRON_ADD) {
      const task = event['task'] as CronTask;
      return new Map([...state, [task.id, task]]);
    }
    if (event.type === CRON_DELETE) {
      const ids = new Set(event['ids'] as readonly string[]);
      return new Map([...state].filter(([id]) => !ids.has(id)));
    }
    if (event.type === CRON_CURSOR) {
      const id = event['id'] as string;
      const lastFiredAt = event['lastFiredAt'] as number;
      const task = state.get(id);
      if (task === undefined) return state;
      return new Map([...state, [id, { ...task, lastFiredAt }]]);
    }
    return state;
  },
};
