/**
 * `kosong/contract` domain (L0) — resolution-provenance annotations.
 *
 * Every settled field of a resolved `Model` has an origin: an explicit config
 * entry, a model `overrides` block, a built-in registry (provider definition,
 * Anthropic profile table, protocol base catalog), an env-bag fallback, a
 * synthesized computation, or no source at all. `InspectionSource` is the
 * L0 vocabulary for naming that origin; `ResolutionTrace` is the collector
 * the resolver (`kosong/model`) records into while assembling a Model, so the
 * on-demand `IModelCatalog.inspect` view can report *why* a value is what it
 * is — never re-resolving, just reading the trace of the same resolution
 * `get` served.
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
  /** Human-readable specifics, e.g. `KIMI_API_KEY (provider env bag)`. */
  readonly detail?: string;
}

/**
 * The collector side of a resolution trace. `record` annotates a dot-path of
 * the inspection god object (`model.effective.supportEfforts`,
 * `resolved.auth`, …); `capture` stashes intermediate resolution artifacts
 * (raw record, provider config, auth material, …) the inspector needs to
 * assemble the god object. Trace capture is reference-only — the expensive
 * assembly and secret redaction happen only when `inspect` is called.
 */
export interface ResolutionTrace {
  record(path: string, source: InspectionSource): void;
  capture(key: string, value: unknown): void;
}
