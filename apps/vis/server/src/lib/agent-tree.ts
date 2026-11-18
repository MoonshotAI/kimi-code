import type { AgentInfo } from './agent-record-types';

export interface AgentNode extends AgentInfo {
  children: AgentNode[];
}

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
  for (const node of byId.values()) {
    node.children.sort(sortAgents);
  }
  return roots.sort(sortAgents);
}

function sortAgents(a: AgentNode, b: AgentNode): number {
  return compareAgentIds(a.agentId, b.agentId);
}

export function compareAgentIds(a: string, b: string): number {
  if (a === b) return 0;
  if (a === 'main') return -1;
  if (b === 'main') return 1;
  const na = /^agent-(\d+)$/.exec(a);
  const nb = /^agent-(\d+)$/.exec(b);
  if (na && nb) return Number(na[1]) - Number(nb[1]);
  if (na) return -1;
  if (nb) return 1;
  return a.localeCompare(b);
}
