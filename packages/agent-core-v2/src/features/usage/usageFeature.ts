import { AgentUsageService } from '#/agent/usage/agentUsageService';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { ISessionUsageService } from '#/session/usage/sessionUsage';

export class UsageFeature extends Feature {
  static override readonly name = 'usage';

  constructor() {
    super();
    this.contributeAgentService(ISessionUsageService, AgentUsageService);
  }
}

registerFeature(UsageFeature);
