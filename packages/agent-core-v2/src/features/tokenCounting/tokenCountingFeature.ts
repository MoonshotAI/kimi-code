import { AgentTokenCountingService } from '#/agent/tokenCounting/agentTokenCountingService';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';

export class TokenCountingFeature extends Feature {
  static override readonly name = 'tokenCounting';

  constructor() {
    super();
    this.contributeAgentService(ISessionTokenCountingService, AgentTokenCountingService);
  }
}

registerFeature(TokenCountingFeature);
