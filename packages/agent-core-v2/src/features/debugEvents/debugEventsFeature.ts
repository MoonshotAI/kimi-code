/**
 * `debugEvents` domain — `DebugEventsFeature`: the event-subscription
 * introspection capability assembled as one App-scope Feature unit.
 *
 * Contributes the App-scope `IDebugEventsService` (OnDemand) through the
 * `features` base-class seam; retracting the unit withdraws the service
 * across the scope tree. The service is intentionally absent from the static
 * scoped registry — the debug RPC dispatcher reaches it by decorator-name
 * fallback. Registered into the feature table at import.
 */

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
