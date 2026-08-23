export type InspectionSourceKind =
  | 'config'
  | 'override'
  | 'builtin'
  | 'env'
  | 'synthesized'
  | 'none';

export interface InspectionSource {
  readonly kind: InspectionSourceKind;
  readonly detail?: string;
}

export interface ResolutionTrace {
  record(path: string, source: InspectionSource): void;
  capture(key: string, value: unknown): void;
}
