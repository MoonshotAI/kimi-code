import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventBus } from '#/app/event/eventBus';
import { LifecycleScope } from '#/app/scopes';
import { IAgentPlanService } from '#/features/plan/plan';
import { PlanModeEnter, planKey } from '#/features/plan/planOps';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { SwarmModeEnter } from '#/features/swarm/swarmOps';
import { IAgentTowerService } from '#/features/tower/tower';
import { TowerModeEnter } from '#/features/tower/towerOps';

import { IAgentModeMutexService } from './modeMutex';

export class AgentModeMutexService extends Disposable implements IAgentModeMutexService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentPlanService private readonly plan: IAgentPlanService,
    @IAgentSwarmService private readonly swarm: IAgentSwarmService,
    @IAgentTowerService private readonly tower: IAgentTowerService,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IEventBus eventBus: IEventBus,
  ) {
    super();
    this._register(
      eventBus.subscribe(PlanModeEnter, () => {
        if (this.tower.isActive) this.tower.exit();
      }),
    );
    this._register(
      eventBus.subscribe(SwarmModeEnter, () => {
        if (this.tower.isActive) this.tower.exit();
      }),
    );
    this._register(
      eventBus.subscribe(TowerModeEnter, () => {
        if (this.agentState.get(planKey).active) this.plan.exit();
        if (this.swarm.isActive) this.swarm.exit();
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentModeMutexService,
  AgentModeMutexService,
  ScopeActivation.OnScopeCreated,
  'modeMutex',
);
