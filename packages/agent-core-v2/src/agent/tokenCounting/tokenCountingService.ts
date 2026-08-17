/**
 * Reports measured and estimated token sizes for the Agent's bounded context
 * window and maintains the persisted measurement-anchor ledger.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { ContextModel } from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import {
  estimateTokens,
  estimateTokensForMessage,
  estimateTokensForMessages,
  estimateTokensForTools,
} from '#/kosong/contract/tokens';
import type { TokenUsage } from '#/kosong/contract/usage';
import { IWireService } from '#/wire/wire';

import { TOKEN_COUNTING_SECTION, type TokenCountingConfig } from './configSection';
import {
  IAgentTokenCountingService,
  type ContextSize,
  type TokenCountingRequest,
  type TokenCountingStrategy,
} from './tokenCounting';
import { TokenCountingModel, tokenCountingMeasured, type TokenAnchor } from './tokenCountingOps';

const ZERO_ANCHOR: TokenAnchor = { length: 0, tokens: 0, measured: true };

export class AgentTokenCountingService extends Disposable implements IAgentTokenCountingService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
  }

  get strategy(): TokenCountingStrategy {
    return (
      this.config.get<TokenCountingConfig>(TOKEN_COUNTING_SECTION)?.strategy ??
      'measured+estimated'
    );
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
        : this.estimateMessages(context.slice(from, measuredEnd));
    const estimated = this.estimateMessages(context.slice(estimatedStart, to));
    return { size: measured + estimated, measured, estimated };
  }

  measured(input: readonly Message[], _output: readonly Message[], usage: TokenUsage): void {
    const context = this.context();
    if (!matchesContext(input, context)) return;
    const length = context.length;
    const tokens = tokenUsageTotal(usage);
    this.wire.dispatch(tokenCountingMeasured({ length, tokens }));
  }

  latestMeasured(): number {
    const anchors = this.wire.getModel(TokenCountingModel).anchors;
    for (let i = anchors.length - 1; i >= 0; i--) {
      if (anchors[i]!.measured) return anchors[i]!.tokens;
    }
    return 0;
  }

  statusSize(): number {
    if (this.strategy === 'measured') return this.latestMeasured();
    if (this.strategy === 'estimated') return this.estimateMessages(this.context());
    return Math.max(this.get().size, this.latestMeasured());
  }

  requestSize(request: TokenCountingRequest): number {
    return (
      this.estimateText(request.systemPrompt) +
      this.estimateTools(request.tools) +
      this.estimateMessages(request.messages)
    );
  }

  estimateText(text: string): number {
    return estimateTokens(text);
  }

  estimateMessage(message: Message): number {
    return estimateTokensForMessage(message);
  }

  estimateMessages(messages: readonly Message[]): number {
    return estimateTokensForMessages(messages);
  }

  estimateTools(tools: readonly Tool[]): number {
    return estimateTokensForTools(tools);
  }

  private context(): readonly ContextMessage[] {
    return this.wire.getModel(ContextModel).messages as readonly ContextMessage[];
  }

  private latestAnchor(contextLength: number): TokenAnchor {
    const anchors = this.wire.getModel(TokenCountingModel).anchors;
    for (let i = anchors.length - 1; i >= 0; i--) {
      const anchor = anchors[i]!;
      if (anchor.length <= contextLength) return anchor;
    }
    return ZERO_ANCHOR;
  }
}

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

registerScopedService(
  LifecycleScope.Agent,
  IAgentTokenCountingService,
  AgentTokenCountingService,
  ScopeActivation.OnScopeCreated,
  'tokenCounting',
);
