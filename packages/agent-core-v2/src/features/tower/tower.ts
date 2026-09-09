import { createDecorator } from "#/_base/di/instantiation";

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

export const TOWER_WORKER_PROFILE = 'tower-worker';

export function hasPinnedPermissionMode(profileName: string | undefined): boolean {
  return profileName === TOWER_WORKER_PROFILE;
}

export const TOWER_FLAG_ID = 'tower';

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

export interface IAgentTowerService {
  readonly _serviceBrand: undefined;

  readonly isActive: boolean;
  readonly requestedBase: string | undefined;
  enter(base?: string): Promise<TowerEnterResult>;
  exit(): void;
}

export const IAgentTowerService = createDecorator<IAgentTowerService>('agentTowerService');
