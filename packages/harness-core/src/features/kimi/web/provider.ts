import type { BearerTokenProvider } from '@moonshot-ai/kimi-code-oauth';

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly date?: string;
  readonly siteName?: string;
}

export interface WebSearchProvider {
  search(
    query: string,
    options?: {
      toolCallId?: string;
      signal?: AbortSignal;
    },
  ): Promise<readonly WebSearchResult[]>;
}

export interface WebSearchFace {
  getProvider(): WebSearchProvider | undefined;
}

export interface MoonshotWebSearchProviderOptions {
  readonly baseUrl: string;
  readonly tokenProvider?: BearerTokenProvider;
  readonly apiKey?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
}

interface MoonshotSearchResult {
  readonly site_name?: string;
  readonly title?: string;
  readonly url?: string;
  readonly snippet?: string;
  readonly date?: string;
}

interface MoonshotSearchResponse {
  readonly search_results?: MoonshotSearchResult[];
}

export function createMoonshotWebSearchProvider(
  options: MoonshotWebSearchProviderOptions,
): WebSearchProvider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const resolveAccessToken = async (): Promise<string> => {
    if (options.tokenProvider !== undefined) {
      try {
        return await options.tokenProvider.getAccessToken();
      } catch (error) {
        if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey;
        throw error;
      }
    }
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey;
    throw new Error(
      'Moonshot search request failed: authentication is not configured (missing API key or OAuth token).',
    );
  };
  return {
    search: async (query, searchOptions) => {
      const accessToken = await resolveAccessToken();
      const toolCallId = searchOptions?.toolCallId;
      const response = await fetchImpl(options.baseUrl, {
        method: 'POST',
        headers: {
          ...options.defaultHeaders,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...(toolCallId !== undefined && toolCallId.length > 0
            ? { 'X-Msh-Tool-Call-Id': toolCallId }
            : {}),
          ...options.customHeaders,
        },
        body: JSON.stringify({ text_query: query }),
        signal: searchOptions?.signal,
      });
      if (response.status === 401) {
        const detail = await safeReadText(response);
        throw new Error(
          `Moonshot search request failed: HTTP 401 (auth/unauthorized). ${detail}`.trim(),
        );
      }
      if (response.status !== 200) {
        const detail = await safeReadText(response);
        throw new Error(
          `Moonshot search request failed: HTTP ${String(response.status)}. ${detail}`.trim(),
        );
      }
      const json = (await response.json()) as MoonshotSearchResponse;
      const raw = Array.isArray(json.search_results) ? json.search_results : [];
      return raw.map((result): WebSearchResult => {
        const out: { title: string; url: string; snippet: string; date?: string; siteName?: string } = {
          title: result.title ?? '',
          url: result.url ?? '',
          snippet: result.snippet ?? '',
        };
        if (typeof result.date === 'string' && result.date.length > 0) out.date = result.date;
        if (typeof result.site_name === 'string' && result.site_name.length > 0) {
          out.siteName = result.site_name;
        }
        return out;
      });
    },
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
