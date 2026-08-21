import { ScopeActivation } from '#/_base/di/instantiation';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { AgentCron, IAgentCron } from '#/session/cron/agentCron';
import { AgentCronBinding, CronAgentRuntimeDefinition } from '#/session/cron/cronAgentRuntime';

export class CronFeature extends Feature {
  static override readonly name = 'cron';

  constructor() {
    super();
    this.contributeAgentRuntime(AgentCron, CronAgentRuntimeDefinition);
    this.contributeAgentService(IAgentCron, AgentCronBinding, {
      activation: ScopeActivation.OnDemand,
    });
  }
}

registerFeature(CronFeature);
