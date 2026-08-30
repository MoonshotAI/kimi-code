import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { interactionAgentRuntimeProvider } from '#/actor/interaction/interactionAgentRuntime';

export class InteractionFeature extends Feature {
  static override readonly name = 'interaction';

  constructor() {
    super();
    this.contributeAgentRuntime(interactionAgentRuntimeProvider);
  }
}

registerFeature(InteractionFeature);
