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
