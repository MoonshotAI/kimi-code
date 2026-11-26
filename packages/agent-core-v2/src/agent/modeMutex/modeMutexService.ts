import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IEventBus } from '#/app/event/eventBus';
import { LifecycleScope } from '#/app/scopes';
import { GoalUpdated } from '#/features/goal/goalOps';
import { IAgentGoalService } from '#/features/goal/goalService';
import { IAgentPlanService } from '#/features/plan/plan';
import { planKey } from '#/features/plan/planOps';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { IAgentTowerService } from '#/features/tower/tower';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { IAgentModeMutexService } from './modeMutex';

export class AgentModeMutexService extends Disposable implements IAgentModeMutexService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentTowerService private readonly tower: IAgentTowerService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IEventBus eventBus: IEventBus,
  ) {
    super();
    this._register(
      eventBus.subscribe(GoalUpdated, (event) => {
        if (event.snapshot?.status !== 'active') return;
        if (!this.tower.isActive) return;
        void this.dispatcher.dispatch(
          new AgentStatusUpdated({
            agentId: event.agentId,
            towerMode: false,
            towerExitReason: 'mode-mutex',
          }),
        );
        void this.tower.exit('mode-mutex');
      }),
    );
    this._register(
      this.dispatcher.hooks.onDidRestore.register('modeMutex', async (_ctx, next) => {
        if (this.tower.isActive) await this.beforeTowerEnter();
        await next();
      }),
    );
  }

  async beforePlanEnter(): Promise<void> {
    if (this.tower.isActive) await this.tower.exit('mode-mutex');
  }

  beforeSwarmEnter(): void {
    if (this.tower.isActive) void this.tower.exit('mode-mutex');
  }

  async beforeTowerEnter(): Promise<void> {
    if (this.agentState.get(planKey).active) {
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentPlanService)).exit();
    }
    const swarm = this.instantiation.invokeFunction((accessor) =>
      accessor.get(IAgentSwarmService),
    );
    if (swarm.isActive) swarm.exit();
    const goal = this.instantiation.invokeFunction((accessor) =>
      accessor.get(IAgentGoalService),
    );
    if (goal?.getGoal().goal?.status === 'active') {
      await goal.pauseGoal({ reason: 'Paused after tower mode entered' }, 'system');
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentModeMutexService,
  AgentModeMutexService,
  ScopeActivation.OnScopeCreated,
  'modeMutex',
);
