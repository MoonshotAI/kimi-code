import { describe, expect, it } from 'vitest';

import {
  blockSignature,
  ColdGraph,
  computeColdStampOps,
  DEFAULT_COLD_PARAMS,
  type ColdGraphEdge,
  type ColdGraphNode,
} from './coldgraph';

function intent(id: number, state: string): ColdGraphNode {
  return { id, kind: 'intent', state };
}

function fact(id: number): ColdGraphNode {
  return { id, kind: 'fact', state: 'confirmed' };
}

function yields(from: number, to: number): ColdGraphEdge {
  return { from, rel: 'yields', to };
}

function derived(from: number, to: number): ColdGraphEdge {
  return { from, rel: 'derived_from', to };
}

describe('ColdGraph hot/cold', () => {
  it('keeps the whole chain hot when any branch is live', () => {
    const nodes = [intent(1, 'done'), intent(2, 'done'), fact(3), intent(4, 'running')];
    const edges = [derived(1, 2), yields(2, 3), derived(2, 4)];
    const g = new ColdGraph(nodes, edges);
    const hot = g.hotSet();
    for (const id of [1, 2, 4]) expect(hot.has(id)).toBe(true);
    expect(hot.has(3)).toBe(false);
    const structCold = g.structuralCold(hot);
    expect([...structCold]).toEqual([3]);
  });

  it('folds the whole chain into one block once all settled', () => {
    const nodes = [intent(1, 'done'), intent(2, 'done'), fact(3), intent(4, 'done')];
    const edges = [derived(1, 2), yields(2, 3), derived(2, 4)];
    const g = new ColdGraph(nodes, edges);
    const hot = g.hotSet();
    expect(hot.size).toBe(0);
    const structCold = g.structuralCold(hot);
    const stamps = new Map<number, number | undefined>([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
    ]);
    const elig = g.eligibleCold(structCold, stamps, 100);
    expect(elig.size).toBe(4);
    const blocks = g.group(elig);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.members).toEqual([1, 2, 3, 4]);
  });
});

describe('ColdGraph debounce (R=6)', () => {
  it('holds a freshly cooled node until it ages R rounds', () => {
    const nodes = [intent(1, 'done'), fact(2)];
    const edges = [yields(1, 2)];
    const g = new ColdGraph(nodes, edges);
    const structCold = g.structuralCold(g.hotSet());
    const stamps = new Map<number, number | undefined>([
      [1, 98],
      [2, 98],
    ]);
    expect(g.eligibleCold(structCold, stamps, 100).size).toBe(0);
    expect(g.eligibleCold(structCold, stamps, 104).size).toBe(2);
  });
});

describe('ColdGraph grouping (rules ①/②, K=2)', () => {
  it('rescues a flat fan-out of dead leaves under a shared hot parent', () => {
    const nodes = [intent(50, 'exhausted'), intent(77, 'running')];
    const edges = [derived(50, 77)];
    for (let id = 51; id <= 54; id++) {
      nodes.push(fact(id));
      edges.push(yields(50, id));
    }
    const g = new ColdGraph(nodes, edges);
    const hot = g.hotSet();
    expect(hot.has(50)).toBe(true);
    expect(hot.has(77)).toBe(true);
    const structCold = g.structuralCold(hot);
    const stamps = new Map<number, number | undefined>();
    for (let id = 51; id <= 54; id++) stamps.set(id, 1);
    const elig = g.eligibleCold(structCold, stamps, 100);
    const blocks = g.group(elig);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.members).toEqual([51, 52, 53, 54]);
    expect(blocks[0]!.anchors).toEqual([50]);
    expect(blocks[0]!.members).not.toContain(50);
  });

  it('leaves a lone cold child as an unfolded singleton', () => {
    const nodes = [intent(50, 'running'), intent(77, 'running'), fact(51)];
    const edges = [derived(50, 77), yields(50, 51)];
    const g = new ColdGraph(nodes, edges);
    const structCold = g.structuralCold(g.hotSet());
    const elig = g.eligibleCold(structCold, new Map([[51, 1]]), 100);
    expect(g.group(elig)).toHaveLength(0);
  });
});

describe('blockSignature', () => {
  it('is stable under reordering and sensitive to member/anchor version bumps', () => {
    const block = { members: [12, 28, 41], anchors: [50] };
    const cv = new Map([
      [12, 0],
      [28, 0],
      [41, 0],
      [50, 0],
    ]);
    const s1 = blockSignature(block, cv);
    expect(s1).toBe(blockSignature({ members: [12, 28, 41], anchors: [50] }, cv));
    const cv2 = new Map([
      [12, 0],
      [28, 1],
      [41, 0],
      [50, 0],
    ]);
    expect(blockSignature(block, cv2)).not.toBe(s1);
    const cv3 = new Map([
      [12, 0],
      [28, 0],
      [41, 0],
      [50, 1],
    ]);
    expect(blockSignature(block, cv3)).not.toBe(s1);
  });
});

describe('computeColdStampOps', () => {
  it('stamps on first cool, never re-stamps, and clears on revival', () => {
    const structCold = new Set([1, 2]);
    const coldSince = new Map<number, number | undefined>([
      [2, 5],
      [3, 4],
    ]);
    const ops = computeColdStampOps(structCold, coldSince, 10);
    const byId = new Map(ops.map((o) => [o.id, o]));
    expect(byId.get(1)).toEqual({ id: 1, set: true, round: 10 });
    expect(byId.has(2)).toBe(false);
    expect(byId.get(3)?.set).toBe(false);
  });
});

describe('DEFAULT_COLD_PARAMS', () => {
  it('uses R=6 and K=2', () => {
    expect(DEFAULT_COLD_PARAMS).toEqual({ r: 6, k: 2 });
  });
});
