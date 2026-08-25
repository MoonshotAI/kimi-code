import { contextMemoryAgentRuntimeProvider } from '#/features/contextMemory/contextMemoryAgentRuntime';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

export class ContextMemoryFeature extends Feature {
  static override readonly name = 'contextMemory';

  constructor() {
    super();
    this.contributeAgentRuntime(contextMemoryAgentRuntimeProvider);
  }
}

registerFeature(ContextMemoryFeature);
