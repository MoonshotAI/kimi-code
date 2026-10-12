import { describe, expect, it, vi } from 'vitest';
import { parse as parseToml } from 'smol-toml';

import { createHarness } from '#/app/index';
import {
  CatalogModels,
  CredentialResolvers,
  ENV_MODEL_ALIAS_KEY,
  ENV_MODEL_PROVIDER_KEY,
  matchCatalogBinding,
  providerCatalog,
  ProviderCatalogRef,
  resolveCredentialProvider,
  useCredentialResolver,
  useProvider,
  useProviderProtocol,
  type CatalogModelDefinition,
  type ProviderStore,
} from '#/builtin/provider-catalog/index';
import { ConfigRef, createConfig, type ConfigPersist } from '#/builtin/config/index';
import { createFeature } from '#/feature/index';
import { openAIBase } from '#/llm/builtin/protocol/openai/index';
import type { LlmModel } from '#/llm/model';
import type { Provider } from '#/llm/provider';
import type { LlmCredentialProvider, LlmRequester } from '#/llm/requester/requester';
import { openBlobs } from '#/store/blob';
import { MemoryBackend, Trees } from '#/store/tree';
import { openSessionStores, type SessionStores } from '#/stores/session';

const modelDef: CatalogModelDefinition = {
  provider: 'test',
  model: 'm1',
  capability: {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: true,
  },
  maxContextSize: 4096,
};

function failingRequester(message: string): LlmRequester {
  return {
    generate: (_config, _content, { onEvent }) => {
      onEvent?.({
        type: 'llm.failed.remote',
        error: {
          kind: 'status',
          statusCode: 500,
          message,
          requestId: null,
          retryAfterMs: null,
          headers: null,
        },
      });
      return Promise.resolve();
    },
  };
}

