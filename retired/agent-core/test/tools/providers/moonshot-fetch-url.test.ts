import { describe, expect, it, vi } from 'vitest';

import type { UrlFetcher } from '../../../src/tools/builtin/web/fetch-url';
import { MoonshotFetchURLProvider } from '../../../src/tools/providers/moonshot-fetch-url';

function fakeFetcher(
  content = '',
  kind: 'passthrough' | 'extracted' = 'extracted',
): UrlFetcher {
  return { fetch: vi.fn().mockResolvedValue({ content, kind }) };
}

describe('MoonshotFetchURLProvider auth fallback', () => {
  it('falls back to the configured API key when the token provider has no token', async () => {
    // Mirrors py test_resolve_api_key_falls_back_to_api_key_when_no_token:
    // the host should call moonshot with the static api key when oauth
    // returns nothing — without needing a separate prime step.
    const getAccessToken = vi.fn<() => Promise<string>>().mockResolvedValue('');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }));
    const provider = new MoonshotFetchURLProvider({
      tokenProvider: { getAccessToken },
      apiKey: 'fallback-key',
      baseUrl: 'https://fetch.example/v1',
      localFallback: fakeFetcher('fallback content'),
      fetchImpl,
    });

    await provider.fetch('https://example.com/page');

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1];
    const authHeader = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
    expect(authHeader).toBe('Bearer fallback-key');
  });

  it('drops the rejected oauth token and uses the static api key on the next call', async () => {
    // Mirrors py test_resolve_api_key_falls_back_after_rejected_refresh_token:
    // once the refresh path has been rejected with 401, subsequent fetches
    // must prefer the static api key instead of the persisted oauth token.
    const getAccessToken = vi
      .fn<(o?: { force?: boolean }) => Promise<string>>()
      .mockRejectedValue(new Error('revoked'));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }));
    const provider = new MoonshotFetchURLProvider({
      tokenProvider: { getAccessToken },
      apiKey: 'fallback-key',
      baseUrl: 'https://fetch.example/v1',
      localFallback: fakeFetcher('fallback content'),
      fetchImpl,
    });

    await provider.fetch('https://example.com/page');

    const init = fetchImpl.mock.calls[0]?.[1];
    const authHeader = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
    expect(authHeader).toBe('Bearer fallback-key');
  });
});

describe('MoonshotFetchURLProvider content kind', () => {
  it('reports service responses as extracted content', async () => {
    const getAccessToken = vi.fn<() => Promise<string>>().mockResolvedValue('token');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('# Extracted markdown', { status: 200 }));
    const provider = new MoonshotFetchURLProvider({
      tokenProvider: { getAccessToken },
      baseUrl: 'https://fetch.example/v1',
      localFallback: fakeFetcher('fallback content'),
      fetchImpl,
    });

    const result = await provider.fetch('https://example.com/page');

    expect(result).toEqual({ content: '# Extracted markdown', kind: 'extracted' });
  });

  it('forwards the content kind from the local fallback', async () => {
    const getAccessToken = vi.fn<() => Promise<string>>().mockResolvedValue('token');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('boom', { status: 503 }));
    const provider = new MoonshotFetchURLProvider({
      tokenProvider: { getAccessToken },
      baseUrl: 'https://fetch.example/v1',
      localFallback: fakeFetcher('verbatim body', 'passthrough'),
      fetchImpl,
    });

    const result = await provider.fetch('https://example.com/page');

    expect(result).toEqual({ content: 'verbatim body', kind: 'passthrough' });
  });
});
