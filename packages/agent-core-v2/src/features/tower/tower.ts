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

/**
 * Profile name of tower-spawned worker/reviewer agents. TowerSpawn pins these
 * agents to the `auto` permission mode at spawn (they run detached and
 * unattended), and `broadcastPermissionMode` skips them, so a session-wide
 * mode switch never moves them off `auto`.
 */
export const TOWER_WORKER_PROFILE = 'tower-worker';

export interface IAgentTowerService {
  readonly _serviceBrand: undefined;

  readonly isActive: boolean;
  enter(): void;
  exit(): void;
}

export const IAgentTowerService = createDecorator<IAgentTowerService>('agentTowerService');
