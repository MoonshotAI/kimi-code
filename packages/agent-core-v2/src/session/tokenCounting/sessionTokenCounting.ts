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
  /** Tokens of the most recent measured anchor (0 when none) — a real reading
   *  that stays valid across transient uncascaded context rewrites. */
  latestMeasured(agent: AgentContext): number;
  /** The externally reported context size — the ONLY reading the
   *  `[token_counting]` strategy selects: `measured` reports the latest
   *  measured anchor alone, `estimated` reports a pure estimate with anchors
   *  ignored, and the default reports the live size floored by the last
   *  measured total. Internal logic (triggers, budgets, overflow backoff)
   *  must use `get()` / the estimate primitives, never this method. */
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
