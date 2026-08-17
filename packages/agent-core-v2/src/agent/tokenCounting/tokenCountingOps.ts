/**
 * `tokenCounting` domain — the measured-anchor ledger state
 * (`tokenCountingKey`) and the transient events maintaining it.
 *
 * State is `{ anchors, tokens }`: `anchors` is the live history of measured
 * context sizes — one entry per measured LLM exchange (`measured: true`), or
 * a single rebased entry after clear / compaction (`measured` marks whether
 * the value is fully LLM-reported). Folding the ledger lets undo restore the
 * REAL size of a surviving prefix instead of re-estimating it. `tokens` is
 * the display value carried by the most recent event, kept for status
 * emission because folds cannot estimate.
 *
 * All three events are live-only (transient): the ledger is not a v1 record
 * type, so resume starts empty and reads estimates until the next measured
 * exchange — same contract as the previous single-anchor model. Each fold
 * keeps the same reference on a no-op and emits the `agent.status.updated`
 * contextTokens slice live (never on replay).
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { z } from 'zod';

import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

export interface TokenAnchor {
  readonly length: number;
  readonly tokens: number;
  readonly measured: boolean;
}

export interface TokenCountingState {
  readonly anchors: readonly TokenAnchor[];
  readonly tokens: number;
}

const sizeSchema = z.object({ length: z.number(), tokens: z.number() });

export class TokenCountingMeasured extends Event2<z.infer<typeof sizeSchema>> {
  static override readonly type = 'token_counting.measured';
  static override readonly durable = true;
  static override readonly schema = sizeSchema;
}
export interface TokenCountingMeasured extends z.infer<typeof sizeSchema> {}

export class TokenCountingTruncated extends Event2<z.infer<typeof sizeSchema>> {
  static override readonly type = 'token_counting.truncated';
  static override readonly durable = true;
  static override readonly schema = sizeSchema;
}
export interface TokenCountingTruncated extends z.infer<typeof sizeSchema> {}

const rebaseSchema = sizeSchema.extend({ measured: z.boolean() });

export class TokenCountingRebased extends Event2<z.infer<typeof rebaseSchema>> {
  static override readonly type = 'token_counting.rebased';
  static override readonly durable = true;
  static override readonly schema = rebaseSchema;
}
export interface TokenCountingRebased extends z.infer<typeof rebaseSchema> {}

function anchorsEqual(a: readonly TokenAnchor[], b: readonly TokenAnchor[]): boolean {
  return a.length === b.length && a.every((anchor, i) => anchor === b[i]);
}

export const tokenCountingKey = defineState(
  'tokenCounting',
  (): TokenCountingState => ({ anchors: [], tokens: 0 }),
).replayable({ schema: z.custom<TokenCountingState>() })
  .on(TokenCountingMeasured, (s, e, ctx) => {
    const length = normalizeAnchorLength(e.length);
    const tokens = Math.max(0, e.tokens);
    const anchor: TokenAnchor = { length, tokens, measured: true };
    const anchors = [...s.anchors.filter((a) => a.length < length), anchor];
    if (!(s.tokens === tokens && anchorsEqual(s.anchors, anchors))) {
      s.anchors = anchors;
      s.tokens = tokens;
    }
    ctx.emit(new AgentStatusUpdated({ contextTokens: s.tokens }));
  })
  .on(TokenCountingTruncated, (s, e, ctx) => {
    const length = normalizeAnchorLength(e.length);
    const tokens = Math.max(0, e.tokens);
    const anchors = s.anchors.filter((a) => a.length <= length);
    if (!(s.tokens === tokens && anchorsEqual(s.anchors, anchors))) {
      s.anchors = anchors;
      s.tokens = tokens;
    }
    ctx.emit(new AgentStatusUpdated({ contextTokens: s.tokens }));
  })
  .on(TokenCountingRebased, (s, e, ctx) => {
    const length = normalizeAnchorLength(e.length);
    const tokens = Math.max(0, e.tokens);
    const anchors: TokenAnchor[] = [{ length, tokens, measured: e.measured }];
    if (!(s.tokens === tokens && anchorsEqual(s.anchors, anchors))) {
      s.anchors = anchors;
      s.tokens = tokens;
    }
    ctx.emit(new AgentStatusUpdated({ contextTokens: s.tokens }));
  });

function normalizeAnchorLength(length: number): number {
  if (!Number.isFinite(length)) return 0;
  return Math.max(0, Math.floor(length));
}
