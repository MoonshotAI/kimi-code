import { HttpFetchError, type UrlFetcher, type UrlFetchResult } from '../tools/fetch-url-types';

interface BearerTokenProvider {
  getAccessToken(options?: { readonly force?: boolean | undefined }): Promise<string>;
}

export interface MoonshotFetchURLProviderOptions {
  tokenProvider?: BearerTokenProvider;
  apiKey?: string;
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  customHeaders?: Record<string, string>;
  localFallback: UrlFetcher;
  fetchImpl?: typeof fetch;
}

export class MoonshotFetchURLProvider implements UrlFetcher {
  private readonly tokenProvider: BearerTokenProvider | undefined;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly customHeaders: Record<string, string>;
  private readonly localFallback: UrlFetcher;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MoonshotFetchURLProviderOptions) {
    this.tokenProvider = options.tokenProvider;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.customHeaders = options.customHeaders ?? {};
    this.localFallback = options.localFallback;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async fetch(
    url: string,
    options?: { toolCallId?: string; signal?: AbortSignal },
  ): Promise<UrlFetchResult> {
    try {
      const content = await this.fetchViaMoonshot(url, options?.toolCallId, options?.signal);
      return { content, kind: 'extracted' };
    } catch (error) {
      if (options?.signal?.aborted === true) throw error;
      return this.localFallback.fetch(url, options ?? {});
    }
  }

  private async fetchViaMoonshot(
    url: string,
    toolCallId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const bodyJson = JSON.stringify({ url });
    const response = await this.post(bodyJson, toolCallId, signal);

    if (response.status !== 200) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
      }
      throw new HttpFetchError(
        response.status,
        `Moonshot fetch request failed: HTTP ${String(response.status)}. ${detail}`.trim(),
      );
    }
    return response.text();
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
        Accept: 'text/markdown',
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
        const token = await this.tokenProvider.getAccessToken();
        if (token.trim().length > 0) return token;
        if (this.apiKey !== undefined && this.apiKey.length > 0) return this.apiKey;
      } catch (error) {
        if (this.apiKey !== undefined && this.apiKey.length > 0) return this.apiKey;
        throw error;
      }
    }
    if (this.apiKey !== undefined && this.apiKey.length > 0) return this.apiKey;
    throw new Error('Moonshot fetch service is not configured: missing API key or token provider.');
  }
}
