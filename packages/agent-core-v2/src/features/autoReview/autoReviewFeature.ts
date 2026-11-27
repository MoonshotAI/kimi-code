import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import './autoReviewEvents';
import './configSection';
import './flag';
import { AutoReviewCloudConfigService, IAutoReviewCloudConfigService } from './cloudConfig';
import { IAutoReviewService, ISessionAutoReviewService } from './review';
import { AutoReviewService } from './reviewService';
import { SessionAutoReviewService } from './sessionReviewService';

export class AutoReviewFeature extends Feature {
  static override readonly name = 'autoReview';

  constructor() {
    super();
    this.contributeService(LifecycleScope.App, IAutoReviewCloudConfigService, AutoReviewCloudConfigService);
    this.contributeService(LifecycleScope.Session, ISessionAutoReviewService, SessionAutoReviewService);
    this.contributeAgentService(IAutoReviewService, AutoReviewService);
  }
}

registerFeature(AutoReviewFeature);
