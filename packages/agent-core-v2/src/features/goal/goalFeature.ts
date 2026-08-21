import { ScopeActivation } from '#/_base/di/instantiation';
import { AgentGoal, IAgentGoal } from '#/agent/goal/goal';
import { AgentGoalBinding, GoalAgentRuntimeDefinition } from '#/agent/goal/goalAgentRuntime';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

export class GoalFeature extends Feature {
  static override readonly name = 'goal';

  constructor() {
    super();
    this.contributeAgentRuntime(AgentGoal, GoalAgentRuntimeDefinition);
    this.contributeAgentService(IAgentGoal, AgentGoalBinding, {
      activation: ScopeActivation.OnDemand,
    });
  }
}

registerFeature(GoalFeature);
