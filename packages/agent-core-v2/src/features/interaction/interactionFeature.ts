import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { AgentInteraction } from '#/session/interaction/interactionAgentRuntime';

export class InteractionFeature extends Feature {
  static override readonly name = 'interaction';

  constructor() {
    super();
    this.contributeAgentRuntime(AgentInteraction);
  }
}

registerFeature(InteractionFeature);
