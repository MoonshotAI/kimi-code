import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyOpenAICodexConfig,
  clearOpenAICodexConfig,
  createOpenAICodexRequestAuth,
  createOpenAICodexTokenProvider,
  extractOpenAICodexAccountId,
  fetchOpenAICodexModels,
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_OAUTH_KEY,
  OPENAI_CODEX_PROVIDER_NAME,
  resolveKimiTokenStorageName,
  type ManagedKimiConfigShape,
  type TokenInfo,
  type TokenStorage,
} from '../src';

class MemoryTokenStorage implements TokenStorage {
  readonly tokens = new Map<string, TokenInfo>();

  async load(name: string): Promise<TokenInfo | undefined> {
    return this.tokens.get(name);
  }

  async save(name: string, token: TokenInfo): Promise<void> {
    this.tokens.set(name, token);
  }

  async remove(name: string): Promise<void> {
    this.tokens.delete(name);
  }

  async list(): Promise<string[]> {
    return [...this.tokens.keys()];
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  return `header.${encoded}.signature`;
}

function token(input: Partial<TokenInfo> = {}): TokenInfo {
  return {
    accessToken: input.accessToken ?? 'access-token',
    refreshToken: input.refreshToken ?? 'refresh-token',
    expiresAt: input.expiresAt ?? 10_000,
    scope: input.scope ?? '',
    tokenType: input.tokenType ?? 'Bearer',
    expiresIn: input.expiresIn ?? 3600,
  };
}

describe('extractOpenAICodexAccountId', () => {
  it('reads the ChatGPT account id from OpenAI OAuth JWT claims', () => {
    expect(
      extractOpenAICodexAccountId(
        jwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'account-123',
          },
        }),
      ),
    ).toBe('account-123');
  });

  it('returns undefined for malformed or missing claims', () => {
    expect(extractOpenAICodexAccountId('not-a-jwt')).toBeUndefined();
    expect(extractOpenAICodexAccountId(jwt({}))).toBeUndefined();
  });
});

describe('createOpenAICodexRequestAuth', () => {
  it('builds the bearer credential and ChatGPT account headers', () => {
    const accessToken = jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-123' },
    });

    expect(createOpenAICodexRequestAuth(accessToken)).toEqual({
      apiKey: accessToken,
      headers: {
        'ChatGPT-Account-Id': 'account-123',
        'OpenAI-Beta': 'responses=experimental',
        originator: 'kimi-code',
      },
    });
  });

  it('rejects a token without a ChatGPT account id', () => {
    expect(() => createOpenAICodexRequestAuth(jwt({}))).toThrow(
      'OpenAI Codex OAuth token missing ChatGPT account id.',
    );
  });
});

describe('applyOpenAICodexConfig', () => {
  it('provisions the OpenAI Codex Responses provider and bundled model aliases', () => {
    const config: ManagedKimiConfigShape = {
      providers: {},
      models: {
        'openai-codex/old-model': {
          provider: OPENAI_CODEX_PROVIDER_NAME,
          model: 'old-model',
        },
      },
    };

    const result = applyOpenAICodexConfig(config, {
      selectedModelId: 'gpt-5.4-mini',
      thinking: true,
      effort: 'high',
    });

    expect(result.defaultModel).toBe('openai-codex/gpt-5.4-mini');
    expect(config.providers[OPENAI_CODEX_PROVIDER_NAME]).toMatchObject({
      type: 'openai_responses',
      baseUrl: OPENAI_CODEX_BASE_URL,
      apiKey: '',
      oauth: {
        storage: 'file',
        key: OPENAI_CODEX_OAUTH_KEY,
        oauthHost: 'https://auth.openai.com',
      },
    });
    expect(config.models?.['openai-codex/old-model']).toBeUndefined();
    expect(config.models?.['openai-codex/gpt-5.4-mini']).toMatchObject({
      provider: OPENAI_CODEX_PROVIDER_NAME,
      model: 'gpt-5.4-mini',
      capabilities: ['tool_use', 'thinking', 'image_in'],
      supportEfforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
    });
    expect(config.models?.['openai-codex/gpt-5.4-mini']?.['maxOutputSize']).toBeUndefined();
    expect(config.defaultModel).toBe('openai-codex/gpt-5.4-mini');
    expect(config.thinking).toMatchObject({ enabled: true, effort: 'high' });
  });

  it('provisions model aliases from a fetched OpenAI Codex model catalog', () => {
    const config: ManagedKimiConfigShape = { providers: {} };

    applyOpenAICodexConfig(config, {
      selectedModelId: 'gpt-dynamic',
      models: [
        {
          id: 'gpt-dynamic',
          displayName: 'GPT Dynamic',
          contextLength: 353000,
          supportsImageIn: true,
          supportEfforts: ['low', 'high'],
          defaultEffort: 'high',
        },
      ],
    });

    expect(config.models?.['openai-codex/gpt-dynamic']).toMatchObject({
      provider: OPENAI_CODEX_PROVIDER_NAME,
      model: 'gpt-dynamic',
      maxContextSize: 353000,
      capabilities: ['tool_use', 'thinking', 'image_in'],
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
    });
  });
});

