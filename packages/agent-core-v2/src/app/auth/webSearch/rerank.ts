/**
 * `auth` domain (L2) — rerank provider contract and DI service identifier.
 *
 * Defines the `RerankProvider` interface (reorder search results by semantic
 * relevance to a query) and the `IRerankService` DI token that resolves the
 * configured rerank backend (or `undefined` when rerank is not configured).
 * Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { RateLimiter } from './providers/rateLimiter';
import type { WebSearchResult } from './tools/web-search';

export interface RerankProvider {
  rerank(query: string, results: WebSearchResult[], signal?: AbortSignal): Promise<WebSearchResult[]>;
}

export interface IRerankService {
  readonly _serviceBrand: undefined;
  getRerankProvider(limiter?: RateLimiter): RerankProvider | undefined;
}

export const IRerankService: ServiceIdentifier<IRerankService> =
  createDecorator<IRerankService>('rerankService');
