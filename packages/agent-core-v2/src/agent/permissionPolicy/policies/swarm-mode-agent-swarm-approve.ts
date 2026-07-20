import { IAgentSwarmService } from '#/agent/swarm/swarm';
import type { IAgentSwarmService as AgentSwarmService } from '#/agent/swarm/swarm';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';

export class SwarmModeAgentSwarmApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'swarm-mode-agent-swarm-approve';

  constructor(@IAgentSwarmService private readonly swarm: AgentSwarmService) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'AgentSwarm') return undefined;
    return this.swarm.isActive ? { kind: 'approve' } : undefined;
  }
}
