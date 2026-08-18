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
