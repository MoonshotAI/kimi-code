import { describe, expect, it } from 'vitest';

import { Graph } from '#/di/graph';

/**
 * Pure data-structure tests for the vendored `Graph` (no DI container
 * involvement). Hash function is identity-on-string so test setup stays
 * obvious.
 */
describe('Graph (pure data structure)', () => {
  it('chain A → B → C consumes via roots()/removeNode() in C, B, A order', () => {
    const g = new Graph<string>((s) => s);
    // A depends on B, B depends on C: edges go from depender to dependency.
    g.insertEdge('A', 'B');
    g.insertEdge('B', 'C');

    // C has no outgoing edges — it is the only root initially.
    const order: string[] = [];
    while (!g.isEmpty()) {
      const roots = g.roots();
      expect(roots.length).toBeGreaterThan(0);
      for (const root of roots) {
        order.push(root.data);
        g.removeNode(root.data);
      }
    }
    expect(order).toEqual(['C', 'B', 'A']);
  });

  it('cycle A → B → A: findCycleSlow returns path containing "A -> B -> A"', () => {
    const g = new Graph<string>((s) => s);
    g.insertEdge('A', 'B');
    g.insertEdge('B', 'A');
    const cycle = g.findCycleSlow();
    expect(cycle).toBeDefined();
    expect(cycle).toContain('A -> B -> A');
  });
});