function stubProvider(
  id: string,
  requester: LlmRequester,
  listModels: () => Promise<readonly LlmModel[]> = () => Promise.resolve([]),
): Provider {
  return {
    id,
    requesters: { openai: requester },
    listModels,
    resolveModel: () => {
      throw new Error('unused');
    },
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(predicate()).toBe(true);
}

async function mountCatalog(extra?: ReturnType<typeof createFeature>): Promise<{
  catalog: ProviderStore;
  models: () => readonly { readonly model: { readonly model: string } }[];
  dispose: () => Promise<void>;
}> {
  const app = createHarness({
    features: extra === undefined ? [providerCatalog] : [providerCatalog, extra],
  });
  await app.ready();
  return {
    catalog: app.resolve(ProviderCatalogRef),
    models: () => app.node.fold(CatalogModels),
    dispose: () => app.disposeAsync(),
  };
}

describe('providerCatalog feature', () => {
  it('contributes a provider, pings through the store, and exposes a requester binding', async () => {
    let failing = true;
    const requester: LlmRequester = {
      generate: (_config, _content, { onEvent }) => {
        if (failing) {
          onEvent?.({
            type: 'llm.failed.remote',
            error: {
              kind: 'status',
              statusCode: 500,
              message: 'boom',
              requestId: null,
              retryAfterMs: null,
              headers: null,
            },
          });
        } else {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'pong' } });
          onEvent?.({ type: 'llm.done' });
        }
        return Promise.resolve();
      },
    };
    const { catalog, models, dispose } = await mountCatalog(
      createFeature('probe', {
        app() {
          useProvider({ provider: stubProvider('test', requester), models: [modelDef] });
        },
      }),
    );
    await until(() => catalog.models('test').length === 1);
    await until(() => models().some((item) => item.model.model === 'm1'));
    expect(catalog.resolve('test', 'm1')?.requester).toBe(requester);

    catalog.ping('test', 'm1');
    await until(() => catalog.models('test').at(0)?.pingError === 'boom');

    failing = false;
    catalog.ping('test', 'm1');
    await until(() => catalog.models('test').at(0)?.pingError === undefined);
    await dispose();
  });

  it('ignores pings for unknown providers and models', async () => {
    const { catalog, dispose } = await mountCatalog();
    catalog.upsert({ provider: stubProvider('test', failingRequester('boom')), models: [modelDef] });
    await until(() => catalog.models('test').length === 1);

    catalog.ping('nope', 'm1');
    catalog.ping('test', 'nope');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(catalog.models('test').at(0)?.pingError).toBeUndefined();
    expect(catalog.resolve('nope', 'm1')).toBeUndefined();
    await dispose();
  });

  it('pings through the latest provider instance after a re-upsert', async () => {
    const { catalog, dispose } = await mountCatalog();
    catalog.upsert({ provider: stubProvider('test', failingRequester('first')), models: [modelDef] });
    catalog.upsert({
      provider: stubProvider('test', failingRequester('second')),
      models: [modelDef],
    });

    catalog.ping('test', 'm1');

    await until(() => catalog.models('test').at(0)?.pingError === 'second');
    expect(catalog.resolve('test', 'm1')?.requester).toBeDefined();
    await dispose();
  });

  it('carries the model protocol flags into ping and requester', async () => {
    const seen: LlmModel[] = [];
    const requester: LlmRequester = {
      generate: (config) => {
        seen.push(config.model);
        return Promise.resolve();
      },
    };
    const provider: Provider = {
      id: 'test',
      requesters: { anthropic: requester },
      listModels: () => Promise.resolve([]),
      resolveModel: () => {
        throw new Error('unused');
      },
    };
    const { catalog, dispose } = await mountCatalog();
    catalog.upsert({
      provider,
      models: [{ ...modelDef, protocol: 'anthropic', betaApi: true }],
    });

    catalog.ping('test', 'm1');
    await until(() => seen.length > 0);
    expect(seen[0]?.betaApi).toBe(true);
    expect(catalog.resolve('test', 'm1')?.requester).toBe(requester);
    await dispose();
  });

  it('defers a ping sent while refreshing until the refresh completes', async () => {
    let pulls = 0;
    let resolvePull: (models: readonly LlmModel[]) => void = () => {};
    const provider = stubProvider('test', failingRequester('boom'), () => {
      pulls += 1;
      return new Promise((resolve) => {
        resolvePull = resolve;
      });
    });
    const { catalog, dispose } = await mountCatalog();
    catalog.upsert({ provider, models: [modelDef] });
    await until(() => pulls === 1);

    catalog.ping('test', 'm1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(catalog.models('test').at(0)?.pingError).toBeUndefined();

    resolvePull([]);
    await until(() => catalog.models('test').at(0)?.pingError === 'boom');
    await dispose();
  });
});


function fakePersist(initial?: string): {
  saved: string[];
  persist: ConfigPersist;
} {
  const saved: string[] = [];
  let text = initial;
  return {
    saved,
    persist: {
      load: () => Promise.resolve(text),
      save: (value) => {
        saved.push(value);
        text = value;
        return Promise.resolve();
      },
    },
  };
}

