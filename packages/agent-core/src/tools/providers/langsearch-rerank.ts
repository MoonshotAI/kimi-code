/** LangSearch Semantic Rerank API provider. */

import type { WebSearchResult } from '../builtin';
import type { RerankProvider } from './rerank';
import {
  LANGSEARCH_TIER_LIMITS,
  RateLimiter,
  type LangSearchTier,
} from './rate-limiter';

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
  private readonly customHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;

  constructor(options: LangSearchRerankProviderOptions) {
    const tier = options.tier ?? 'free';
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.customHeaders = options.customHeaders ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.limiter = options.limiter ?? new RateLimiter(LANGSEARCH_TIER_LIMITS[tier], tier);
  }

  async rerank(
    query: string,
    results: WebSearchResult[],
    signal?: AbortSignal,
  ): Promise<WebSearchResult[]> {
    if (results.length === 0) return results;

    const body = JSON.stringify({
      model: RERANK_MODEL,
      query,
      documents: results.map((result) => result.snippet || result.title),
      top_n: results.length,
      return_documents: false,
    });

    await this.limiter.acquire(signal);
    const response = await this.fetchImpl(`${this.baseUrl}/v1/rerank`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...this.customHeaders,
      },
      body,
      signal,
    });

    if (response.status !== 200) {
      throw new Error(
        `LangSearch rerank request failed: HTTP ${String(response.status)}. ${await safeReadText(response)}`.trim(),
      );
    }

    const json = (await response.json()) as LangSearchRerankResponse;
    assertLangSearchSuccess('rerank request', json.code, json.msg);
    if (!Array.isArray(json.results)) return results;

    const reordered: WebSearchResult[] = [];
    const used = new Set<number>();
    const ranked = json.results.toSorted(
      (left, right) => (right.relevance_score ?? 0) - (left.relevance_score ?? 0),
    );
    for (const entry of ranked) {
      if (
        Number.isInteger(entry.index) &&
        entry.index >= 0 &&
        entry.index < results.length &&
        !used.has(entry.index)
      ) {
        reordered.push(results[entry.index]!);
        used.add(entry.index);
      }
    }
    for (let index = 0; index < results.length; index++) {
      if (!used.has(index)) reordered.push(results[index]!);
    }
    return reordered;
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
