import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { dateChangeAgentRuntimeProvider } from './dateChangeAgentRuntime';

export class DateChangeFeature extends Feature {
  static override readonly name = 'dateChange';

  constructor() {
    super();
    this.contributeAgentRuntime(dateChangeAgentRuntimeProvider);
  }
}

registerFeature(DateChangeFeature);