describe('providerCatalog config integration', () => {
  it('syncs config sections into the catalog and reacts to config changes', async () => {
    const file = fakePersist(
      '[providers.ghost]\nbase_url = "https://api.example.com"\ndefault_model = "g1"\n\n[models.g1]\nprovider = "ghost"\nmodel = "g1"\n',
    );
    const app = createHarness({
      features: [createConfig({ persist: file.persist }), providerCatalog],
    });
    await app.ready();
    const catalog = app.resolve(ProviderCatalogRef);
    expect(catalog.providers()).toContain('ghost');
    expect(catalog.providerInfo('ghost')?.baseUrl).toBe('https://api.example.com');
    expect(catalog.models('ghost').map((model) => model.model)).toEqual(['g1']);

    const config = app.resolve(ConfigRef);
    await config.set(
      'providers',
      { ghost: { baseUrl: 'https://v2.example.com', defaultModel: 'g1' } },
      'memory',
    );
    expect(catalog.providerInfo('ghost')?.baseUrl).toBe('https://v2.example.com');

    await config.replace({ providers: {}, models: {} }, 'memory');
    expect(catalog.providers()).not.toContain('ghost');
    expect(file.saved).toHaveLength(0);
    await app.disposeAsync();
  });

  it('writes discovered models under provider-prefixed aliases, rebuilds the generated zone on refresh, and preserves user aliases', async () => {
    const file = fakePersist('[models."my-fav"]\nprovider = "test"\nmodel = "m1"\ndisplay_name = "mine"\n');
    let upstream: readonly LlmModel[] = [
      { provider: 'test', model: 'm1', capability: modelDef.capability, maxContextSize: 4096 },
      { provider: 'test', model: 'm2', capability: modelDef.capability, maxContextSize: 4096 },
    ];
    const provider = stubProvider('test', failingRequester('boom'), () => Promise.resolve(upstream));
    const app = createHarness({
      features: [
        providerCatalog,
        createConfig({ persist: file.persist }),
        createFeature('probe', {
          app() {
            useProvider({ provider, models: [modelDef] });
            useProvider({
              provider: stubProvider('test2', failingRequester('boom'), () =>
                Promise.resolve([
                  { provider: 'test2', model: 'm1', capability: modelDef.capability, maxContextSize: 8192 },
                ]),
              ),
            });
          },
        }),
      ],
    });
    await app.ready();
    const catalog = app.resolve(ProviderCatalogRef);
    const readModels = (): Record<string, Record<string, unknown>> =>
      (parseToml(file.saved.at(-1)!) as { models: Record<string, Record<string, unknown>> }).models;
    await until(() => file.saved.length > 0 && readModels()['test2/m1'] !== undefined);
    expect(readModels()['test/m1']).toMatchObject({
      provider: 'test',
      model: 'm1',
      max_context_size: 4096,
    });
    expect(readModels()['test/m2']).toMatchObject({ provider: 'test', model: 'm2' });
    expect(readModels()['test2/m1']).toMatchObject({
      provider: 'test2',
      model: 'm1',
      max_context_size: 8192,
    });
    expect(readModels()['my-fav']).toMatchObject({
      provider: 'test',
      model: 'm1',
      display_name: 'mine',
    });

    upstream = [{ provider: 'test', model: 'm2', capability: modelDef.capability, maxContextSize: 4096 }];
    catalog.refresh(provider);
    await until(() => readModels()['test/m1'] === undefined);
    expect(readModels()['test/m2']).toBeDefined();
    expect(readModels()['test2/m1']).toBeDefined();
    expect(readModels()['my-fav']).toBeDefined();

    const settled = file.saved.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(file.saved.length).toBe(settled);
    await app.disposeAsync();
  });

  it('prefers user-zone aliases over generated aliases for the same model id', async () => {
    const file = fakePersist(
      '[models."test/m1"]\nprovider = "test"\nmodel = "m1"\nmax_context_size = 4096\n\n[models."my-fav"]\nprovider = "test"\nmodel = "m1"\ndisplay_name = "mine"\n',
    );
    const app = createHarness({
      features: [createConfig({ persist: file.persist }), providerCatalog],
    });
    await app.ready();
    const catalog = app.resolve(ProviderCatalogRef);
    const m1 = catalog.models('test').find((model) => model.model === 'm1');
    expect(m1?.displayName).toBe('mine');
    await app.disposeAsync();
  });

  it('prefers config-sourced info and models over contributed ones on conflict', async () => {
    const file = fakePersist('[providers.test]\nbase_url = "https://config.example.com"\n');
    const app = createHarness({
      features: [
        createConfig({ persist: file.persist }),
        providerCatalog,
        createFeature('probe', {
          app() {
            useProvider({
              provider: stubProvider('test', failingRequester('boom')),
              info: { baseUrl: 'https://contributed.example.com' },
              models: [modelDef],
            });
          },
        }),
      ],
    });
    await app.ready();
    const catalog = app.resolve(ProviderCatalogRef);
    expect(catalog.providers()).toContain('test');
    expect(catalog.providerInfo('test')?.baseUrl).toBe('https://config.example.com');
    expect(catalog.models('test')).toEqual([]);
    await app.disposeAsync();
  });

  it('loads a v2-format file with [model_catalog] and a capabilities array, then writes the same format back', async () => {
    const file = fakePersist(
      '[model_catalog]\nrefresh_interval_ms = 60000\nrefresh_on_start = false\n\n' +
        '[models."test/m1"]\nprovider = "test"\nmodel = "m1"\nmax_context_size = 4096\ncapabilities = [ "image_in", "tool_use" ]\n',
    );
    const app = createHarness({
      features: [createConfig({ persist: file.persist }), providerCatalog],
    });
    await app.ready();
    const config = app.resolve(ConfigRef);
    expect(config.get('modelCatalog')).toEqual({ refreshIntervalMs: 60000, refreshOnStart: false });
    const catalog = app.resolve(ProviderCatalogRef);
    const m1 = catalog.models('test').find((model) => model.model === 'm1');
    expect(m1?.capability).toEqual({
      image_in: true,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
    });
    const loaded = config.get<Record<string, Record<string, unknown>>>('models');
    await config.replace(
      { models: { 'test/m1': { ...loaded['test/m1'], maxContextSize: 8192 } } },
      'user',
    );
    const text = file.saved.at(-1)!;
    expect(text).toContain('[model_catalog]');
    expect(text).toContain('refresh_interval_ms = 60000');
    const models = (parseToml(text) as { models: Record<string, Record<string, unknown>> }).models;
    expect(models['test/m1']).toMatchObject({
      provider: 'test',
      model: 'm1',
      max_context_size: 8192,
      capabilities: ['image_in', 'tool_use'],
    });
    expect(models['test/m1']!['capability']).toBeUndefined();
    expect(models['test/m1']!['maxContextSize']).toBeUndefined();
    await app.disposeAsync();
  });

  it('preserves unknown capability entries on disk through the extras channel', async () => {
    const file = fakePersist(
      '[models."test/m1"]\nprovider = "test"\nmodel = "m1"\ncapabilities = [ "tool_use", "future_cap" ]\n',
    );
    const app = createHarness({
      features: [createConfig({ persist: file.persist }), providerCatalog],
    });
    await app.ready();
    const config = app.resolve(ConfigRef);
    const models = config.get<Record<string, { capability?: Record<string, unknown>; extras?: Record<string, unknown> }>>('models');
    expect(models['test/m1']?.capability?.['tool_use']).toBe(true);
    expect(models['test/m1']?.extras?.['capabilities']).toEqual(['future_cap']);
    await config.replace({ models: { 'test/m1': { ...models['test/m1'], maxContextSize: 100 } } }, 'user');
    const written = (parseToml(file.saved.at(-1)!) as { models: Record<string, Record<string, unknown>> }).models;
    expect(written['test/m1']!['capabilities']).toEqual(['tool_use', 'future_cap']);
    expect(written['test/m1']!['max_context_size']).toBe(100);
    expect((written['test/m1']!['extras'] as Record<string, unknown> | undefined)?.['capabilities']).toBeUndefined();
    await app.disposeAsync();
  });

  it('warns at load time when a dotted model alias parses as a nested table', async () => {
    const file = fakePersist('[models.test.m1]\nprovider = "test"\nmodel = "m1"\n');
    const app = createHarness({
      features: [createConfig({ persist: file.persist }), providerCatalog],
    });
    await app.ready();
    const config = app.resolve(ConfigRef);
    expect(
      config.diagnostics().some(
        (entry) =>
          entry.section === 'models' &&
          entry.message.includes("[models] entry 'test' is missing the 'model' field") &&
          entry.message.includes('[models."test.m1"]'),
      ),
    ).toBe(true);
    await app.disposeAsync();
  });
});


