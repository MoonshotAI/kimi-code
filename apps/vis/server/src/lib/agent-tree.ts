import type { AgentInfo } from './agent-record-types';

export interface AgentNode extends AgentInfo {
  children: AgentNode[];
}

/**
 * Build a parent/child tree from the flat agent inventory found on
 * `state.json.agents`. Roots are agents with no `parentAgentId`, plus any
 * agent whose `parentAgentId` does not resolve in the inventory (orphans).
 * The returned roots are sorted so that the `main` agent always appears
 * first; remaining roots fall back to a stable lexicographic order.
 */
export function buildAgentTree(agents: ReadonlyArray<AgentInfo>): AgentNode[] {
  const byId = new Map<string, AgentNode>();
  for (const a of agents) byId.set(a.agentId, { ...a, children: [] });

  const roots: AgentNode[] = [];
  for (const node of byId.values()) {
    if (node.parentAgentId !== null && byId.has(node.parentAgentId)) {
      byId.get(node.parentAgentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots.sort(sortAgents);
}

function sortAgents(a: AgentNode, b: AgentNode): number {
  if (a.agentId === 'main') return -1;
  if (b.agentId === 'main') return 1;
  return a.agentId.localeCompare(b.agentId);
}
