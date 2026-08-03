import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CoreRPC,
  GetKimiConfigPayload,
  KimiConfig,
  KimiConfigPatch,
  SetKimiConfigPayload,
} from '../../src';
import { KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';

import {
  type ICoreProcessService,
  type IEnvironmentService,
  ModelCatalogService,
  ModelNotFoundError,
  ProviderNotFoundError,
  toProtocolModel,
  toProtocolProvider,
} from '../../src/services';
import type { ServicesAuthFacade } from '../../src/services/auth/managedAuth';
import type { IEventService } from '../../src/services/event/event';
import type { Event as ProtocolEvent } from '@moonshot-ai/protocol';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function makeEnv(): IEnvironmentService {
  return {
    _serviceBrand: undefined,
    homeDir: '/tmp/kimi-model-catalog-test',
    configPath: '/tmp/kimi-model-catalog-test/config.toml',
  };
}

function makeCore(configRef: { current: KimiConfig }): {
  core: ICoreProcessService;
  getCalls: GetKimiConfigPayload[];
  setCalls: KimiConfigPatch[];
  removeCalls: string[];
} {
  const getCalls: GetKimiConfigPayload[] = [];
  const setCalls: KimiConfigPatch[] = [];
  const removeCalls: string[] = [];
  const rpc: Partial<CoreRPC> = {
    getKimiConfig: vi.fn(async (payload: GetKimiConfigPayload) => {
      getCalls.push(payload);
      return configRef.current;
    }),
    setKimiConfig: vi.fn(async (payload: SetKimiConfigPayload) => {
      setCalls.push(payload);
      const next: KimiConfig = { ...configRef.current };
      if (payload.providers !== undefined) {
        next.providers = payload.providers as KimiConfig['providers'];
      }
      if (payload.models !== undefined) {
        next.models = payload.models as KimiConfig['models'];
      }
      if (payload.defaultModel !== undefined) next.defaultModel = payload.defaultModel;
      if (payload.thinking !== undefined) next.thinking = payload.thinking;
      configRef.current = next;
      return configRef.current;
    }),
    removeKimiProvider: vi.fn(async ({ providerId }) => {
      removeCalls.push(providerId);
      const providers = { ...configRef.current.providers };
      delete providers[providerId];
      const models = Object.fromEntries(
        Object.entries(configRef.current.models ?? {}).filter(([, model]) => model.provider !== providerId),
      ) as KimiConfig['models'];
      configRef.current = {
        ...configRef.current,
        providers,
        models,
        defaultModel: undefined,
      };
      return configRef.current;
    }),
  };
  return {
    core: {
      _serviceBrand: undefined,
      rpc: rpc as CoreRPC,
      ready: async () => undefined,
      dispose: () => undefined,
    },
    getCalls,
    setCalls,
    removeCalls,
  };
}

function authFacade(accessToken = 'token-test'): ServicesAuthFacade {
  return {
    login: vi.fn(),
    logout: vi.fn(),
    getCachedAccessToken: vi.fn(async () => accessToken),
    resolveOAuthTokenProvider: vi.fn(() => ({
      getAccessToken: vi.fn(async () => accessToken),
    })),
  };
}

function makeEventService(): { svc: IEventService; published: ProtocolEvent[] } {
  const published: ProtocolEvent[] = [];
  const svc: IEventService = {
    _serviceBrand: undefined,
    onDidPublish: () => ({ dispose: () => undefined }),
    publish: (event) => {
      published.push(event);
    },
  };
  return { svc, published };
}

function catalogConfig(): KimiConfig {
  return {
    providers: {
      kimi: {
        type: 'kimi',
        apiKey: 'sk-test',
        baseUrl: 'https://api.example.test/v1',
      },
      openai: { type: 'openai' },
    },
    defaultModel: 'k2',
    models: {
      k2: {
        provider: 'kimi',
        model: 'kimi-k2',
        maxContextSize: 131072,
        displayName: 'Kimi K2',
        capabilities: ['thinking'],
      },
      turbo: {
        provider: 'kimi',
        model: 'kimi-turbo',
        maxContextSize: 32768,
      },
      gpt4o: {
        provider: 'openai',
        model: 'gpt-4o',
        maxContextSize: 128000,
      },
    },
  };
}

describe('model catalog adapters', () => {
  it('maps model aliases to selectable wire ids', () => {
    const alias = catalogConfig().models!['k2']!;
    expect(toProtocolModel('k2', alias)).toEqual({
      provider: 'kimi',
      model: 'k2',
      display_name: 'Kimi K2',
      max_context_size: 131072,
      capabilities: ['thinking'],
    });
  });

  it('uses the provider model name as display fallback', () => {
    const alias = catalogConfig().models!['turbo']!;
    expect(toProtocolModel('turbo', alias).display_name).toBe('kimi-turbo');
  });

  it('projects official Anthropic effort metadata inferred from the model name', () => {
    expect(
      toProtocolModel('opus', {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        maxContextSize: 200000,
      }),
    ).toMatchObject({
      capabilities: ['thinking'],
      support_efforts: ['low', 'medium', 'high', 'max'],
      default_effort: 'high',
    });
  });

  it('maps provider model ids and global default', () => {
    const config = catalogConfig();
    expect(
      toProtocolProvider('kimi', config.providers['kimi']!, config, {
        hasApiKey: true,
        hasOAuthToken: false,
      }),
    ).toEqual({
      id: 'kimi',
      type: 'kimi',
      base_url: 'https://api.example.test/v1',
      default_model: 'k2',
      has_api_key: true,
      status: 'connected',
      models: ['k2', 'turbo'],
    });
  });
});

describe('ModelCatalogService', () => {
  it('lists models and providers from live config', async () => {
    const configRef = { current: catalogConfig() };
    const { core, getCalls } = makeCore(configRef);
    const svc = new ModelCatalogService(makeEnv(), core, makeEventService().svc);

    expect(await svc.listModels()).toHaveLength(3);
    expect(await svc.listProviders()).toHaveLength(2);
    expect(getCalls).toEqual([{ reload: true }, { reload: true }]);
  });

  it('projects latest Opus efforts for unknown Claude-marked Anthropic-compatible models', async () => {
    const configRef = { current: catalogConfig() };
    configRef.current.providers['custom'] = { type: 'anthropic' };
    configRef.current.models!['compatible'] = {
      provider: 'custom',
      model: 'custom-claude-model',
      maxContextSize: 128000,
    };
    const { core } = makeCore(configRef);
    const svc = new ModelCatalogService(makeEnv(), core, makeEventService().svc);

    const compatible = (await svc.listModels()).find((model) => model.model === 'compatible');
    expect(compatible).toMatchObject({
      capabilities: ['thinking'],
      support_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      default_effort: 'high',
    });
  });

  it('does not project fallback efforts for clearly non-Claude Anthropic-compatible models', async () => {
    const configRef = { current: catalogConfig() };
    configRef.current.providers['custom'] = { type: 'anthropic' };
    configRef.current.models!['compatible'] = {
      provider: 'custom',
      model: 'compatible-model',
      maxContextSize: 128000,
    };
    const { core } = makeCore(configRef);
    const svc = new ModelCatalogService(makeEnv(), core, makeEventService().svc);

    const compatible = (await svc.listModels()).find((model) => model.model === 'compatible');
    expect(compatible?.capabilities).toBeUndefined();
    expect(compatible?.support_efforts).toBeUndefined();
    expect(compatible?.default_effort).toBeUndefined();
  });

  it('does not project fallback efforts for a Kimi provider routed through the Anthropic protocol', async () => {
    const configRef = { current: catalogConfig() };
    configRef.current.models!['compatible'] = {
      provider: 'kimi',
      protocol: 'anthropic',
      model: 'compatible-model',
      maxContextSize: 128000,
    };
    const { core } = makeCore(configRef);
    const svc = new ModelCatalogService(makeEnv(), core, makeEventService().svc);

    const compatible = (await svc.listModels()).find((model) => model.model === 'compatible');
    expect(compatible).toMatchObject({
      provider: 'kimi',
      model: 'compatible',
    });
    expect(compatible?.capabilities).toBeUndefined();
    expect(compatible?.support_efforts).toBeUndefined();
    expect(compatible?.default_effort).toBeUndefined();
  });

  it('gets one provider or throws ProviderNotFoundError', async () => {
    const configRef = { current: catalogConfig() };
    const { core } = makeCore(configRef);
    const svc = new ModelCatalogService(makeEnv(), core, makeEventService().svc);

    await expect(svc.getProvider('kimi')).resolves.toMatchObject({ id: 'kimi' });
    await expect(svc.getProvider('missing')).rejects.toBeInstanceOf(
      ProviderNotFoundError,
    );
  });

  it('sets defaultModel through core config patch', async () => {
    const configRef = { current: catalogConfig() };
    const { core, setCalls } = makeCore(configRef);
    const svc = new ModelCatalogService(makeEnv(), core, makeEventService().svc);

    await expect(svc.setDefaultModel('turbo')).resolves.toEqual({
      default_model: 'turbo',
      model: {
        provider: 'kimi',
        model: 'turbo',
        display_name: 'kimi-turbo',
        max_context_size: 32768,
      },
    });
    expect(setCalls).toEqual([{ defaultModel: 'turbo' }]);
  });

  it('rejects unknown model ids', async () => {
    const configRef = { current: catalogConfig() };
    const { core } = makeCore(configRef);
    const svc = new ModelCatalogService(makeEnv(), core, makeEventService().svc);

    await expect(svc.setDefaultModel('missing')).rejects.toBeInstanceOf(
      ModelNotFoundError,
    );
  });

  it('refreshes managed OAuth models and preserves always-thinking defaults', async () => {
    const configRef: { current: KimiConfig } = {
      current: {
        providers: {
          [KIMI_CODE_PROVIDER_NAME]: {
            type: 'kimi',
            apiKey: '',
            baseUrl: 'https://api.example.test/coding/v1',
            oauth: { storage: 'file', key: 'oauth/kimi-code' },
          },
        },
        defaultModel: 'kimi-code/kimi-for-coding',
        thinking: { enabled: false },
        models: {
          'kimi-code/kimi-for-coding': {
            provider: KIMI_CODE_PROVIDER_NAME,
            model: 'kimi-for-coding',
            maxContextSize: 131_072,
            capabilities: ['thinking'],
          },
        },
      },
    };
    const { core, removeCalls, setCalls } = makeCore(configRef);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          id: 'kimi-for-coding',
          context_length: 262_144,
          supports_reasoning: true,
          supports_thinking_type: 'only',
          supports_image_in: false,
          supports_video_in: false,
        },
      ],
    })));
    vi.stubGlobal('fetch', fetchMock);
    const svc = ModelCatalogService._createForTest(makeEnv(), core, authFacade());

    await expect(svc.refreshOAuthProviderModels()).resolves.toMatchObject({
      changed: [{ provider_id: KIMI_CODE_PROVIDER_NAME, added: 0, removed: 0 }],
      failed: [],
    });

    expect(removeCalls).toEqual([KIMI_CODE_PROVIDER_NAME]);
    expect(setCalls.at(-1)).toMatchObject({
      defaultModel: 'kimi-code/kimi-for-coding',
      thinking: { enabled: true },
      models: {
        'kimi-code/kimi-for-coding': {
          capabilities: ['thinking', 'always_thinking', 'tool_use'],
          maxContextSize: 262_144,
        },
      },
    });
  });

  it('keeps the kimi-code provider on the REST base and records the model protocol when anthropic', async () => {
    const configRef: { current: KimiConfig } = {
      current: {
        providers: {
          [KIMI_CODE_PROVIDER_NAME]: {
            type: 'kimi',
            apiKey: '',
            baseUrl: 'https://api.example.test/coding/v1',
            oauth: { storage: 'file', key: 'oauth/kimi-code' },
          },
        },
        defaultModel: 'kimi-code/kimi-for-coding',
        models: {
          'kimi-code/kimi-for-coding': {
            provider: KIMI_CODE_PROVIDER_NAME,
            model: 'kimi-for-coding',
            maxContextSize: 200_000,
          },
        },
      },
    };
    const { core, setCalls } = makeCore(configRef);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'kimi-for-coding',
                context_length: 200_000,
                protocol: 'anthropic',
              },
            ],
          }),
        ),
      ),
    );
    const svc = ModelCatalogService._createForTest(makeEnv(), core, authFacade());

    await svc.refreshOAuthProviderModels();

    const last = setCalls.at(-1) as Record<string, unknown>;
    const providers = last['providers'] as Record<string, { type: string; baseUrl: string }>;
    const models = last['models'] as Record<string, { provider: string; protocol?: string }>;
    // Provider type/baseUrl stay on the kimi wire + REST base; the anthropic
    // transport is carried on the model alias for per-model resolution.
    expect(providers[KIMI_CODE_PROVIDER_NAME]?.type).toBe('kimi');
    expect(providers[KIMI_CODE_PROVIDER_NAME]?.baseUrl).toBe('https://api.example.test/coding/v1');
    expect(models['kimi-code/kimi-for-coding']?.provider).toBe(KIMI_CODE_PROVIDER_NAME);
    expect(models['kimi-code/kimi-for-coding']?.protocol).toBe('anthropic');
  });

  it('publishes event.model_catalog.changed when a broad refresh changes the catalog', async () => {
    const configRef: { current: KimiConfig } = {
      current: {
        providers: {
          [KIMI_CODE_PROVIDER_NAME]: {
            type: 'kimi',
            apiKey: '',
            baseUrl: 'https://api.example.test/coding/v1',
            oauth: { storage: 'file', key: 'oauth/kimi-code' },
          },
        },
        defaultModel: 'kimi-code/kimi-for-coding',
        models: {
          'kimi-code/kimi-for-coding': {
            provider: KIMI_CODE_PROVIDER_NAME,
            model: 'kimi-for-coding',
            maxContextSize: 131_072,
            capabilities: ['thinking'],
          },
        },
      },
    };
    const { core } = makeCore(configRef);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ id: 'kimi-for-coding', context_length: 262_144, supports_reasoning: true }],
            }),
          ),
      ),
    );
    const { svc: eventService, published } = makeEventService();
    const svc = ModelCatalogService._createForTest(makeEnv(), core, authFacade(), eventService);

    const result = await svc.refreshProviderModels();

    expect(result.changed).toEqual([
      { provider_id: KIMI_CODE_PROVIDER_NAME, provider_name: 'Kimi Code', added: 0, removed: 0 },
    ]);
    expect(published).toEqual([
      {
        type: 'event.model_catalog.changed',
        agentId: 'main',
        sessionId: '__global__',
        changed: result.changed,
        unchanged: result.unchanged,
        failed: [],
      },
    ]);
  });

  it('does not publish an event when the refresh is a no-op', async () => {
    const configRef: { current: KimiConfig } = {
      current: {
        providers: {
          [KIMI_CODE_PROVIDER_NAME]: {
            type: 'kimi',
            apiKey: '',
            baseUrl: 'https://api.example.test/coding/v1',
            oauth: { storage: 'file', key: 'oauth/kimi-code' },
          },
        },
        models: {
          'kimi-code/kimi-for-coding': {
            provider: KIMI_CODE_PROVIDER_NAME,
            model: 'kimi-for-coding',
            maxContextSize: 262_144,
            capabilities: ['thinking', 'tool_use'],
          },
        },
      },
    };
    const { core } = makeCore(configRef);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ id: 'kimi-for-coding', context_length: 262_144, supports_reasoning: true }],
            }),
          ),
      ),
    );
    const { svc: eventService, published } = makeEventService();
    const svc = ModelCatalogService._createForTest(makeEnv(), core, authFacade(), eventService);

    const result = await svc.refreshProviderModels();

    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual([KIMI_CODE_PROVIDER_NAME]);
    expect(published).toEqual([]);
  });

  it('sends the host User-Agent on custom-registry fetches', async () => {
    const configRef: { current: KimiConfig } = {
      current: {
        providers: {
          acme: {
            type: 'openai',
            apiKey: 'sk-acme',
            source: {
              kind: 'apiJson',
              url: 'https://registry.example.test/api.json',
              apiKey: 'sk-registry',
            },
          },
        },
        models: {},
      },
    };
    const { core } = makeCore(configRef);
    (core as { kimiRequestHeaders?: Record<string, string> }).kimiRequestHeaders = {
      'User-Agent': 'kimi-code-cli/test',
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            acme: {
              id: 'acme',
              name: 'Acme',
              api: 'https://acme.example.test/v1',
              type: 'openai',
              models: { m1: { id: 'm1', name: 'M1' } },
            },
          }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const svc = ModelCatalogService._createForTest(makeEnv(), core, authFacade());

    await svc.refreshProviderModels();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://registry.example.test/api.json',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'kimi-code-cli/test' }),
      }),
    );
  });
});
