import type { Projection } from '@moonshot-ai/agent-core/store/index';

import type { FeatureEvent } from '#/runtime/index';

export const PLAN_MODE_ENTER = 'plan_mode.enter' as const;
export const PLAN_MODE_CANCEL = 'plan_mode.cancel' as const;
export const PLAN_MODE_EXIT = 'plan_mode.exit' as const;
export const PLAN_REVISION = 'plan.revision' as const;

export const PLAN_REMIND_KEY = 'plan-mode';

export interface PlanModeEnterEvent extends FeatureEvent {
  readonly type: typeof PLAN_MODE_ENTER;
  readonly id: string;
}

export interface PlanModeCancelEvent extends FeatureEvent {
  readonly type: typeof PLAN_MODE_CANCEL;
  readonly id?: string;
}

export interface PlanModeExitEvent extends FeatureEvent {
  readonly type: typeof PLAN_MODE_EXIT;
  readonly id?: string;
}

export interface PlanRevisionEvent extends FeatureEvent {
  readonly type: typeof PLAN_REVISION;
  readonly id: string;
  readonly version: number;
  readonly key: string;
  readonly sha256: string;
  readonly bytes: number;
}

export type PlanEvent = PlanModeEnterEvent | PlanModeCancelEvent | PlanModeExitEvent | PlanRevisionEvent;

export interface PlanState {
  readonly active: boolean;
  readonly id?: string;
  readonly revisionCount: Readonly<Record<string, number>>;
}

export const planProjection: Projection<PlanState, PlanEvent> = {
  initial: () => ({ active: false, revisionCount: {} }),
  reduce: (state, entry) => {
    const { event } = entry;
    if (event.type === PLAN_MODE_ENTER) {
      if (state.active && state.id === event.id) return state;
      return { ...state, active: true, id: event.id };
    }
    if (event.type === PLAN_MODE_CANCEL || event.type === PLAN_MODE_EXIT) {
      if (!state.active) return state;
      return { ...state, active: false, id: undefined };
    }
    if (event.type === PLAN_REVISION) {
      return { ...state, revisionCount: { ...state.revisionCount, [event.id]: event.version } };
    }
    return state;
  },
};
