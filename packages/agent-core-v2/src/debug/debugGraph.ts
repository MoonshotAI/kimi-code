/**
 * `debug` domain — `IDebugGraphService`: the persistent dependency DAG (L5
 * debug surface, plan §5.11).
 *
 * Public contract. `graph()` renders the tree-global dependency graph: nodes
 * are every registered token of every container (union the edge endpoints, so
 * collection tokens that own no registration still appear), edges are the live
 * instance edges (cross-tree) and collection edges, told apart by `kind`.
 * Bound at App scope. All payloads are JSON-serializable wire data.
 */

import type { UnitState } from '#/_base/di/cascadeEngine';
import type { DependencyEdgeKind } from '#/_base/di/dependencyGraph';
import { createDecorator } from '#/_base/di/instantiation';

export interface DebugGraphNode {
  readonly id: string;
  readonly token: string;
  readonly scopePath: string;
  readonly uid?: number;
  readonly state?: UnitState;
}

export interface DebugGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: DependencyEdgeKind;
}

export interface DebugGraph {
  readonly nodes: DebugGraphNode[];
  readonly edges: DebugGraphEdge[];
}

export interface IDebugGraphService {
  readonly _serviceBrand: undefined;

  graph(): DebugGraph;
}

export const IDebugGraphService = createDecorator<IDebugGraphService>('debugGraphService');
