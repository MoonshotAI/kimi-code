import { ScopeActivation } from '#/_base/di/instantiation';
import type {
  AgentToolFactoryContext,
  AnyAgentTool,
} from '#/agent/toolRegistry/toolContribution';
import { IAgentHostService } from '#/agent/host/agentHost';
import { AgentTask } from '#/actor/task/taskAgentRuntime';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionPermissionModeService } from '#/session/permissionMode/sessionPermissionMode';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { ISessionSubagentService } from '#/session/subagent/subagent';

import { TOWER_FLAG_ID } from './tower';
import { ITowerRateLimitService } from './towerRateLimit';
import { TowerRateLimitService } from './towerRateLimitService';
import { ISessionTowerService } from './sessionTowerService';
import {
  markTowerFeatureAssembled,
  unmarkTowerFeatureAssembled,
} from './towerAssembly';
import { TowerFindingTool } from './tools/finding/findingTool';
import { TowerInboxTool } from './tools/inbox/inboxTool';
import { TowerInitTool } from './tools/init/initTool';
import { TowerMergeTool } from './tools/merge/mergeTool';
import { TowerMissionTool } from './tools/mission/missionTool';
import { TowerPlanTool } from './tools/plan/planTool';
import { TowerReviewTool } from './tools/review/reviewTool';
import { TowerSendTool } from './tools/send/sendTool';
import { TowerSpawnTool } from './tools/spawn/spawnTool';
import { TowerStatusTool } from './tools/status/statusTool';
import { TowerTeardownTool } from './tools/teardown/teardownTool';
import { TOWER_WORKER_PROFILE_DEF } from './workerProfile';

interface TowerToolContribution {
  readonly name: string;
  readonly create: (ctx: AgentToolFactoryContext) => AnyAgentTool;
}

export const TOWER_TOOL_CONTRIBUTIONS: readonly TowerToolContribution[] = [
  {
    name: 'TowerInit',
    create: (ctx) =>
      new TowerInitTool(
        ctx.get(ISessionContext),
        ctx.get(ISessionTowerService).of(ctx.agent),
        ctx.get(ISessionManager),
        ctx.host.scopeContext,
      ),
  },
  {
    name: 'TowerPlan',
    create: (ctx) =>
      new TowerPlanTool(
        ctx.get(ISessionContext),
        ctx.get(ISessionTowerService).of(ctx.agent),
        ctx.host.scopeContext,
      ),
  },
  {
    name: 'TowerSpawn',
    create: (ctx) =>
      new TowerSpawnTool(
        ctx.get(ISessionTowerService).of(ctx.agent),
        ctx.get(ITowerRateLimitService),
        ctx.get(ISessionContext),
        ctx.host.scopeContext,
        ctx.get(IAgentLifecycleService),
        ctx.get(IAgentHostService),
        ctx.get(ISessionSubagentService),
        ctx.get(IAgentLifecycleService).resolve(ctx.agent, AgentTask),
        ctx.get(IConfigService),
        ctx.get(IFlagService),
        ctx.get(IModelCatalog),
        ctx.get(ISessionPermissionModeService),
        ctx.get(ISessionTokenCountingService),
      ),
  },
  {
    name: 'TowerMerge',
    create: (ctx) => new TowerMergeTool(ctx.get(ISessionContext), ctx.host.scopeContext),
  },
  {
    name: 'TowerTeardown',
    create: (ctx) =>
      new TowerTeardownTool(
        ctx.get(ISessionContext),
        ctx.get(ISessionTowerService).of(ctx.agent),
        ctx.get(ISessionManager),
        ctx.host.scopeContext,
      ),
  },
  {
    name: 'TowerSend',
    create: (ctx) => new TowerSendTool(ctx.get(ISessionContext), ctx.host.scopeContext),
  },
  {
    name: 'TowerInbox',
    create: (ctx) => new TowerInboxTool(ctx.get(ISessionContext), ctx.host.scopeContext),
  },
  {
    name: 'TowerFinding',
    create: (ctx) => new TowerFindingTool(ctx.get(ISessionContext), ctx.host.scopeContext),
  },
  {
    name: 'TowerReview',
    create: (ctx) => new TowerReviewTool(ctx.get(ISessionContext), ctx.host.scopeContext),
  },
  {
    name: 'TowerMission',
    create: (ctx) => new TowerMissionTool(ctx.get(ISessionContext), ctx.host.scopeContext),
  },
  {
    name: 'TowerStatus',
    create: (ctx) =>
      new TowerStatusTool(
        ctx.get(ISessionContext),
        ctx.host.scopeContext,
        ctx.get(ITowerRateLimitService),
      ),
  },
];

export class TowerFeature extends Feature {
  static override readonly name = 'tower';

  constructor(@IFlagService flags: IFlagService) {
    super();
    if (!flags.enabled(TOWER_FLAG_ID)) return;
    markTowerFeatureAssembled(flags);
    this.onDispose(() => {
      unmarkTowerFeatureAssembled(flags);
    });
    this.contributeService(LifecycleScope.App, ITowerRateLimitService, TowerRateLimitService, {
      activation: ScopeActivation.OnDemand,
    });
    for (const tool of TOWER_TOOL_CONTRIBUTIONS) {
      this.contributeTool({
        name: tool.name,
        domain: 'tower',
        create: tool.create,
      });
    }
    this.contributeProfiles([TOWER_WORKER_PROFILE_DEF]);
  }
}

export { isTowerFeatureAssembled, _setTowerFeatureAssembledForTests } from './towerAssembly';

registerFeature(TowerFeature);
