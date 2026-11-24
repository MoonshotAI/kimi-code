import { ScopeActivation } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';
import { LifecycleScope } from '@moonshot-ai/agent-core-v2/app/scopes';
import { Feature } from '@moonshot-ai/agent-core-v2/features/feature';

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