describe('kimiModelEnvOverlay', () => {
  const mountWithEnv = async (env: Record<string, string>) => {
    const app = createHarness({
      features: [createConfig({ persist: fakePersist('').persist, env }), providerCatalog],
    });
    await app.ready();
    return app;
  };

  it('applies the KIMI_MODEL_NAME overlay end to end: effective provider/model/defaultModel, a resolvable binding, and no persisted leakage', async () => {
    const file = fakePersist(
      'default_model = "test/m1"\n\n[providers.test]\ntype = "acme"\napi_key = "sk-static"\n\n[models."test/m1"]\nprovider = "test"\nmodel = "m1"\nmax_context_size = 4096\n',
    );
    const app = createHarness({
      features: [
        createConfig({
          persist: file.persist,
          env: { KIMI_MODEL_NAME: 'kimi-for-coding', KIMI_MODEL_API_KEY: 'sk-env' },
        }),
        providerCatalog,
        createFeature('probe', {
          app() {
            useProviderProtocol({
              type: 'kimi',
              protocols: () => ({ openai: { base: openAIBase } }),
            });
          },
        }),
      ],
    });
    await app.ready();
    const config = app.resolve(ConfigRef);
    expect(
      config.get<Record<string, Record<string, unknown>>>('providers')[ENV_MODEL_PROVIDER_KEY],
    ).toEqual({
      type: 'kimi',
      apiKey: 'sk-env',
      baseUrl: 'https://api.moonshot.ai/v1',
    });
    expect(
      config.get<Record<string, Record<string, unknown>>>('models')[ENV_MODEL_ALIAS_KEY],
    ).toEqual({
      provider: ENV_MODEL_PROVIDER_KEY,
      model: 'kimi-for-coding',
      maxContextSize: 262144,
      capability: {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: false,
      },
    });
    expect(config.get('defaultModel')).toBe(ENV_MODEL_ALIAS_KEY);

    const catalog = app.resolve(ProviderCatalogRef);
    await until(() =>
      app.node
        .fold(CatalogModels)
        .some(
          (binding) =>
            binding.providerId === ENV_MODEL_PROVIDER_KEY &&
            binding.model.model === 'kimi-for-coding',
        ),
    );
    expect(catalog.isLive(ENV_MODEL_PROVIDER_KEY)).toBe(true);
    expect(catalog.providerInfo(ENV_MODEL_PROVIDER_KEY)?.apiKey).toBe('sk-env');
    expect(catalog.resolve(ENV_MODEL_PROVIDER_KEY, 'kimi-for-coding')?.requester).toBeDefined();
    expect(
      matchCatalogBinding(ENV_MODEL_ALIAS_KEY, app.node.fold(CatalogModels))?.model.model,
    ).toBe('kimi-for-coding');

    await config.set('defaultModel', config.get('defaultModel'), 'user');
    expect(file.saved).toHaveLength(0);
    await config.set('providers', { acme2: { type: 'acme', apiKey: 'sk-2' } }, 'user');
    let written = file.saved.at(-1)!;
    expect(written).toContain('[providers.acme2]');
    expect(written).not.toContain(ENV_MODEL_PROVIDER_KEY);
    expect(written).not.toContain('sk-env');
    await config.replace(
      {
        models: {
          ...config.get<Record<string, Record<string, unknown>>>('models'),
          'test/m2': { provider: 'test', model: 'm2' },
        },
      },
      'user',
    );
    written = file.saved.at(-1)!;
    expect(written).toContain('[models."test/m2"]');
    expect(written).toContain('[models."test/m1"]');
    expect(written).not.toContain(ENV_MODEL_ALIAS_KEY);
    expect(written).not.toContain(ENV_MODEL_PROVIDER_KEY);
    expect(written).toContain('default_model = "test/m1"');
    expect(config.get('defaultModel')).toBe(ENV_MODEL_ALIAS_KEY);
    await app.disposeAsync();
  });

  it('populates model_overrides from the KIMI_MODEL_* knobs without a model name and never persists it', async () => {
    const file = fakePersist('');
    const app = createHarness({
      features: [
        createConfig({
          persist: file.persist,
          env: {
            KIMI_MODEL_TEMPERATURE: '0.7',
            KIMI_MODEL_TOP_P: '0.95',
            KIMI_MODEL_THINKING_KEEP: 'all',
            KIMI_MODEL_MAX_COMPLETION_TOKENS: '4096',
            KIMI_MODEL_MAX_TOKENS: '2048',
          },
        }),
        providerCatalog,
      ],
    });
    await app.ready();
    const config = app.resolve(ConfigRef);
    expect(config.get('modelOverrides')).toEqual({
      temperature: 0.7,
      topP: 0.95,
      thinkingKeep: 'all',
      maxCompletionTokens: 4096,
    });
    expect(config.get('defaultModel')).toBeUndefined();
    await config.replace(
      { modelOverrides: config.get('modelOverrides'), defaultModel: 'test/m1' },
      'user',
    );
    const written = file.saved.at(-1)!;
    expect(written).toContain('default_model = "test/m1"');
    expect(written).not.toContain('model_overrides');
    await app.disposeAsync();

    const legacy = await mountWithEnv({ KIMI_MODEL_MAX_TOKENS: '2048' });
    expect(legacy.resolve(ConfigRef).get('modelOverrides')).toEqual({ maxCompletionTokens: 2048 });
    await legacy.disposeAsync();
  });

  it('maps extended model metadata, resolves the env provider endpoint chain, and reports invalid env values as diagnostics', async () => {
    const extended = await mountWithEnv({
      KIMI_MODEL_NAME: 'env-model',
      KIMI_MODEL_MAX_CONTEXT_SIZE: '1000000',
      KIMI_MODEL_MAX_OUTPUT_SIZE: '8192',
      KIMI_MODEL_CAPABILITIES: 'Image_In, thinking , tool_use',
      KIMI_MODEL_DISPLAY_NAME: 'Custom Model',
      KIMI_MODEL_REASONING_KEY: 'reasoning',
      KIMI_MODEL_ADAPTIVE_THINKING: 'true',
      KIMI_MODEL_PROVIDER_TYPE: 'openai',
      KIMI_MODEL_BASE_URL: 'https://proxy.example.com/v1',
      KIMI_MODEL_TEMPERATURE: '0.3',
    });
    const extendedConfig = extended.resolve(ConfigRef);
    expect(extendedConfig.get('modelOverrides')).toEqual({ temperature: 0.3 });
    expect(
      extendedConfig.get<Record<string, Record<string, unknown>>>('models')[ENV_MODEL_ALIAS_KEY],
    ).toEqual({
      provider: ENV_MODEL_PROVIDER_KEY,
      model: 'env-model',
      maxContextSize: 1000000,
      maxOutputSize: 8192,
      capability: {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
      },
      displayName: 'Custom Model',
      reasoningKey: 'reasoning',
      adaptiveThinking: true,
    });
    expect(
      extendedConfig.get<Record<string, Record<string, unknown>>>('providers')[
        ENV_MODEL_PROVIDER_KEY
      ],
    ).toEqual({ type: 'openai', baseUrl: 'https://proxy.example.com/v1' });
    await extended.disposeAsync();

    const openai = await mountWithEnv({
      KIMI_MODEL_NAME: 'env-model',
      KIMI_MODEL_PROVIDER_TYPE: 'openai',
    });
    expect(
      openai.resolve(ConfigRef).get<Record<string, Record<string, unknown>>>('providers')[
        ENV_MODEL_PROVIDER_KEY
      ],
    ).toEqual({ type: 'openai' });
    await openai.disposeAsync();

    const invalid = await mountWithEnv({
      KIMI_MODEL_NAME: 'env-model',
      KIMI_MODEL_TEMPERATURE: 'hot',
    });
    const invalidConfig = invalid.resolve(ConfigRef);
    expect(invalidConfig.get('defaultModel')).toBeUndefined();
    expect(
      invalidConfig.diagnostics().some(
        (entry) =>
          entry.message.includes('Ignoring config environment overlay') &&
          entry.message.includes('KIMI_MODEL_TEMPERATURE must be a number'),
      ),
    ).toBe(true);
    await invalid.disposeAsync();
  });
});


