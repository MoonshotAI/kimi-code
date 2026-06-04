import {
  KIMI_CODE_PROVIDER_NAME,
  resolveKimiCodeOAuthKey,
  resolveKimiCodeOAuthRef,
} from '@moonshot-ai/kimi-code-oauth';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { refreshAllProviderModels } from '../../../src/tui/utils/refresh-providers';
import type { KimiConfig } from '@moonshot-ai/kimi-code-sdk';

type FetchMock = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe('refreshAllProviderModels', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('refreshes managed Kimi Code against environment endpoints over persisted config', async () => {
    const configuredBaseUrl = 'https://api.configured.example.test/coding/v1';
    const envBaseUrl = 'https://api.env.example.test/coding/v1';
    const envOauthHost = 'https://auth.env.example.test';
    const configuredOauthKey = resolveKimiCodeOAuthKey({ baseUrl: configuredBaseUrl });
    const envOauthRef = resolveKimiCodeOAuthRef({
      oauthHost: envOauthHost,
      baseUrl: envBaseUrl,
    });
    const config: KimiConfig = {
      providers: {
        [KIMI_CODE_PROVIDER_NAME]: {
          type: 'kimi',
          baseUrl: configuredBaseUrl,
          apiKey: '',
          oauth: {
            storage: 'file',
            key: configuredOauthKey,
            oauthHost: 'https://auth.kimi.com',
          },
        },
      },
      models: {
        'kimi-code/kimi-for-coding': {
          provider: KIMI_CODE_PROVIDER_NAME,
          model: 'kimi-for-coding',
          maxContextSize: 262144,
        },
      },
      defaultModel: 'kimi-code/kimi-for-coding',
      telemetry: true,
    };
    vi.stubEnv('KIMI_CODE_BASE_URL', envBaseUrl);
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', envOauthHost);
    const resolveOAuthToken = vi.fn(async (_providerName, oauthRef) => {
      expect(oauthRef).toEqual(envOauthRef);
      return 'env-access-token';
    });
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe(`${envBaseUrl}/models`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer env-access-token');
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'kimi-for-coding',
              context_length: 262144,
              supports_reasoning: true,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllProviderModels({
      getConfig: async () => config,
      removeProvider: vi.fn(),
      setConfig: vi.fn(),
      resolveOAuthToken,
    });

    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual([KIMI_CODE_PROVIDER_NAME]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolveOAuthToken).toHaveBeenCalledWith(KIMI_CODE_PROVIDER_NAME, envOauthRef);
  });
});
