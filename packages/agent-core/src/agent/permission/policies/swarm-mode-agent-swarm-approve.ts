import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class SwarmModeAgentSwarmApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'swarm-mode-agent-swarm-approve';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'AgentSwarm') return;
    if (!this.agent.swarmMode.isActive) return;
    return {
      kind: 'approve',
    };
  }
}
