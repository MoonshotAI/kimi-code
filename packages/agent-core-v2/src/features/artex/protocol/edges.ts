export type ArtexEdgeRelation = 'spawns' | 'derived_from' | 'yields' | 'proves' | 'covers';

export const ARTEX_EDGE_RELATIONS: readonly ArtexEdgeRelation[] = [
  'spawns',
  'derived_from',
  'yields',
  'proves',
  'covers',
];

export interface ArtexEdge {
  readonly explorationId: number;
  readonly srcId: number;
  readonly rel: ArtexEdgeRelation;
  readonly dstId: number;
  readonly createdAt: string;
}

export function isValidArtexEdgeRelation(rel: string): rel is ArtexEdgeRelation {
  return (ARTEX_EDGE_RELATIONS as readonly string[]).includes(rel);
}

export function isDerivedViewRelation(rel: ArtexEdgeRelation): boolean {
  switch (rel) {
    case 'covers':
      return true;
    case 'spawns':
    case 'derived_from':
    case 'yields':
    case 'proves':
      return false;
    default: {
      const exhaustive: never = rel;
      return exhaustive;
    }
  }
}
