import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { SessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCountingService';

import { tokenCountingAgentRuntimeProvider } from './tokenCountingAgentRuntime';

export class TokenCountingFeature extends Feature {
  static override readonly name = 'tokenCounting';

  constructor() {
    super();
    this.contributeAgentRuntime(tokenCountingAgentRuntimeProvider);
    this.contributeService(
      LifecycleScope.Session,
      ISessionTokenCountingService,
      SessionTokenCountingService,
    );
  }
}

registerFeature(TokenCountingFeature);
