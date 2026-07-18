/**
 * `auth` domain — `WebSearchProvider` wrapper that applies a rerank pass.
 *
 * Wraps any `WebSearchProvider` and reorders its results through a
 * `RerankProvider` after each `search()`. Rerank failures are non-fatal: the
 * original search-order results are returned unless the caller's abort signal
 * fired.
 */

import type { RerankProvider } from '../rerank';
import type { WebSearchProvider, WebSearchResult } from '../tools/web-search';

export class RerankingWebSearchProvider implements WebSearchProvider {
  constructor(
    private readonly delegate: WebSearchProvider,
    private readonly reranker: RerankProvider,
  ) {}

  async search(
    query: string,
    options?: { toolCallId?: string; signal?: AbortSignal },
  ): Promise<WebSearchResult[]> {
    const results = await this.delegate.search(query, options);
    if (results.length === 0) return results;
    try {
      return await this.reranker.rerank(query, results, options?.signal);
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      return results;
    }
  }
}
