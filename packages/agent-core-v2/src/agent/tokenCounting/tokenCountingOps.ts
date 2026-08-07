/**
 * `tokenCounting` domain — wire Model (`TokenCountingModel`) and the transient
 * Ops maintaining the measured-anchor ledger.
 *
 * State is `{ anchors, tokens }`: `anchors` is the live history of measured
 * context sizes — one entry per measured LLM exchange (`measured: true`), or a
 * single rebased entry after clear / compaction (`measured` marks whether the
 * value is fully LLM-reported). Folding the ledger lets undo restore the REAL
 * size of a surviving prefix instead of re-estimating it. `tokens` is the
 * display value carried by the most recent Op, kept for `toEvent` / status
 * emission because Ops are pure and cannot estimate.
 *
 * All three Ops are live-only (`persist: false`): the ledger is not a v1
 * record type, so resume starts empty and reads estimates until the next
 * measured exchange — same contract as the previous single-anchor model.
 * `apply` functions are pure and return the SAME reference on a no-op so the
 * wire's reference-equality gate stays quiet.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

export interface TokenAnchor {
  readonly length: number;
  readonly tokens: number;
  readonly measured: boolean;
}

export interface TokenCountingState {
  readonly anchors: readonly TokenAnchor[];
  readonly tokens: number;
}

export const TokenCountingModel = defineModel<TokenCountingState>('tokenCounting', () => ({
  anchors: [],
  tokens: 0,
}));

declare module '#/wire/types' {
  interface TransientOpMap {
    'token_counting.measured': typeof tokenCountingMeasured;
    'token_counting.truncated': typeof tokenCountingTruncated;
    'token_counting.rebased': typeof tokenCountingRebased;
  }
}

const sizeSchema = z.object({ length: z.number(), tokens: z.number() });

function statusEvent(state: TokenCountingState) {
  return { type: 'agent.status.updated' as const, contextTokens: state.tokens };
}

function anchorsEqual(a: readonly TokenAnchor[], b: readonly TokenAnchor[]): boolean {
  return a.length === b.length && a.every((anchor, i) => anchor === b[i]);
}

/** Exchange anchor: a true LLM-reported count for the whole live context. */
export const tokenCountingMeasured = TokenCountingModel.defineOp('token_counting.measured', {
  schema: sizeSchema,
  persist: false,
  apply: (s, p) => {
    const length = normalizeAnchorLength(p.length);
    const tokens = Math.max(0, p.tokens);
    const anchor: TokenAnchor = { length, tokens, measured: true };
    // Non-monotonic guard: a stale/future anchor can never outlive a newer
    // exchange at a shorter context (e.g. after an uncascaded rewrite).
    const anchors = [...s.anchors.filter((a) => a.length < length), anchor];
    if (s.tokens === tokens && anchorsEqual(s.anchors, anchors)) return s;
    return { anchors, tokens };
  },
  toEvent: (_p, state) => statusEvent(state),
});

/** Undo cut: drop anchors beyond the cut; `tokens` is the dispatcher's
 *  precomputed post-cut size, carried for status display only. */
export const tokenCountingTruncated = TokenCountingModel.defineOp('token_counting.truncated', {
  schema: sizeSchema,
  persist: false,
  apply: (s, p) => {
    const length = normalizeAnchorLength(p.length);
    const tokens = Math.max(0, p.tokens);
    const anchors = s.anchors.filter((a) => a.length <= length);
    if (s.tokens === tokens && anchorsEqual(s.anchors, anchors)) return s;
    return { anchors, tokens };
  },
  toEvent: (_p, state) => statusEvent(state),
});

/** Clear / compaction: reset the ledger to a single anchor. Compaction passes
 *  `measured: false` — its `tokensAfter` blends a measured summary with
 *  estimated kept messages and the estimated request overhead (system prompt
 *  + tools), keeping the anchor on the same full-request basis as measured
 *  exchange anchors. */
export const tokenCountingRebased = TokenCountingModel.defineOp('token_counting.rebased', {
  schema: sizeSchema.extend({ measured: z.boolean() }),
  persist: false,
  apply: (s, p) => {
    const length = normalizeAnchorLength(p.length);
    const tokens = Math.max(0, p.tokens);
    const anchors: readonly TokenAnchor[] = [{ length, tokens, measured: p.measured }];
    if (s.tokens === tokens && anchorsEqual(s.anchors, anchors)) return s;
    return { anchors, tokens };
  },
  toEvent: (_p, state) => statusEvent(state),
});

function normalizeAnchorLength(length: number): number {
  if (!Number.isFinite(length)) return 0;
  return Math.max(0, Math.floor(length));
}
