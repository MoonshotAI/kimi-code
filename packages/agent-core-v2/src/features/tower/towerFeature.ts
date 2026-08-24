import { ScopeActivation } from '#/_base/di/instantiation';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import type {
  AgentToolCtor,
  AnyAgentTool,
} from '#/agent/toolRegistry/toolContribution';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { TOWER_FLAG_ID } from './tower';
import { ITowerRateLimitService } from './towerRateLimit';
import { TowerRateLimitService } from './towerRateLimitService';
import { ITowerFindingTool } from './tools/finding/finding';
import { TowerFindingTool } from './tools/finding/findingTool';
import { ITowerInboxTool } from './tools/inbox/inbox';
import { TowerInboxTool } from './tools/inbox/inboxTool';
import { ITowerInitTool } from './tools/init/init';
import { TowerInitTool } from './tools/init/initTool';
import { ITowerMergeTool } from './tools/merge/merge';
import { TowerMergeTool } from './tools/merge/mergeTool';
import { ITowerMissionTool } from './tools/mission/mission';
import { TowerMissionTool } from './tools/mission/missionTool';
import { ITowerPlanTool } from './tools/plan/plan';
import { TowerPlanTool } from './tools/plan/planTool';
import { ITowerReviewTool } from './tools/review/review';
import { TowerReviewTool } from './tools/review/reviewTool';
import { ITowerSendTool } from './tools/send/send';
import { TowerSendTool } from './tools/send/sendTool';
import { ITowerSpawnTool } from './tools/spawn/spawn';
import { TowerSpawnTool } from './tools/spawn/spawnTool';
import { ITowerStatusTool } from './tools/status/status';
import { TowerStatusTool } from './tools/status/statusTool';
import { ITowerTeardownTool } from './tools/teardown/teardown';
import { TowerTeardownTool } from './tools/teardown/teardownTool';
import { TOWER_WORKER_PROFILE_DEF } from './workerProfile';

interface TowerToolContribution {
  readonly id: ServiceIdentifier<AnyAgentTool>;
  readonly ctor: AgentToolCtor;
  readonly name: string;
}

export const TOWER_TOOL_CONTRIBUTIONS: readonly TowerToolContribution[] = [
  { id: ITowerInitTool, ctor: TowerInitTool, name: 'TowerInit' },
  { id: ITowerPlanTool, ctor: TowerPlanTool, name: 'TowerPlan' },
  { id: ITowerSpawnTool, ctor: TowerSpawnTool, name: 'TowerSpawn' },
  { id: ITowerMergeTool, ctor: TowerMergeTool, name: 'TowerMerge' },
  { id: ITowerTeardownTool, ctor: TowerTeardownTool, name: 'TowerTeardown' },
  { id: ITowerSendTool, ctor: TowerSendTool, name: 'TowerSend' },
  { id: ITowerInboxTool, ctor: TowerInboxTool, name: 'TowerInbox' },
  { id: ITowerFindingTool, ctor: TowerFindingTool, name: 'TowerFinding' },
  { id: ITowerReviewTool, ctor: TowerReviewTool, name: 'TowerReview' },
  { id: ITowerMissionTool, ctor: TowerMissionTool, name: 'TowerMission' },
  { id: ITowerStatusTool, ctor: TowerStatusTool, name: 'TowerStatus' },
];

export class TowerFeature extends Feature {
  static override readonly name = 'tower';

  constructor(@IFlagService flags: IFlagService) {
    super();
    if (!flags.enabled(TOWER_FLAG_ID)) return;
    assembledFlagServices.add(flags);
    this.onDispose(() => {
      assembledFlagServices.delete(flags);
    });
    this.contributeService(LifecycleScope.App, ITowerRateLimitService, TowerRateLimitService, {
      activation: ScopeActivation.OnDemand,
    });
    for (const tool of TOWER_TOOL_CONTRIBUTIONS) {
      this.contributeTool(tool.id, tool.ctor, {
        name: tool.name,
        domain: 'tower',
      });
    }
    this.contributeProfiles([TOWER_WORKER_PROFILE_DEF]);
  }
}

const assembledFlagServices = new WeakSet<IFlagService>();
let assembledOverrideForTests: boolean | undefined;

/**
 * Whether the App scope owning `flags` ran its tower feature assembly with
 * the flag on. A live `/experiments` flip does not re-assemble features, so
 * until a restart the tower tools/profile do not exist and the mode
 * machinery must stay inert. Keyed per App scope (via its flag service) so
 * coexisting Apps in one process do not leak assembly state into each other.
 */
export function isTowerFeatureAssembled(flags: IFlagService): boolean {
  return assembledOverrideForTests ?? assembledFlagServices.has(flags);
}

export function _setTowerFeatureAssembledForTests(value: boolean | undefined): void {
  assembledOverrideForTests = value;
}

registerFeature(TowerFeature);
