import { ScopeActivation } from '#/_base/di/instantiation';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { LifecycleScope } from '#/app/scopes';

import { ISessionStaleGuardService, SessionStaleGuardService } from './sessionStaleGuardService';

export class StaleGuardFeature extends Feature {
  static override readonly name = 'staleGuard';

  constructor() {
    super();
    this.contributeService(LifecycleScope.Session, ISessionStaleGuardService, SessionStaleGuardService, {
      activation: ScopeActivation.OnScopeCreated,
    });
  }
}

registerFeature(StaleGuardFeature);
