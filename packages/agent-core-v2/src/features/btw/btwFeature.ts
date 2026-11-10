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
