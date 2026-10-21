import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createFeature,
  createApp,
  type App,
} from '#/app/index';
import { memorySessionSpace } from '@moonshot-ai/agent-core/session/index';
import { useInject, type ShallowRef } from '#/kernel/index';

import {
  ConfigRef,
  DEFAULT_MODEL_CONFIG_SECTION,
  MODELS_CONFIG_SECTION,
  PROVIDERS_CONFIG_SECTION,
  createConfig,
  type ConfigPersist,
  type ConfigStore,
} from '#/features/config/index';
import {
  ProviderCatalogRef,
  providerCatalog,
  type CatalogModelConfig,
  type ProviderCatalogFace,
} from '#/features/provider-catalog/index';
import {
  createModelsDev,
  getModelsDevCatalog,
  ModelsDevRef,
  modelsDevModelToConfig,
  modelsDevProviderModels,
  PROVIDER_ID_PATTERN,
  resetModelsDevUpstreamForTest,
  resolveModelsDevImport,
  setModelsDevUpstreamForTest,
  toModelsDevProviderItem,
  type ModelsDevCatalog,
  type ModelsDevFace,
  type ModelsDevProviderEntry,
} from '#/features/models-dev/index';


const harnesses: App[] = [];

afterEach(async () => {
  vi.useRealTimers();
  resetModelsDevUpstreamForTest();
  vi.unstubAllGlobals();
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

function fakePersist(initial?: string): { saved: string[]; persist: ConfigPersist } {
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

const CATALOG: ModelsDevCatalog = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    npm: '@ai-sdk/anthropic',
    api: 'https://api.anthropic.com/v1',
    env: ['ANTHROPIC_API_KEY'],
    models: {
      'claude-sonnet': {
        id: 'claude-sonnet',
        name: 'Claude Sonnet',
        limit: { context: 200000, input: 180000, output: 64000 },
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
    },
  },
  acme: {
    id: 'acme',
    name: 'Acme',
    api: 'https://acme.example.com/v1',
    env: ['ACME_API_KEY'],
    models: {
      'acme-pro': {
        id: 'acme-pro',
        name: 'Acme Pro',
        limit: { context: 32768, output: 4096 },
        modalities: { input: ['text', 'audio'], output: ['text'] },
        interleaved: { field: 'reasoning_content' },
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
      'acme-old': { id: 'acme-old', limit: { context: 8192 }, status: 'deprecated' },
      'acme-embed': { id: 'acme-embed', limit: { context: 8192 } },
    },
  },
  placeholder: {
    id: 'placeholder',
    name: 'Placeholder',
    npm: '@ai-sdk/openai',
    api: 'https://${PLACEHOLDER_KEY}.example.com',
    models: {
      p1: { id: 'p1', limit: { context: 4096 } },
    },
  },
  bedrock: {
    id: 'bedrock',
    name: 'Bedrock',
    npm: '@ai-sdk/amazon-bedrock',
    models: {},
  },
  empty: {
    id: 'empty',
    name: 'Empty',
    api: 'https://empty.example.com',
    models: {},
  },
};

let currentCatalog: unknown = CATALOG;

function stubFailingFetch(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    throw new Error(`unexpected fetch ${typeof input === 'string' ? input : input.url}`);
  });
}

interface ModelsDevCapture {
  face?: Readonly<ShallowRef<ModelsDevFace | undefined>>;
  config?: Readonly<ShallowRef<ConfigStore | undefined>>;
  catalog?: Readonly<ShallowRef<ProviderCatalogFace | undefined>>;
}

function modelsDevProbe(capture: ModelsDevCapture) {
  return createFeature('models-dev-probe', {
    app() {
      capture.face = useInject(ModelsDevRef);
      capture.config = useInject(ConfigRef);
      capture.catalog = useInject(ProviderCatalogRef);
    },
  });
}

async function mountModelsDev(options: {
  toml?: string;
  withConfig?: boolean;
  userAgent?: string;
}): Promise<{ harness: App; face: ModelsDevFace; config?: ConfigStore; catalog: ProviderCatalogFace }> {
  stubFailingFetch();
  const capture: ModelsDevCapture = {};
  const harness = createApp({ space: memorySessionSpace() });
  harnesses.push(harness);
  harness.features.add(providerCatalog);
  if (options.withConfig !== false) {
    harness.features.add(createConfig({ persist: fakePersist(options.toml).persist }));
  }
  harness.features.add(
    createModelsDev({ builtinCatalog: () => currentCatalog, userAgent: options.userAgent }),
  );
  harness.features.add(modelsDevProbe(capture));
  await tick();
  const face = capture.face?.value;
  const catalog = capture.catalog?.value;
  if (face === undefined || catalog === undefined) {
    throw new Error('models-dev or provider-catalog face was not exposed');
  }
  const config = capture.config?.value;
  if (options.withConfig !== false && config === undefined) {
    throw new Error('config face was not exposed');
  }
  if (config !== undefined) await config.reload();
  return { harness, face, config, catalog };
}

describe('models-dev pure conversion', () => {
  it('resolveModelsDevImport classifies wire, baseUrl and failure states', () => {
    expect(resolveModelsDevImport(CATALOG['anthropic']!)).toEqual({
      kind: 'ok',
      wire: 'anthropic',
      guessed: false,
      baseUrl: 'https://api.anthropic.com',
    });
    expect(resolveModelsDevImport(CATALOG['acme']!)).toEqual({
      kind: 'ok',
      wire: 'openai',
      guessed: true,
      baseUrl: 'https://acme.example.com/v1',
    });
    expect(resolveModelsDevImport(CATALOG['bedrock']!)).toEqual({
      kind: 'invalid',
      reason: 'proprietary-sdk',
    });
    expect(resolveModelsDevImport({ id: 'x', type: 'weird' })).toEqual({
      kind: 'invalid',
      reason: 'unknown-explicit-type',
    });
    expect(resolveModelsDevImport(CATALOG['placeholder']!)).toEqual({
      kind: 'needs-base-url',
      wire: 'openai',
      guessed: false,
    });
    expect(resolveModelsDevImport({ id: 'x', npm: '@ai-sdk/openai', models: {} })).toEqual({
      kind: 'ok',
      wire: 'openai',
      guessed: false,
    });
    expect(resolveModelsDevImport(CATALOG['acme']!, '   ')).toEqual({
      kind: 'invalid',
      reason: 'empty-base-url',
    });
    expect(resolveModelsDevImport(CATALOG['acme']!, 'https://${KEY}.example.com')).toEqual({
      kind: 'invalid',
      reason: 'placeholder-base-url',
    });
    expect(resolveModelsDevImport(CATALOG['anthropic']!, 'https://proxy.example.com/v1/')).toEqual({
      kind: 'ok',
      wire: 'anthropic',
      guessed: false,
      baseUrl: 'https://proxy.example.com',
    });
  });

  it('modelsDevProviderModels filters unusable models and maps capabilities', () => {
    const models = modelsDevProviderModels(CATALOG['acme']!);
    expect(models.map((model) => model.id)).toEqual(['acme-pro']);
    const pro = models[0]!;
    expect(pro.maxContextSize).toBe(32768);
    expect(pro.maxOutputSize).toBe(4096);
    expect(pro.capability).toEqual({
      image_in: false,
      video_in: false,
      audio_in: true,
      thinking: true,
      tool_use: true,
      dynamically_loaded_tools: false,
    });
    expect(pro.supportEfforts).toEqual(['low', 'high']);
    expect(pro.offEffort).toBeUndefined();
    expect(pro.alwaysThinking).toBe(true);
    expect(pro.reasoningKey).toBe('reasoning_content');

    const entry: ModelsDevProviderEntry = {
      id: 'opts',
      api: 'https://opts.example.com',
      models: {
        off: {
          id: 'off',
          limit: { context: 1000, input: 5000 },
          reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high'] }],
        },
        nullable: {
          id: 'nullable',
          limit: { context: 1000 },
          tool_call: false,
          reasoning_options: [{ type: 'effort', values: [null, 'minimal'] }],
        },
        toggle: {
          id: 'toggle',
          limit: { context: 1000 },
          reasoning_options: [{ type: 'toggle' }],
        },
        noContext: { id: 'no-context', limit: { output: 100 } },
        badContext: { id: 'bad-context', limit: { context: 0 } },
        alpha: { id: 'alpha', limit: { context: 1000 }, status: 'alpha' },
        imageOnly: {
          id: 'image-only',
          limit: { context: 1000 },
          modalities: { input: ['text'], output: ['image'] },
        },
      },
    };
    const byId = new Map(modelsDevProviderModels(entry).map((model) => [model.id, model]));
    expect([...byId.keys()].toSorted()).toEqual(['nullable', 'off', 'toggle']);
    expect(byId.get('off')).toMatchObject({
      supportEfforts: ['low', 'high'],
      offEffort: 'none',
      maxInputSize: 1000,
    });
    expect(byId.get('off')?.alwaysThinking).toBeUndefined();
    expect(byId.get('nullable')).toMatchObject({
      supportEfforts: ['minimal'],
      offEffort: 'none',
    });
    expect(byId.get('nullable')?.capability.tool_use).toBe(false);
    expect(byId.get('toggle')?.capability.thinking).toBe(true);
    expect(byId.get('toggle')?.alwaysThinking).toBeUndefined();

    const alwaysOnAnthropic = modelsDevProviderModels({
      id: 'anthropic-x',
      npm: '@ai-sdk/anthropic',
      models: {
        m: {
          id: 'm',
          limit: { context: 1000 },
          reasoning_options: [{ type: 'effort', values: ['low'] }],
        },
      },
    });
    expect(alwaysOnAnthropic[0]?.alwaysThinking).toBeUndefined();
  });

  it('modelsDevProviderModels applies model-level provider overrides', () => {
    const models = modelsDevProviderModels({
      id: 'mix',
      api: 'https://mix.example.com/v1',
      models: {
        keep: { id: 'keep', limit: { context: 1000 } },
        toAnthropic: {
          id: 'to-anth',
          limit: { context: 1000 },
          provider: { npm: '@ai-sdk/anthropic', api: 'https://ant.example.com/v1' },
        },
        toBedrock: {
          id: 'to-bed',
          limit: { context: 1000 },
          provider: { npm: '@ai-sdk/amazon-bedrock' },
        },
        sameWire: {
          id: 'same',
          limit: { context: 1000 },
          provider: { npm: '@ai-sdk/openai', api: 'https://alt.example.com/v1' },
        },
        crossGoogle: {
          id: 'cross',
          limit: { context: 1000 },
          provider: { npm: '@ai-sdk/google', api: 'https://g.example.com' },
        },
      },
    });
    const byId = new Map(models.map((model) => [model.id, model]));
    expect([...byId.keys()].toSorted()).toEqual(['keep', 'same', 'to-anth']);
    expect(byId.get('keep')?.protocol).toBeUndefined();
    expect(byId.get('keep')?.baseUrl).toBeUndefined();
    expect(byId.get('to-anth')).toMatchObject({
      protocol: 'anthropic',
      baseUrl: 'https://ant.example.com',
    });
    expect(byId.get('same')).toMatchObject({ baseUrl: 'https://alt.example.com/v1' });
  });

  it('modelsDevModelToConfig and toModelsDevProviderItem emit catalog config and browse DTOs', () => {
    const pro = modelsDevProviderModels(CATALOG['acme']!)[0]!;
    expect(modelsDevModelToConfig('acme', pro)).toEqual({
      provider: 'acme',
      model: 'acme-pro',
      maxContextSize: 32768,
      maxOutputSize: 4096,
      capability: {
        image_in: false,
        video_in: false,
        audio_in: true,
        thinking: true,
        tool_use: true,
      },
      displayName: 'Acme Pro',
      reasoningKey: 'reasoning_content',
      supportEfforts: ['low', 'high'],
      alwaysThinking: true,
    });

    expect(toModelsDevProviderItem('acme', CATALOG['acme']!)).toEqual({
      id: 'acme',
      name: 'Acme',
      wire_type: 'openai',
      guessed: true,
      needs_base_url: false,
      rejected: false,
      reject_reason: null,
      env_key: 'ACME_API_KEY',
      models: [
        {
          id: 'acme-pro',
          name: 'Acme Pro',
          max_context_size: 32768,
          capabilities: ['audio_in', 'thinking', 'tool_use'],
          reasoning: true,
        },
      ],
    });
    expect(toModelsDevProviderItem('bedrock', CATALOG['bedrock']!)).toMatchObject({
      wire_type: null,
      guessed: false,
      rejected: true,
      reject_reason: 'proprietary-sdk',
      env_key: null,
    });
    expect(PROVIDER_ID_PATTERN.test('acme-x_1 y')).toBe(true);
    expect(PROVIDER_ID_PATTERN.test('!acme')).toBe(false);
  });
});

describe('models-dev upstream', () => {
  it('caches within the TTL, falls back to stale cache, then to builtinCatalog, else throws', async () => {
    let nowValue = 1_000_000;
    let calls = 0;
    const okPayload = { demo: { id: 'demo' } };
    let fail = false;
    setModelsDevUpstreamForTest({
      now: () => nowValue,
      fetchImpl: (async () => {
        calls += 1;
        if (fail) throw new Error('network down');
        return new Response(JSON.stringify(okPayload), { status: 200 });
      }) as typeof fetch,
    });
    await expect(getModelsDevCatalog()).resolves.toEqual(okPayload);
    await expect(getModelsDevCatalog()).resolves.toEqual(okPayload);
    expect(calls).toBe(1);

    nowValue += 11 * 60 * 1000;
    fail = true;
    await expect(getModelsDevCatalog()).resolves.toEqual(okPayload);
    expect(calls).toBe(2);

    resetModelsDevUpstreamForTest();
    nowValue = 2_000_000;
    const builtin = { legacy: { id: 'legacy' } };
    setModelsDevUpstreamForTest({
      now: () => nowValue,
      fetchImpl: (async () => {
        throw new Error('network down');
      }) as typeof fetch,
    });
    await expect(getModelsDevCatalog({ builtinCatalog: () => builtin })).resolves.toEqual(builtin);

    resetModelsDevUpstreamForTest();
    setModelsDevUpstreamForTest({
      fetchImpl: (async () => new Response('forbidden', { status: 403 })) as typeof fetch,
    });
    const missing = getModelsDevCatalog({ builtinCatalog: () => 42 });
    await expect(missing).rejects.toMatchObject({
      name: 'ModelsDevError',
      code: 'modelsDev.catalog_unavailable',
    });

    resetModelsDevUpstreamForTest();
    setModelsDevUpstreamForTest({
      fetchImpl: (async () =>
        new Response(JSON.stringify(['not', 'an', 'object']), { status: 200 })) as typeof fetch,
    });
    await expect(getModelsDevCatalog()).rejects.toMatchObject({
      code: 'modelsDev.catalog_unavailable',
    });
  });

  it('dedupes in-flight fetches and sends Accept plus optional User-Agent', async () => {
    const seen: Array<Record<string, string>> = [];
    let release: (response: Response) => void = () => {};
    setModelsDevUpstreamForTest({
      fetchImpl: ((_: unknown, init?: RequestInit) => {
        seen.push((init?.headers ?? {}) as Record<string, string>);
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }) as typeof fetch,
    });
    const first = getModelsDevCatalog({ userAgent: 'kimi-test/1.0' });
    const second = getModelsDevCatalog({ userAgent: 'kimi-test/1.0' });
    release(new Response(JSON.stringify({}), { status: 200 }));
    await expect(first).resolves.toEqual({});
    await expect(second).resolves.toEqual({});
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ Accept: 'application/json', 'User-Agent': 'kimi-test/1.0' });

    resetModelsDevUpstreamForTest();
    seen.length = 0;
    setModelsDevUpstreamForTest({
      fetchImpl: ((_: unknown, init?: RequestInit) => {
        seen.push((init?.headers ?? {}) as Record<string, string>);
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      }) as typeof fetch,
    });
    await getModelsDevCatalog();
    expect(seen[0]).toEqual({ Accept: 'application/json' });
  });
});

