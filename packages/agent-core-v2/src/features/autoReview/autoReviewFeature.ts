import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { AutoReviewGate } from './autoReviewGate';
import { IAutoReviewGate, IAutoReviewService } from './review';
import { AutoReviewService } from './reviewService';

export class AutoReviewFeature extends Feature {
  static override readonly name = 'autoReview';

  constructor() {
    super();
    this.contributeAgentService(IAutoReviewService, AutoReviewService);
    this.contributeAgentService(IAutoReviewGate, AutoReviewGate);
  }
}

registerFeature(AutoReviewFeature);
