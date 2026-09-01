import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { AgentContextBudgetService, IAgentContextBudgetService } from './contextBudgetService';

export class ContextBudgetFeature extends Feature {
  static override readonly name = 'contextBudget';

  constructor() {
    super();
    this.contributeAgentService(IAgentContextBudgetService, AgentContextBudgetService);
  }
}

registerFeature(ContextBudgetFeature);
