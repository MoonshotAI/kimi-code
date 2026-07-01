import Dagre from '@dagrejs/dagre';

import type { Edge, ServiceNode, ServiceScope } from '../../analyzer/types';

/** Rough node box used for dagre spacing; must approximately match the CSS in GraphView. */
const NODE_WIDTH = 220;
const NODE_HEIGHT = 48;

/** Horizontal gap between scope bands when `groupByScope` is on. */
const BAND_GAP = 120;

export interface LayoutOptions {
  /**
   * Layout direction. Defaults to `RL` so base primitives (nodes with no
   * outgoing dependencies) sit on the left and facades sit on the right —
   * dependency arrows then flow naturally from right-to-left along the
   * "depends on" relation without needing rank hacks.
   */
  direction?: 'LR' | 'RL' | 'TB' | 'BT';
  /** Space between layers (rank direction). */
  ranksep?: number;
  /** Space between nodes within a layer. */
  nodesep?: number;
  /**
   * When true, split the graph by `service.scope` and run dagre three times
   * (App / Session / Agent), then stack the results vertically with
   * `BAND_GAP` between bands. Inter-scope edges are drawn by React Flow as
   * cross-band connectors. When false (default), one dagre run over the
   * whole set.
   */
  groupByScope?: boolean;
}

export interface ScopeBand {
  scope: ServiceScope;
  /** Top-left corner of the band's bounding box. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
  /** Populated only when `groupByScope` is true — one entry per scope. */
  bands?: ScopeBand[];
}

/**
 * Horizontal ordering of scope bands, outer-most to inner-most: App on the
 * left (base / longest-lived), Agent on the right (built on top). This
 * matches the "depends on" flow — arrows from Agent go leftward into
 * Session and App, which lines up with the intra-scope RL direction.
 */
const BAND_ORDER: ServiceScope[] = ['App', 'Session', 'Agent'];

/**
 * Run dagre over the filtered node/edge set and return a `ServiceNode.id` →
 * position map. When `groupByScope` is on, we run dagre three times (one per
 * scope) on the intra-scope edges only, then stack the sub-layouts vertically.
 *
 * Layout is stable for a given input set — dagre picks node ranks
 * deterministically — so filter toggles won't jiggle unrelated nodes.
 * dagre handles 100+ nodes / 400+ edges in <50ms so re-running per filter
 * change is fine.
 */
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
    // Only intra-scope edges shape this band's layout; inter-scope edges
    // are rendered across bands by React Flow.
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

  // Isolated nodes (no edges at all) have no ranking constraint, so dagre
  // parks them at rank 0 — which is the *source* rank (rightmost in RL).
  // Semantically they don't depend on anything, so they belong with the
  // base primitives on the sink side (leftmost in RL). Pin them to
  // `rank: 'max'` — dagre-speak for "put in the sink rank" — regardless of
  // rankdir; that keeps the intent stable if the direction is flipped later.
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
    g.setNode(s.id, {
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      ...(isolated ? { rank: 'max' } : {}),
    });
    known.add(s.id);
  }
  for (const e of edges) {
    // Multigraph: label each parallel edge by kind so dagre keeps them
    // distinct instead of collapsing. Unresolved edges point at pseudo
    // targets (`unresolved::TOKEN`) that don't have layout nodes, so they
    // are skipped here — the frontend renders them separately if needed.
    if (!known.has(e.from) || !known.has(e.to)) continue;
    g.setEdge(e.from, e.to, {}, e.kind);
  }

  Dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  for (const s of services) {
    const n = g.node(s.id);
    if (!n) continue;
    // Dagre returns center coordinates; React Flow uses top-left.
    positions.set(s.id, { x: n.x - NODE_WIDTH / 2, y: n.y - NODE_HEIGHT / 2 });
  }
  const { width = 0, height = 0 } = g.graph();
  return { positions, width, height };
}
