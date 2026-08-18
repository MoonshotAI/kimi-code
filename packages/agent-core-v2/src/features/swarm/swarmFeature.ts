import { ScopeActivation } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { IAgentSwarmService } from './agent/swarm';
import { AgentSwarmService } from './agent/swarmService';
import { ISessionSwarmService } from './session/sessionSwarm';
import { SessionSwarmService } from './session/sessionSwarmService';
import { IAgentSwarmTool } from './tools/agent-swarm/agent-swarm';
import { AgentSwarmTool } from './tools/agent-swarm/agentSwarmTool';

export class SwarmFeature extends Feature {
  static override readonly name = 'swarm';

  constructor() {
    super();
    this.contributeAgentService(IAgentSwarmService, AgentSwarmService, {
      activation: ScopeActivation.OnScopeCreated,
    });
    this.contributeService(LifecycleScope.Session, ISessionSwarmService, SessionSwarmService, {
      activation: ScopeActivation.OnScopeCreated,
    });
    this.contributeTool(IAgentSwarmTool, AgentSwarmTool, { name: 'AgentSwarm', domain: 'swarm' });
  }
}

registerFeature(SwarmFeature);
