/**
 * `auth` domain — LangSearch rerank provider.
 *
 * Implements {@link RerankProvider} against the LangSearch rerank API
 * (https://api.langsearch.com/v1/rerank). Reorders a set of search results by
 * semantic relevance to a query. The search wrapper treats rerank failures as
 * non-fatal and preserves the original order.
 *
 * Rate limiting is enforced client-side per the configured `tier` (see
 * https://docs.langsearch.com/limits/api-limits) via the shared `RateLimiter`.
 */

import type { RerankProvider } from '../rerank';
import type { WebSearchResult } from '../tools/web-search';
import { RateLimiter, TIER_LIMITS, type LangSearchTier } from './rateLimiter';

export interface LangSearchRerankProviderOptions {
  apiKey: string;
  baseUrl?: string;
  tier?: LangSearchTier;
  customHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
}

interface LangSearchRerankResult {
  index: number;
  relevance_score?: number;
}

interface LangSearchRerankResponse {
  code?: number;
  msg?: string | null;
  results?: LangSearchRerankResult[];
}

const DEFAULT_BASE_URL = 'https://api.langsearch.com';
const RERANK_MODEL = 'langsearch-reranker-v1';

export class LangSearchRerankProvider implements RerankProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly tier: LangSearchTier;
  private readonly customHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;

  constructor(options: LangSearchRerankProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.tier = options.tier ?? 'free';
    this.customHeaders = options.customHeaders ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.limiter = options.limiter ?? new RateLimiter(TIER_LIMITS[this.tier], this.tier);
  }

  async rerank(
    query: string,
    results: WebSearchResult[],
    signal?: AbortSignal,
  ): Promise<WebSearchResult[]> {
    if (results.length === 0) return results;

    const documents = results.map((r) => r.snippet || r.title);
    const body = JSON.stringify({
      model: RERANK_MODEL,
      query,
      documents,
      top_n: results.length,
      return_documents: false,
    });

    const response = await this.post('/v1/rerank', body, signal);

    if (response.status !== 200) {
      throw new Error(
        `LangSearch rerank request failed: HTTP ${String(response.status)}. ${await safeReadText(response)}`.trim(),
      );
    }

    const json = (await response.json()) as LangSearchRerankResponse;
    assertLangSearchSuccess('rerank request', json.code, json.msg);
    const ranked = json.results;
    if (!Array.isArray(ranked)) return results;

    const reordered: WebSearchResult[] = [];
    const used = new Set<number>();
    const sorted = ranked.toSorted(
      (a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0),
    );
    for (const entry of sorted) {
      if (Number.isInteger(entry.index) && entry.index >= 0 && entry.index < results.length) {
        if (!used.has(entry.index)) {
          reordered.push(results[entry.index]!);
          used.add(entry.index);
        }
      }
    }
    for (let i = 0; i < results.length; i++) {
      if (!used.has(i)) reordered.push(results[i]!);
    }
    return reordered;
  }

  private async post(
    path: string,
    bodyJson: string,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    await this.limiter.acquire(signal);
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...this.customHeaders,
      },
      body: bodyJson,
      signal,
    });
  }
}

function assertLangSearchSuccess(
  operation: string,
  code: number | undefined,
  message: string | null | undefined,
): void {
  if (code === undefined || code === 200) return;
  const detail = typeof message === 'string' && message.length > 0 ? ` ${message}` : '';
  throw new Error(`LangSearch ${operation} failed: API code ${String(code)}.${detail}`);
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
