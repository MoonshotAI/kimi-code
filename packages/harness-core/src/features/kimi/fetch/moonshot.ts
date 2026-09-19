import type { BearerTokenProvider } from '@moonshot-ai/kimi-code-oauth';

import { HttpFetchError, type UrlFetcher } from './fetcher';

export interface MoonshotFetchURLProviderOptions {
  readonly baseUrl: string;
  readonly tokenProvider?: BearerTokenProvider;
  readonly apiKey?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly localFallback: UrlFetcher;
  readonly fetchImpl?: typeof fetch;
}

export function createMoonshotFetchURLProvider(options: MoonshotFetchURLProviderOptions): UrlFetcher {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const resolveAccessToken = async (): Promise<string> => {
    if (options.tokenProvider !== undefined) {
      try {
        const token = await options.tokenProvider.getAccessToken();
        if (token.trim().length > 0) return token;
        if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey;
      } catch (error) {
        if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey;
        throw error;
      }
    }
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey;
    throw new Error(
      'Moonshot fetch service is not configured: missing API key or token provider.',
    );
  };
  return {
    fetch: async (url, fetchOptions) => {
      try {
        const accessToken = await resolveAccessToken();
        const toolCallId = fetchOptions?.toolCallId;
        const response = await fetchImpl(options.baseUrl, {
          method: 'POST',
          headers: {
            ...options.defaultHeaders,
            Authorization: `Bearer ${accessToken}`,
            Accept: 'text/markdown',
            'Content-Type': 'application/json',
            ...(toolCallId !== undefined && toolCallId.length > 0
              ? { 'X-Msh-Tool-Call-Id': toolCallId }
              : {}),
            ...options.customHeaders,
          },
          body: JSON.stringify({ url }),
          signal: fetchOptions?.signal,
        });
        if (response.status !== 200) {
          let detail = '';
          try {
            detail = await response.text();
          } catch {}
          throw new HttpFetchError(
            response.status,
            `Moonshot fetch request failed: HTTP ${String(response.status)}. ${detail}`.trim(),
          );
        }
        return { content: await response.text(), kind: 'extracted' };
      } catch (error) {
        if (fetchOptions?.signal?.aborted === true) throw error;
        return options.localFallback.fetch(url, fetchOptions ?? {});
      }
    },
  };
}
