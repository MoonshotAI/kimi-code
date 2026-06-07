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
});
