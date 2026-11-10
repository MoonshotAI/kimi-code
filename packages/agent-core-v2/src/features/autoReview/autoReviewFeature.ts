import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import './autoReviewEvents';
import './configSection';
import './flag';
import { IAutoReviewService } from './review';
import { AutoReviewService } from './reviewService';

export class AutoReviewFeature extends Feature {
  static override readonly name = 'autoReview';

  constructor() {
    super();
    this.contributeAgentService(IAutoReviewService, AutoReviewService);
  }
}

registerFeature(AutoReviewFeature);
