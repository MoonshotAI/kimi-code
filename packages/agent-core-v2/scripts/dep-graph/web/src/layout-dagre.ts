import Dagre from '@dagrejs/dagre';

import type { Edge, ServiceNode, ServiceScope } from '../../analyzer/types';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 48;

const BAND_GAP = 120;

export interface LayoutOptions {
  direction?: 'LR' | 'RL' | 'TB' | 'BT';
  ranksep?: number;
  nodesep?: number;
  groupByScope?: boolean;
  nodeSize?: (id: string) => { width: number; height: number };
}

export interface ScopeBand {
  scope: ServiceScope;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
  bands?: ScopeBand[];
}

const BAND_ORDER: ServiceScope[] = ['App', 'Session', 'Agent'];

export function layoutDagre(
  services: ServiceNode[],
  edges: Edge[],
  options: LayoutOptions = {},
): LayoutResult {
  if (options.groupByScope) return layoutByScope(services, edges, options);
  return runDagre(services, edges, options);
}

function layoutByScope(
  services: ServiceNode[],
  edges: Edge[],
  options: LayoutOptions,
): LayoutResult {
  const byScope = new Map<ServiceScope, ServiceNode[]>();
  for (const s of services) {
    const arr = byScope.get(s.scope);
    if (arr) arr.push(s);
    else byScope.set(s.scope, [s]);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const bands: ScopeBand[] = [];
  let xCursor = 0;
  let totalHeight = 0;

  for (const scope of BAND_ORDER) {
    const scoped = byScope.get(scope);
    if (!scoped || scoped.length === 0) continue;
    const scopedIds = new Set(scoped.map((s) => s.id));
    const scopedEdges = edges.filter((e) => scopedIds.has(e.from) && scopedIds.has(e.to));
    const sub = runDagre(scoped, scopedEdges, options);
    for (const [id, pos] of sub.positions) {
      positions.set(id, { x: pos.x + xCursor, y: pos.y });
    }
    bands.push({ scope, x: xCursor, y: 0, width: sub.width, height: sub.height });
    xCursor += sub.width + BAND_GAP;
    if (sub.height > totalHeight) totalHeight = sub.height;
  }

  return {
    positions,
    width: Math.max(0, xCursor - BAND_GAP),
    height: totalHeight,
    bands,
  };
}

function runDagre(
  services: ServiceNode[],
  edges: Edge[],
  options: LayoutOptions,
): LayoutResult {
  const g = new Dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({
    rankdir: options.direction ?? 'RL',
    ranksep: options.ranksep ?? 90,
    nodesep: options.nodesep ?? 20,
    edgesep: 10,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));

  const degree = new Map<string, number>();
  for (const s of services) degree.set(s.id, 0);
  for (const e of edges) {
    if (!degree.has(e.from) || !degree.has(e.to)) continue;
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }

  const known = new Set<string>();
  for (const s of services) {
    const isolated = (degree.get(s.id) ?? 0) === 0;
    const size = options.nodeSize?.(s.id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
    g.setNode(s.id, {
      width: size.width,
      height: size.height,
      ...(isolated ? { rank: 'max' } : {}),
    });
    known.add(s.id);
  }
  for (const e of edges) {
    if (!known.has(e.from) || !known.has(e.to)) continue;
    g.setEdge(e.from, e.to, {}, e.kind);
  }

  Dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  for (const s of services) {
    const n = g.node(s.id);
    if (!n) continue;
    const size = options.nodeSize?.(s.id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
    positions.set(s.id, { x: n.x - size.width / 2, y: n.y - size.height / 2 });
  }
  const { width = 0, height = 0 } = g.graph();
  return { positions, width, height };
}
