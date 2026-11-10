import { ScopeActivation } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { IDebugEventsService } from './debugEvents';
import { DebugEventsService } from './debugEventsService';

export class DebugEventsFeature extends Feature {
  static override readonly name = 'debugEvents';

  constructor() {
    super();
    this.contributeService(LifecycleScope.App, IDebugEventsService, DebugEventsService, {
      activation: ScopeActivation.OnDemand,
    });
  }
}

registerFeature(DebugEventsFeature);
