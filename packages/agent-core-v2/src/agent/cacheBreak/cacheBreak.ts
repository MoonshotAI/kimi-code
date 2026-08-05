/**
 * `cacheBreak` domain — passive prompt-cache break detection contract.
 *
 * Detects a sudden prompt-cache read drop between consecutive turn requests
 * from recorded LLM request usage and reports it. Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const MIN_CACHE_BREAK_DROP_TOKENS = 2000;

export interface IAgentCacheBreakService {
  readonly _serviceBrand: undefined;
}

export const IAgentCacheBreakService: ServiceIdentifier<IAgentCacheBreakService> =
  createDecorator<IAgentCacheBreakService>('agentCacheBreakService');
