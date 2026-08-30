import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { fullCompactionAgentRuntimeProvider } from './fullCompactionAgentRuntime';

export class FullCompactionFeature extends Feature {
  static override readonly name = 'fullCompaction';

  constructor() {
    super();
    this.contributeAgentRuntime(fullCompactionAgentRuntimeProvider);
  }
}

registerFeature(FullCompactionFeature);
