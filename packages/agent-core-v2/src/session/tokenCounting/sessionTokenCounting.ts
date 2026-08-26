import { createDecorator } from '#/_base/di/instantiation';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type {
  ContextSize,
  TokenCountingRequest,
  TokenCountingStrategy,
} from '#/agent/tokenCounting/tokenCounting';
import type { Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import type { TokenUsage } from '#/kosong/contract/usage';

export interface TokenCountingRebaseInput {
  readonly length: number;
  readonly tokens: number;
  readonly measured: boolean;
}

export interface ISessionTokenCountingService {
  readonly _serviceBrand: undefined;

  readonly strategy: TokenCountingStrategy;

  get(agent: AgentContext, start?: number, end?: number): ContextSize;
  measured(
    agent: AgentContext,
    input: readonly Message[],
    output: readonly Message[],
    usage: TokenUsage,
  ): void;
  latestMeasured(agent: AgentContext): number;
  statusSize(agent: AgentContext): number;
  recordTruncation(agent: AgentContext, cutIndex: number): void;
  rebase(agent: AgentContext, input: TokenCountingRebaseInput): void;
  requestSize(request: TokenCountingRequest): number;

  estimateText(text: string): number;
  estimateMessage(message: Message): number;
  estimateMessages(messages: readonly Message[]): number;
  estimateTools(tools: readonly Tool[]): number;
}

export const ISessionTokenCountingService =
  createDecorator<ISessionTokenCountingService>('sessionTokenCountingService');
