import { ScopeActivation } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { IAgentHostBrowserService, ISessionHostBrowserService } from './hostBrowser';
import { AgentHostBrowserService } from './agentHostBrowserService';
import { SessionHostBrowserService } from './sessionHostBrowserService';

export class HostBrowserFeature extends Feature {
  static override readonly name = 'hostBrowser';

  constructor() {
    super();
    this.contributeService(LifecycleScope.Session, ISessionHostBrowserService, SessionHostBrowserService, {
      activation: ScopeActivation.OnScopeCreated,
    });
    this.contributeAgentService(IAgentHostBrowserService, AgentHostBrowserService, {
      activation: ScopeActivation.OnScopeCreated,
    });
  }
}

registerFeature(HostBrowserFeature);
