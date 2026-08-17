/**
 * `tower` domain — `TowerFeature`: multi-agent tower orchestration assembled
 * as one App-scope Feature unit.
 *
 * Contributes the App-scope `ITowerRateLimitService` (provider-concurrency
 * governor), the eleven `Tower*` agent tools, and the `tower-worker` agent
 * profile through the `features` base-class seams; retracting the unit
 * withdraws all of them across the scope tree. `TowerInit`/`TowerPlan`/
 * `TowerSpawn`/`TowerMerge`/`TowerTeardown` are gated to the main agent (the
 * tower itself); the rest serve workers and reviewers. The `tower` wire
 * vocabulary (`features/tower/towerOps`) and `IAgentTowerService` (the
 * tower-mode write guard must be live from agent-scope creation) stay on
 * their static import=register channels — wire records must remain
 * replayable even when the feature unit is retracted. Registered into the
 * feature table at import.
 */

import { ScopeActivation } from '#/_base/di/instantiation';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type {
  AgentToolCtor,
  AnyAgentTool,
} from '#/agent/toolRegistry/toolContribution';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

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

/** Tower-orchestration tools exist only on the main agent (the tower). */
const towerOnly = (accessor: ServicesAccessor): boolean =>
  accessor.get(IAgentScopeContext).agentId === 'main';

/**
 * The tower tool registration contract — name, implementation, and the
 * main-agent gate, as data so tests can assert the gating without assembling
 * the feature unit.
 */
interface TowerToolContribution {
  readonly id: ServiceIdentifier<AnyAgentTool>;
  readonly ctor: AgentToolCtor;
  readonly name: string;
  readonly when?: (accessor: ServicesAccessor) => boolean;
}

export const TOWER_TOOL_CONTRIBUTIONS: readonly TowerToolContribution[] = [
  { id: ITowerInitTool, ctor: TowerInitTool, name: 'TowerInit', when: towerOnly },
  { id: ITowerPlanTool, ctor: TowerPlanTool, name: 'TowerPlan', when: towerOnly },
  { id: ITowerSpawnTool, ctor: TowerSpawnTool, name: 'TowerSpawn', when: towerOnly },
  { id: ITowerMergeTool, ctor: TowerMergeTool, name: 'TowerMerge', when: towerOnly },
  { id: ITowerTeardownTool, ctor: TowerTeardownTool, name: 'TowerTeardown', when: towerOnly },
  { id: ITowerSendTool, ctor: TowerSendTool, name: 'TowerSend' },
  { id: ITowerInboxTool, ctor: TowerInboxTool, name: 'TowerInbox' },
  { id: ITowerFindingTool, ctor: TowerFindingTool, name: 'TowerFinding' },
  { id: ITowerReviewTool, ctor: TowerReviewTool, name: 'TowerReview' },
  { id: ITowerMissionTool, ctor: TowerMissionTool, name: 'TowerMission' },
  { id: ITowerStatusTool, ctor: TowerStatusTool, name: 'TowerStatus' },
];

export class TowerFeature extends Feature {
  static override readonly name = 'tower';

  constructor() {
    super();
    this.contributeService(LifecycleScope.App, ITowerRateLimitService, TowerRateLimitService, {
      activation: ScopeActivation.OnDemand,
    });
    for (const tool of TOWER_TOOL_CONTRIBUTIONS) {
      this.contributeTool(tool.id, tool.ctor, {
        name: tool.name,
        domain: 'tower',
        when: tool.when,
      });
    }
    this.contributeProfiles([TOWER_WORKER_PROFILE_DEF]);
  }
}

registerFeature(TowerFeature);
