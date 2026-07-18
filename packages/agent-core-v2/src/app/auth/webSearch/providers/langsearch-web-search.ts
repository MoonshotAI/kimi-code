/**
 * `auth` domain — LangSearch web-search provider.
 *
 * Implements {@link WebSearchProvider} against the LangSearch API
 * (https://api.langsearch.com/v1/web-search). Rerank is handled by the separate
 * `RerankProvider` / `RerankingWebSearchProvider` seam, not inline here.
 *
 * Rate limiting is enforced client-side per the configured `tier` (see
 * https://docs.langsearch.com/limits/api-limits). The limiter is in-memory and
 * best-effort — it prevents common 429s in normal single-session use but does
 * not coordinate across processes. A 429 from the API is still handled with a
 * clear error message suggesting a tier upgrade.
 */

import { RateLimiter, TIER_LIMITS, type LangSearchTier } from './rateLimiter';
import type { WebSearchProvider, WebSearchResult } from '../tools/web-search';

export type { LangSearchTier } from './rateLimiter';

export interface LangSearchWebSearchProviderOptions {
  apiKey: string;
  baseUrl?: string;
  tier?: LangSearchTier;
  freshness?: string;
  summary?: boolean;
  count?: number;
  customHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
}

interface LangSearchWebPageValue {
  name?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  siteName?: string;
  datePublished?: string;
}

interface LangSearchSearchResponse {
  code?: number;
  msg?: string | null;
  data?: {
    webPages?: {
      value?: LangSearchWebPageValue[];
    };
  };
}

const DEFAULT_BASE_URL = 'https://api.langsearch.com';

export class LangSearchWebSearchProvider implements WebSearchProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly tier: LangSearchTier;
  private readonly freshness: string;
  private readonly summary: boolean;
  private readonly count: number;
  private readonly customHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;

  constructor(options: LangSearchWebSearchProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.tier = options.tier ?? 'free';
    this.freshness = options.freshness ?? 'noLimit';
    this.summary = options.summary ?? true;
    this.count = options.count ?? 10;
    this.customHeaders = options.customHeaders ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.limiter = options.limiter ?? new RateLimiter(TIER_LIMITS[this.tier], this.tier);
  }

  async search(
    query: string,
    options?: { toolCallId?: string; signal?: AbortSignal },
  ): Promise<WebSearchResult[]> {
    return this.doSearch(query, options?.signal);
  }

  private async doSearch(
    query: string,
    signal: AbortSignal | undefined,
  ): Promise<WebSearchResult[]> {
    const body = JSON.stringify({
      query,
      freshness: this.freshness,
      summary: this.summary,
      count: this.count,
    });

    const response = await this.post('/v1/web-search', body, signal);

    if (response.status === 401) {
      const detail = await safeReadText(response);
      throw new Error(
        `LangSearch request failed: HTTP 401 (auth/unauthorized). ${detail}`.trim(),
      );
    }
    if (response.status === 429) {
      const detail = await safeReadText(response);
      throw new Error(
        `LangSearch rate limit exceeded (tier: ${this.tier}). ${detail}`.trim(),
      );
    }
    if (response.status !== 200) {
      const detail = await safeReadText(response);
      throw new Error(
        `LangSearch request failed: HTTP ${String(response.status)}. ${detail}`.trim(),
      );
    }

    const json = (await response.json()) as LangSearchSearchResponse;
    assertLangSearchSuccess('web search request', json.code, json.msg);
    const raw = json.data?.webPages?.value;
    if (!Array.isArray(raw)) return [];

    return raw.map((r): WebSearchResult => {
      const snippet = this.summary && r.summary ? r.summary : (r.snippet ?? '');
      const out: WebSearchResult = {
        title: r.name ?? '',
        url: r.url ?? '',
        snippet,
      };
      if (typeof r.siteName === 'string' && r.siteName.length > 0) {
        out.siteName = r.siteName;
      }
      if (typeof r.datePublished === 'string' && r.datePublished.length > 0) {
        out.date = r.datePublished;
      }
      return out;
    });
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
