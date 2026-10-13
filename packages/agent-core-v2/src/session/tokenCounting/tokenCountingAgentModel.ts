import { z } from 'zod';

import { contextMemoryKey } from '#/agent/contextMemory/contextOps';
import { profileKey } from '#/agent/profile/profileOps';
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
import type { Message } from '#/llm-adapter/contract/message';
import { estimateTokensForMessages } from '#/llm-adapter/contract/tokens';
import { inputTotal, type TokenUsage } from '#human/llm/usage';
import { AgentModel, defineAgentModel, type AgentModelContext } from '#/state/agentModel';

import type { TokenCountingRebaseInput } from './sessionTokenCounting';

const ZERO_ANCHOR: TokenAnchor = { length: 0, tokens: 0, measured: true };
const DEFAULT_ESTIMATE_CALIBRATION = 1;
const MIN_ESTIMATE_CALIBRATION = 0.5;
const MAX_ESTIMATE_CALIBRATION = 4;
const CALIBRATION_SMOOTHING = 0.5;

function clampCalibration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_ESTIMATE_CALIBRATION;
  return Math.min(MAX_ESTIMATE_CALIBRATION, Math.max(MIN_ESTIMATE_CALIBRATION, value));
}

export class TokenCountingAgentModel extends AgentModel<TokenCountingState> {
  constructor(context: AgentModelContext) {
    super(context);
    this.on(TokenCountingMeasured, (event) => {
      const length = normalizeAnchorLength(event.length);
      const tokens = Math.max(0, event.tokens);
      const anchor: TokenAnchor = {
        length,
        tokens,
        measured: true,
        inputTokens: event.inputTokens,
        envelopeHash: event.envelopeHash,
      };
      const committed = this._state();
      const modelAlias = this.currentModelAlias();
      const modelChanged =
        modelAlias !== undefined &&
        committed.modelAlias !== undefined &&
        modelAlias !== committed.modelAlias;
      const calibration = modelChanged
        ? DEFAULT_ESTIMATE_CALIBRATION
        : this.nextCalibration(committed, length, tokens, event.inputTokens, event.envelopeHash);
      const anchors = [...committed.anchors.filter((a) => a.length < length), anchor];
      if (
        !(
          committed.tokens === tokens &&
          anchorsEqual(committed.anchors, anchors) &&
          committed.calibration === calibration &&
          committed.modelAlias === (modelAlias ?? committed.modelAlias)
        )
      ) {
        this.state.anchors = anchors;
        this.state.tokens = tokens;
        this.state.calibration = calibration;
        this.state.modelAlias = modelAlias ?? committed.modelAlias;
      }
      void this.emit(new AgentStatusUpdated({ agentId: event.agentId, contextTokens: tokens }));
    });
    this.on(TokenCountingTruncated, (event) => {
      const length = normalizeAnchorLength(event.length);
      const tokens = Math.max(0, event.tokens);
      const committed = this._state();
      const anchors = committed.anchors.filter((a) => a.length <= length);
      if (!(committed.tokens === tokens && anchorsEqual(committed.anchors, anchors))) {
        this.state.anchors = anchors;
        this.state.tokens = tokens;
      }
      void this.emit(new AgentStatusUpdated({ agentId: event.agentId, contextTokens: tokens }));
    });
    this.on(TokenCountingRebased, (event) => {
      const length = normalizeAnchorLength(event.length);
      const tokens = Math.max(0, event.tokens);
      const committed = this._state();
      const anchors: TokenAnchor[] = [{ length, tokens, measured: event.measured }];
      if (!(committed.tokens === tokens && anchorsEqual(committed.anchors, anchors))) {
        this.state.anchors = anchors;
        this.state.tokens = tokens;
      }
      void this.emit(new AgentStatusUpdated({ agentId: event.agentId, contextTokens: tokens }));
    });
    this.on(TokenCountingTurnRecorded, (event) => {
      const length = normalizeAnchorLength(event.length);
      const tokens = Math.max(0, event.tokens);
      const committed = this._state();
      if (committed.anchors.some((anchor) => anchor.length === length)) {
        if (committed.tokens !== tokens) {
          this.state.tokens = tokens;
        }
      } else {
        this.state.anchors = [
          ...committed.anchors.filter((anchor) => anchor.length < length),
          { length, tokens, measured: false },
        ];
        this.state.tokens = tokens;
      }
      void this.emit(new AgentStatusUpdated({ agentId: event.agentId, contextTokens: tokens }));
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
    const estimated = Math.round(
      estimateTokensForMessages(context.slice(estimatedStart, to)) * this.calibrationFactor(),
    );
    return { size: measured + estimated, measured, estimated };
  }

  measured(
    input: readonly Message[],
    _output: readonly Message[],
    usage: TokenUsage,
    envelopeHash?: string,
  ): Promise<void> {
    const context = this.context();
    if (!matchesContext(input, context)) return Promise.resolve();
    return this.emit(
      new TokenCountingMeasured({
        agentId: this.agent.agentId,
        length: context.length,
        tokens: tokenUsageTotal(usage),
        inputTokens: inputTotal(usage),
        envelopeHash,
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
    if (strategy === 'estimated') {
      return Math.round(estimateTokensForMessages(this.context()) * this.calibrationFactor());
    }
    return Math.max(this.get().size, this.latestMeasured());
  }

  calibrationFactor(): number {
    const committed = this._state();
    const modelAlias = this.currentModelAlias();
    if (
      modelAlias !== undefined &&
      committed.modelAlias !== undefined &&
      modelAlias !== committed.modelAlias
    ) {
      return DEFAULT_ESTIMATE_CALIBRATION;
    }
    return committed.calibration > 0 ? committed.calibration : DEFAULT_ESTIMATE_CALIBRATION;
  }

  private currentModelAlias(): string | undefined {
    return this.readLegacy(profileKey).modelAlias;
  }

  private nextCalibration(
    committed: TokenCountingState,
    length: number,
    tokens: number,
    inputTokens: number | undefined,
    envelopeHash: string | undefined,
  ): number {
    const current = committed.calibration > 0 ? committed.calibration : DEFAULT_ESTIMATE_CALIBRATION;
    let previous: TokenAnchor | undefined;
    for (let i = committed.anchors.length - 1; i >= 0; i--) {
      const candidate = committed.anchors[i]!;
      if (candidate.measured && candidate.length < length) {
        previous = candidate;
        break;
      }
    }
    if (previous === undefined || previous.inputTokens === undefined || inputTokens === undefined) {
      return current;
    }
    if (
      previous.envelopeHash !== undefined &&
      envelopeHash !== undefined &&
      previous.envelopeHash !== envelopeHash
    ) {
      return current;
    }
    if (inputTokens <= previous.inputTokens) return current;
    const context = this.context();
    const deltaEstimate = estimateTokensForMessages(context.slice(previous.length, length));
    if (deltaEstimate <= 0) return current;
    const ratio = (inputTokens - previous.inputTokens) / deltaEstimate;
    return clampCalibration(current * (1 - CALIBRATION_SMOOTHING) + ratio * CALIBRATION_SMOOTHING);
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
    initial: (): TokenCountingState => ({ anchors: [], tokens: 0, calibration: 1 }),
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
