import type { AgentContext } from './agentContext';

const activeAgentContexts = new WeakSet<AgentContext>();

export function activateAgentContext(context: AgentContext): void {
  activeAgentContexts.add(context);
}

export function deactivateAgentContext(context: AgentContext): void {
  activeAgentContexts.delete(context);
}

export function isActiveAgentContext(context: AgentContext): boolean {
  return activeAgentContexts.has(context);
}
