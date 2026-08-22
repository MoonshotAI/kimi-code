import { Disposable } from '#/_base/di/lifecycle';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { agentSpaceOf } from '#/agent/agentContext/agentSpace';
import { agentContextOf } from '#/agent/scopeContext/scopeContext';
import { TurnEnded } from '#/agent/loop/turnOps';
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

import {
  ISessionTokenCountingService,
  type TokenCountingRebaseInput,
} from './sessionTokenCounting';
import { TokenCountingAgentModelDefinition } from './tokenCountingAgentModel';

export class SessionTokenCountingService extends Disposable implements ISessionTokenCountingService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @ISessionEventBus eventBus: ISessionEventBus,
    @IAgentLifecycleService lifecycle: IAgentLifecycleService,
  ) {
    super();
    this._register(
      eventBus.subscribe(TurnEnded, (event) => {
        const handle = lifecycle.findAgentHandle(event.agentId);
        if (handle === undefined) return;
        void agentSpaceOf(agentContextOf(handle)).use(
          TokenCountingAgentModelDefinition,
          (model) => model.recordTurn(event.turnId, this.strategy),
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
    return agentSpaceOf(agent).use(TokenCountingAgentModelDefinition, (model) =>
      model.get(start, end),
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
  }

  latestMeasured(agent: AgentContext): number {
    return agentSpaceOf(agent).use(TokenCountingAgentModelDefinition, (model) =>
      model.latestMeasured(),
    );
  }

  statusSize(agent: AgentContext): number {
    return agentSpaceOf(agent).use(TokenCountingAgentModelDefinition, (model) =>
      model.statusSize(this.strategy),
    );
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
}
