import { ScopeActivation } from '#/_base/di/instantiation';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { IAgentDateChangeService } from './dateChange';
import { AgentDateChangeService } from './dateChangeService';

export class DateChangeFeature extends Feature {
  static override readonly name = 'dateChange';

  constructor() {
    super();
    this.contributeAgentService(IAgentDateChangeService, AgentDateChangeService, {
      activation: ScopeActivation.OnScopeCreated,
    });
  }
}

registerFeature(DateChangeFeature);