describe('clearOpenAICodexConfig', () => {
  it('removes only OpenAI Codex config and clears its active default', () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        [OPENAI_CODEX_PROVIDER_NAME]: { type: 'openai_responses' },
        other: { type: 'openai', apiKey: 'sk-test' },
      },
      models: {
        'openai-codex/gpt': {
          provider: OPENAI_CODEX_PROVIDER_NAME,
          model: 'gpt',
        },
        other: { provider: 'other', model: 'other' },
      },
      defaultModel: 'openai-codex/gpt',
      thinking: { enabled: true },
    };

    expect(clearOpenAICodexConfig(config)).toEqual({
      providerName: OPENAI_CODEX_PROVIDER_NAME,
      removedProvider: true,
      removedModels: ['openai-codex/gpt'],
      defaultModelCleared: true,
    });
    expect(config.providers).toEqual({ other: { type: 'openai', apiKey: 'sk-test' } });
    expect(config.models).toEqual({ other: { provider: 'other', model: 'other' } });
    expect(config.defaultModel).toBeUndefined();
    expect(config.thinking).toEqual({ enabled: true });
  });

  it('preserves a default owned by another provider', () => {
    const config: ManagedKimiConfigShape = {
      providers: { [OPENAI_CODEX_PROVIDER_NAME]: { type: 'openai_responses' } },
      models: {
        codex: { provider: OPENAI_CODEX_PROVIDER_NAME, model: 'gpt' },
        other: { provider: 'other', model: 'other' },
      },
      defaultModel: 'other',
    };

    expect(clearOpenAICodexConfig(config).defaultModelCleared).toBe(false);
    expect(config.defaultModel).toBe('other');
  });
});

describe('fetchOpenAICodexModels', () => {
  it('fetches and parses listed models from the ChatGPT Codex catalog', async () => {
    const accessToken = jwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'account-123',
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                slug: 'gpt-dynamic',
                display_name: 'GPT Dynamic',
                context_window: 353000,
                max_context_window: 353000,
                input_modalities: ['text', 'image'],
                supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
                default_reasoning_level: 'high',
                visibility: 'list',
                supported_in_api: true,
                upgrade: null,
              },
              {
                slug: 'hidden-model',
                display_name: 'Hidden',
                context_window: 1,
                visibility: 'hide',
                supported_in_api: true,
                upgrade: null,
              },
              {
                slug: 'upgrade-model',
                display_name: 'Upgrade',
                context_window: 1,
                visibility: 'list',
                supported_in_api: true,
                upgrade: { reason: 'upgrade' },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const models = await fetchOpenAICodexModels(accessToken, {
      clientVersions: ['0.200.0'],
    });

    expect(models).toEqual([
      {
        id: 'gpt-dynamic',
        displayName: 'GPT Dynamic',
        contextLength: 353000,
        supportsImageIn: true,
        supportEfforts: ['low', 'high'],
        defaultEffort: 'high',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit];
    expect(String(url)).toContain('/backend-api/codex/models?client_version=0.200.0');
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${accessToken}`,
      'ChatGPT-Account-Id': 'account-123',
    });
  });

  it('tries the next catalog client version when a response has no listed models', async () => {
    const accessToken = jwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'account-123',
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [
              {
                slug: 'gpt-fallback',
                display_name: 'GPT Fallback',
                context_window: 128000,
                visibility: 'list',
                supported_in_api: true,
                upgrade: null,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const models = await fetchOpenAICodexModels(accessToken, {
      clientVersions: ['0.1.0', '0.2.0'],
    });

    expect(models.map((model) => model.id)).toEqual(['gpt-fallback']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('createOpenAICodexTokenProvider', () => {
  it('returns an unexpired cached token from provider-specific storage', async () => {
    const storage = new MemoryTokenStorage();
    const storageName = resolveKimiTokenStorageName({
      providerName: OPENAI_CODEX_PROVIDER_NAME,
      oauthKey: OPENAI_CODEX_OAUTH_KEY,
    });
    storage.tokens.set(storageName, token({ accessToken: 'cached-access', expiresAt: 500 }));

    const provider = createOpenAICodexTokenProvider({
      storage,
      providerName: OPENAI_CODEX_PROVIDER_NAME,
      now: () => 100,
    });

    await expect(provider.getAccessToken()).resolves.toBe('cached-access');
  });

  it('refreshes expired tokens and persists the replacement', async () => {
    const storage = new MemoryTokenStorage();
    const storageName = resolveKimiTokenStorageName({
      providerName: OPENAI_CODEX_PROVIDER_NAME,
      oauthKey: OPENAI_CODEX_OAUTH_KEY,
    });
    storage.tokens.set(storageName, token({ accessToken: 'old-access', expiresAt: 101 }));
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
            scope: '',
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOpenAICodexTokenProvider({
      storage,
      providerName: OPENAI_CODEX_PROVIDER_NAME,
      now: () => 100,
    });

    await expect(provider.getAccessToken()).resolves.toBe('new-access');
    expect(storage.tokens.get(storageName)?.refreshToken).toBe('new-refresh');
  });
});
