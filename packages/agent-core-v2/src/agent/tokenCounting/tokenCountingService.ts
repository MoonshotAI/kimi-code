/**
 * `tokenCounting` domain — `IAgentTokenCountingService` implementation.
 *
 * Folds the `tokenCountingKey` anchor ledger with strategy-gated estimates.
 * `get(start?, end?)` resolves the range like `Array.prototype.slice`: the
 * latest anchor valid for the live context (anchors beyond it are stale — a
 * rewrite that did not cascade — and skipped) supplies the REAL prefix
 * count, and the not-yet-anchored tail is estimated per message; sub-ranges
 * of the anchored prefix fall back to per-message estimates (the exact
 * aggregate is only known at anchor boundaries). Both tracks always feed
 * internal logic; the `[token_counting]` strategy only selects the externally
 * reported reading (`statusSize`) — `measured` reports anchors alone,
 * `estimated` reports a pure estimate, the default floors the live size by
 * the last measured total.
 * `measured(input, output, usage)` writes the exchange anchor by dispatching
 * `TokenCountingMeasured` after each measured LLM exchange. The context is
 * read from the `contextMemoryKey` state directly (not
 * via `IAgentContextMemoryService`) so `contextMemory` can depend on this
 * service without a constructor cycle. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { contextMemoryKey } from '#/agent/contextMemory/contextOps';
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
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { TOKEN_COUNTING_SECTION, type TokenCountingConfig } from './configSection';
import {
  IAgentTokenCountingService,
  type ContextSize,
  type TokenCountingRequest,
  type TokenCountingStrategy,
} from './tokenCounting';
import {
  TokenCountingMeasured,
  tokenCountingKey,
  type TokenAnchor,
} from './tokenCountingOps';

const ZERO_ANCHOR: TokenAnchor = { length: 0, tokens: 0, measured: true };

export class AgentTokenCountingService extends Disposable implements IAgentTokenCountingService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IConfigService private readonly config: IConfigService,
    @IAgentStateService private readonly agentState: IAgentStateService,
  ) {
    super();
    this.agentState.contributeState(tokenCountingKey);
  }

  get strategy(): TokenCountingStrategy {
    // `?? default`: unregistered / stubbed config reads (test harnesses) keep
    // the default; the registered section default is 'measured+estimated'.
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
    void this.dispatcher.dispatch(new TokenCountingMeasured({ length, tokens }));
  }

  latestMeasured(): number {
    const anchors = this.agentState.get(tokenCountingKey).anchors;
    for (let i = anchors.length - 1; i >= 0; i--) {
      if (anchors[i]!.measured) return anchors[i]!.tokens;
    }
    return 0;
  }

  statusSize(): number {
    if (this.strategy === 'measured') return this.latestMeasured();
    if (this.strategy === 'estimated') return this.estimateMessages(this.context());
    // The live size can transiently dip below the last measured total while a
    // post-step fold/rewrite leaves the context shorter than the measured
    // prefix (the estimate then excludes the system prompt); the measured
    // total is the better reading there. Every REAL shrink (undo / clear /
    // compaction) rebases the measured model first, so the max only wins in
    // that window.
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
    return this.agentState.get(contextMemoryKey) as readonly ContextMessage[];
  }

  /** Latest anchor still valid for the live context: anchors beyond it are
   *  stale (a rewrite that did not cascade) and skipped. An anchor longer
   *  than the queried range still certifies the range as measured — the
   *  caller clamps with `min(to, anchor.length)`. */
  private latestAnchor(contextLength: number): TokenAnchor {
    const anchors = this.agentState.get(tokenCountingKey).anchors;
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
