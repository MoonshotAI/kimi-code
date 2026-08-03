/**
 * `tokenCounting` domain — `IAgentTokenCountingService` contract.
 *
 * The single owner of every token count the agent reasons about: the context
 * size (measured anchors + estimated tail), the full request size (system
 * prompt + tools + messages) used by overflow heuristics, and the raw
 * character-based estimate primitives consumed by compaction budgets. The
 * `[token_counting]` strategy is resolved HERE and nowhere else:
 *   - `measured+estimated` (default): real exchange anchors plus estimates
 *     for the not-yet-measured tail;
 *   - `measured`: estimates read as 0 — sizing and triggers rely on measured
 *     usage alone;
 *   - `estimated`: anchors are ignored — everything is estimated (the escape
 *     hatch for providers whose usage reporting is absent or unreliable).
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import type { TokenUsage } from '#/kosong/contract/usage';

export type TokenCountingStrategy = 'measured+estimated' | 'measured' | 'estimated';

export interface ContextSize {
  readonly size: number;
  readonly measured: number;
  readonly estimated: number;
}

export interface TokenCountingRequest {
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
}

export interface IAgentTokenCountingService {
  readonly _serviceBrand: undefined;

  readonly strategy: TokenCountingStrategy;

  get(start?: number, end?: number): ContextSize;
  measured(input: readonly Message[], output: readonly Message[], usage: TokenUsage): void;
  /** Tokens of the most recent measured anchor (0 when none) — a real reading
   *  that stays valid across transient uncascaded context rewrites. */
  latestMeasured(): number;
  requestSize(request: TokenCountingRequest): number;

  estimateText(text: string): number;
  estimateMessage(message: Message): number;
  estimateMessages(messages: readonly Message[]): number;
  estimateTools(tools: readonly Tool[]): number;
}

export const IAgentTokenCountingService =
  createDecorator<IAgentTokenCountingService>('agentTokenCountingService');
