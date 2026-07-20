import { beforeEach, describe, expect, it } from 'vitest';

import { Graph } from '#/_base/di/graph';

describe('Graph', () => {
  let graph: Graph<string>;

  beforeEach(() => {
    graph = new Graph<string>((s) => s);
  });

  it('a fresh graph is empty and has no roots', () => {
    expect(graph.isEmpty()).toBe(true);
    expect(graph.roots()).toEqual([]);
  });

  it('lookupOrInsertNode creates a node lazily and is idempotent', () => {
    expect(graph.isEmpty()).toBe(true);
    const node = graph.lookupOrInsertNode('ddd');
    expect(node.data).toBe('ddd');
    expect(graph.isEmpty()).toBe(false);
    expect(graph.lookupOrInsertNode('ddd')).toBe(node);
  });

  it('removeNode removes the node and updates isEmpty', () => {
    graph.lookupOrInsertNode('ddd');
    expect(graph.isEmpty()).toBe(false);
    graph.removeNode('ddd');
    expect(graph.isEmpty()).toBe(true);
  });

  it('roots: a node with no outgoing edges is a root', () => {
    graph.insertEdge('1', '2');
    let roots = graph.roots();
    expect(roots).toHaveLength(1);
    expect(roots[0]!.data).toBe('2');

    graph.insertEdge('2', '1');
    roots = graph.roots();
    expect(roots).toHaveLength(0);
  });

  it('roots: finds multiple roots in a branching graph', () => {
    graph.insertEdge('1', '2');
    graph.insertEdge('1', '3');
    graph.insertEdge('3', '4');

    const roots = graph.roots();
    expect(roots).toHaveLength(2);
    expect(['2', '4'].every((n) => roots.some((node) => node.data === n))).toBe(true);
  });

  it('insertEdge auto-creates both endpoints', () => {
    graph.insertEdge('a', 'b');
    expect(graph.isEmpty()).toBe(false);
    const a = graph.lookupOrInsertNode('a');
    const b = graph.lookupOrInsertNode('b');
    expect(a.outgoing.has('b')).toBe(true);
    expect(b.incoming.has('a')).toBe(true);
  });

  it('findCycleSlow returns the cycle path or undefined', () => {
    graph.insertEdge('1', '2');
    graph.insertEdge('2', '3');
    expect(graph.findCycleSlow()).toBeUndefined();

    graph.insertEdge('3', '1');
    expect(graph.findCycleSlow()).toBe('1 -> 2 -> 3 -> 1');
  });
});
