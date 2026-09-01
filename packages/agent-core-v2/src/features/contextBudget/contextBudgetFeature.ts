import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { contextBudgetAgentRuntimeProvider } from './contextBudgetAgentRuntime';

export class ContextBudgetFeature extends Feature {
  static override readonly name = 'contextBudget';

  constructor() {
    super();
    this.contributeAgentRuntime(contextBudgetAgentRuntimeProvider);
  }
}

registerFeature(ContextBudgetFeature);
