import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { activityViewAgentRuntimeProvider } from './activityViewAgentRuntime';

export class ActivityViewFeature extends Feature {
  static override readonly name = 'activityView';

  constructor() {
    super();
    this.contributeAgentRuntime(activityViewAgentRuntimeProvider);
  }
}

registerFeature(ActivityViewFeature);
