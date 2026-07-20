import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';

export class AgentSwarmExclusiveDenyPermissionPolicyService implements PermissionPolicy {
  readonly name = 'agent-swarm-exclusive-deny';

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    const agentSwarmCount = context.toolCalls.filter(
      (toolCall) => toolCall.name === 'AgentSwarm',
    ).length;
    if (agentSwarmCount === 0) return undefined;
    if (agentSwarmCount === 1 && context.toolCalls.length === 1) return undefined;

    return {
      kind: 'deny',
      message:
        agentSwarmCount > 1
          ? multipleAgentSwarmDeniedMessage(context.toolCalls.length > agentSwarmCount)
          : mixedAgentSwarmDeniedMessage(),
      reason: {
        agent_swarm_tool_calls: agentSwarmCount,
        tool_calls: context.toolCalls.length,
      },
    };
  }
}

function multipleAgentSwarmDeniedMessage(hasOtherToolCalls: boolean): string {
  const suffix = hasOtherToolCalls
    ? ' AgentSwarm also must not be combined with other tools in the same response.'
    : '';
  return (
    'AgentSwarm must be called one swarm at a time. Multiple AgentSwarm calls are not forbidden, ' +
    'but issue them sequentially: call one AgentSwarm, wait for its result, then call the next; ' +
    `or merge the work into a single AgentSwarm when one swarm can cover it.${suffix}`
  );
}

function mixedAgentSwarmDeniedMessage(): string {
  return (
    'AgentSwarm must be the only tool call in a model response. Retry with a single AgentSwarm ' +
    'call by itself, then call any other tools after it returns.'
  );
}
