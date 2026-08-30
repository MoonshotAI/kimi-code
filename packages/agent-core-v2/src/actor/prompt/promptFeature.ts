import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { promptAgentRuntimeProvider } from './promptAgentRuntime';

export class PromptFeature extends Feature {
  static override readonly name = 'prompt';

  constructor() {
    super();
    this.contributeAgentRuntime(promptAgentRuntimeProvider);
  }
}

registerFeature(PromptFeature);
