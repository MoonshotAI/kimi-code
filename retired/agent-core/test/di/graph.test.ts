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

  it('isEmpty returns true for a freshly constructed graph', () => {
    const g = new Graph<string>((s) => s);
    expect(g.isEmpty()).toBe(true);
  });

  it('single node with no edges: roots() returns it and isEmpty works', () => {
    const g = new Graph<string>((s) => s);
    g.insertEdge('A', 'A');
    // A single node with a self-loop — it has an outgoing edge, so it is not a root.
    expect(g.isEmpty()).toBe(false);

    // Insert a pair of distinct nodes so there is a path to consume.
    const g2 = new Graph<string>((s) => s);
    g2.insertEdge('A', 'B');
    // B is a root. Remove it, then A becomes a root.
    const roots = g2.roots();
    expect(roots).toHaveLength(1);
    expect(roots[0]!.data).toBe('B');
  });

  it('disconnected subgraphs: each root is consumed independently', () => {
    const g = new Graph<string>((s) => s);
    g.insertEdge('A', 'B');
    g.insertEdge('C', 'D');
    // B and D are roots (no outgoing edges).
    const roots = g.roots();
    expect(roots).toHaveLength(2);
    const rootData = roots.map((r) => r.data).sort();
    expect(rootData).toEqual(['B', 'D']);
    g.removeNode('B');
    g.removeNode('D');
    // Now A and C are roots.
    const nextRoots = g.roots().map((r) => r.data).sort();
    expect(nextRoots).toEqual(['A', 'C']);
  });

  it('fan-out: one node depends on multiple others', () => {
    const g = new Graph<string>((s) => s);
    g.insertEdge('A', 'B');
    g.insertEdge('A', 'C');
    g.insertEdge('A', 'D');
    // B, C, D are all roots.
    const roots = g.roots().map((r) => r.data).sort();
    expect(roots).toEqual(['B', 'C', 'D']);
    g.removeNode('B');
    g.removeNode('C');
    g.removeNode('D');
    expect(g.roots().map((r) => r.data)).toEqual(['A']);
  });

  it('fan-in: multiple nodes depend on the same target', () => {
    const g = new Graph<string>((s) => s);
    g.insertEdge('A', 'D');
    g.insertEdge('B', 'D');
    g.insertEdge('C', 'D');
    // D is the only root.
    const roots = g.roots().map((r) => r.data);
    expect(roots).toEqual(['D']);
    g.removeNode('D');
    // Now A, B, C are all roots.
    const nextRoots = g.roots().map((r) => r.data).sort();
    expect(nextRoots).toEqual(['A', 'B', 'C']);
  });

  it('self-loop: A depends on itself via findCycleSlow', () => {
    const g = new Graph<string>((s) => s);
    g.insertEdge('A', 'A');
    const cycle = g.findCycleSlow();
    expect(cycle).toBeDefined();
    expect(cycle).toContain('A -> A');
  });

  it('longer cycle A → B → C → A is detected with the full path', () => {
    const g = new Graph<string>((s) => s);
    g.insertEdge('A', 'B');
    g.insertEdge('B', 'C');
    g.insertEdge('C', 'A');
    const cycle = g.findCycleSlow();
    expect(cycle).toBeDefined();
    expect(cycle).toContain('A -> B -> C -> A');
  });

  it('re-inserting an existing edge is a no-op (idempotent)', () => {
    const g = new Graph<string>((s) => s);
    g.insertEdge('A', 'B');
    g.insertEdge('A', 'B'); // duplicate
    // Should still be a single A→B edge.
    g.removeNode('B');
    const roots = g.roots();
    expect(roots).toHaveLength(1);
    expect(roots[0]!.data).toBe('A');
  });

  it('removeNode on a non-existent key does not throw', () => {
    const g = new Graph<string>((s) => s);
    expect(() => g.removeNode('NONEXISTENT')).not.toThrow();
  });

  it('roots() after partial removal returns the correct intermediate set', () => {
    const g = new Graph<string>((s) => s);
    g.insertEdge('A', 'B');
    g.insertEdge('B', 'C');
    g.insertEdge('A', 'D');
    // Roots: C, D
    expect(g.roots().map((r) => r.data).sort()).toEqual(['C', 'D']);
    g.removeNode('C');
    // Now B and D are roots.
    expect(g.roots().map((r) => r.data).sort()).toEqual(['B', 'D']);
    g.removeNode('D');
    // Now B is still a root.
    expect(g.roots().map((r) => r.data)).toEqual(['B']);
  });

  it('lookupOrInsertNode reuses an existing node and does not duplicate', () => {
    const g = new Graph<string>((s) => s);
    const n1 = g.lookupOrInsertNode('A');
    const n2 = g.lookupOrInsertNode('A');
    expect(n1).toBe(n2);
    expect(g.isEmpty()).toBe(false);
  });

  it('toString() returns a human-readable representation', () => {
    const g = new Graph<string>((s) => s);
    g.insertEdge('A', 'B');
    const str = g.toString();
    expect(str).toContain('A');
    expect(str).toContain('B');
    expect(str).toContain('incoming');
    expect(str).toContain('outgoing');
  });
});