describe('models-dev feature browse and import', () => {
  it('lists and gets catalog entries without a mounted config and rejects imports coded', async () => {
    const { face } = await mountModelsDev({ withConfig: false });
    const items = await face.listProviders();
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get('anthropic')).toMatchObject({
      wire_type: 'anthropic',
      guessed: false,
      needs_base_url: false,
      env_key: 'ANTHROPIC_API_KEY',
    });
    expect(byId.get('placeholder')).toMatchObject({ needs_base_url: true, wire_type: 'openai' });
    expect(byId.get('bedrock')).toMatchObject({ rejected: true, reject_reason: 'proprietary-sdk' });
    await expect(face.getProvider('acme')).resolves.toMatchObject({ id: 'acme', name: 'Acme' });
    await expect(face.getProvider('missing')).rejects.toMatchObject({
      code: 'modelsDev.catalog_entry_not_found',
    });
    await expect(face.importProvider({ catalogId: 'acme' })).rejects.toMatchObject({
      code: 'config.unavailable',
    });
    await expect(face.importRegistry({ url: 'https://registry.example.com/api.json' })).rejects.toMatchObject({
      code: 'config.unavailable',
    });
  });

  it('importProvider writes both sections, preserves apiKey, seeds defaultModel once', async () => {
    const { face, config } = await mountModelsDev({});
    expect(config).toBeDefined();
    const store = config!;

    const first = await face.importProvider({ catalogId: 'anthropic', apiKey: 'sk-ant' });
    expect(first.provider).toEqual({
      id: 'anthropic',
      type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      has_api_key: true,
      models: ['claude-sonnet'],
    });
    expect(first.models_imported).toBe(1);
    expect(store.get(PROVIDERS_CONFIG_SECTION)).toEqual({
      anthropic: {
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant',
        source: { kind: 'modelsDev', catalogId: 'anthropic' },
      },
    });
    expect(store.get(MODELS_CONFIG_SECTION)).toEqual({
      'anthropic/claude-sonnet': {
        provider: 'anthropic',
        model: 'claude-sonnet',
        maxContextSize: 200000,
        maxInputSize: 180000,
        maxOutputSize: 64000,
        capability: {
          image_in: true,
          video_in: false,
          audio_in: false,
          thinking: true,
          tool_use: true,
        },
        displayName: 'Claude Sonnet',
      },
    });
    expect(store.get(DEFAULT_MODEL_CONFIG_SECTION)).toBe('anthropic/claude-sonnet');

    await face.refreshRegistries();
    expect(store.get(MODELS_CONFIG_SECTION)).toMatchObject({
      'anthropic/claude-sonnet': {
        displayName: 'Claude Sonnet',
        maxOutputSize: 64000,
      },
    });

    await face.importProvider({ catalogId: 'acme' });
    expect(store.get(DEFAULT_MODEL_CONFIG_SECTION)).toBe('anthropic/claude-sonnet');

    currentCatalog = {
      acme: {
        ...CATALOG['acme']!,
        models: { 'acme-lite': { id: 'acme-lite', limit: { context: 1024 } } },
      },
    };
    resetModelsDevUpstreamForTest();
    const again = await face.importProvider({ catalogId: 'acme' });
    expect(again.models_imported).toBe(1);
    const modelsAfter = store.get(MODELS_CONFIG_SECTION) as Record<string, unknown>;
    expect(Object.keys(modelsAfter).toSorted()).toEqual([
      'acme/acme-lite',
      'anthropic/claude-sonnet',
    ]);
    expect(modelsAfter['acme/acme-lite']).toEqual({
      provider: 'acme',
      model: 'acme-lite',
      maxContextSize: 1024,
      capability: {
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: false,
        tool_use: true,
      },
    });
    currentCatalog = CATALOG;

    resetModelsDevUpstreamForTest();
    await face.importProvider({ catalogId: 'anthropic' });
    expect(store.get(PROVIDERS_CONFIG_SECTION)).toMatchObject({
      anthropic: { apiKey: 'sk-ant' },
    });
  });

  it('importProvider rejects oauth-managed providers, invalid ids and unimportable entries', async () => {
    const toml =
      '[providers.managed]\n' +
      'type = "kimi"\n' +
      '[providers.managed.oauth]\n' +
      'storage = "file"\n' +
      'key = "oauth/kimi-code"\n';
    const { face } = await mountModelsDev({ toml });
    await expect(face.importProvider({ catalogId: 'acme', id: 'managed' })).rejects.toMatchObject({
      code: 'provider.oauth_managed',
    });
    await expect(face.importProvider({ catalogId: 'acme', id: '!bad' })).rejects.toMatchObject({
      code: 'modelsDev.import_invalid',
    });
    await expect(face.importProvider({ catalogId: 'missing' })).rejects.toMatchObject({
      code: 'modelsDev.catalog_entry_not_found',
    });
    await expect(face.importProvider({ catalogId: 'empty' })).rejects.toMatchObject({
      code: 'modelsDev.import_invalid',
    });
    await expect(face.importProvider({ catalogId: 'bedrock' })).rejects.toMatchObject({
      code: 'modelsDev.import_invalid',
    });
    await expect(face.importProvider({ catalogId: 'placeholder' })).rejects.toMatchObject({
      code: 'modelsDev.import_invalid',
    });
    const viaBaseUrl = await face.importProvider({
      catalogId: 'placeholder',
      id: 'proxied',
      baseUrl: 'https://proxy.example.com/v1',
    });
    expect(viaBaseUrl.provider.base_url).toBe('https://proxy.example.com/v1');
    await expect(
      face.importProvider({ catalogId: 'placeholder', baseUrl: 'https://${STILL_BAD}.example.com' }),
    ).rejects.toMatchObject({ code: 'modelsDev.import_invalid' });
  });
});

