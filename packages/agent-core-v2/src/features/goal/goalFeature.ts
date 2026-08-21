import { AgentGoal } from '#/agent/goal/goalAgentRuntime';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

export class GoalFeature extends Feature {
  static override readonly name = 'goal';

  constructor() {
    super();
    this.contributeAgentRuntime(AgentGoal);
  }
}

registerFeature(GoalFeature);
