/**
 * `btw` domain — `BtwFeature`: the side-question ("by the way") capability
 * assembled as one App-scope Feature unit.
 *
 * Contributes the per-Session `ISessionBtwService` through the `features`
 * base-class seams; retracting the unit withdraws it across the scope tree.
 * Registered into the feature table at import.
 */

import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { ISessionBtwService } from './btw';
import { SessionBtwService } from './btwService';

export class BtwFeature extends Feature {
  static override readonly name = 'btw';

  constructor() {
    super();
    this.contributeService(LifecycleScope.Session, ISessionBtwService, SessionBtwService);
  }
}

registerFeature(BtwFeature);