describe('models-dev custom registry', () => {
  const REGISTRY_URL = 'https://registry.example.com/api.json';

  let registryPayload: unknown;
  let registryFails: boolean;
  let registryCalls: Array<{ url: string; authorization?: string; userAgent?: string }>;

  function stubRegistryFetch(): void {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === REGISTRY_URL) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        registryCalls.push({
          url,
          authorization: headers['Authorization'],
          userAgent: headers['User-Agent'] ?? headers['user-agent'],
        });
        if (registryFails) return new Response('boom', { status: 500 });
        return new Response(JSON.stringify(registryPayload), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  function registryEntry(
    id: string,
    type: string,
    models: Record<string, unknown>,
  ): Record<string, unknown> {
    return { id, name: id, api: `https://${id}.example.com/v1`, type, models };
  }

  async function mountRegistry(
    toml?: string,
    userAgent?: string,
  ): Promise<{ harness: App; face: ModelsDevFace; config: ConfigStore; catalog: ProviderCatalogFace }> {
    registryPayload = {
      'upstream-one': registryEntry('regone', 'openai', {
        'reg-a': {
          id: 'reg-a',
          name: 'Reg A',
          limit: { context: 65536, output: 8192 },
          tool_call: true,
          reasoning: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          support_efforts: ['low', 'high'],
          default_effort: 'low',
        },
      }),
      regtwo: registryEntry('regtwo', 'anthropic', {
        'reg-b': { id: 'reg-b' },
      }),
    };
    registryFails = false;
    registryCalls = [];
    stubRegistryFetch();
    const capture: ModelsDevCapture = {};
    const harness = createApp({ space: memorySessionSpace() });
    harnesses.push(harness);
    harness.features.add(providerCatalog);
    harness.features.add(createConfig({ persist: fakePersist(toml).persist }));
    harness.features.add(createModelsDev({ builtinCatalog: () => currentCatalog, userAgent }));
    harness.features.add(modelsDevProbe(capture));
    await tick();
    const face = capture.face?.value;
    const config = capture.config?.value;
    const catalog = capture.catalog?.value;
    if (face === undefined || config === undefined || catalog === undefined) {
      throw new Error('models-dev, config or provider-catalog face was not exposed');
    }
    await config.reload();
    return { harness, face, config, catalog };
  }

  it('imports a registry and refresh applies upstream additions, removals and failures', async () => {
    const manualToml =
      '[providers.manual]\n' +
      'type = "openai"\n' +
      'baseUrl = "https://manual.example.com"\n' +
      'apiKey = "sk-manual"\n\n' +
      '[models."manual/m1"]\n' +
      'provider = "manual"\n' +
      'model = "m1"\n' +
      'maxContextSize = 4096\n';
    const { harness, face, config, catalog } = await mountRegistry(manualToml, 'test-agent');

    const imported = await face.importRegistry({ url: REGISTRY_URL, apiKey: 'sk-reg' });
    expect(imported.models_imported).toBe(2);
    expect(imported.providers).toEqual([
      {
        id: 'regone',
        type: 'openai',
        base_url: 'https://regone.example.com/v1',
        has_api_key: true,
        models: ['reg-a'],
      },
      {
        id: 'regtwo',
        type: 'anthropic',
        base_url: 'https://regtwo.example.com/v1',
        has_api_key: true,
        models: ['reg-b'],
      },
    ]);
    expect(registryCalls.at(-1)).toMatchObject({
      authorization: 'Bearer sk-reg',
      userAgent: 'test-agent',
    });
    expect(config.get(PROVIDERS_CONFIG_SECTION)).toMatchObject({
      manual: { type: 'openai', apiKey: 'sk-manual' },
      regone: {
        type: 'openai',
        baseUrl: 'https://regone.example.com/v1',
        apiKey: 'sk-reg',
        source: { kind: 'apiJson', url: REGISTRY_URL, apiKey: 'sk-reg' },
      },
      regtwo: { type: 'anthropic', apiKey: 'sk-reg' },
    });
    expect(config.get(MODELS_CONFIG_SECTION)).toMatchObject({
      'regone/reg-a': {
        provider: 'regone',
        model: 'reg-a',
        maxContextSize: 65536,
        maxOutputSize: 8192,
        displayName: 'Reg A',
        supportEfforts: ['low', 'high'],
        defaultEffort: 'low',
        capability: {
          image_in: true,
          video_in: false,
          audio_in: false,
          thinking: true,
          tool_use: true,
        },
      },
      'regtwo/reg-b': {
        provider: 'regtwo',
        model: 'reg-b',
        maxContextSize: 131072,
        displayName: 'reg-b',
        capability: {
          image_in: false,
          video_in: false,
          audio_in: false,
          thinking: false,
          tool_use: true,
        },
      },
    });
    expect(config.get(DEFAULT_MODEL_CONFIG_SECTION)).toBe('regone/reg-a');

    await until(() => catalog.isLive('regone') && catalog.isLive('regtwo'));
    expect(catalog.requester('regone', 'reg-a')).toBeDefined();
    const current = config.get<Record<string, CatalogModelConfig>>(MODELS_CONFIG_SECTION) ?? {};
    await config.set(
      MODELS_CONFIG_SECTION,
      {
        ...current,
        'regone/reg-a': {
          ...current['regone/reg-a'],
          extras: { custom: 'canonical' },
          overrides: { displayName: 'canonical-override' },
        },
        'my-fav': {
          provider: 'regone',
          model: 'reg-a',
          displayName: 'mine',
          extras: { custom: 'user' },
          overrides: { displayName: 'user-override' },
        },
        flat: {
          name: 'flat',
          baseUrl: 'https://flat.example.com/v1',
          protocol: 'openai',
        },
      },
      'user',
    );
    const refreshed = await catalog.refresh({ providerId: 'regone' });
    expect(refreshed).toEqual({ changed: [], unchanged: ['regone'], failed: [] });
    expect(config.get(MODELS_CONFIG_SECTION)).toHaveProperty('regone/reg-a');

    const retirements: Array<{ from: string; to: string }> = [];
    const changedPayloads: Array<{ retired_default?: { from: string; to: string } }> = [];
    catalog.onRetiredModel((event) => {
      retirements.push(event);
    });
    harness.on(providerCatalog, 'event.model_catalog.changed', (event) => {
      changedPayloads.push(event.payload);
    });

    registryPayload = {
      'upstream-one': registryEntry('regone', 'openai', {
        'reg-a': {
          id: 'reg-a',
          name: 'Reg A',
          limit: { context: 65536 },
          tool_call: true,
          upgrade: { model: 'reg-c', migration_markdown: 'Use C' },
        },
        'reg-c': {
          id: 'reg-c',
          limit: { context: 2048 },
          upgrade: { model: 'reg-d', migration_markdown: 'Use D' },
        },
        'reg-d': { id: 'reg-d', limit: { context: 1024 } },
      }),
    };
    const second = await face.refreshRegistries();
    expect(second.changed).toEqual(
      expect.arrayContaining([
        { provider_id: 'regone', provider_name: 'regone', added: 2, removed: 0 },
        { provider_id: 'regtwo', provider_name: 'regtwo', added: 0, removed: 1 },
      ]),
    );
    expect(second.retired_default).toBeUndefined();
    expect(config.get(PROVIDERS_CONFIG_SECTION)).toMatchObject({
      manual: { type: 'openai' },
      regone: { type: 'openai', apiKey: 'sk-reg' },
    });
    expect(config.get(PROVIDERS_CONFIG_SECTION)).not.toHaveProperty('regtwo');
    const modelsAfterRefresh = config.get(MODELS_CONFIG_SECTION) as Record<string, CatalogModelConfig>;
    expect(Object.keys(modelsAfterRefresh).toSorted()).toEqual([
      'flat',
      'manual/m1',
      'my-fav',
      'regone/reg-a',
      'regone/reg-c',
      'regone/reg-d',
    ]);
    expect(modelsAfterRefresh['flat']).toMatchObject({ name: 'flat' });
    expect(modelsAfterRefresh['flat']).not.toHaveProperty('provider');
    expect(modelsAfterRefresh['flat']).not.toHaveProperty('model');
    expect(modelsAfterRefresh['regone/reg-a']).toMatchObject({
      extras: { custom: 'canonical' },
      overrides: { displayName: 'canonical-override' },
    });
    expect(modelsAfterRefresh['my-fav']).toMatchObject({
      displayName: 'mine',
      extras: { custom: 'user' },
      overrides: { displayName: 'user-override' },
    });
    expect(config.get(DEFAULT_MODEL_CONFIG_SECTION)).toBe('regone/reg-a');
    expect(registryCalls.at(-1)).toMatchObject({
      authorization: 'Bearer sk-reg',
      userAgent: 'test-agent',
    });

    registryPayload = {
      'upstream-one': registryEntry('regone', 'openai', {
        'reg-a': {
          id: 'reg-a',
          name: 'Reg A',
          limit: { context: 65536 },
          tool_call: true,
          upgrade: { model: 'reg-c', migration_markdown: 'Use C' },
        },
        'reg-c': {
          id: 'reg-c',
          limit: { context: 2048 },
          upgrade: { model: 'reg-d', migration_markdown: 'Use D' },
        },
        'reg-d': { id: 'reg-d', limit: { context: 1024 } },
      }),
      other: registryEntry('other', 'openai', { x: { id: 'x' } }),
    };
    const discovered = await face.refreshRegistries();
    expect(discovered.changed).toEqual(
      expect.arrayContaining([
        { provider_id: 'other', provider_name: 'other', added: 1, removed: 0 },
      ]),
    );
    expect(config.get(PROVIDERS_CONFIG_SECTION)).toHaveProperty('other');

    registryPayload = {
      'upstream-one': registryEntry('regone', 'openai', {
        'reg-c': {
          id: 'reg-c',
          limit: { context: 2048 },
          upgrade: { model: 'reg-d', migration_markdown: 'Use D' },
        },
        'reg-d': { id: 'reg-d', limit: { context: 1024 } },
      }),
    };
    const retired = await face.refreshRegistries();
    expect(retired.changed).toEqual(
      expect.arrayContaining([
        { provider_id: 'regone', provider_name: 'regone', added: 0, removed: 1 },
        { provider_id: 'other', provider_name: 'other', added: 0, removed: 1 },
      ]),
    );
    expect(retired.retired_default).toEqual({
      from: 'regone/reg-a',
      to: 'regone/reg-c',
      from_display_name: 'canonical-override',
    });
    expect(config.get(DEFAULT_MODEL_CONFIG_SECTION)).toBe('regone/reg-c');
    expect(catalog.retiredModelReplacement('regone/reg-a')).toBe('regone/reg-c');
    expect(catalog.retiredModelReplacement('regone/reg-c')).toBeUndefined();

    registryPayload = {
      'upstream-one': registryEntry('regone', 'openai', {
        'reg-d': { id: 'reg-d', limit: { context: 1024 } },
      }),
    };
    const chained = await face.refreshRegistries();
    expect(changedPayloads.some(
      (payload) =>
        payload.retired_default?.from === 'regone/reg-a' &&
        payload.retired_default.to === 'regone/reg-c',
    )).toBe(true);
    expect(chained.retired_default).toEqual({
      from: 'regone/reg-c',
      to: 'regone/reg-d',
      from_display_name: 'reg-c',
    });
    expect(config.get(DEFAULT_MODEL_CONFIG_SECTION)).toBe('regone/reg-d');
    expect(catalog.retiredModelReplacement('regone/reg-a')).toBe('regone/reg-d');
    expect(catalog.retiredModelReplacement('regone/reg-c')).toBe('regone/reg-d');
    expect(retirements).toEqual([
      { from: 'regone/reg-a', to: 'regone/reg-c' },
      { from: 'regone/reg-c', to: 'regone/reg-d' },
    ]);
    const modelsBeforeFailure = config.get(MODELS_CONFIG_SECTION);

    registryFails = true;
    registryPayload = { other: registryEntry('other', 'openai', { x: { id: 'x' } }) };
    const failed = await face.refreshRegistries();
    expect(failed.failed.map((failure) => failure.provider)).toEqual(['regone']);
    expect(config.get(PROVIDERS_CONFIG_SECTION)).not.toHaveProperty('other');
    expect(config.get(MODELS_CONFIG_SECTION)).toEqual(modelsBeforeFailure);

    registryFails = false;
    registryPayload = { other: registryEntry('other', 'openai', { x: { id: 'x' } }) };
    const reimported = await face.importRegistry({ url: REGISTRY_URL });
    expect(reimported.providers.map((provider) => provider.id)).toEqual(['other']);
    expect(registryCalls.at(-1)).toMatchObject({
      authorization: 'Bearer sk-reg',
      userAgent: 'test-agent',
    });
    expect(config.get(PROVIDERS_CONFIG_SECTION)).toMatchObject({
      manual: { type: 'openai' },
      other: {
        type: 'openai',
        apiKey: 'sk-reg',
        source: { kind: 'apiJson', url: REGISTRY_URL, apiKey: 'sk-reg' },
      },
    });
    expect(config.get(PROVIDERS_CONFIG_SECTION)).not.toHaveProperty('regone');
    expect(config.get(DEFAULT_MODEL_CONFIG_SECTION)).toBe('other/x');

    const timerToml =
      '[providers.regone]\n' +
      'type = "openai"\n' +
      'baseUrl = "https://regone.example.com/v1"\n' +
      'apiKey = "sk-reg"\n' +
      '[providers.regone.source]\n' +
      'kind = "apiJson"\n' +
      'url = "https://registry.example.com/api.json"\n' +
      'apiKey = "sk-reg"\n\n' +
      '[model_catalog]\n' +
      'refresh_on_start = true\n' +
      'refresh_interval_ms = 50\n';
    vi.useFakeTimers();
    const pending = mountRegistry(timerToml);
    await vi.advanceTimersByTimeAsync(0);
    const timed = await pending;
    await vi.advanceTimersByTimeAsync(1);
    expect(registryCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(registryCalls).toHaveLength(2);
    await timed.harness.close();
    vi.useRealTimers();
  });

  it('rejects invalid registries and oauth-managed collisions', async () => {
    const { face } = await mountRegistry();
    registryFails = true;
    await expect(face.importRegistry({ url: REGISTRY_URL })).rejects.toMatchObject({
      code: 'modelsDev.registry_import_invalid',
    });
    registryFails = false;
    registryPayload = {};
    await expect(face.importRegistry({ url: REGISTRY_URL })).rejects.toMatchObject({
      code: 'modelsDev.registry_import_invalid',
    });
    const managedToml =
      '[providers.managed]\n' +
      'type = "kimi"\n' +
      '[providers.managed.oauth]\n' +
      'storage = "file"\n' +
      'key = "oauth/kimi-code"\n';
    const managed = await mountRegistry(managedToml);
    registryPayload = {
      managed: registryEntry('managed', 'openai', { x: { id: 'x' } }),
    };
    await expect(managed.face.importRegistry({ url: REGISTRY_URL })).rejects.toMatchObject({
      code: 'provider.oauth_managed',
    });
  });
});

describe('models-dev generic protocol factories', () => {
  it('materializes config providers of all four generic wire types', async () => {
    const toml =
      '[providers.openp]\n' +
      'type = "openai"\n' +
      'base_url = "https://openp.example.com/v1"\n' +
      'api_key = "sk-open"\n\n' +
      '[providers.antp]\n' +
      'type = "anthropic"\n' +
      'base_url = "https://ant.example.com"\n' +
      'api_key = "sk-ant"\n\n' +
      '[providers.genp]\n' +
      'type = "google-genai"\n' +
      'base_url = "https://gen.example.com"\n' +
      'api_key = "sk-gen"\n\n' +
      '[providers.vtxp]\n' +
      'type = "vertexai"\n' +
      'base_url = "https://vtx.example.com"\n' +
      'api_key = "sk-vtx"\n\n' +
      '[models."openp/m1"]\n' +
      'provider = "openp"\n' +
      'model = "m1"\n' +
      'max_context_size = 4096\n';
    const { catalog } = await mountModelsDev({ toml });
    await until(
      () =>
        catalog.isLive('openp') &&
        catalog.isLive('antp') &&
        catalog.isLive('genp') &&
        catalog.isLive('vtxp'),
    );
    const requester = catalog.requester('openp', 'm1');
    expect(requester).toBeDefined();
    const request = requester!.request({ content: { messages: [] } });
    expect(request.endpoint?.baseUrl).toBe('https://openp.example.com/v1');
    expect(await request.endpoint?.credentials?.resolve?.()).toMatchObject({ apiKey: 'sk-open' });
  });
});
