import { createHash } from 'node:crypto';

import type { ArtexEdgeRelation, ArtexNodeKind } from '#/features/artex/protocol/index';
import { isFoldableArtexNodeKind } from '#/features/artex/protocol/index';

export interface ColdGraphNode {
  readonly id: number;
  readonly kind: ArtexNodeKind;
  readonly state: string;
}

export interface ColdGraphEdge {
  readonly from: number;
  readonly rel: ArtexEdgeRelation;
  readonly to: number;
}

export interface ColdParams {
  readonly r: number;
  readonly k: number;
}

export const DEFAULT_COLD_PARAMS: ColdParams = { r: 6, k: 2 };

export interface ColdStampOp {
  readonly id: number;
  readonly set: boolean;
  readonly round: number;
}

export interface ColdBlock {
  readonly members: readonly number[];
  readonly anchors: readonly number[];
}

function isLiveIntent(node: ColdGraphNode): boolean {
  if (node.kind !== 'intent') return false;
  switch (node.state) {
    case 'open':
    case 'running':
    case 'paused':
      return true;
    default:
      return false;
  }
}

export class ColdGraph {
  private readonly nodes = new Map<number, ColdGraphNode>();
  private readonly children = new Map<number, number[]>();
  private readonly parents = new Map<number, number[]>();

  constructor(nodes: readonly ColdGraphNode[], edges: readonly ColdGraphEdge[]) {
    for (const n of nodes) this.nodes.set(n.id, n);
    for (const e of edges) {
      if (e.rel === 'covers') continue;
      if (!this.nodes.has(e.from) || !this.nodes.has(e.to)) continue;
      this.pushInto(this.children, e.from, e.to);
      this.pushInto(this.parents, e.to, e.from);
    }
  }

  private pushInto(map: Map<number, number[]>, key: number, value: number): void {
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, [value]);
    } else {
      existing.push(value);
    }
  }

  private childrenOf(id: number): readonly number[] {
    return this.children.get(id) ?? [];
  }

  private parentsOf(id: number): readonly number[] {
    return this.parents.get(id) ?? [];
  }

  hotSet(): Set<number> {
    const hot = new Set<number>();
    const stack: number[] = [];
    for (const n of this.nodes.values()) {
      if (isLiveIntent(n)) stack.push(n.id);
    }
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (hot.has(id)) continue;
      hot.add(id);
      for (const parent of this.parentsOf(id)) stack.push(parent);
    }
    for (const n of this.nodes.values()) {
      if (!isLiveIntent(n)) continue;
      for (const child of this.childrenOf(n.id)) hot.add(child);
    }
    return hot;
  }

  structuralCold(hot: ReadonlySet<number>): Set<number> {
    const cold = new Set<number>();
    for (const [id, n] of this.nodes) {
      if (isFoldableArtexNodeKind(n.kind) && !hot.has(id)) cold.add(id);
    }
    return cold;
  }

  eligibleCold(
    structCold: ReadonlySet<number>,
    coldSince: ReadonlyMap<number, number | undefined>,
    roundNo: number,
    params: ColdParams = DEFAULT_COLD_PARAMS,
  ): Set<number> {
    const out = new Set<number>();
    for (const id of structCold) {
      const cs = coldSince.get(id);
      if (cs !== undefined && roundNo - cs >= params.r) out.add(id);
    }
    return out;
  }

  group(set: ReadonlySet<number>, params: ColdParams = DEFAULT_COLD_PARAMS): ColdBlock[] {
    const uf = new UnionFind(set);
    for (const from of set) {
      for (const to of this.childrenOf(from)) {
        if (set.has(to)) uf.union(from, to);
      }
    }
    const byParent = new Map<number, number[]>();
    for (const ids of uf.components().values()) {
      if (ids.length !== 1) continue;
      const s = ids[0]!;
      for (const parent of this.parentsOf(s)) {
        if (this.nodes.get(parent)?.kind === 'digest') continue;
        this.pushInto(byParent, parent, s);
      }
    }
    for (const sibs of byParent.values()) {
      if (sibs.length < 2) continue;
      for (let i = 1; i < sibs.length; i++) uf.union(sibs[0]!, sibs[i]!);
    }
    const blocks: ColdBlock[] = [];
    for (const ids of uf.components().values()) {
      if (ids.length < params.k) continue;
      const members = [...ids].toSorted((a, b) => a - b);
      const memberSet = new Set(members);
      const anchorSet = new Set<number>();
      for (const m of members) {
        for (const parent of this.parentsOf(m)) {
          if (memberSet.has(parent)) continue;
          const pn = this.nodes.get(parent);
          if (pn === undefined || pn.kind === 'digest') continue;
          anchorSet.add(parent);
        }
      }
      const anchors = [...anchorSet].toSorted((a, b) => a - b);
      blocks.push({ members, anchors });
    }
    blocks.sort((a, b) => a.members[0]! - b.members[0]!);
    return blocks;
  }
}

export function computeColdStampOps(
  structCold: ReadonlySet<number>,
  coldSince: ReadonlyMap<number, number | undefined>,
  roundNo: number,
): ColdStampOp[] {
  const ops: ColdStampOp[] = [];
  const seen = new Set<number>();
  for (const id of structCold) {
    seen.add(id);
    if (coldSince.get(id) === undefined) ops.push({ id, set: true, round: roundNo });
  }
  for (const [id, cs] of coldSince) {
    if (cs !== undefined && !seen.has(id)) ops.push({ id, set: false, round: 0 });
  }
  ops.sort((a, b) => a.id - b.id);
  return ops;
}

export function blockSignature(
  block: ColdBlock,
  contentVersion: ReadonlyMap<number, number>,
): string {
  const hash = createHash('sha256');
  for (const m of block.members) hash.update(`m:${String(m)}:${String(contentVersion.get(m) ?? 0)};`);
  for (const a of block.anchors) hash.update(`a:${String(a)}:${String(contentVersion.get(a) ?? 0)};`);
  return hash.digest('hex');
}

class UnionFind {
  private readonly parent = new Map<number, number>();

  constructor(set: ReadonlySet<number>) {
    for (const id of set) this.parent.set(id, id);
  }

  find(x: number): number {
    let node = x;
    while (this.parent.get(node) !== node) {
      const grandparent = this.parent.get(this.parent.get(node)!)!;
      this.parent.set(node, grandparent);
      node = grandparent;
    }
    return node;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  components(): Map<number, number[]> {
    const out = new Map<number, number[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      const group = out.get(root);
      if (group === undefined) {
        out.set(root, [id]);
      } else {
        group.push(id);
      }
    }
    return out;
  }
}
