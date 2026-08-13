/**
 * `swarm` domain — `SwarmFeature`: the agent-swarm capability assembled as
 * one App-scope Feature unit.
 *
 * Contributes the per-Agent `IAgentSwarmService` (swarm mode), the
 * per-Session `ISessionSwarmService` (batch scheduler), and the `AgentSwarm`
 * agent tool through the `features` base-class seams; retracting the unit
 * withdraws all of them across the scope tree. Both services keep
 * `OnScopeCreated` activation — `AgentSwarmService` subscribes the
 * `turn.ended` auto-exit and the AgentSwarm batch-exclusivity veto in its
 * constructor. The `swarm` wire vocabulary (`features/swarm/swarmOps`) stays
 * on its static import=register channel — wire records must remain
 * replayable even when the feature unit is retracted. Registered into the
 * feature table at import.
 */

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
