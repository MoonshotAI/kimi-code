import { describe, it, expect } from 'vitest';
import { buildAgentTree, compareAgentIds } from '../../src/lib/agent-tree';
import type { AgentInfo } from '../../src/lib/agent-record-types';

function info(overrides: Partial<AgentInfo> & Pick<AgentInfo, 'agentId'>): AgentInfo {
  return {
    type: 'sub',
    parentAgentId: null,
    homedir: `/tmp/${overrides.agentId}`,
    wireExists: true,
    wireRecordCount: 0,
    wireProtocolVersion: '1.1',
    swarmItem: null,
    ...overrides,
  };
}

describe('agent-tree', () => {
  it('returns single main agent as the only root', () => {
    const tree = buildAgentTree([info({ agentId: 'main', type: 'main' })]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.agentId).toBe('main');
    expect(tree[0]!.children).toEqual([]);
  });

  it('attaches a sub agent to its main parent', () => {
    const tree = buildAgentTree([
      info({ agentId: 'main', type: 'main' }),
      info({ agentId: 'agent-0', type: 'sub', parentAgentId: 'main' }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.agentId).toBe('main');
    expect(tree[0]!.children).toHaveLength(1);
    expect(tree[0]!.children[0]!.agentId).toBe('agent-0');
    expect(tree[0]!.children[0]!.parentAgentId).toBe('main');
  });

  it('treats orphan parentAgentId as a root node', () => {
    const tree = buildAgentTree([
      info({ agentId: 'main', type: 'main' }),
      info({ agentId: 'agent-0', type: 'sub', parentAgentId: 'does-not-exist' }),
    ]);
    expect(tree).toHaveLength(2);
    const ids = tree.map((n) => n.agentId).sort();
    expect(ids).toEqual(['agent-0', 'main']);
    // orphan is still a root, no children attached anywhere
    const orphan = tree.find((n) => n.agentId === 'agent-0')!;
    expect(orphan.children).toEqual([]);
  });

  it('sorts main as the first root regardless of input order', () => {
    const tree = buildAgentTree([
      info({ agentId: 'agent-1', type: 'sub', parentAgentId: 'orphan' }),
      info({ agentId: 'main', type: 'main' }),
      info({ agentId: 'agent-2', type: 'sub', parentAgentId: 'orphan' }),
    ]);
    expect(tree[0]!.agentId).toBe('main');
  });

  it('orders agents by numeric suffix, main first (agent-2 before agent-10)', () => {
    const mk = (id: string): AgentInfo => ({
      agentId: id, type: id === 'main' ? 'main' : 'sub', parentAgentId: id === 'main' ? null : 'main',
      homedir: '', wireExists: true, wireRecordCount: 0, wireProtocolVersion: null, swarmItem: null,
    });
    const tree = buildAgentTree([mk('main'), mk('agent-10'), mk('agent-2')]);
    const order = [tree[0]!.agentId, ...tree[0]!.children.map((c) => c.agentId)];
    expect(order).toEqual(['main', 'agent-2', 'agent-10']);
  });

  it('orders orphan ROOTS by numeric suffix (agent-2 before agent-10)', () => {
    const tree = buildAgentTree([
      info({ agentId: 'agent-10', type: 'sub', parentAgentId: 'missing' }),
      info({ agentId: 'agent-2', type: 'sub', parentAgentId: 'missing' }),
    ]);
    expect(tree.map((n) => n.agentId)).toEqual(['agent-2', 'agent-10']);
  });

  it('compareAgentIds is a deterministic total order when agent-N and foreign ids mix', () => {
    // 'agent-1a' is a foreign/hand-edited id reachable via state.json keys or
    // discoverAgentsFromDisk directory names — it does not match agent-N.
    // Under the new rule: all agent-N ids sort numerically first, then any
    // non-agent-N id by localeCompare. Sorting any permutation must yield the
    // same order; the OLD comparator was intransitive and order-dependent here.
    const forward = ['agent-2', 'agent-1a', 'agent-10'];
    const reverse = [...forward].reverse();
    const expected = ['agent-2', 'agent-10', 'agent-1a'];
    expect([...forward].sort(compareAgentIds)).toEqual(expected);
    expect([...reverse].sort(compareAgentIds)).toEqual(expected);
  });
});
