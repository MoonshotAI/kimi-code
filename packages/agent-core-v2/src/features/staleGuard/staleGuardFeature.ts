import { ScopeActivation } from '#/_base/di/instantiation';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { IStaleGuardService } from './staleGuard';
import { StaleGuardService } from './staleGuardService';

export class StaleGuardFeature extends Feature {
  static override readonly name = 'staleGuard';

  constructor() {
    super();
    this.contributeAgentService(IStaleGuardService, StaleGuardService, {
      activation: ScopeActivation.OnScopeCreated,
    });
  }
}

registerFeature(StaleGuardFeature);
