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

function makeRefreshHost(initial: KimiConfig): {
  current: () => KimiConfig;
  removeProvider: ReturnType<typeof vi.fn<(providerId: string) => Promise<KimiConfig>>>;
  setConfig: ReturnType<typeof vi.fn<(patch: Partial<KimiConfig>) => Promise<KimiConfig>>>;
} {
  let persisted = structuredClone(initial);
  const removeProvider = vi.fn(async (providerId: string) => {
    const providers = { ...persisted.providers };
    delete providers[providerId];
    const models = { ...persisted.models };
    let defaultRemoved = false;
    for (const [alias, model] of Object.entries(models)) {
      if (model.provider !== providerId) continue;
      delete models[alias];
      if (persisted.defaultModel === alias) defaultRemoved = true;
    }
    persisted = { ...persisted, providers, models };
    if (defaultRemoved) persisted = { ...persisted, defaultModel: undefined };
    return structuredClone(persisted);
  });
  const setConfig = vi.fn(async (patch: Partial<KimiConfig>) => {
    persisted = { ...persisted, ...patch };
    return structuredClone(persisted);
  });
  return {
    current: () => structuredClone(persisted),
    removeProvider,
    setConfig,
  };
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
          capabilities: ['thinking', 'tool_use'],
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

  it('can refresh only the managed OAuth provider without fetching third-party registries', async () => {
    const baseUrl = 'https://api.example.test/coding/v1';
    const registryUrl = 'https://registry.example.test/v1/models/api.json';
    const config: KimiConfig = {
      providers: {
        [KIMI_CODE_PROVIDER_NAME]: {
          type: 'kimi',
          baseUrl,
          apiKey: '',
          oauth: {
            storage: 'file',
            key: resolveKimiCodeOAuthKey({ baseUrl }),
          },
        },
        custom: {
          type: 'openai',
          baseUrl: 'https://custom.example.test/v1',
          apiKey: 'sk-test-token',
          source: { kind: 'apiJson', url: registryUrl, apiKey: 'sk-test-token' },
        },
      },
      models: {
        'kimi-code/kimi-for-coding': {
          provider: KIMI_CODE_PROVIDER_NAME,
          model: 'kimi-for-coding',
          maxContextSize: 262144,
          capabilities: ['thinking', 'tool_use'],
          displayName: 'Old Kimi',
        },
        'custom/m1': {
          provider: 'custom',
          model: 'm1',
          maxContextSize: 131072,
          capabilities: ['tool_use'],
          displayName: 'Custom M1',
        },
      },
      defaultModel: 'kimi-code/kimi-for-coding',
      telemetry: true,
    };
    const host = makeRefreshHost(config);
    const resolveOAuthToken = vi.fn(async () => 'oauth-access-token');
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe(`${baseUrl}/models`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer oauth-access-token');
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'kimi-for-coding',
              context_length: 262144,
              supports_reasoning: true,
              display_name: 'Fresh Kimi',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllProviderModels(
      {
        getConfig: async () => host.current(),
        removeProvider: host.removeProvider,
        setConfig: host.setConfig,
        resolveOAuthToken,
      },
      { scope: 'oauth' },
    );

    expect(result.failed).toEqual([]);
    expect(result.changed).toEqual([
      {
        providerId: KIMI_CODE_PROVIDER_NAME,
        providerName: 'Kimi Code',
        added: 0,
        removed: 0,
      },
    ]);
    expect(result.unchanged).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.current().models?.['kimi-code/kimi-for-coding']?.displayName).toBe('Fresh Kimi');
    expect(host.current().models?.['custom/m1']?.displayName).toBe('Custom M1');
  });

  it('refreshes custom-registry model capabilities even when model ids are unchanged', async () => {
    const registryUrl = 'https://registry.example.test/v1/models/api.json';
    const providerId = 'example_chat-completions';
    const siblingProviderId = 'example_messages';
    const modelId = 'reasoner-pro';
    const modelAlias = `${providerId}/${modelId}`;
    const siblingModelAlias = `${siblingProviderId}/${modelId}`;
    const userAlias = 'my-reasoner';
    const userAliasModel = {
      provider: providerId,
      model: modelId,
      maxContextSize: 262144,
      capabilities: ['tool_use'],
      displayName: 'My Reasoner',
    };
    const host = makeRefreshHost({
      providers: {
        [providerId]: {
          type: 'openai',
          baseUrl: 'https://api.example.test/v1',
          apiKey: 'sk-test-token',
          source: { kind: 'apiJson', url: registryUrl, apiKey: 'sk-test-token' },
        },
        [siblingProviderId]: {
          type: 'anthropic',
          baseUrl: 'https://messages.example.test',
          apiKey: 'sk-test-token',
          source: { kind: 'apiJson', url: registryUrl, apiKey: 'sk-test-token' },
        },
      },
      models: {
        [modelAlias]: {
          provider: providerId,
          model: modelId,
          maxContextSize: 262144,
          capabilities: ['tool_use'],
          displayName: 'Reasoner Pro',
        },
        [siblingModelAlias]: {
          provider: siblingProviderId,
          model: modelId,
          maxContextSize: 262144,
          capabilities: ['tool_use'],
          displayName: 'Reasoner Pro',
        },
        [userAlias]: userAliasModel,
      },
      defaultModel: modelAlias,
      telemetry: true,
    } as unknown as KimiConfig);

    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe(registryUrl);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test-token');
      return new Response(
        JSON.stringify({
          [providerId]: {
            id: providerId,
            name: 'Example Chat Completions',
            api: 'https://api.example.test/v1',
            type: 'openai',
            models: {
              [modelId]: {
                id: modelId,
                name: 'Reasoner Pro',
                limit: { context: 262144, output: 262144 },
                tool_call: true,
                reasoning: true,
                modalities: { input: ['text', 'image', 'video'], output: ['text'] },
              },
            },
          },
          [siblingProviderId]: {
            id: siblingProviderId,
            name: 'Example Messages',
            api: 'https://messages.example.test',
            type: 'anthropic',
            models: {
              [modelId]: {
                id: modelId,
                name: 'Reasoner Pro',
                limit: { context: 262144, output: 262144 },
                tool_call: true,
                reasoning: true,
                modalities: { input: ['text', 'image', 'video'], output: ['text'] },
              },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllProviderModels({
      getConfig: async () => host.current(),
      removeProvider: host.removeProvider,
      setConfig: host.setConfig,
      resolveOAuthToken: vi.fn(),
    });

    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.changed).toEqual([
      {
        providerId,
        providerName: 'Example Chat Completions',
        added: 0,
        removed: 0,
      },
      {
        providerId: siblingProviderId,
        providerName: 'Example Messages',
        added: 0,
        removed: 0,
      },
    ]);
    expect(host.removeProvider).toHaveBeenCalledWith(providerId);
    expect(host.removeProvider).toHaveBeenCalledWith(siblingProviderId);
    expect(host.setConfig).toHaveBeenCalledTimes(1);
    expect(host.current().models?.[modelAlias]?.capabilities).toEqual([
      'tool_use',
      'thinking',
      'image_in',
      'video_in',
    ]);
    expect(host.current().models?.[siblingModelAlias]?.capabilities).toEqual([
      'tool_use',
      'thinking',
      'image_in',
      'video_in',
    ]);
    expect(host.current().models?.[userAlias]).toEqual(userAliasModel);
  });

  it('adds custom-registry providers that appear under an existing source URL', async () => {
    const registryUrl = 'https://registry.example.test/v1/models/api.json';
    const apiKey = 'sk-test-token';
    const source = { kind: 'apiJson', url: registryUrl, apiKey };
    const host = makeRefreshHost({
      providers: {
        a: {
          type: 'openai',
          baseUrl: 'https://a.example.test/v1',
          apiKey,
          source,
        },
      },
      models: {
        'a/m1': {
          provider: 'a',
          model: 'm1',
          maxContextSize: 131072,
          capabilities: ['tool_use'],
          displayName: 'm1',
        },
      },
      telemetry: true,
    } as unknown as KimiConfig);

    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe(registryUrl);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test-token');
      return new Response(
        JSON.stringify({
          a: {
            id: 'a',
            name: 'Provider A',
            api: 'https://a.example.test/v1',
            type: 'openai',
            models: { m1: { id: 'm1' } },
          },
          b: {
            id: 'b',
            name: 'Provider B',
            api: 'https://b.example.test/v1',
            type: 'openai',
            models: { m1: { id: 'm1' } },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllProviderModels({
      getConfig: async () => host.current(),
      removeProvider: host.removeProvider,
      setConfig: host.setConfig,
      resolveOAuthToken: vi.fn(),
    });

    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual(['a']);
    expect(result.changed).toEqual([
      {
        providerId: 'b',
        providerName: 'Provider B',
        added: 1,
        removed: 0,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.removeProvider).not.toHaveBeenCalled();
    expect(host.setConfig).toHaveBeenCalledTimes(1);
    expect(Object.keys(host.current().providers).toSorted()).toEqual(['a', 'b']);
    expect(host.current().providers['b']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://b.example.test/v1',
      apiKey,
      source,
    });
    expect(host.current().models?.['b/m1']).toEqual({
      provider: 'b',
      model: 'm1',
      maxContextSize: 131072,
      capabilities: ['tool_use'],
      displayName: 'm1',
    });
  });

  it('removes custom-registry providers that disappear from an existing source URL', async () => {
    const registryUrl = 'https://registry.example.test/v1/models/api.json';
    const apiKey = 'sk-test-token';
    const source = { kind: 'apiJson', url: registryUrl, apiKey };
    const host = makeRefreshHost({
      providers: {
        a: {
          type: 'openai',
          baseUrl: 'https://a.example.test/v1',
          apiKey,
          source,
        },
        b: {
          type: 'openai',
          baseUrl: 'https://b.example.test/v1',
          apiKey,
          source,
        },
      },
      models: {
        'a/m1': {
          provider: 'a',
          model: 'm1',
          maxContextSize: 131072,
          capabilities: ['tool_use'],
          displayName: 'm1',
        },
        'b/m1': {
          provider: 'b',
          model: 'm1',
          maxContextSize: 131072,
          capabilities: ['tool_use'],
          displayName: 'm1',
        },
        'my-b': {
          provider: 'b',
          model: 'm1',
          maxContextSize: 131072,
          capabilities: ['tool_use'],
          displayName: 'My B',
        },
      },
      defaultModel: 'my-b',
      defaultThinking: true,
      telemetry: true,
    } as unknown as KimiConfig);

    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe(registryUrl);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test-token');
      return new Response(
        JSON.stringify({
          a: {
            id: 'a',
            name: 'Provider A',
            api: 'https://a.example.test/v1',
            type: 'openai',
            models: { m1: { id: 'm1' } },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllProviderModels({
      getConfig: async () => host.current(),
      removeProvider: host.removeProvider,
      setConfig: host.setConfig,
      resolveOAuthToken: vi.fn(),
    });

    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual(['a']);
    expect(result.changed).toEqual([
      {
        providerId: 'b',
        providerName: 'b',
        added: 0,
        removed: 1,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.removeProvider).toHaveBeenCalledWith('b');
    expect(host.setConfig).toHaveBeenCalledTimes(1);
    expect(Object.keys(host.current().providers)).toEqual(['a']);
    expect(host.current().models?.['a/m1']).toBeDefined();
    expect(host.current().models?.['b/m1']).toBeUndefined();
    expect(host.current().models?.['my-b']).toBeUndefined();
    expect(host.current().defaultModel).toBeUndefined();
    expect(host.current().defaultThinking).toBeUndefined();
  });

  it('coalesces duplicate custom-registry source URLs without reporting config-only changes', async () => {
    const registryUrl = 'https://registry.example.test/v1/models/api.json';
    const oldSource = { kind: 'apiJson', url: registryUrl, apiKey: 'sk-old-token' };
    const newSource = { kind: 'apiJson', url: registryUrl, apiKey: 'sk-new-token' };
    const host = makeRefreshHost({
      providers: {
        a: {
          type: 'openai',
          baseUrl: 'https://a.example.test/v1',
          apiKey: 'sk-old-token',
          source: oldSource,
        },
        b: {
          type: 'openai',
          baseUrl: 'https://b.example.test/v1',
          apiKey: 'sk-new-token',
          source: newSource,
        },
      },
      models: {
        'a/m1': {
          provider: 'a',
          model: 'm1',
          maxContextSize: 131072,
          capabilities: ['tool_use'],
          displayName: 'm1',
        },
        'b/m1': {
          provider: 'b',
          model: 'm1',
          maxContextSize: 131072,
          capabilities: ['tool_use'],
          displayName: 'm1',
        },
      },
      telemetry: true,
    } as unknown as KimiConfig);

    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe(registryUrl);
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization === 'Bearer sk-old-token') {
        return new Response(JSON.stringify({ message: 'expired token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      expect(authorization).toBe('Bearer sk-new-token');
      return new Response(
        JSON.stringify({
          a: {
            id: 'a',
            name: 'Provider A',
            api: 'https://a.example.test/v1',
            type: 'openai',
            models: { m1: { id: 'm1' } },
          },
          b: {
            id: 'b',
            name: 'Provider B',
            api: 'https://b.example.test/v1',
            type: 'openai',
            models: { m1: { id: 'm1' }, m2: { id: 'm2' } },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllProviderModels({
      getConfig: async () => host.current(),
      removeProvider: host.removeProvider,
      setConfig: host.setConfig,
      resolveOAuthToken: vi.fn(),
    });

    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual(['a']);
    expect(result.changed).toEqual([
      {
        providerId: 'b',
        providerName: 'Provider B',
        added: 1,
        removed: 0,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(host.removeProvider).toHaveBeenCalledWith('a');
    expect(host.removeProvider).toHaveBeenCalledWith('b');
    expect(host.setConfig).toHaveBeenCalledTimes(1);
    expect(host.current().providers['a']?.source).toEqual(newSource);
    expect(host.current().providers['b']?.source).toEqual(newSource);
    expect(host.current().providers['a']?.apiKey).toBe('sk-new-token');
    expect(host.current().providers['b']?.apiKey).toBe('sk-new-token');
    expect(host.current().models?.['b/m2']).toEqual({
      provider: 'b',
      model: 'm2',
      maxContextSize: 131072,
      capabilities: ['tool_use'],
      displayName: 'm2',
    });
  });

  it('ignores user-defined aliases when custom-registry metadata is unchanged', async () => {
    const registryUrl = 'https://registry.example.test/v1/models/api.json';
    const providerId = 'example_chat-completions';
    const modelId = 'reasoner-pro';
    const modelAlias = `${providerId}/${modelId}`;
    const userAlias = 'my-reasoner';
    const richCapabilities = ['tool_use', 'thinking', 'image_in'];
    const userAliasModel = {
      provider: providerId,
      model: modelId,
      maxContextSize: 262144,
      capabilities: ['tool_use'],
      displayName: 'My Reasoner',
    };
    const host = makeRefreshHost({
      providers: {
        [providerId]: {
          type: 'openai',
          baseUrl: 'https://api.example.test/v1',
          apiKey: 'sk-test-token',
          source: { kind: 'apiJson', url: registryUrl, apiKey: 'sk-test-token' },
        },
      },
      models: {
        [modelAlias]: {
          provider: providerId,
          model: modelId,
          maxContextSize: 262144,
          capabilities: richCapabilities,
          displayName: 'Reasoner Pro',
        },
        [userAlias]: userAliasModel,
      },
      defaultModel: userAlias,
      defaultThinking: false,
      telemetry: true,
    } as unknown as KimiConfig);

    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe(registryUrl);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test-token');
      return new Response(
        JSON.stringify({
          [providerId]: {
            id: providerId,
            name: 'Example Chat Completions',
            api: 'https://api.example.test/v1',
            type: 'openai',
            models: {
              [modelId]: {
                id: modelId,
                name: 'Reasoner Pro',
                limit: { context: 262144, output: 262144 },
                tool_call: true,
                reasoning: true,
                modalities: { input: ['text', 'image'], output: ['text'] },
              },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllProviderModels({
      getConfig: async () => host.current(),
      removeProvider: host.removeProvider,
      setConfig: host.setConfig,
      resolveOAuthToken: vi.fn(),
    });

    expect(result.failed).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual([providerId]);
    expect(host.removeProvider).not.toHaveBeenCalled();
    expect(host.setConfig).not.toHaveBeenCalled();
    expect(host.current().models?.[userAlias]).toEqual(userAliasModel);
    expect(host.current().defaultModel).toBe(userAlias);
    expect(host.current().defaultThinking).toBe(false);
  });

  it('forces default thinking on when the refreshed default model cannot disable thinking', async () => {
    const host = makeRefreshHost({
      providers: {
        [KIMI_CODE_PROVIDER_NAME]: {
          type: 'kimi',
          apiKey: '',
          oauth: { storage: 'file', key: 'oauth/kimi-code' },
        },
      },
      models: {
        'kimi-code/kimi-deep-coder': {
          provider: KIMI_CODE_PROVIDER_NAME,
          model: 'kimi-deep-coder',
          maxContextSize: 262144,
          capabilities: ['thinking', 'tool_use'],
        },
      },
      defaultModel: 'kimi-code/kimi-deep-coder',
      defaultThinking: false,
      telemetry: true,
    } as unknown as KimiConfig);

    const fetchMock = vi.fn<FetchMock>(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'kimi-deep-coder',
                context_length: 262144,
                supports_reasoning: true,
                supports_thinking_type: 'only',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllProviderModels({
      getConfig: async () => host.current(),
      removeProvider: host.removeProvider,
      setConfig: host.setConfig,
      resolveOAuthToken: vi.fn(async () => 'oauth-access-token'),
    });

    expect(result.failed).toEqual([]);
    expect(host.current().models?.['kimi-code/kimi-deep-coder']?.capabilities).toEqual([
      'thinking',
      'always_thinking',
      'tool_use',
    ]);
    expect(host.current().defaultModel).toBe('kimi-code/kimi-deep-coder');
    expect(host.current().defaultThinking).toBe(true);
  });
});
