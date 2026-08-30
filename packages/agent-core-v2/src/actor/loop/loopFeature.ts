import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { loopAgentRuntimeProvider } from './loopAgentRuntime';

export class LoopFeature extends Feature {
  static override readonly name = 'loop';

  constructor() {
    super();
    this.contributeAgentRuntime(loopAgentRuntimeProvider);
  }
}

registerFeature(LoopFeature);
