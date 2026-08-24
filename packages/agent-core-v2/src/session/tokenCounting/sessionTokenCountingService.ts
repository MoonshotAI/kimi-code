import { Disposable } from '#/_base/di/lifecycle';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { agentSpaceOf } from '#/agent/agentContext/agentSpace';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { TurnEnded } from '#/agent/loop/turnOps';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IConfigService } from '#/app/config/config';
import { ISessionEventBus } from '#/app/event/eventBus';
import {
  TOKEN_COUNTING_SECTION,
  type TokenCountingConfig,
} from '#/agent/tokenCounting/configSection';
import type {
  ContextSize,
  TokenCountingRequest,
  TokenCountingStrategy,
} from '#/agent/tokenCounting/tokenCounting';
import type { Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import {
  estimateTokens,
  estimateTokensForMessage,
  estimateTokensForMessages,
  estimateTokensForTools,
} from '#/kosong/contract/tokens';
import type { TokenUsage } from '#/kosong/contract/usage';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  ISessionTokenCountingService,
  type TokenCountingRebaseInput,
  type TokenMeasurement,
} from './sessionTokenCounting';
import { TokenCountingAgentModelDefinition } from './tokenCountingAgentModel';

export class SessionTokenCountingService extends Disposable implements ISessionTokenCountingService {
  declare readonly _serviceBrand: undefined;

  private estimatingProjected = false;
  private readonly lastEmitted = new Map<
    string,
    { readonly contextTokens: number; readonly rawContextTokens: number }
  >();

  constructor(
    @IConfigService private readonly config: IConfigService,
    @ISessionEventBus eventBus: ISessionEventBus,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {
    super();
    this._register(
      eventBus.subscribe(TurnEnded, (event) => {
        const agent = agentLifecycle.get(event.agentId);
        if (agent === undefined) return;
        void agentSpaceOf(agent).use(TokenCountingAgentModelDefinition, (model) =>
          model.recordTurn(event.turnId, this.strategy, (tail) =>
            this.estimateProjected(agent, tail),
          ),
        );
      }),
    );
    this._register(
      eventBus.subscribe(ContextSpliced, (event) => {
        const agent = this.agentLifecycle.get(event.agentId);
        if (agent === undefined) return;
        this.publishSizes(agent);
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
    return agentSpaceOf(agent).use(TokenCountingAgentModelDefinition, (model) =>
      model.get(start, end, (tail) => this.estimateProjected(agent, tail)),
    );
  }

  measured(
    agent: AgentContext,
    input: readonly Message[],
    output: readonly Message[],
    usage: TokenUsage,
  ): void {
    void agentSpaceOf(agent).use(TokenCountingAgentModelDefinition, (model) =>
      model.measured(input, output, usage),
    );
    this.publishSizes(agent);
  }

  latestMeasured(agent: AgentContext): number {
    return agentSpaceOf(agent).use(TokenCountingAgentModelDefinition, (model) =>
      model.latestMeasured(),
    );
  }

  latestMeasurement(agent: AgentContext): TokenMeasurement | undefined {
    return agentSpaceOf(agent).use(TokenCountingAgentModelDefinition, (model) =>
      model.latestMeasurement(),
    );
  }

  statusSize(agent: AgentContext): number {
    return agentSpaceOf(agent).use(TokenCountingAgentModelDefinition, (model) =>
      model.statusSize(this.strategy, (tail) => this.estimateProjected(agent, tail)),
    );
  }

  rawSize(agent: AgentContext): number {
    const size = this.get(agent).size;
    const handle = this.agentLifecycle.handleOf(agent.agentId);
    const history = handle?.accessor.get(IAgentContextMemoryService)?.get() ?? [];
    const rawMessages = estimateTokensForMessages(history);
    let projectedMessages: number;
    try {
      const projected = handle?.accessor.get(IAgentContextProjectorService)?.project(history);
      projectedMessages =
        projected === undefined ? rawMessages : estimateTokensForMessages(projected);
    } catch {
      projectedMessages = rawMessages;
    }
    return size + Math.max(0, rawMessages - projectedMessages);
  }

  recordTruncation(agent: AgentContext, cutIndex: number): void {
    void agentSpaceOf(agent).use(TokenCountingAgentModelDefinition, (model) =>
      model.recordTruncation(cutIndex),
    );
  }

  rebase(agent: AgentContext, input: TokenCountingRebaseInput): void {
    void agentSpaceOf(agent).use(TokenCountingAgentModelDefinition, (model) =>
      model.rebase(input),
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

  private publishSizes(agent: AgentContext): void {
    const contextTokens = this.get(agent).size;
    const rawContextTokens = this.rawSize(agent);
    const last = this.lastEmitted.get(agent.agentId);
    if (
      last !== undefined &&
      last.contextTokens === contextTokens &&
      last.rawContextTokens === rawContextTokens
    ) {
      return;
    }
    this.lastEmitted.set(agent.agentId, { contextTokens, rawContextTokens });
    void this.agentLifecycle
      .handleOf(agent.agentId)
      ?.accessor.get(IEventDispatcher)
      ?.dispatch(new AgentStatusUpdated({ agentId: agent.agentId, contextTokens, rawContextTokens }));
  }

  private estimateProjected(agent: AgentContext, messages: readonly ContextMessage[]): number {
    if (this.estimatingProjected) return estimateTokensForMessages(messages);
    this.estimatingProjected = true;
    try {
      const projector = this.agentLifecycle
        .handleOf(agent.agentId)
        ?.accessor.get(IAgentContextProjectorService);
      if (projector === undefined) return estimateTokensForMessages(messages);
      return projector.estimateProjectedTokens(messages);
    } finally {
      this.estimatingProjected = false;
    }
  }
}