describe('provider-catalog materialization', () => {
  it('materializes a config-declared provider, discovers models, writes them back under the alias scope, and unbinds on removal', async () => {
    const seen: { url: string; authorization?: string }[] = [];
    let upstream: readonly string[] = ['m1', 'm2'];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        authorization: (init?.headers as Record<string, string> | undefined)?.['authorization'],
      });
      return new Response(JSON.stringify({ data: upstream.map((id) => ({ id })) }), {
        status: 200,
      });
    });
    try {
      const file = fakePersist(
        '[providers.acme]\ntype = "acme"\nbase_url = "https://acme.example.com"\nmodel_source = "discover"\nalias_scope = "shared"\n\n[providers.acme.env]\napiKey = "ACME_KEY"\n',
      );
      const app = createHarness({
        features: [
          createConfig({ persist: file.persist, env: { ACME_KEY: 'sk-resolved' } }),
          providerCatalog,
          createFeature('probe', {
            app() {
              useProviderProtocol({
                type: 'acme',
                protocols: () => ({ openai: { base: openAIBase } }),
              });
            },
          }),
        ],
      });
      await app.ready();
      const catalog = app.resolve(ProviderCatalogRef);
      await until(() => seen.length > 0);
      expect(seen[0]).toEqual({
        url: 'https://acme.example.com/models',
        authorization: 'Bearer sk-resolved',
      });
      await until(() => catalog.models('acme').length === 2);
      expect(catalog.models('acme').map((model) => model.model)).toEqual(['m1', 'm2']);
      expect(catalog.models('acme').at(0)?.apiKey).toBe('sk-resolved');
      expect(catalog.resolve('acme', 'm1')?.requester).toBeDefined();
      const readModels = (): Record<string, Record<string, unknown>> =>
        (parseToml(file.saved.at(-1)!) as { models: Record<string, Record<string, unknown>> })
          .models;
      await until(() => file.saved.length > 0 && readModels()['shared/m2'] !== undefined);
      expect(readModels()['shared/m1']).toMatchObject({ provider: 'acme', model: 'm1' });
      expect(readModels()['shared/m2']).toMatchObject({ provider: 'acme', model: 'm2' });
      expect(readModels()['shared/m1']!['api_key']).toBeUndefined();

      upstream = ['m2'];
      catalog.refresh('acme');
      await until(() => readModels()['shared/m1'] === undefined);
      expect(readModels()['shared/m2']).toBeDefined();

      const config = app.resolve(ConfigRef);
      await config.replace({ providers: {}, models: {} }, 'memory');
      expect(catalog.providers()).not.toContain('acme');
      expect(catalog.isLive('acme')).toBe(false);
      const settled = file.saved.length;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(file.saved.length).toBe(settled);
      await app.disposeAsync();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not fetch models for static providers and skips oauth-backed and unknown types', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const file = fakePersist(
        '[providers.acme]\ntype = "acme"\nbase_url = "https://acme.example.com"\napi_key = "sk-x"\n\n[providers.managed]\ntype = "acme"\nmodel_source = "oauth-catalog"\nbase_url = "https://managed.example.com"\n\n[providers.legacy]\ntype = "acme"\nbase_url = "https://legacy.example.com"\n\n[providers.legacy.oauth]\nstorage = "file"\nkey = "oauth/legacy"\n\n[providers.ghost]\ntype = "nope"\nbase_url = "https://ghost.example.com"\n',
      );
      const app = createHarness({
        features: [
          createConfig({ persist: file.persist }),
          providerCatalog,
          createFeature('probe', {
            app() {
              useProviderProtocol({
                type: 'acme',
                protocols: () => ({ openai: { base: openAIBase } }),
              });
            },
          }),
        ],
      });
      await app.ready();
      const catalog = app.resolve(ProviderCatalogRef);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(catalog.isLive('acme')).toBe(true);
      expect(catalog.isLive('managed')).toBe(false);
      expect(catalog.isLive('legacy')).toBe(false);
      expect(catalog.isLive('ghost')).toBe(false);
      await app.disposeAsync();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});


