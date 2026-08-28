import { ScopeActivation } from '#/_base/di/instantiation';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionSubagentService } from '#/session/subagent/subagent';

import { ISessionSwarmService } from './session/sessionSwarm';
import { SessionSwarmService } from './session/sessionSwarmService';
import {
  ISessionSwarmAgentService,
  SessionSwarmAgentService,
} from './session/sessionSwarmAgentService';
import { AgentSwarmTool } from './tools/agent-swarm/agentSwarmTool';

export class SwarmFeature extends Feature {
  static override readonly name = 'swarm';

  constructor() {
    super();
    this.contributeService(
      LifecycleScope.Session,
      ISessionSwarmAgentService,
      SessionSwarmAgentService,
      { activation: ScopeActivation.OnScopeCreated },
    );
    this.contributeService(LifecycleScope.Session, ISessionSwarmService, SessionSwarmService, {
      activation: ScopeActivation.OnScopeCreated,
    });
    this.contributeTool({
      name: 'AgentSwarm',
      domain: 'swarm',
      create: (ctx) =>
        new AgentSwarmTool(
          ctx.get(ISessionSwarmService),
          ctx.host.scopeContext,
          ctx.get(ISessionSwarmAgentService).of(ctx.agent),
          ctx.get(IConfigService),
          ctx.get(IFlagService),
          ctx.get(ISessionSubagentService),
          ctx.get(IAgentLifecycleService),
        ),
    });
  }
}

registerFeature(SwarmFeature);
