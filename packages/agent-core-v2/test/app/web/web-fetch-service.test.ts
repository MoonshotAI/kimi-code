/**
 * `web` domain tests — `WebFetchService` backend selection.
 *
 * Locks in that the default `WebFetchService` routes fetches through the
 * Moonshot fetch service when the managed Kimi OAuth provider is configured
 * (with a local fallback), and otherwise yields the built-in local fetcher so
 * `FetchURL` keeps working without OAuth.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IOAuthService } from '#/app/auth/auth';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IProviderService, type ProviderConfig } from '#/kosong/provider/provider';
import { LocalFetchURLProvider } from '#/app/web/providers/local-fetch-url';
import { MoonshotFetchURLProvider } from '#/app/web/providers/moonshot-fetch-url';
import { IWebFetchService } from '#/app/web/web';
import { WebFetchService } from '#/app/web/webService';
import '#/kosong/provider/providers/kimi/kimi.contrib';

const OAUTH_PROVIDER = 'managed:kimi-code';
const NON_OAUTH_PROVIDER = 'openai-main';

describe('WebFetchService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let providers: Record<string, ProviderConfig>;
  let resolveTokenProvider: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    providers = {};
    resolveTokenProvider = vi
      .fn()
      .mockReturnValue({ getAccessToken: async () => 'access-token' });
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IProviderService, {
          get: ((name: string) => providers[name]) as IProviderService['get'],
        });
        reg.definePartialInstance(IOAuthService, {
          resolveTokenProvider:
            resolveTokenProvider as unknown as IOAuthService['resolveTokenProvider'],
        });
        reg.definePartialInstance(IHostRequestHeaders, {
          headers: {
            'User-Agent': 'kimi-code-cli/test',
            'X-Msh-Device-Id': 'device-test',
          },
        });
        reg.define(IWebFetchService, WebFetchService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
    vi.unstubAllGlobals();
  });

  function fetcher(): ReturnType<IWebFetchService['getUrlFetcher']> {
    return ix.get(IWebFetchService).getUrlFetcher();
  }

  it('yields the local fetcher when the managed provider is not configured', () => {
    providers = { [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' } };
    expect(fetcher()).toBeInstanceOf(LocalFetchURLProvider);
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });

  it('yields the local fetcher when the managed provider is not an OAuth kimi provider', () => {
    providers = { [OAUTH_PROVIDER]: { type: 'kimi', apiKey: 'sk-test' } };
    expect(fetcher()).toBeInstanceOf(LocalFetchURLProvider);
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });

  it('yields the local fetcher when the oauth service yields no token provider', () => {
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    };
    resolveTokenProvider.mockReturnValue(undefined);
    expect(fetcher()).toBeInstanceOf(LocalFetchURLProvider);
  });

  it('builds a Moonshot fetcher from the managed provider oauth ref', () => {
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com/v1',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    };
    expect(fetcher()).toBeInstanceOf(MoonshotFetchURLProvider);
    expect(resolveTokenProvider).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      storage: 'file',
      key: 'oauth/kimi-code',
    });
  });

  it('fetches against /fetch with the OAuth access token, host identity headers, and custom headers', async () => {
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com/v1/',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
        customHeaders: { 'X-Custom': 'yes' },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => 'page body',
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetcher().fetch('https://example.com/page');

    expect(result).toEqual({ content: 'page body', kind: 'extracted' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/fetch');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer access-token');
    expect(headers['User-Agent']).toBe('kimi-code-cli/test');
    expect(headers['X-Msh-Device-Id']).toBe('device-test');
    expect(headers['X-Custom']).toBe('yes');
  });
});
