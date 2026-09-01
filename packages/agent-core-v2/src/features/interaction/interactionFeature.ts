import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { AgentInteractionService, IAgentInteractionService } from '#/features/interaction/interactionService';

export class InteractionFeature extends Feature {
  static override readonly name = 'interaction';

  constructor() {
    super();
    this.contributeAgentService(IAgentInteractionService, AgentInteractionService);
  }
}

registerFeature(InteractionFeature);
