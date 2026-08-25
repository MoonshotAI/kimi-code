import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { SessionUsageService } from '#/session/usage/sessionUsageService';

import { usageAgentRuntimeProvider } from './usageAgentRuntime';

export class UsageFeature extends Feature {
  static override readonly name = 'usage';

  constructor() {
    super();
    this.contributeAgentRuntime(usageAgentRuntimeProvider);
    this.contributeService(LifecycleScope.Session, ISessionUsageService, SessionUsageService);
  }
}

registerFeature(UsageFeature);
