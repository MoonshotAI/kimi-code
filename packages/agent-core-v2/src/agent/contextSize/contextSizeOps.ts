/**
 * `contextSize` domain (L4) — wire Model (`ContextSizeModel`) and the
 * `context_size.measured` (`contextSizeMeasured`) Op for the last measured
 * context token count.
 *
 * Declares the deterministic measured prefix as `{ length, tokens }` (initial
 * `{ 0, 0 }`): the length (in messages) and total token count of the most
 * recent `context_size.measured` record. That record is written from two live
 * paths: `llmRequester` after each measured exchange (a true LLM-reported
 * count), and `contextMemoryService` cascading alongside every context mutation
 * that changes the measured prefix (`clear` resets, `applyCompaction` adopts
 * `tokensAfter`, and `undo` rebases to an estimate when the aggregate is
 * truncated); `append` is intentionally not cascaded because new messages are
 * the unmeasured tail. The Op is live-only because `context_size.measured` is
 * not a v1 record type: resume starts from `{ 0, 0 }` and
 * `contextSizeService.get()` estimates until the next measured exchange.
 * `apply` is pure — it normalizes the payload and returns the SAME reference
 * on a no-op so the wire's reference-equality gate stays quiet — and carries no
 * non-determinism (the last measured record wins). The sparse
 * `measuredPrefixTokens` array and the per-message live `estimates` are
 * intentionally NOT in the Model. Consumed by the Agent-scope
 * `contextSizeService`.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

export interface ContextSizeState {
  readonly length: number;
  readonly tokens: number;
}

export const ContextSizeModel = defineModel<ContextSizeState>('contextSize', () => ({
  length: 0,
  tokens: 0,
}));

declare module '#/wire/types' {
  interface TransientOpMap {
    'context_size.measured': typeof contextSizeMeasured;
  }
}

export const contextSizeMeasured = ContextSizeModel.defineOp('context_size.measured', {
  schema: z.object({ length: z.number(), tokens: z.number() }),
  persist: false,
  apply: (s, p) => {
    const length = normalizeMeasuredLength(p.length);
    const tokens = Math.max(0, p.tokens);
    if (s.length === length && s.tokens === tokens) return s;
    return { length, tokens };
  },
  toEvent: (_p, state) => ({
    type: 'agent.status.updated' as const,
    contextTokens: state.tokens,
  }),
});

function normalizeMeasuredLength(length: number): number {
  if (!Number.isFinite(length)) return 0;
  return Math.max(0, Math.floor(length));
}
