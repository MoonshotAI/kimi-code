import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { toolExecutorAgentRuntimeProvider } from './toolExecutorAgentRuntime';

export class ToolExecutorFeature extends Feature {
  static override readonly name = 'toolExecutor';

  constructor() {
    super();
    this.contributeAgentRuntime(toolExecutorAgentRuntimeProvider);
  }
}

registerFeature(ToolExecutorFeature);
