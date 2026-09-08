import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { ISessionInitService } from './sessionInit';
import { SessionInitService } from './sessionInitService';

export class SessionInitFeature extends Feature {
  static override readonly name = 'sessionInit';

  constructor() {
    super();
    this.contributeService(
      LifecycleScope.Session,
      ISessionInitService,
      SessionInitService,
    );
  }
}

registerFeature(SessionInitFeature);
