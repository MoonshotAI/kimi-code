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

export interface TokenMeasurement {
  readonly length: number;
  readonly tokens: number;
  readonly measured: boolean;
}

export interface IAgentTokenCountingService {
  readonly _serviceBrand: undefined;

  readonly strategy: TokenCountingStrategy;

  get(start?: number, end?: number): ContextSize;
  measured(input: readonly Message[], output: readonly Message[], usage: TokenUsage): void;
  /** Tokens of the most recent measured anchor (0 when none) — a real reading
   *  that stays valid across transient uncascaded context rewrites. */
  latestMeasured(): number;
  /** The latest anchor as a measurement (`undefined` before the first one):
   *  `measured` distinguishes a real provider reading from an estimate
   *  re-base. */
  latestMeasurement(): TokenMeasurement | undefined;
  /** The externally reported context size — the ONLY reading the
   *  `[token_counting]` strategy selects: `measured` reports the latest
   *  measured anchor alone, `estimated` reports a pure estimate with anchors
   *  ignored, and the default reports the live size floored by the last
   *  measured total. Internal logic (triggers, budgets, overflow backoff)
   *  must use `get()` / the estimate primitives, never this method. */
  statusSize(): number;
  /** The unfolded-request cost: `get().size` plus what the registered folds
   *  removed from the stored history (always >= the projected size). Fold
   *  consumers (spine) need the raw caliber to reason about the untruncated
   *  tree; a fold failure falls back to the raw estimate. */
  rawSize(): number;
  requestSize(request: TokenCountingRequest): number;

  estimateText(text: string): number;
  estimateMessage(message: Message): number;
  estimateMessages(messages: readonly Message[]): number;
  estimateTools(tools: readonly Tool[]): number;
}

export const IAgentTokenCountingService =
  createDecorator<IAgentTokenCountingService>('agentTokenCountingService');
