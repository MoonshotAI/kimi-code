import type { WebSearchResult } from '../builtin';

/** A backend capable of reordering search results by semantic relevance. */
export interface RerankProvider {
  rerank(
    query: string,
    results: WebSearchResult[],
    signal?: AbortSignal,
  ): Promise<WebSearchResult[]>;
}
