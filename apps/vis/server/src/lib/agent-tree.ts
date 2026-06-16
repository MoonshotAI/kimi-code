import type { AgentInfo } from './agent-record-types';

export interface AgentNode extends AgentInfo {
  children: AgentNode[];
}

/**
 * Build a parent/child tree from the flat agent inventory found on
 * `state.json.agents`. Roots are agents with no `parentAgentId`, plus any
 * agent whose `parentAgentId` does not resolve in the inventory (orphans).
 * The returned roots are sorted so that the `main` agent always appears
 * first; remaining agents fall back to a numeric `agent-N` order (so
 * `agent-2` precedes `agent-10`), then a stable lexicographic order. The
 * same ordering is applied to each node's children.
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
  for (const node of byId.values()) {
    node.children.sort(sortAgents);
  }
  return roots.sort(sortAgents);
}

function sortAgents(a: AgentNode, b: AgentNode): number {
  return compareAgentIds(a.agentId, b.agentId);
}

/**
 * Shared agent-id ordering: `main` always first, then `agent-N` records by
 * numeric suffix (so `agent-2` precedes `agent-10`), with a lexicographic
 * fallback for any id that does not match the `agent-N` shape.
 *
 * In practice a sibling set is `main` plus `agent-N` ids (agent-core's id
 * generator only emits those). The `na`/`nb`-only branches below exist solely
 * to keep a stable TOTAL order when foreign/hand-edited ids (reachable via
 * `state.json` keys or `discoverAgentsFromDisk` directory names) are mixed in:
 * all `agent-N` ids sort before any non-`agent-N` id, so the comparator stays
 * transitive instead of degenerating into V8's order-dependent output.
 */
export function compareAgentIds(a: string, b: string): number {
  if (a === b) return 0;
  if (a === 'main') return -1;
  if (b === 'main') return 1;
  const na = /^agent-(\d+)$/.exec(a);
  const nb = /^agent-(\d+)$/.exec(b);
  if (na && nb) return Number(na[1]) - Number(nb[1]);
  if (na) return -1; // all agent-N sort before any non-agent-N id
  if (nb) return 1;
  return a.localeCompare(b);
}
