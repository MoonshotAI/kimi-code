export type ArtexExplorationStatus = 'open' | 'achieved' | 'failed';

export const ARTEX_EXPLORATION_STATUSES: readonly ArtexExplorationStatus[] = [
  'open',
  'achieved',
  'failed',
];

export interface ArtexExploration {
  readonly id: number;
  description?: string;
  goal: string;
  status: ArtexExplorationStatus;
  roundNo: number;
  goalMetAt?: string;
  goalMetReason?: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface ArtexExplorationAnchor {
  readonly nodeId: number;
  readonly assetId: number;
}

export type ArtexTaskConstraintKind = 'allow' | 'deny';

export interface ArtexTaskConstraint {
  readonly id: number;
  readonly explorationId: number;
  kind: ArtexTaskConstraintKind;
  text: string;
  origin?: string;
  readonly createdAt: string;
  updatedAt: string;
}
