import type { ResolvedToolExecutionHookContext } from '../../../../loop';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../permissionPolicy';
import type { PermissionPolicyRuntime } from './runtime';

export class SwarmModeAgentSwarmApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'swarm-mode-agent-swarm-approve';

  constructor(private readonly runtime: PermissionPolicyRuntime) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'AgentSwarm') return undefined;
    return this.runtime.swarmModeIsActive() ? { kind: 'approve' } : undefined;
  }
}
