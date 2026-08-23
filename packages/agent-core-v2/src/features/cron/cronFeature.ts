import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { cronAgentRuntimeProvider } from '#/session/cron/cronAgentRuntime';

export class CronFeature extends Feature {
  static override readonly name = 'cron';

  constructor() {
    super();
    this.contributeAgentRuntime(cronAgentRuntimeProvider);
  }
}

registerFeature(CronFeature);
