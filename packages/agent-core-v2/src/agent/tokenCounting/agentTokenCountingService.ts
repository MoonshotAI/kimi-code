import { Disposable } from '#/_base/di/lifecycle';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { contextMemoryKey } from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import type {
  ContextSize,
  TokenCountingRequest,
  TokenCountingStrategy,
} from '#/agent/tokenCounting/tokenCounting';
import {
  TOKEN_COUNTING_SECTION,
  type TokenCountingConfig,
} from '#/agent/tokenCounting/configSection';
import {
  latestAnchor,
  tokenCountingKey,
  TokenCountingMeasured,
  TokenCountingRebased,
  TokenCountingTruncated,
  TokenCountingTurnRecorded,
  type TokenCountingState,
} from '#/agent/tokenCounting/tokenCountingOps';
import { IConfigService } from '#/app/config/config';
import { ISessionEventBus } from '#/app/event/eventBus';
import type { Message } from '#/llm-adapter/contract/message';
import type { ToolDescription as Tool } from '#human/llm/message';
import {
  estimateTokens,
  estimateTokensForMessage,
  estimateTokensForMessages,
  estimateTokensForTools,
} from '#/llm-adapter/contract/tokens';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  ISessionTokenCountingService,
  type TokenCountingRebaseInput,
} from '#/session/tokenCounting/sessionTokenCounting';
import type { TokenUsage } from '#human/llm/usage';

export class AgentTokenCountingService extends Disposable implements ISessionTokenCountingService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly states: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IConfigService private readonly config: IConfigService,
    @ISessionEventBus eventBus: ISessionEventBus,
  ) {
    super();
    this.states.contributeState(tokenCountingKey);
    this._register(
      eventBus.subscribe(TurnEnded, (event) => {
        if (event.agentId !== this.scopeContext.agentId) return;
        const context = this.states.get(contextMemoryKey) as readonly ContextMessage[];
        void this.dispatcher.dispatch(
          new TokenCountingTurnRecorded({
            agentId: event.agentId,
            turnId: event.turnId,
            length: context.length,
            tokens: this.statusSizeFrom(this.states.get(tokenCountingKey), context, this.strategy),
          }),
        );
      }),
    );
  }

  get strategy(): TokenCountingStrategy {
    return (
      this.config.get<TokenCountingConfig>(TOKEN_COUNTING_SECTION)?.strategy ??
      'measured+estimated'
    );
  }

  get(agent: AgentContext, start?: number, end?: number): ContextSize {
    this.assertIssued(agent);
    return this.getFrom(
      this.states.get(tokenCountingKey),
      this.states.get(contextMemoryKey) as readonly ContextMessage[],
      start,
      end,
    );
  }

  measured(
    agent: AgentContext,
    input: readonly Message[],
    output: readonly Message[],
    usage: TokenUsage,
  ): void {
    this.assertIssued(agent);
    const context = this.states.get(contextMemoryKey) as readonly ContextMessage[];
    if (!matchesContext(input, context)) return;
    void this.dispatcher.dispatch(
      new TokenCountingMeasured({
        agentId: agent.agentId,
        length: context.length,
        tokens: tokenUsageTotal(usage),
      }),
    );
  }

  latestMeasured(agent: AgentContext): number {
    this.assertIssued(agent);
    return this.latestMeasuredFrom(this.states.get(tokenCountingKey));
  }

  statusSize(agent: AgentContext): number {
    this.assertIssued(agent);
    return this.statusSizeFrom(
      this.states.get(tokenCountingKey),
      this.states.get(contextMemoryKey) as readonly ContextMessage[],
      this.strategy,
    );
  }

  recordTruncation(agent: AgentContext, cutIndex: number): void {
    this.assertIssued(agent);
    if (!this.states.get(tokenCountingKey).anchors.some((anchor) => anchor.length > cutIndex)) {
      return;
    }
    void this.dispatcher.dispatch(
      new TokenCountingTruncated({
        agentId: agent.agentId,
        length: cutIndex,
        tokens: this.getFrom(
          this.states.get(tokenCountingKey),
          this.states.get(contextMemoryKey) as readonly ContextMessage[],
          0,
          cutIndex,
        ).size,
      }),
    );
  }

  rebase(agent: AgentContext, input: TokenCountingRebaseInput): void {
    this.assertIssued(agent);
    void this.dispatcher.dispatch(
      new TokenCountingRebased({
        agentId: agent.agentId,
        length: input.length,
        tokens: input.tokens,
        measured: input.measured,
      }),
    );
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

  private getFrom(
    state: TokenCountingState,
    context: readonly ContextMessage[],
    start?: number,
    end?: number,
  ): ContextSize {
    const from = normalizeSliceIndex(start ?? 0, context.length);
    const to = normalizeSliceIndex(end ?? context.length, context.length);
    const anchor = latestAnchor(state, context.length);
    const measuredEnd = Math.min(to, anchor.length);
    const estimatedStart = Math.max(from, anchor.length);
    const measured =
      from === 0 && measuredEnd === anchor.length
        ? anchor.tokens
        : estimateTokensForMessages(context.slice(from, measuredEnd));
    const estimated = estimateTokensForMessages(context.slice(estimatedStart, to));
    return { size: measured + estimated, measured, estimated };
  }

  private latestMeasuredFrom(state: TokenCountingState): number {
    const anchors = state.anchors;
    for (let i = anchors.length - 1; i >= 0; i--) {
      if (anchors[i]!.measured) return anchors[i]!.tokens;
    }
    return 0;
  }

  private statusSizeFrom(
    state: TokenCountingState,
    context: readonly ContextMessage[],
    strategy: TokenCountingStrategy,
  ): number {
    if (strategy === 'measured') return this.latestMeasuredFrom(state);
    if (strategy === 'estimated') return estimateTokensForMessages(context);
    return Math.max(this.getFrom(state, context).size, this.latestMeasuredFrom(state));
  }

  private assertIssued(agent: AgentContext): void {
    if (agent !== this.scopeContext.agentContext) {
      throw new Error(
        `Agent ${agent.agentId}:${String(agent.generation)} is not a lifecycle-issued context`,
      );
    }
  }
}

function matchesContext(input: readonly Message[], context: readonly ContextMessage[]): boolean {
  if (input.length !== context.length) return false;
  for (let index = 0; index < input.length; index++) {
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
