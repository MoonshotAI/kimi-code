import type { AgentContext } from '#/agent/agentContext/agentContext';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';

export function stubAgentContext(agentId: string, generation = 1): AgentContext {
  return makeAgentScopeContext({
    agentId,
    agentScope: `agents/${agentId}`,
    generation,
  }).agentContext;
}
