import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { profileAgentRuntimeProvider } from './profileAgentRuntime';

export class ProfileFeature extends Feature {
  static override readonly name = 'profile';

  constructor() {
    super();
    this.contributeAgentRuntime(profileAgentRuntimeProvider);
  }
}

registerFeature(ProfileFeature);
