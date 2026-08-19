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

export const TOWER_FLAG_ID = 'tower';

export interface IAgentTowerService {
  readonly _serviceBrand: undefined;

  /**
   * Effective tower-mode state: the persisted state gated by the tower
   * experimental flag — `false` while the flag is disabled even when the
   * persisted state says active, so projections never report a mode whose
   * feature is inert.
   */
  readonly isActive: boolean;
  enter(): void;
  exit(): void;
}

export const IAgentTowerService = createDecorator<IAgentTowerService>('agentTowerService');
