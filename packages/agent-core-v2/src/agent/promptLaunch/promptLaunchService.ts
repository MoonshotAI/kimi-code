import { Disposable } from '#/_base/di/lifecycle';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentLoopService } from '#/agent/loop/loop';
import { WarningIssued } from '#/agent/profile/profileOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { LifecycleScope } from '#/app/scopes';
import { IAgentGoalService } from '#/features/goal/goalService';
import { IAgentPlanService } from '#/features/plan/plan';
import { IAgentTowerService } from '#/features/tower/tower';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { PromptLaunch } from '#human/agent/turn';

import { IAgentPromptLaunchService } from './promptLaunch';

export class AgentPromptLaunchService extends Disposable implements IAgentPromptLaunchService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLoopService loop: IAgentLoopService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @IAgentPlanService private readonly plan: IAgentPlanService,
    @IAgentTowerService private readonly tower: IAgentTowerService,
    @IAgentGoalService private readonly goal: IAgentGoalService | undefined,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
  ) {
    super();
    this._register(
      loop.hooks.onBeforeSubmitPrompt.register('promptLaunch', async (ctx, next) => {
        await next();
        if (ctx.block || ctx.launch === undefined || this.scope.agentId !== MAIN_AGENT_ID) return;
        try {
          await this.apply(ctx.launch);
        } catch (error) {
          void this.dispatcher.dispatch(
            new WarningIssued({
              agentId: this.scope.agentId,
              code: 'prompt-launch-failed',
              message: `The prompt runs without its requested mode: ${toErrorMessage(error)}`,
            }),
          );
        }
      }),
    );
  }

  private async apply(launch: PromptLaunch): Promise<void> {
    if (launch.goalObjective !== undefined && this.goal !== undefined) {
      await this.goal.createGoal({ objective: launch.goalObjective });
      if ((await this.plan.status()) !== null) this.plan.exit();
      return;
    }
    if (launch.planMode === true) {
      if ((await this.plan.status()) === null) await this.plan.enter();
      if (this.tower.isActive) await this.tower.exit();
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPromptLaunchService,
  AgentPromptLaunchService,
  ScopeActivation.OnScopeCreated,
  'promptLaunch',
);
