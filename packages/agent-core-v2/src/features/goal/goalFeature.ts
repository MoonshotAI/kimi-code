import { ScopeActivation } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { IAgentGoalService } from './goal';
import { IGoalDeadlineScheduler } from './goalDeadlineScheduler';
import { GoalDeadlineSchedulerService } from './goalDeadlineSchedulerService';
import { AgentGoalService } from './goalService';
import { ICreateGoalTool } from './tools/create-goal/create-goal';
import { CreateGoalTool } from './tools/create-goal/createGoalTool';
import { IGetGoalTool } from './tools/get-goal/get-goal';
import { GetGoalTool } from './tools/get-goal/getGoalTool';
import { ISetGoalBudgetTool } from './tools/set-goal-budget/set-goal-budget';
import { SetGoalBudgetTool } from './tools/set-goal-budget/setGoalBudgetTool';
import { IUpdateGoalTool } from './tools/update-goal/update-goal';
import { UpdateGoalTool } from './tools/update-goal/updateGoalTool';

export class GoalFeature extends Feature {
  static override readonly name = 'goal';

  constructor() {
    super();
    this.contributeAgentService(IAgentGoalService, AgentGoalService, {
      activation: ScopeActivation.OnScopeCreated,
    });
    this.contributeService(LifecycleScope.App, IGoalDeadlineScheduler, GoalDeadlineSchedulerService, {
      activation: ScopeActivation.OnDemand,
    });
    this.contributeTool(ICreateGoalTool, CreateGoalTool, {
      name: 'CreateGoal',
      domain: 'goal',
    });
    this.contributeTool(IGetGoalTool, GetGoalTool, {
      name: 'GetGoal',
      domain: 'goal',
    });
    this.contributeTool(ISetGoalBudgetTool, SetGoalBudgetTool, {
      name: 'SetGoalBudget',
      domain: 'goal',
    });
    this.contributeTool(IUpdateGoalTool, UpdateGoalTool, {
      name: 'UpdateGoal',
      domain: 'goal',
    });
  }
}

registerFeature(GoalFeature);
