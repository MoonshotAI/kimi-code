import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class AgentSwarmExclusiveDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'agent-swarm-exclusive-deny';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const toolCalls = context.toolCalls;
    const agentSwarmCount = toolCalls.filter(
      (toolCall) => toolCall.name === 'AgentSwarm',
    ).length;

    if (agentSwarmCount === 0) return;
    if (agentSwarmCount === 1 && toolCalls.length === 1) return;

    return {
      kind: 'deny',
      message:
        agentSwarmCount > 1
          ? multipleAgentSwarmDeniedMessage(toolCalls.length > agentSwarmCount)
          : mixedAgentSwarmDeniedMessage(),
      reason: {
        agent_swarm_tool_calls: agentSwarmCount,
        tool_calls: toolCalls.length,
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
