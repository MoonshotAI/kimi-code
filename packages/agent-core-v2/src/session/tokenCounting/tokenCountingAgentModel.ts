import { z } from 'zod';

import { contextMemoryKey } from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ContextSize, TokenCountingStrategy } from '#/agent/tokenCounting/tokenCounting';
import {
  anchorsEqual,
  normalizeAnchorLength,
  TokenCountingMeasured,
  TokenCountingRebased,
  TokenCountingTruncated,
  TokenCountingTurnRecorded,
  type TokenAnchor,
  type TokenCountingState,
} from '#/agent/tokenCounting/tokenCountingOps';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import type { Message } from '#/kosong/contract/message';
import { estimateTokensForMessages } from '#/kosong/contract/tokens';
import type { TokenUsage } from '#/kosong/contract/usage';
import { AgentModel, defineAgentModel, type AgentModelContext } from '#/state/agentModel';

import type { TokenCountingRebaseInput } from './sessionTokenCounting';

const ZERO_ANCHOR: TokenAnchor = { length: 0, tokens: 0, measured: true };

export class TokenCountingAgentModel extends AgentModel<TokenCountingState> {
  constructor(context: AgentModelContext) {
    super(context);
    this.on(TokenCountingMeasured, (event) => {
      const length = normalizeAnchorLength(event.length);
      const tokens = Math.max(0, event.tokens);
      const anchor: TokenAnchor = { length, tokens, measured: true };
      const anchors = [...this.state.anchors.filter((a) => a.length < length), anchor];
      if (!(this.state.tokens === tokens && anchorsEqual(this.state.anchors, anchors))) {
        this.state.anchors = anchors;
        this.state.tokens = tokens;
      }
      void this.emit(
        new AgentStatusUpdated({ agentId: event.agentId, contextTokens: this.state.tokens }),
      );
    });
    this.on(TokenCountingTruncated, (event) => {
      const length = normalizeAnchorLength(event.length);
      const tokens = Math.max(0, event.tokens);
      const anchors = this.state.anchors.filter((a) => a.length <= length);
      if (!(this.state.tokens === tokens && anchorsEqual(this.state.anchors, anchors))) {
        this.state.anchors = anchors;
        this.state.tokens = tokens;
      }
      void this.emit(
        new AgentStatusUpdated({ agentId: event.agentId, contextTokens: this.state.tokens }),
      );
    });
    this.on(TokenCountingRebased, (event) => {
      const length = normalizeAnchorLength(event.length);
      const tokens = Math.max(0, event.tokens);
      const anchors: TokenAnchor[] = [{ length, tokens, measured: event.measured }];
      if (!(this.state.tokens === tokens && anchorsEqual(this.state.anchors, anchors))) {
        this.state.anchors = anchors;
        this.state.tokens = tokens;
      }
      void this.emit(
        new AgentStatusUpdated({ agentId: event.agentId, contextTokens: this.state.tokens }),
      );
    });
    this.on(TokenCountingTurnRecorded, (event) => {
      const length = normalizeAnchorLength(event.length);
      const tokens = Math.max(0, event.tokens);
      const pinned = this.state.anchors.some((anchor) => anchor.length === length);
      const anchors = pinned
        ? this.state.anchors
        : [
          ...this.state.anchors.filter((anchor) => anchor.length < length),
          { length, tokens, measured: false },
        ];
      if (!(this.state.tokens === tokens && anchorsEqual(this.state.anchors, anchors))) {
        this.state.anchors = anchors;
        this.state.tokens = tokens;
      }
      void this.emit(
        new AgentStatusUpdated({ agentId: event.agentId, contextTokens: this.state.tokens }),
      );
    });
  }

  get(start?: number, end?: number): ContextSize {
    const context = this.context();
    const from = normalizeSliceIndex(start ?? 0, context.length);
    const to = normalizeSliceIndex(end ?? context.length, context.length);
    const anchor = this.latestAnchor(context.length);
    const measuredEnd = Math.min(to, anchor.length);
    const estimatedStart = Math.max(from, anchor.length);
    const measured =
      from === 0 && measuredEnd === anchor.length
        ? anchor.tokens
        : estimateTokensForMessages(context.slice(from, measuredEnd));
    const estimated = estimateTokensForMessages(context.slice(estimatedStart, to));
    return { size: measured + estimated, measured, estimated };
  }

  measured(
    input: readonly Message[],
    _output: readonly Message[],
    usage: TokenUsage,
  ): Promise<void> {
    const context = this.context();
    if (!matchesContext(input, context)) return Promise.resolve();
    return this.emit(
      new TokenCountingMeasured({
        agentId: this.agent.agentId,
        length: context.length,
        tokens: tokenUsageTotal(usage),
      }),
    );
  }

  latestMeasured(): number {
    const anchors = this.state.anchors;
    for (let i = anchors.length - 1; i >= 0; i--) {
      if (anchors[i]!.measured) return anchors[i]!.tokens;
    }
    return 0;
  }

  statusSize(strategy: TokenCountingStrategy): number {
    if (strategy === 'measured') return this.latestMeasured();
    if (strategy === 'estimated') return estimateTokensForMessages(this.context());
    return Math.max(this.get().size, this.latestMeasured());
  }

  recordTruncation(cutIndex: number): Promise<void> {
    if (!this.state.anchors.some((anchor) => anchor.length > cutIndex)) {
      return Promise.resolve();
    }
    return this.emit(
      new TokenCountingTruncated({
        agentId: this.agent.agentId,
        length: cutIndex,
        tokens: this.get(0, cutIndex).size,
      }),
    );
  }

  rebase(input: TokenCountingRebaseInput): Promise<void> {
    return this.emit(
      new TokenCountingRebased({
        agentId: this.agent.agentId,
        length: input.length,
        tokens: input.tokens,
        measured: input.measured,
      }),
    );
  }

  recordTurn(turnId: number, strategy: TokenCountingStrategy): Promise<void> {
    return this.emit(
      new TokenCountingTurnRecorded({
        agentId: this.agent.agentId,
        turnId,
        length: this.context().length,
        tokens: this.statusSize(strategy),
      }),
    );
  }

  private context(): readonly ContextMessage[] {
    return this.readLegacy(contextMemoryKey) as readonly ContextMessage[];
  }

  private latestAnchor(contextLength: number): TokenAnchor {
    const anchors = this.state.anchors;
    for (let i = anchors.length - 1; i >= 0; i--) {
      const anchor = anchors[i]!;
      if (anchor.length <= contextLength) return anchor;
    }
    return ZERO_ANCHOR;
  }
}

export const TokenCountingAgentModelDefinition = defineAgentModel({
  id: 'tokenCounting',
  model: TokenCountingAgentModel,
  state: {
    initial: (): TokenCountingState => ({ anchors: [], tokens: 0 }),
    schema: z.custom<TokenCountingState>(),
  },
  events: [
    TokenCountingMeasured,
    TokenCountingTruncated,
    TokenCountingRebased,
    TokenCountingTurnRecorded,
  ],
});

function matchesContext(input: readonly Message[], context: readonly ContextMessage[]): boolean {
  if (input.length !== context.length) return false;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== context[index]) return false;
  }
  return true;
}

function tokenUsageTotal(usage: TokenUsage): number {
  return usage.inputCacheRead + usage.inputCacheCreation + usage.inputOther + usage.output;
}

function normalizeSliceIndex(index: number, length: number): number {
  if (index < 0) return Math.max(length + index, 0);
  return Math.min(index, length);
}
