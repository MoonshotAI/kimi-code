import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigRef,
  createConfig,
  createHarness,
  providerCatalog,
  ProviderCatalogRef,
  type AppHandle,
  type ConfigPersist,
} from '@moonshot-ai/agent-core';

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
import { createHttp, HttpRef } from '#/feature-http/index';

const apps: AppHandle[] = [];

afterEach(async () => {
  resetModelsDevUpstreamForTest();
  vi.unstubAllGlobals();
  await Promise.all(apps.splice(0).map((app) => app.disposeAsync()));
});

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
    throw new Error(`unexpected fetch ${String(input)}`);
  });
}

async function mountModelsDev(options: {
  toml?: string;
  withConfig?: boolean;
  userAgent?: string;
}): Promise<{ app: AppHandle; face: ModelsDevFace }> {
  stubFailingFetch();
  const app = createHarness({
    features: [
      ...(options.withConfig === false
        ? []
        : [createConfig({ persist: fakePersist(options.toml).persist })]),
      providerCatalog,
      createModelsDev({ builtinCatalog: () => currentCatalog, userAgent: options.userAgent }),
    ],
  });
  apps.push(app);
  await app.ready();
  return { app, face: app.resolve(ModelsDevRef) };
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
    const { app, face } = await mountModelsDev({});
    const config = app.resolve(ConfigRef);

    const first = await face.importProvider({ catalogId: 'anthropic', apiKey: 'sk-ant' });
    expect(first.provider).toEqual({
      id: 'anthropic',
      type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      has_api_key: true,
      models: ['claude-sonnet'],
    });
    expect(first.models_imported).toBe(1);
    expect(config.get('providers')).toEqual({
      anthropic: { type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant' },
    });
    expect(config.get('models')).toEqual({
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
    expect(config.get('defaultModel')).toBe('anthropic/claude-sonnet');

    await face.importProvider({ catalogId: 'acme' });
    expect(config.get('defaultModel')).toBe('anthropic/claude-sonnet');

    currentCatalog = {
      acme: {
        ...CATALOG['acme']!,
        models: { 'acme-lite': { id: 'acme-lite', limit: { context: 1024 } } },
      },
    };
    resetModelsDevUpstreamForTest();
    const again = await face.importProvider({ catalogId: 'acme' });
    expect(again.models_imported).toBe(1);
    const modelsAfter = config.get('models') as Record<string, unknown>;
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
    expect(config.get('providers')).toMatchObject({
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
  let registryCalls: Array<{ url: string; authorization?: string }>;

  function stubRegistryFetch(): void {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === REGISTRY_URL) {
        registryCalls.push({
          url,
          authorization: (init?.headers as Record<string, string> | undefined)?.['Authorization'],
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

  async function mountRegistry(toml?: string): Promise<{ app: AppHandle; face: ModelsDevFace }> {
    registryPayload = {
      regone: registryEntry('regone', 'openai', {
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
    const app = createHarness({
      features: [
        createConfig({ persist: fakePersist(toml).persist }),
        providerCatalog,
        createModelsDev({ builtinCatalog: () => currentCatalog }),
      ],
    });
    apps.push(app);
    await app.ready();
    return { app, face: app.resolve(ModelsDevRef) };
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
    const { app, face } = await mountRegistry(manualToml);
    const config = app.resolve(ConfigRef);

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
    expect(registryCalls.at(-1)?.authorization).toBe('Bearer sk-reg');
    expect(config.get('providers')).toMatchObject({
      manual: { type: 'openai', apiKey: 'sk-manual' },
      regone: {
        type: 'openai',
        baseUrl: 'https://regone.example.com/v1',
        apiKey: 'sk-reg',
        source: { kind: 'apiJson', url: REGISTRY_URL },
      },
      regtwo: { type: 'anthropic', apiKey: 'sk-reg' },
    });
    expect(config.get('models')).toMatchObject({
      'regone/reg-a': {
        provider: 'regone',
        model: 'reg-a',
        maxContextSize: 65536,
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
    expect(config.get('defaultModel')).toBe('regone/reg-a');

    const catalog = app.resolve(ProviderCatalogRef);
    await until(() => catalog.isLive('regone') && catalog.isLive('regtwo'));
    expect(catalog.requester('regone', 'reg-a')).toBeDefined();

    registryPayload = {
      regone: registryEntry('regone', 'openai', {
        'reg-a': { id: 'reg-a', name: 'Reg A', limit: { context: 65536 }, tool_call: true },
        'reg-c': { id: 'reg-c', limit: { context: 2048 } },
      }),
    };
    await face.refreshRegistries();
    expect(config.get('providers')).toMatchObject({
      manual: { type: 'openai' },
      regone: { type: 'openai', apiKey: 'sk-reg' },
    });
    expect(config.get('providers')).not.toHaveProperty('regtwo');
    const modelsAfterRefresh = config.get('models') as Record<string, { provider: string }>;
    expect(Object.keys(modelsAfterRefresh).toSorted()).toEqual([
      'manual/m1',
      'regone/reg-a',
      'regone/reg-c',
    ]);
    expect(modelsAfterRefresh['regone/reg-c']).toMatchObject({
      provider: 'regone',
      maxContextSize: 2048,
    });
    expect(config.get('defaultModel')).toBe('regone/reg-a');

    registryFails = true;
    registryPayload = { other: registryEntry('other', 'openai', { x: { id: 'x' } }) };
    await face.refreshRegistries();
    expect(config.get('providers')).toMatchObject({ regone: { type: 'openai' } });
    expect(config.get('providers')).not.toHaveProperty('other');

    registryFails = false;
    registryPayload = { other: registryEntry('other', 'openai', { x: { id: 'x' } }) };
    const reimported = await face.importRegistry({ url: REGISTRY_URL });
    expect(reimported.providers.map((provider) => provider.id)).toEqual(['other']);
    expect(registryCalls.at(-1)?.authorization).toBe('Bearer sk-reg');
    expect(config.get('providers')).toMatchObject({
      manual: { type: 'openai' },
      other: { type: 'openai', apiKey: 'sk-reg' },
    });
    expect(config.get('providers')).not.toHaveProperty('regone');
    expect(config.get('defaultModel')).toBe('other/x');
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
    const { app } = await mountModelsDev({ toml });
    const catalog = app.resolve(ProviderCatalogRef);
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

describe('models-dev feature-http routes', () => {
  it('serves browse and import over feature-http and reports 40938 when the feature is absent', async () => {
    setModelsDevUpstreamForTest({ fetchImpl: () => Promise.reject(new Error('offline')) });
    const app = createHarness({
      features: [
        createConfig({ persist: fakePersist().persist }),
        providerCatalog,
        createModelsDev({ builtinCatalog: () => currentCatalog }),
        createHttp(),
      ],
    });
    apps.push(app);
    await app.ready();
    const origin = app.resolve(HttpRef).origin;

    const list = await fetch(`${origin}/api/v1/catalog/providers`);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: { items: { id: string }[] } };
    expect(listBody.data.items.map((item) => item.id)).toContain('anthropic');

    const imported = await fetch(`${origin}/api/v1/providers:import_catalog`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catalog_id: 'acme', api_key: 'sk-acme' }),
    });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({
      data: { provider: { id: 'acme' }, models_imported: 1 },
    });
    const config = app.resolve(ConfigRef);
    await until(() => {
      const providers = config.get('providers') as Record<string, { apiKey?: string }>;
      return providers['acme']?.apiKey === 'sk-acme';
    });
    expect(config.get('providers')).toMatchObject({ acme: { type: 'openai', apiKey: 'sk-acme' } });

    const missingEntry = await fetch(`${origin}/api/v1/catalog/providers/unknown`);
    expect(missingEntry.status).toBe(200);
    expect(await missingEntry.json()).toMatchObject({ code: 40417 });

    const bare = createHarness({ features: [createHttp()] });
    apps.push(bare);
    await bare.ready();
    const unavailable = await fetch(`${bare.resolve(HttpRef).origin}/api/v1/catalog/providers`);
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({ code: 40938 });
  });
});
