/**
 * Local copies of the wire contract types from the retired engine package
 * `@moonshot-ai/agent-core-v2`, ported verbatim from:
 *   - `packages/agent-core-v2/src/kosong/contract/inspection.ts`
 *   - `packages/agent-core-v2/src/kosong/contract/usage.ts`
 *
 * Type-only — kimi-inspect never constructs these, it only types proxy
 * results with them.
 */

/**
 * `kosong/contract` — resolution-provenance annotations: every settled field
 * of a resolved `Model` has an origin, and `InspectionSource` is the L0
 * vocabulary for naming it.
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
 * `kosong/contract` — the common token-usage breakdown for a single LLM
 * generation.
 */
export interface TokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}
