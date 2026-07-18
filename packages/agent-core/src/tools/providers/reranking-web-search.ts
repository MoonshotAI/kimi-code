import type { WebSearchProvider, WebSearchResult } from '../builtin';
import type { RerankProvider } from './rerank';

/** Applies an optional, best-effort rerank pass to any web-search backend. */
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
