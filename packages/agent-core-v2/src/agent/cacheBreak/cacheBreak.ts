/**
 * `cacheBreak` domain — passive prompt-cache break detection contract.
 *
 * Defines the `IAgentCacheBreakService` detector token and the
 * `MIN_CACHE_BREAK_DROP_TOKENS` detection threshold. The detector observes
 * recorded LLM request usage and reports a sudden prompt-cache read drop
 * between consecutive turn requests; no other service injects it — the
 * container constructs it eagerly so its `usage` subscription exists. Bound
 * at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const MIN_CACHE_BREAK_DROP_TOKENS = 2000;

export interface IAgentCacheBreakService {
  readonly _serviceBrand: undefined;
}

export const IAgentCacheBreakService: ServiceIdentifier<IAgentCacheBreakService> =
  createDecorator<IAgentCacheBreakService>('agentCacheBreakService');
