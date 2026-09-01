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

export const TOWER_FLAG_ID = 'tower';

export interface IAgentTowerService {
  readonly _serviceBrand: undefined;

  readonly isActive: boolean;
  readonly requestedBase: string | undefined;
  enter(base?: string): Promise<void>;
  exit(): void;
}

export const IAgentTowerService = createDecorator<IAgentTowerService>('agentTowerService');
