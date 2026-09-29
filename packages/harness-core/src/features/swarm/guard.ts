import type { ToolBeforeBatchHook } from '@moonshot-ai/agent-core';

export const AGENT_SWARM_TOOL_NAME = 'AgentSwarm';

export function createSwarmGuard(deps: { readonly isMain: boolean }): ToolBeforeBatchHook {
  return ({ toolCalls }) => {
    const agentSwarmCount = toolCalls.filter(
      (toolCall) => toolCall.name === AGENT_SWARM_TOOL_NAME,
    ).length;
    if (agentSwarmCount === 0 || (agentSwarmCount === 1 && toolCalls.length === 1)) {
      return undefined;
    }
    const message =
      agentSwarmCount > 1
        ? multipleAgentSwarmDeniedMessage(toolCalls.length > agentSwarmCount)
        : mixedAgentSwarmDeniedMessage();
    return deniedWith(formatSwarmDenyMessage(message, deps.isMain));
  };
}

export function multipleAgentSwarmDeniedMessage(hasOtherToolCalls: boolean): string {
  const suffix = hasOtherToolCalls
    ? ' AgentSwarm also must not be combined with other tools in the same response.'
    : '';
  return (
    'AgentSwarm must be called one swarm at a time. Multiple AgentSwarm calls are not forbidden, ' +
    'but issue them sequentially: call one AgentSwarm, wait for its result, then call the next; ' +
    `or merge the work into a single AgentSwarm when one swarm can cover it.${suffix}`
  );
}

export function mixedAgentSwarmDeniedMessage(): string {
  return (
    'AgentSwarm must be the only tool call in a model response. Retry with a single AgentSwarm ' +
    'call by itself, then call any other tools after it returns.'
  );
}

function deniedWith(text: string) {
  return { type: 'denied' as const, result: { content: [{ type: 'text' as const, text }] } };
}

function formatSwarmDenyMessage(message: string, isMain: boolean): string {
  if (!isMain) {
    return `${message} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
  }
  return message;
}
