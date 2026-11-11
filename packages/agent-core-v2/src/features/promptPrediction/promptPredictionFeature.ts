import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { ISessionPromptPredictionService } from './promptPrediction';
import { SessionPromptPredictionService } from './promptPredictionService';

export class PromptPredictionFeature extends Feature {
  static override readonly name = 'promptPrediction';

  constructor() {
    super();
    this.contributeService(
      LifecycleScope.Session,
      ISessionPromptPredictionService,
      SessionPromptPredictionService,
    );
  }
}

registerFeature(PromptPredictionFeature);
