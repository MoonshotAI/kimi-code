import { describe, it, expect } from 'vitest';
import { buildAgentTree } from '../../src/lib/agent-tree';
import type { AgentInfo } from '../../src/lib/agent-record-types';

function info(overrides: Partial<AgentInfo> & Pick<AgentInfo, 'agentId'>): AgentInfo {
  return {
    type: 'sub',
    parentAgentId: null,
    homedir: `/tmp/${overrides.agentId}`,
    wireExists: true,
    wireRecordCount: 0,
    wireProtocolVersion: '1.1',
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
});