async function testStores(): Promise<{ stores: SessionStores }> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  return { stores: await openSessionStores(tree, openBlobs(backend.blobs)) };
}

describe('provider-catalog default model restore', () => {
  it('restores the model binding on agent mount from defaultModel and keeps explicit overrides', async () => {
    const file = fakePersist(
      'default_model = "test/m1"\n\n[providers.test]\ntype = "acme"\napi_key = "sk-static"\n\n[models."test/m1"]\nprovider = "test"\nmodel = "m1"\nmax_context_size = 4096\n',
    );
    const app = createHarness({
      features: [
        createConfig({ persist: file.persist }),
        providerCatalog,
        createFeature('probe', {
          app() {
            useProviderProtocol({
              type: 'acme',
              protocols: () => ({ openai: { base: openAIBase } }),
            });
          },
        }),
      ],
    });
    await app.ready();
    const env = await testStores();
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const main = await session.create({ agentId: 'main' });
    await until(() => main.config?.model.model === 'm1');
    expect(main.config?.model.provider).toBe('test');
    expect(main.config?.model.maxContextSize).toBe(4096);

    main.setConfig({ model: { provider: 'test', model: 'other', capability: modelDef.capability } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(main.config?.model.model).toBe('other');

    const config = app.resolve(ConfigRef);
    await config.set('defaultModel', 'test/m2', 'user');
    expect(file.saved.at(-1)).toContain('default_model = "test/m2"');
    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('skips the restore silently when defaultModel has no binding', async () => {
    const file = fakePersist(
      'default_model = "ghost/nope"\n\n[providers.test]\ntype = "acme"\napi_key = "sk-static"\n',
    );
    const app = createHarness({
      features: [
        createConfig({ persist: file.persist }),
        providerCatalog,
        createFeature('probe', {
          app() {
            useProviderProtocol({
              type: 'acme',
              protocols: () => ({ openai: { base: openAIBase } }),
            });
          },
        }),
      ],
    });
    await app.ready();
    const env = await testStores();
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const main = await session.create({ agentId: 'main' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(main.config).toBeUndefined();
    await app.disposeAsync();
    await env.stores.dispose();
  });
});

describe('provider-catalog credential resolvers', () => {
  it('resolves contributed resolvers before the static apiKey fallback', async () => {
    const sentinel: LlmCredentialProvider = { resolve: () => ({ apiKey: 'sk-sentinel' }) };
    const app = createHarness({
      features: [
        createConfig({ persist: fakePersist().persist, env: { ACME_KEY: 'sk-env' } }),
        providerCatalog,
        createFeature('probe', {
          app() {
            useCredentialResolver({
              resolve: (info) => (info.type === 'sentinel' ? sentinel : undefined),
            });
          },
        }),
      ],
    });
    await app.ready();
    const resolvers = app.node.fold(CredentialResolvers);
    expect(await resolveCredentialProvider({ apiKey: 'sk-inline' }, resolvers)?.resolve()).toEqual({
      apiKey: 'sk-inline',
    });
    expect(
      await resolveCredentialProvider({ env: { apiKey: 'ACME_KEY' } }, resolvers)?.resolve(),
    ).toEqual({ apiKey: 'sk-env' });
    expect(resolveCredentialProvider({ type: 'sentinel', apiKey: 'sk-x' }, resolvers)).toBe(
      sentinel,
    );
    expect(resolveCredentialProvider({}, resolvers)).toBeUndefined();
    await app.disposeAsync();
  });
});
