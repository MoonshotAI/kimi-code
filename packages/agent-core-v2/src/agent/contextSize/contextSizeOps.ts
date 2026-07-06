/**
 * `contextSize` domain (L4) — wire Model (`ContextSizeModel`) and the
 * `context_size.measured` (`contextSizeMeasured`) Op for the last measured
 * context token count.
 *
 * Declares the deterministic measured prefix as `{ length, tokens }` (initial
 * `{ 0, 0 }`): the length (in messages) and total token count of the most
 * recent `context_size.measured` record. `apply` is pure — it normalizes the
 * payload and returns the SAME reference on a no-op so the wire's
 * reference-equality gate stays quiet — and carries no non-determinism, so
 * `wire.dispatch(contextSizeMeasured(...))` and `wire.replay` produce identical
 * state (the last measured record wins). The sparse `measuredPrefixTokens`
 * array and the per-message live `estimates` (including the compaction-provided
 * `context.tokens`) are intentionally NOT in the Model: they are inherently
 * live estimates, recomputed on the live read path from the surviving context
 * and never persisted or replayed — mirroring the `goal` domain's
 * `wallClockMs` split (deterministic in the Model, live-only out). Consumed by
 * the Agent-scope `contextSizeService`.
 */

import { defineModel, defineOp } from '#/wire';

export interface ContextSizeState {
  readonly length: number;
  readonly tokens: number;
}

export const ContextSizeModel = defineModel<ContextSizeState>('contextSize', () => ({
  length: 0,
  tokens: 0,
}));

export interface ContextSizeMeasuredPayload {
  readonly length: number;
  readonly tokens: number;
}

export const contextSizeMeasured = defineOp(ContextSizeModel, 'context_size.measured', {
  apply: (s, p: ContextSizeMeasuredPayload): ContextSizeState => {
    const length = normalizeMeasuredLength(p.length);
    const tokens = Math.max(0, p.tokens);
    if (s.length === length && s.tokens === tokens) return s;
    return { length, tokens };
  },
});

function normalizeMeasuredLength(length: number): number {
  if (!Number.isFinite(length)) return 0;
  return Math.max(0, Math.floor(length));
}
