import { ScopeActivation } from '#/_base/di/instantiation';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { AgentInteraction, IAgentInteraction } from '#/session/interaction/interaction';
import {
  AgentInteractionBinding,
  InteractionAgentRuntimeDefinition,
} from '#/session/interaction/interactionAgentRuntime';

export class InteractionFeature extends Feature {
  static override readonly name = 'interaction';

  constructor() {
    super();
    this.contributeAgentRuntime(AgentInteraction, InteractionAgentRuntimeDefinition);
    this.contributeAgentService(IAgentInteraction, AgentInteractionBinding, {
      activation: ScopeActivation.OnDemand,
    });
  }
}

registerFeature(InteractionFeature);
