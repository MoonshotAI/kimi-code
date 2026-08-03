/**
 * MoonshotFetchURLProvider — host-side UrlFetcher.
 *
 * Flow:
 *   1. Try Moonshot coding-fetch service (POST {url}, Bearer token from a
 *      narrow token provider, Accept: text/markdown, host-provided headers).
 *   2. Moonshot 200 → return the body as `extracted` content (the
 *      service has already extracted the main page text on its side).
 *   3. Any Moonshot failure — non-200, network error, or token
 *      refresh failure — → delegate to `localFallback`, forwarding its
 *      content kind, so the LLM still gets *something* when the service
 *      is down.
 *   4. If localFallback also throws → propagate that error.
 */

import { HttpFetchError, type UrlFetcher, type UrlFetchResult } from '../builtin';

export interface BearerTokenProvider {
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

  async fetch(url: string, options?: { toolCallId?: string }): Promise<UrlFetchResult> {
    try {
      const content = await this.fetchViaMoonshot(url, options?.toolCallId);
      // The service returns text it has already extracted from the page.
      return { content, kind: 'extracted' };
    } catch {
      // Forward an explicit options object even when the caller passed
      // none, so downstream consumers always see a defined second arg.
      return this.localFallback.fetch(url, options ?? {});
    }
  }

  private async fetchViaMoonshot(
    url: string,
    toolCallId: string | undefined,
  ): Promise<string> {
    const bodyJson = JSON.stringify({ url });

    const response = await this.post(bodyJson, toolCallId);

    if (response.status !== 200) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        // ignore — status code alone is informative enough for the
        // fallback path that catches this.
      }
      throw new HttpFetchError(
        response.status,
        `Moonshot fetch request failed: HTTP ${String(response.status)}. ${detail}`.trim(),
      );
    }

    return response.text();
  }

  private async post(bodyJson: string, toolCallId: string | undefined): Promise<Response> {
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
    });
  }

  private async resolveApiKey(): Promise<string> {
    if (this.tokenProvider !== undefined) {
      try {
        const token = await this.tokenProvider.getAccessToken();
        if (token.trim().length > 0) {
          return token;
        }
        if (this.apiKey !== undefined && this.apiKey.length > 0) {
          return this.apiKey;
        }
      } catch (error) {
        if (this.apiKey !== undefined && this.apiKey.length > 0) {
          return this.apiKey;
        }
        throw error;
      }
    }
    if (this.apiKey !== undefined && this.apiKey.length > 0) {
      return this.apiKey;
    }
    throw new Error('Moonshot fetch service is not configured: missing API key or token provider.');
  }
}
