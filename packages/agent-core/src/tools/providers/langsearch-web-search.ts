/**
 * LangSearch Web Search API provider for the in-process agent-core runtime.
 */

import type { WebSearchProvider, WebSearchResult } from '../builtin';
import {
  LANGSEARCH_TIER_LIMITS,
  RateLimiter,
  type LangSearchTier,
} from './rate-limiter';

export type { LangSearchTier } from './rate-limiter';

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
    this.limiter =
      options.limiter ?? new RateLimiter(LANGSEARCH_TIER_LIMITS[this.tier], this.tier);
  }

  async search(
    query: string,
    options?: { toolCallId?: string; signal?: AbortSignal },
  ): Promise<WebSearchResult[]> {
    const body = JSON.stringify({
      query,
      freshness: this.freshness,
      summary: this.summary,
      count: this.count,
    });

    await this.limiter.acquire(options?.signal);
    const response = await this.fetchImpl(`${this.baseUrl}/v1/web-search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...this.customHeaders,
      },
      body,
      signal: options?.signal,
    });

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

    return raw.map((result): WebSearchResult => {
      const mapped: WebSearchResult = {
        title: result.name ?? '',
        url: result.url ?? '',
        snippet: this.summary && result.summary ? result.summary : (result.snippet ?? ''),
      };
      if (typeof result.siteName === 'string' && result.siteName.length > 0) {
        mapped.siteName = result.siteName;
      }
      if (typeof result.datePublished === 'string' && result.datePublished.length > 0) {
        mapped.date = result.datePublished;
      }
      return mapped;
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
