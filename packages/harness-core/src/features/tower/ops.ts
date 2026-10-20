import type { Projection } from '@moonshot-ai/agent-core/store/index';

import type { FeatureEvent } from '#/runtime/index';

export const TOWER_MODE_ENTER = 'tower_mode.enter' as const;
export const TOWER_MODE_EXIT = 'tower_mode.exit' as const;

export const TOWER_REMIND_KEY = 'tower-mode';

export const TOWER_TOOL_NAMES = [
  'TowerPlan',
  'TowerSpawn',
  'TowerMerge',
  'TowerTeardown',
  'TowerSend',
  'TowerInbox',
  'TowerFinding',
  'TowerReview',
  'TowerMission',
  'TowerStatus',
] as const;

export const TOWER_MODE_TOOLS: readonly string[] = ['TowerInit', ...TOWER_TOOL_NAMES];

export const TOWER_WORKER_PROFILE = 'tower-worker';

export const TOWER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_TOWER';

export interface TowerModeEnterEvent extends FeatureEvent {
  readonly type: typeof TOWER_MODE_ENTER;
  readonly sessionId?: string;
  readonly base?: string;
}

export interface TowerModeExitEvent extends FeatureEvent {
  readonly type: typeof TOWER_MODE_EXIT;
}

export type TowerModeEvent = TowerModeEnterEvent | TowerModeExitEvent;

export interface TowerModeState {
  readonly active: boolean;
  readonly owner?: string;
  readonly base?: string;
}

export const towerModeProjection: Projection<TowerModeState, TowerModeEvent> = {
  initial: () => ({ active: false }),
  reduce: (state, { event }) => {
    if (event.type === TOWER_MODE_ENTER) {
      return {
        active: true,
        owner: event.sessionId,
        base: event.base,
      };
    }
    if (event.type === TOWER_MODE_EXIT) {
      return { active: false };
    }
    return state;
  },
};

export type TowerEnterFailure =
  | {
      readonly entered: false;
      readonly reason: 'not-main-agent' | 'experiment-off' | 'feature-not-assembled';
    }
  | {
      readonly entered: false;
      readonly reason: 'owned-by-live-session';
      readonly owner: string;
      readonly ownerTitle?: string;
    };

export type TowerEnterResult = { readonly entered: true } | TowerEnterFailure;

export function towerEnterFailureMessage(failure: TowerEnterFailure): string {
  switch (failure.reason) {
    case 'not-main-agent':
      return 'tower mode is only supported by the main agent';
    case 'experiment-off':
      return 'the tower experiment is disabled; enable it with KIMI_CODE_EXPERIMENTAL_TOWER=1 or `[experimental] tower = true` in config.toml';
    case 'feature-not-assembled':
      return 'the tower feature is not assembled in this process; a restart is required';
    case 'owned-by-live-session': {
      const owner =
        failure.ownerTitle === undefined
          ? failure.owner
          : `${failure.ownerTitle} (${failure.owner})`;
      return `another live session owns the workspace tower (session ${owner})`;
    }
  }
}
