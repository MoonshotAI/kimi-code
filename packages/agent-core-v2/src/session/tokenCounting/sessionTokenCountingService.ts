import type { AgentContext } from '#/agent/agentContext/agentContext';
import { IConfigService } from '#/app/config/config';
import { readTokenCountingStrategy } from '#/features/tokenCounting/configSection';
import type {
  ContextSize,
  TokenCountingRebaseInput,
  TokenCountingRequest,
  TokenCountingStrategy,
} from '#/features/tokenCounting/tokenCounting';
import {
  AgentTokenCounting,
  type TokenCountingRuntime,
} from '#/features/tokenCounting/tokenCountingAgentRuntime';
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

import { ISessionTokenCountingService } from './sessionTokenCounting';

export class SessionTokenCountingService implements ISessionTokenCountingService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {}

  get strategy(): TokenCountingStrategy {
    return readTokenCountingStrategy(this.config);
  }

  get(agent: AgentContext, start?: number, end?: number): ContextSize {
    return this.runtime(agent).get(start, end);
  }

  measured(
    agent: AgentContext,
    input: readonly Message[],
    _output: readonly Message[],
    usage: TokenUsage,
  ): void {
    void this.runtime(agent).measured(input, usage);
  }

  latestMeasured(agent: AgentContext): number {
    return this.runtime(agent).latestMeasured();
  }

  statusSize(agent: AgentContext): number {
    return this.runtime(agent).statusSize();
  }

  recordTruncation(agent: AgentContext, cutIndex: number): void {
    void this.runtime(agent).recordTruncation(cutIndex);
  }

  rebase(agent: AgentContext, input: TokenCountingRebaseInput): void {
    void this.runtime(agent).rebase(input);
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

  private runtime(agent: AgentContext): TokenCountingRuntime {
    return this.agentLifecycle.resolve(agent, AgentTokenCounting);
  }
}
