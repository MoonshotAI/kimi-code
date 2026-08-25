import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { llmRequesterAgentRuntimeProvider } from './llmRequesterAgentRuntime';

export class LlmRequesterFeature extends Feature {
  static override readonly name = 'llmRequester';

  constructor() {
    super();
    this.contributeAgentRuntime(llmRequesterAgentRuntimeProvider);
  }
}

registerFeature(LlmRequesterFeature);
