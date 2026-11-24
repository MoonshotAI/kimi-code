import { ScopeActivation } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';
import { LifecycleScope } from '@moonshot-ai/agent-core-v2/app/scopes';
import { Feature } from '@moonshot-ai/agent-core-v2/features/feature';

import { IAgentHostBrowserService, ISessionHostBrowserService } from './browser-host-contract';
import { AgentHostBrowserService } from './browser-agent-service';
import { SessionHostBrowserService } from './browser-session-service';

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
