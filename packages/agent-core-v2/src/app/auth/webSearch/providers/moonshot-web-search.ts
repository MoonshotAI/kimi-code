import type { WebSearchProvider, WebSearchResult } from '../tools/web-search';

export interface BearerTokenProvider {
  getAccessToken(options?: { readonly force?: boolean | undefined }): Promise<string>;
}

export interface MoonshotWebSearchProviderOptions {
  tokenProvider?: BearerTokenProvider;
  apiKey?: string;
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  customHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

interface MoonshotSearchResult {
  site_name?: string;
  title?: string;
  url?: string;
  snippet?: string;
  content?: string;
  date?: string;
  icon?: string;
  mime?: string;
}

interface MoonshotSearchResponse {
  search_results?: MoonshotSearchResult[];
}

export class MoonshotWebSearchProvider implements WebSearchProvider {
  private readonly tokenProvider: BearerTokenProvider | undefined;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly customHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MoonshotWebSearchProviderOptions) {
    this.tokenProvider = options.tokenProvider;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.customHeaders = options.customHeaders ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async search(
    query: string,
    options?: {
      limit?: number;
      includeContent?: boolean;
      toolCallId?: string;
      signal?: AbortSignal;
    },
  ): Promise<WebSearchResult[]> {
    const body = {
      text_query: query,
      limit: options?.limit ?? 5,
      enable_page_crawling: options?.includeContent ?? false,
      timeout_seconds: 30,
    };
    const bodyJson = JSON.stringify(body);

    const toolCallId = options?.toolCallId;
    const response = await this.post(bodyJson, toolCallId, options?.signal);

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

    return raw.map((r): WebSearchResult => {
      const out: WebSearchResult = {
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.snippet ?? '',
      };
      if (typeof r.date === 'string' && r.date.length > 0) out.date = r.date;
      if (typeof r.site_name === 'string' && r.site_name.length > 0) out.siteName = r.site_name;
      if (typeof r.content === 'string' && r.content.length > 0) out.content = r.content;
      return out;
    });
  }

  private async post(
    bodyJson: string,
    toolCallId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const accessToken = await this.resolveApiKey();
    return this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: {
        ...this.defaultHeaders,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(toolCallId !== undefined && toolCallId.length > 0
          ? { 'X-Msh-Tool-Call-Id': toolCallId }
          : {}),
        ...this.customHeaders,
      },
      body: bodyJson,
      signal,
    });
  }

  private async resolveApiKey(): Promise<string> {
    if (this.tokenProvider !== undefined) {
      try {
        return await this.tokenProvider.getAccessToken();
      } catch (error) {
        if (this.apiKey !== undefined && this.apiKey.length > 0) return this.apiKey;
        throw error;
      }
    }
    if (this.apiKey !== undefined && this.apiKey.length > 0) return this.apiKey;
    throw new Error(
      'Moonshot search service is not configured: missing API key or token provider.',
    );
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
