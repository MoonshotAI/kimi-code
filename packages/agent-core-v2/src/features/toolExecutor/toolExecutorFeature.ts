import '#/agent/toolRegistry/builtinToolAssemblyService';
import '#/agent/toolRegistry/toolContributionSourceService';

import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { agentToolsRuntimeProvider } from './toolExecutorAgentRuntime';

export class ToolExecutorFeature extends Feature {
  static override readonly name = 'toolExecutor';

  constructor() {
    super();
    this.contributeAgentRuntime(agentToolsRuntimeProvider);
  }
}

registerFeature(ToolExecutorFeature);
