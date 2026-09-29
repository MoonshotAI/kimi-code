import {
  extractText,
  systemReminderText,
  type BranchRef,
  type HistoryMessage,
  type Projection,
  type RecordEvent,
} from '@moonshot-ai/agent-core';

import PLAN_MODE_EXIT_REMINDER from './injection/plan-mode-exit-reminder.md?raw';

export const PLAN_MODE_ENTER = 'plan_mode.enter';
export const PLAN_MODE_CANCEL = 'plan_mode.cancel';
export const PLAN_MODE_EXIT = 'plan_mode.exit';
export const PLAN_REVISION = 'plan.revision';

export const PLAN_REMIND_KEY = 'plan-mode';

const EXIT_REMINDER_TEXT = systemReminderText(PLAN_MODE_EXIT_REMINDER);

export interface PlanState {
  readonly active: boolean;
  readonly id?: string;
  readonly revisionCount: Readonly<Record<string, number>>;
  readonly wasActive: boolean;
}

export const planProjection: Projection<PlanState, RecordEvent, BranchRef> = {
  initial: () => ({ active: false, revisionCount: {}, wasActive: false }),
  reduce: (state, event) => {
    if (event.type === PLAN_MODE_ENTER) {
      const id = event['id'] as string;
      if (state.active && state.id === id) return state;
      return { ...state, active: true, id };
    }
    if (event.type === PLAN_MODE_CANCEL || event.type === PLAN_MODE_EXIT) {
      if (!state.active) return state;
      return { ...state, active: false, id: undefined };
    }
    if (event.type === PLAN_REVISION) {
      const id = event['id'] as string;
      const version = event['version'] as number;
      return { ...state, revisionCount: { ...state.revisionCount, [id]: version } };
    }
    if (event.type === 'message.appended') {
      const entry = event['message'] as HistoryMessage;
      if (entry.meta?.source !== 'reminder' || entry.meta?.key !== PLAN_REMIND_KEY) return state;
      const wasActive = extractText(entry.message) !== EXIT_REMINDER_TEXT;
      return state.wasActive === wasActive ? state : { ...state, wasActive };
    }
    return state;
  },
};
