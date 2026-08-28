import { ScopeActivation } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { goalAgentRuntimeProvider } from './goalAgentRuntime';
import { IGoalDeadlineScheduler } from './goalDeadlineScheduler';
import { GoalDeadlineSchedulerService } from './goalDeadlineSchedulerService';
import { CreateGoalTool } from './tools/create-goal/createGoalTool';
import { GetGoalTool } from './tools/get-goal/getGoalTool';
import { SetGoalBudgetTool } from './tools/set-goal-budget/setGoalBudgetTool';
import { UpdateGoalTool } from './tools/update-goal/updateGoalTool';

export class GoalFeature extends Feature {
  static override readonly name = 'goal';

  constructor() {
    super();
    this.contributeAgentRuntime(goalAgentRuntimeProvider);
    this.contributeService(LifecycleScope.App, IGoalDeadlineScheduler, GoalDeadlineSchedulerService, {
      activation: ScopeActivation.OnDemand,
    });
    this.contributeTool({
      name: 'CreateGoal',
      domain: 'goal',
      create: (ctx) => new CreateGoalTool(ctx.get(IAgentLifecycleService), ctx.host.scopeContext),
    });
    this.contributeTool({
      name: 'GetGoal',
      domain: 'goal',
      create: (ctx) => new GetGoalTool(ctx.get(IAgentLifecycleService), ctx.host.scopeContext),
    });
    this.contributeTool({
      name: 'SetGoalBudget',
      domain: 'goal',
      create: (ctx) => new SetGoalBudgetTool(ctx.get(IAgentLifecycleService), ctx.host.scopeContext),
    });
    this.contributeTool({
      name: 'UpdateGoal',
      domain: 'goal',
      create: (ctx) => new UpdateGoalTool(ctx.get(IAgentLifecycleService), ctx.host.scopeContext),
    });
  }
}

registerFeature(GoalFeature);
