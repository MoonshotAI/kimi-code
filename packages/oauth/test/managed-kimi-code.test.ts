import { describe, expect, it, vi } from 'vitest';

import {
  applyManagedKimiCodeLogoutConfig,
  applyManagedKimiCodeConfig,
  clearManagedKimiCodeConfig,
  fetchManagedKimiCodeModels,
  KIMI_CODE_OAUTH_KEY,
  KIMI_CODE_PROVIDER_NAME,
  ManagedKimiCodeModelsAuthError,
  provisionManagedKimiCodeConfig,
  resolveKimiCodeLoginAuth,
  resolveKimiCodeOAuthKey,
  resolveKimiCodeOAuthRef,
  resolveKimiCodeRuntimeAuth,
  type ManagedKimiConfigShape,
} from '../src/managed-kimi-code';
import { OAuthUnauthorizedError } from '../src/errors';

function makeModelsResponse(): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          id: 'kimi-for-coding',
          context_length: 262144,
          supports_reasoning: true,
          supports_image_in: true,
          supports_video_in: true,
          display_name: 'Kimi for Coding',
        },
        {
          id: 'kimi-k2.5',
          context_length: 250000,
          supports_reasoning: false,
          supports_image_in: false,
          supports_video_in: false,
          supports_tool_use: false,
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('provisionManagedKimiCodeConfig', () => {
  it('keeps the legacy credential key for the default production environment', () => {
    expect(
      resolveKimiCodeOAuthKey({
        oauthHost: 'https://auth.kimi.com/',
        baseUrl: 'https://api.kimi.com/coding/v1/',
      }),
    ).toBe(KIMI_CODE_OAUTH_KEY);
  });

  it('scopes credential keys for non-default OAuth hosts and API base URLs', () => {
    const devKey = resolveKimiCodeOAuthKey({
      oauthHost: 'https://auth.dev.kimi.team',
      baseUrl: 'https://coding.deva.msh.team/coding/v1',
    });

    expect(devKey).not.toBe(KIMI_CODE_OAUTH_KEY);
    expect(devKey).toMatch(/^oauth\/kimi-code-env-[a-f0-9]{16}$/);
    expect(
      resolveKimiCodeOAuthKey({
        oauthHost: 'https://auth.dev.kimi.team/',
        baseUrl: 'https://coding.deva.msh.team/coding/v1/',
      }),
    ).toBe(devKey);
  });

  it('derives a full OAuth ref whose key and persisted host stay in sync', () => {
    // Default environment collapses to the legacy ref (no persisted host), so
    // existing production credentials keep resolving to `kimi-code.json`.
    expect(
      resolveKimiCodeOAuthRef({
        oauthHost: 'https://auth.kimi.com/',
        baseUrl: 'https://api.kimi.com/coding/v1/',
      }),
    ).toEqual({ storage: 'file', key: KIMI_CODE_OAUTH_KEY, oauthHost: undefined });

    const defaultAuthCustomApiRef = resolveKimiCodeOAuthRef({
      baseUrl: 'https://api.example.test/coding/v1',
    });
    expect(defaultAuthCustomApiRef).toEqual({
      storage: 'file',
      key: resolveKimiCodeOAuthKey({
        oauthHost: 'https://auth.kimi.com',
        baseUrl: 'https://api.example.test/coding/v1',
      }),
      oauthHost: 'https://auth.kimi.com',
    });

    // A non-default environment yields a scoped key AND the normalized host,
    // both derived from the same input — login and runtime cannot drift apart.
    const devRef = resolveKimiCodeOAuthRef({
      oauthHost: 'https://auth.dev.kimi.team/',
      baseUrl: 'https://coding.deva.msh.team/coding/v1',
    });
    expect(devRef).toEqual({
      storage: 'file',
      key: resolveKimiCodeOAuthKey({
        oauthHost: 'https://auth.dev.kimi.team',
        baseUrl: 'https://coding.deva.msh.team/coding/v1',
      }),
      oauthHost: 'https://auth.dev.kimi.team',
    });
  });

  it('resolves runtime auth from environment overrides over persisted config', () => {
    const configuredBaseUrl = 'https://api.configured.example.test/coding/v1';
    const envBaseUrl = 'https://api.env.example.test/coding/v1/';
    const envOauthHost = 'https://auth.env.example.test/';
    const configuredOAuthRef = resolveKimiCodeOAuthRef({
      baseUrl: configuredBaseUrl,
    });

    const auth = resolveKimiCodeRuntimeAuth({
      configuredBaseUrl,
      configuredOAuthRef,
      env: {
        KIMI_CODE_BASE_URL: envBaseUrl,
        KIMI_CODE_OAUTH_HOST: envOauthHost,
      },
    });

    expect(auth.baseUrl).toBe('https://api.env.example.test/coding/v1');
    expect(auth.oauthRef).toEqual({
      storage: 'file',
      key: resolveKimiCodeOAuthKey({
        oauthHost: 'https://auth.env.example.test',
        baseUrl: 'https://api.env.example.test/coding/v1',
      }),
      oauthHost: 'https://auth.env.example.test',
    });
  });

  it('preserves a matching configured runtime OAuth ref when env is not overridden', () => {
    const baseUrl = 'https://coding.deva.msh.team/coding/v1';
    const configuredOAuthRef = {
      storage: 'keyring' as const,
      key: resolveKimiCodeOAuthKey({
        oauthHost: 'https://auth.dev.kimi.team',
        baseUrl,
      }),
      oauthHost: 'https://auth.dev.kimi.team',
    };

    expect(
      resolveKimiCodeRuntimeAuth({
        configuredBaseUrl: baseUrl,
        configuredOAuthRef,
        env: {},
      }),
    ).toEqual({
      baseUrl,
      oauthRef: configuredOAuthRef,
    });
  });

  it('resolves login auth without reusing persisted refs under explicit or env overrides', () => {
    const configuredBaseUrl = 'https://api.configured.example.test/coding/v1';
    const configuredOAuthRef = resolveKimiCodeOAuthRef({ baseUrl: configuredBaseUrl });

    expect(
      resolveKimiCodeLoginAuth({
        configuredBaseUrl,
        configuredOAuthRef,
        requestedBaseUrl: 'https://api.requested.example.test/coding/v1/',
        env: {},
      }),
    ).toEqual({
      baseUrl: 'https://api.requested.example.test/coding/v1',
      oauthHost: undefined,
    });

    expect(
      resolveKimiCodeLoginAuth({
        configuredBaseUrl,
        configuredOAuthRef,
        env: {},
      }),
    ).toEqual({
      baseUrl: configuredBaseUrl,
      oauthHost: undefined,
      oauthRef: configuredOAuthRef,
    });
  });

  it('writes the managed provider, models, services, and default model through an adapter', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        custom: {
          type: 'kimi',
          apiKey: 'sk-existing',
          baseUrl: 'https://example.test/v1',
        },
      },
      models: {
        'kimi-code/stale': {
          provider: KIMI_CODE_PROVIDER_NAME,
          model: 'stale',
        },
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
        },
      },
    };
    const write = vi.fn();
    const fetchMock = vi.fn(async () => makeModelsResponse());

    const result = await provisionManagedKimiCodeConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: fetchMock as unknown as typeof fetch,
      adapter: {
        configPath: '/tmp/config.toml',
        read: () => config,
        write,
        apply: applyManagedKimiCodeConfig,
      },
    });

    expect(result).toMatchObject({
      providerName: KIMI_CODE_PROVIDER_NAME,
      defaultModel: 'kimi-code/kimi-for-coding',
      defaultThinking: true,
      configPath: '/tmp/config.toml',
    });
    expect(result.models[0]?.supportsToolUse).toBe(true);
    expect(result.models[1]?.supportsToolUse).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.kimi.com/coding/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-access-token',
          Accept: 'application/json',
        }),
      }),
    );
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    const init = calls[0]?.[1] ?? {};
    const headers = new Headers((init.headers ?? {}) as Record<string, string>);
    expect(headers.get('user-agent')).toBeNull();
    expect(headers.get('x-msh-platform')).toBeNull();
    expect(write).toHaveBeenCalledWith(config);

    expect(config.providers['custom']).toMatchObject({
      apiKey: 'sk-existing',
    });
    expect(config.models?.['custom-default']?.provider).toBe('custom');
    expect(config.models?.['kimi-code/stale']).toBeUndefined();
    expect(config.providers[KIMI_CODE_PROVIDER_NAME]).toMatchObject({
      type: 'kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: '',
      oauth: { storage: 'file', key: 'oauth/kimi-code' },
    });
    expect(config.models?.['kimi-code/kimi-for-coding']).toMatchObject({
      provider: KIMI_CODE_PROVIDER_NAME,
      model: 'kimi-for-coding',
      maxContextSize: 262144,
      capabilities: ['thinking', 'image_in', 'video_in', 'tool_use'],
      displayName: 'Kimi for Coding',
    });
    expect(config.models?.['kimi-code/kimi-k2.5']?.capabilities).toBeUndefined();
    expect(config.services?.moonshotSearch).toMatchObject({
      baseUrl: 'https://api.kimi.com/coding/v1/search',
      apiKey: '',
      oauth: { storage: 'file', key: 'oauth/kimi-code' },
    });
    expect(Object.keys(config.services ?? {})).toEqual(['moonshotSearch', 'moonshotFetch']);
  });

  it('writes scoped OAuth refs when provisioning against a non-default environment', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {},
    };
    const oauthKey = resolveKimiCodeOAuthKey({
      oauthHost: 'https://auth.dev.kimi.team',
      baseUrl: 'https://coding.deva.msh.team/coding/v1',
    });

    await provisionManagedKimiCodeConfig({
      accessToken: 'oauth-access-token',
      baseUrl: 'https://coding.deva.msh.team/coding/v1',
      oauthKey,
      oauthHost: 'https://auth.dev.kimi.team',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedKimiCodeConfig,
      },
    });

    expect(config.providers[KIMI_CODE_PROVIDER_NAME]).toMatchObject({
      baseUrl: 'https://coding.deva.msh.team/coding/v1',
      oauth: {
        storage: 'file',
        key: oauthKey,
        oauthHost: 'https://auth.dev.kimi.team',
      },
    });
    expect(config.services?.moonshotSearch?.oauth).toEqual({
      storage: 'file',
      key: oauthKey,
      oauthHost: 'https://auth.dev.kimi.team',
    });
    expect(config.services?.moonshotFetch?.oauth).toEqual({
      storage: 'file',
      key: oauthKey,
      oauthHost: 'https://auth.dev.kimi.team',
    });
  });

  it('persists the default OAuth host when only the API base URL is scoped', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {},
    };
    const baseUrl = 'https://api.example.test/coding/v1';
    const oauthKey = resolveKimiCodeOAuthKey({ baseUrl });

    await provisionManagedKimiCodeConfig({
      accessToken: 'oauth-access-token',
      baseUrl,
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedKimiCodeConfig,
      },
    });

    expect(config.providers[KIMI_CODE_PROVIDER_NAME]).toMatchObject({
      baseUrl,
      oauth: {
        storage: 'file',
        key: oauthKey,
        oauthHost: 'https://auth.kimi.com',
      },
    });
  });

  it('preserves an existing valid default model during refresh', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        custom: {
          type: 'kimi',
          apiKey: 'sk-existing',
          baseUrl: 'https://example.test/v1',
        },
        [KIMI_CODE_PROVIDER_NAME]: {
          type: 'kimi',
          apiKey: '',
        },
      },
      defaultModel: 'custom-default',
      defaultThinking: false,
      models: {
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
        },
        'kimi-code/stale': {
          provider: KIMI_CODE_PROVIDER_NAME,
          model: 'stale',
          maxContextSize: 1000,
        },
      },
    };

    const result = await provisionManagedKimiCodeConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedKimiCodeConfig,
      },
    });

    expect(result.defaultModel).toBe('custom-default');
    expect(result.defaultThinking).toBe(false);
    expect(config.defaultModel).toBe('custom-default');
    expect(config.defaultThinking).toBe(false);
    expect(config.models?.['kimi-code/stale']).toBeUndefined();
    expect(config.models?.['kimi-code/kimi-for-coding']?.displayName).toBe('Kimi for Coding');
  });

  it('infers default_thinking from fresh managed model capabilities', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        [KIMI_CODE_PROVIDER_NAME]: {
          type: 'kimi',
          apiKey: '',
        },
      },
      defaultModel: 'kimi-code/kimi-for-coding',
      models: {
        'kimi-code/kimi-for-coding': {
          provider: KIMI_CODE_PROVIDER_NAME,
          model: 'kimi-for-coding',
          maxContextSize: 1000,
          capabilities: [],
        },
      },
    };

    const result = await provisionManagedKimiCodeConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedKimiCodeConfig,
      },
    });

    expect(result.defaultModel).toBe('kimi-code/kimi-for-coding');
    expect(result.defaultThinking).toBe(true);
    expect(config.defaultThinking).toBe(true);
  });

  it('preserves explicit default_thinking when preserving a custom default without capabilities', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        custom: {
          type: 'kimi',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'custom-default',
      defaultThinking: true,
      models: {
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
        },
      },
    };

    const result = await provisionManagedKimiCodeConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedKimiCodeConfig,
      },
    });

    expect(result.defaultModel).toBe('custom-default');
    expect(result.defaultThinking).toBe(true);
    expect(config.defaultThinking).toBe(true);
  });

  it('defaults default_thinking to false when a preserved custom default has no signal', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        custom: {
          type: 'kimi',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'custom-default',
      models: {
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
        },
      },
    };

    const result = await provisionManagedKimiCodeConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedKimiCodeConfig,
      },
    });

    expect(result.defaultModel).toBe('custom-default');
    expect(result.defaultThinking).toBe(false);
    expect(config.defaultThinking).toBe(false);
  });

  it('does not infer default_thinking from preserved custom default capabilities', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        custom: {
          type: 'kimi',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'custom-default',
      models: {
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
          capabilities: [],
        },
      },
    };

    const result = await provisionManagedKimiCodeConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedKimiCodeConfig,
      },
    });

    expect(result.defaultModel).toBe('custom-default');
    expect(result.defaultThinking).toBe(false);
    expect(config.defaultThinking).toBe(false);
  });

  it('keeps default_thinking off even when preserved custom default has thinking capability', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        custom: {
          type: 'kimi',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'custom-default',
      models: {
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
          capabilities: ['thinking'],
        },
      },
    };

    const result = await provisionManagedKimiCodeConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedKimiCodeConfig,
      },
    });

    expect(result.defaultModel).toBe('custom-default');
    expect(result.defaultThinking).toBe(false);
    expect(config.defaultThinking).toBe(false);
  });

  it('falls back to the first fetched model when the preserved default was removed', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        [KIMI_CODE_PROVIDER_NAME]: {
          type: 'kimi',
          apiKey: '',
        },
      },
      defaultModel: 'kimi-code/stale',
      defaultThinking: false,
      models: {
        'kimi-code/stale': {
          provider: KIMI_CODE_PROVIDER_NAME,
          model: 'stale',
          maxContextSize: 1000,
        },
      },
    };

    const result = await provisionManagedKimiCodeConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedKimiCodeConfig,
      },
    });

    expect(result.defaultModel).toBe('kimi-code/kimi-for-coding');
    expect(result.defaultThinking).toBe(false);
    expect(config.defaultModel).toBe('kimi-code/kimi-for-coding');
    expect(config.defaultThinking).toBe(false);
  });

  it('removes managed provider, models, services, and default model on logout', () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        [KIMI_CODE_PROVIDER_NAME]: {
          type: 'kimi',
          apiKey: '',
        },
        custom: {
          type: 'kimi',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'kimi-code/kimi-for-coding',
      defaultThinking: true,
      models: {
        'kimi-code/kimi-for-coding': {
          provider: KIMI_CODE_PROVIDER_NAME,
          model: 'kimi-for-coding',
          maxContextSize: 262144,
        },
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
        },
      },
      services: {
        moonshotSearch: { baseUrl: 'https://api.kimi.com/coding/v1/search' },
        moonshotFetch: { baseUrl: 'https://api.kimi.com/coding/v1/fetch' },
        customService: { baseUrl: 'https://service.example.test' },
      },
      raw: {
        default_model: 'kimi-code/kimi-for-coding',
        providers: {
          [KIMI_CODE_PROVIDER_NAME]: { type: 'kimi' },
          custom: { type: 'kimi' },
        },
        models: {
          'kimi-code/kimi-for-coding': {
            provider: KIMI_CODE_PROVIDER_NAME,
            model: 'kimi-for-coding',
          },
          'custom-default': {
            provider: 'custom',
            model: 'custom-model',
          },
        },
        services: {
          moonshot_search: { base_url: 'https://api.kimi.com/coding/v1/search' },
          moonshot_fetch: { base_url: 'https://api.kimi.com/coding/v1/fetch' },
        },
      },
    };

    applyManagedKimiCodeLogoutConfig(config);

    expect(config.defaultModel).toBeUndefined();
    expect(config.providers[KIMI_CODE_PROVIDER_NAME]).toBeUndefined();
    expect(config.providers['custom']).toBeDefined();
    expect(config.models?.['kimi-code/kimi-for-coding']).toBeUndefined();
    expect(config.models?.['custom-default']).toBeDefined();
    expect(config.services?.moonshotSearch).toBeUndefined();
    expect(config.services?.moonshotFetch).toBeUndefined();
    expect(config.services?.['customService']).toEqual({
      baseUrl: 'https://service.example.test',
    });
  });

  it('rejects managed models that do not include a positive context_length', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'kimi-for-coding', supports_reasoning: true }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    await expect(
      fetchManagedKimiCodeModels({
        accessToken: 'oauth-access-token',
        fetchImpl,
      }),
    ).rejects.toThrow(/positive context_length/);
  });

  it('surfaces API error messages from model listing failures', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    await expect(
      fetchManagedKimiCodeModels({
        accessToken: 'oauth-access-token',
        fetchImpl,
      }),
    ).rejects.toThrow('quota exceeded');
  });

  it('classifies model listing 401 responses as OAuth unauthorized', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: 'The API Key appears to be invalid or may have expired.' },
          }),
          {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    ) as unknown as typeof fetch;

    await expect(
      fetchManagedKimiCodeModels({
        accessToken: 'oauth-access-token',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(OAuthUnauthorizedError);
  });

  it('classifies membership-check 402 responses as OAuth unauthorized', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "We're unable to verify your membership benefits at this time. Please ensure your membership is active.",
            },
          }),
          {
            status: 402,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    ) as unknown as typeof fetch;

    const promise = fetchManagedKimiCodeModels({
      accessToken: 'oauth-access-token',
      baseUrl: 'https://coding.deva.msh.team/coding/v1',
      fetchImpl,
    });

    await expect(promise).rejects.toThrow(
      "Kimi Code models endpoint https://coding.deva.msh.team/coding/v1 rejected OAuth credentials: We're unable to verify your membership benefits at this time. Please ensure your membership is active.",
    );
    await expect(
      fetchManagedKimiCodeModels({
        accessToken: 'oauth-access-token',
        baseUrl: 'https://coding.deva.msh.team/coding/v1',
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      status: 402,
      baseUrl: 'https://coding.deva.msh.team/coding/v1',
    });
    await expect(
      fetchManagedKimiCodeModels({
        accessToken: 'oauth-access-token',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(OAuthUnauthorizedError);
    await expect(
      fetchManagedKimiCodeModels({
        accessToken: 'oauth-access-token',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(ManagedKimiCodeModelsAuthError);
  });

  it('clears managed provider, models, default model, and services on logout', () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        [KIMI_CODE_PROVIDER_NAME]: {
          type: 'kimi',
          apiKey: '',
          oauth: { storage: 'file', key: 'oauth/kimi-code' },
        },
        custom: {
          type: 'kimi',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'kimi-code/kimi-for-coding',
      models: {
        'kimi-code/kimi-for-coding': {
          provider: KIMI_CODE_PROVIDER_NAME,
          model: 'kimi-for-coding',
          maxContextSize: 262144,
        },
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 128000,
        },
      },
      services: {
        moonshotSearch: {
          baseUrl: 'https://api.kimi.com/coding/v1/search',
          apiKey: '',
          oauth: { storage: 'file', key: 'oauth/kimi-code' },
        },
        moonshotFetch: {
          baseUrl: 'https://api.kimi.com/coding/v1/fetch',
          apiKey: '',
          oauth: { storage: 'file', key: 'oauth/kimi-code' },
        },
        otherService: { baseUrl: 'https://service.example.test' },
      },
    };

    const result = clearManagedKimiCodeConfig(config);

    expect(result).toMatchObject({
      providerName: KIMI_CODE_PROVIDER_NAME,
      removedProvider: true,
      removedModels: ['kimi-code/kimi-for-coding'],
      defaultModelCleared: true,
      removedServices: ['moonshotSearch', 'moonshotFetch'],
    });
    expect(config.providers[KIMI_CODE_PROVIDER_NAME]).toBeUndefined();
    expect(config.providers['custom']).toMatchObject({ apiKey: 'sk-existing' });
    expect(config.defaultModel).toBeUndefined();
    expect(config.models?.['kimi-code/kimi-for-coding']).toBeUndefined();
    expect(config.models?.['custom-default']).toMatchObject({ provider: 'custom' });
    expect(config.services?.moonshotSearch).toBeUndefined();
    expect(config.services?.moonshotFetch).toBeUndefined();
    expect(config.services?.['otherService']).toMatchObject({
      baseUrl: 'https://service.example.test',
    });
  });
});
