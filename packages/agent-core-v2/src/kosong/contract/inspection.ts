/**
 * `kosong/contract` domain — resolution-provenance annotations.
 *
 * Every settled field of a resolved `Model` has an origin: an explicit config
 * entry, a model `overrides` block, a built-in registry (provider definition,
 * Anthropic profile table, protocol base catalog), an env-bag fallback, a
 * synthesized computation, or no source at all. `InspectionSource` is the
 * L0 vocabulary for naming that origin; `ResolutionTrace` is the collector
 * the model resolver records into while assembling a Model, so the on-demand
 * inspection view can report *why* a value is what it is — never re-resolving,
 * just reading the trace of that same resolution.
 */

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
