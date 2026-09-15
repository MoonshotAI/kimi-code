/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
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

const sizeSchema = z.object({
  agentId: z.string(),
  length: z.number(),
  tokens: z.number(),
});

export class TokenCountingMeasured extends AgentEvent2<z.infer<typeof sizeSchema>> {
  static override readonly type = 'token_counting.measured';
  static override readonly durable = true;
  static override readonly schema = sizeSchema;
}
export interface TokenCountingMeasured {
  readonly agentId: string;
  readonly length: number;
  readonly tokens: number;
}

export class TokenCountingTruncated extends AgentEvent2<z.infer<typeof sizeSchema>> {
  static override readonly type = 'token_counting.truncated';
  static override readonly durable = true;
  static override readonly schema = sizeSchema;
}
export interface TokenCountingTruncated {
  readonly agentId: string;
  readonly length: number;
  readonly tokens: number;
}

const rebaseSchema = sizeSchema.extend({ measured: z.boolean() });

export class TokenCountingRebased extends AgentEvent2<z.infer<typeof rebaseSchema>> {
  static override readonly type = 'token_counting.rebased';
  static override readonly durable = true;
  static override readonly schema = rebaseSchema;
}
export interface TokenCountingRebased {
  readonly agentId: string;
  readonly length: number;
  readonly tokens: number;
  readonly measured: boolean;
}

const turnRecordedSchema = sizeSchema.extend({ turnId: z.number() });

export class TokenCountingTurnRecorded extends AgentEvent2<z.infer<typeof turnRecordedSchema>> {
  static override readonly type = 'token_counting.turn_recorded';
  static override readonly durable = true;
  static override readonly schema = turnRecordedSchema;
}
export interface TokenCountingTurnRecorded {
  readonly agentId: string;
  readonly length: number;
  readonly tokens: number;
  readonly turnId: number;
}

export function anchorsEqual(a: readonly TokenAnchor[], b: readonly TokenAnchor[]): boolean {
  return a.length === b.length && a.every((anchor, i) => anchor === b[i]);
}

export function normalizeAnchorLength(length: number): number {
  if (!Number.isFinite(length)) return 0;
  return Math.max(0, Math.floor(length));
}

export const ZERO_ANCHOR: TokenAnchor = { length: 0, tokens: 0, measured: true };

export function latestAnchor(state: TokenCountingState, contextLength: number): TokenAnchor {
  const anchors = state.anchors;
  for (let i = anchors.length - 1; i >= 0; i--) {
    const anchor = anchors[i]!;
    if (anchor.length <= contextLength) return anchor;
  }
  return ZERO_ANCHOR;
}

export const tokenCountingKey = defineState(
  'tokenCounting',
  (): TokenCountingState => ({ anchors: [], tokens: 0 }),
)
  .replayable({ schema: z.custom<TokenCountingState>() })
  .on(TokenCountingMeasured, (state, event, ctx) => {
    const length = normalizeAnchorLength(event.length);
    const tokens = Math.max(0, event.tokens);
    const anchor: TokenAnchor = { length, tokens, measured: true };
    const anchors = [...state.anchors.filter((a) => a.length < length), anchor];
    if (!(state.tokens === tokens && anchorsEqual(state.anchors, anchors))) {
      state.anchors = anchors;
      state.tokens = tokens;
    }
    ctx.emit(new AgentStatusUpdated({ agentId: event.agentId, contextTokens: state.tokens }));
  })
  .on(TokenCountingTruncated, (state, event, ctx) => {
    const length = normalizeAnchorLength(event.length);
    const tokens = Math.max(0, event.tokens);
    const anchors = state.anchors.filter((a) => a.length <= length);
    if (!(state.tokens === tokens && anchorsEqual(state.anchors, anchors))) {
      state.anchors = anchors;
      state.tokens = tokens;
    }
    ctx.emit(new AgentStatusUpdated({ agentId: event.agentId, contextTokens: state.tokens }));
  })
  .on(TokenCountingRebased, (state, event, ctx) => {
    const length = normalizeAnchorLength(event.length);
    const tokens = Math.max(0, event.tokens);
    const anchors: TokenAnchor[] = [{ length, tokens, measured: event.measured }];
    if (!(state.tokens === tokens && anchorsEqual(state.anchors, anchors))) {
      state.anchors = anchors;
      state.tokens = tokens;
    }
    ctx.emit(new AgentStatusUpdated({ agentId: event.agentId, contextTokens: state.tokens }));
  })
  .on(TokenCountingTurnRecorded, (state, event, ctx) => {
    const length = normalizeAnchorLength(event.length);
    const tokens = Math.max(0, event.tokens);
    const pinned = state.anchors.some((anchor) => anchor.length === length);
    const anchors = pinned
      ? state.anchors
      : [
        ...state.anchors.filter((anchor) => anchor.length < length),
        { length, tokens, measured: false },
      ];
    if (!(state.tokens === tokens && anchorsEqual(state.anchors, anchors))) {
      state.anchors = anchors;
      state.tokens = tokens;
    }
    ctx.emit(new AgentStatusUpdated({ agentId: event.agentId, contextTokens: state.tokens }));
  });
