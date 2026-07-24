/**
 * `app/kosongConfig` models.dev import tests — `IModelsDevImportService`:
 *
 *  - the browse surface prunes the models.dev directory and resolves import
 *    eligibility (ok / needs-base-url / rejected), and a missing entry throws
 *    `provider.catalog_entry_not_found`;
 *  - a failed upstream fetch with no built-in snapshot throws
 *    `provider.catalog_unavailable`;
 *  - `importModelsDevProvider` writes the provider + model aliases through
 *    `config.replace` (never the default pointers), keeps the stored api_key
 *    on a re-import without one, and rejects OAuth-managed providers and
 *    non-importable entries with coded errors;
 *  - `importCustomRegistry` applies every valid entry with a `source` blob,
 *    drops same-URL providers that vanished upstream, rejects OAuth-managed
 *    targets, and maps fetch/validation failures to
 *    `provider.registry_import_invalid`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createScopedTestHost } from '#/_base/di/test';
import { Error2, isError2 } from '#/_base/errors/errors';
import { IConfigService } from '#/app/config/config';
import {
  resetModelsDevUpstreamForTest,
  setModelsDevUpstreamForTest,
} from '#/app/kosongConfig/modelsDevUpstream';
import { MODELS_SECTION, PROVIDERS_SECTION } from '#/app/kosongConfig/configSection';
import { ModelsDevImportErrors } from '#/app/kosongConfig/errors';
import { IKosongConfigService } from '#/app/kosongConfig/kosongConfig';
import { IModelsDevImportService } from '#/app/kosongConfig/modelsDevImport';
import '#/app/kosongConfig/modelsDevImportService';
import { IModelCatalog, type ProviderCatalogItem } from '#/kosong/model/catalog';
import type { ModelsSection } from '#/kosong/model/model';
import type { ProvidersSection } from '#/kosong/provider/provider';

import { StubConfigService } from '../../kosong/stubs';

const codes = ModelsDevImportErrors.codes;

const CATALOG = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    api: 'https://api.openai.com/v1',
    npm: '@ai-sdk/openai',
    env: ['OPENAI_API_KEY'],
    models: {
      'gpt-4.1': {
        id: 'gpt-4.1',
        name: 'GPT-4.1',
        limit: { context: 1047576, output: 32768 },
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
    },
  },
  bedrock: {
    id: 'bedrock',
    name: 'Amazon Bedrock',
    api: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    npm: '@ai-sdk/amazon-bedrock',
    models: {
      'claude-sonnet': {
        id: 'claude-sonnet',
        limit: { context: 200000 },
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
  gateway: {
    id: 'gateway',
    name: 'Some Gateway',
    npm: 'some-gateway-sdk',
    models: {
      'gw-model': {
        id: 'gw-model',
        limit: { context: 64000 },
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
} as const;

const REGISTRY_URL = 'https://internal.example/api.json';
const REGISTRY_DOC = {
  'acme-gpt': {
    id: 'acme-gpt',
    name: 'Acme GPT',
    api: 'https://acme.example/v1',
    type: 'openai',
    models: {
      'gpt-x': {
        id: 'gpt-x',
        name: 'GPT X',
        limit: { context: 128000 },
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
} as const;

function fetchJson(doc: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(doc), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

function fetchFail(): typeof fetch {
  return (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
}

function stubKosongConfig(): IKosongConfigService {
  return { _serviceBrand: undefined, ready: Promise.resolve() } as IKosongConfigService;
}

function stubModelCatalog(): IModelCatalog {
  return {
    _serviceBrand: undefined,
    getProvider: (id: string): Promise<ProviderCatalogItem> =>
      Promise.resolve({
        id,
        type: 'openai',
        has_api_key: true,
        status: 'connected',
      } as ProviderCatalogItem),
  } as unknown as IModelCatalog;
}

function createHost(sections: Record<string, unknown> = {}): {
  config: StubConfigService;
  imports: IModelsDevImportService;
} {
  const config = new StubConfigService(sections);
  const host = createScopedTestHost([
    [IConfigService, config],
    [IKosongConfigService, stubKosongConfig()],
    [IModelCatalog, stubModelCatalog()],
  ]);
  return { config, imports: host.app.accessor.get(IModelsDevImportService) };
}

async function expectError2(promise: Promise<unknown>, code: string): Promise<Error2> {
  const err = await promise.then(
    () => {
      throw new Error(`expected the call to throw ${code}`);
    },
    (cause: unknown) => cause,
  );
  expect(isError2(err)).toBe(true);
  expect((err as Error2).code).toBe(code);
  return err as Error2;
}

describe('IModelsDevImportService', () => {
  afterEach(() => {
    resetModelsDevUpstreamForTest();
  });

  it('lists pruned directory entries with import eligibility resolved', async () => {
    setModelsDevUpstreamForTest({ fetchImpl: fetchJson(CATALOG) });
    const { imports } = createHost();
    const items = await imports.listModelsDevProviders();
    const byId = new Map(items.map((item) => [item.id, item]));

    const openai = byId.get('openai');
    expect(openai).toMatchObject({
      wire_type: 'openai',
      guessed: false,
      needs_base_url: false,
      rejected: false,
      env_key: 'OPENAI_API_KEY',
    });
    expect(openai?.models).toEqual([
      expect.objectContaining({ id: 'gpt-4.1', max_context_size: 1047576 }),
    ]);
    expect(byId.get('gateway')).toMatchObject({ needs_base_url: true, wire_type: 'openai' });
    expect(byId.get('bedrock')).toMatchObject({
      rejected: true,
      wire_type: null,
      reject_reason: 'proprietary-sdk',
    });
  });

  it('throws provider.catalog_entry_not_found for an unknown catalog id', async () => {
    setModelsDevUpstreamForTest({ fetchImpl: fetchJson(CATALOG) });
    const { imports } = createHost();
    await expectError2(imports.getModelsDevProvider('nope'), codes.CATALOG_ENTRY_NOT_FOUND);
  });

  it('throws provider.catalog_unavailable when the fetch fails without a snapshot', async () => {
    setModelsDevUpstreamForTest({ fetchImpl: fetchFail() });
    const { imports } = createHost();
    const err = await expectError2(imports.listModelsDevProviders(), codes.CATALOG_UNAVAILABLE);
    expect(err.message).toContain('models.dev catalog unavailable');
  });

  it('imports a catalog entry as provider + aliases without touching the default pointers', async () => {
    setModelsDevUpstreamForTest({ fetchImpl: fetchJson(CATALOG) });
    const { config, imports } = createHost({
      providers: {},
      models: {},
      defaultProvider: 'kimi',
      defaultModel: 'k2',
    });

    const result = await imports.importModelsDevProvider({
      catalogId: 'openai',
      apiKey: 'sk-test',
    });
    expect(result.modelsImported).toBe(1);
    expect(result.provider.id).toBe('openai');

    const providers = config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue ?? {};
    expect(providers['openai']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });
    const models = config.inspect<ModelsSection>(MODELS_SECTION).userValue ?? {};
    expect(models['openai/gpt-4.1']).toMatchObject({
      provider: 'openai',
      model: 'gpt-4.1',
      maxContextSize: 1047576,
    });
    expect(config.get('defaultProvider')).toBe('kimi');
    expect(config.get('defaultModel')).toBe('k2');
  });

  it('seeds default_model from the first imported model only when none is configured', async () => {
    setModelsDevUpstreamForTest({ fetchImpl: fetchJson(CATALOG) });
    const { config, imports } = createHost({ providers: {}, models: {} });

    await imports.importModelsDevProvider({ catalogId: 'openai' });
    expect(config.get('defaultModel')).toBe('openai/gpt-4.1');

    // A later import never moves the seeded pointer.
    await imports.importModelsDevProvider({
      catalogId: 'gateway',
      baseUrl: 'https://gw.example/v1',
    });
    expect(config.get('defaultModel')).toBe('openai/gpt-4.1');
  });

  it('keeps the stored api_key on a re-import without one, replaces it when given', async () => {
    setModelsDevUpstreamForTest({ fetchImpl: fetchJson(CATALOG) });
    const { config, imports } = createHost({
      providers: { openai: { type: 'openai', apiKey: 'sk-old' } },
    });

    await imports.importModelsDevProvider({ catalogId: 'openai' });
    let providers = config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue ?? {};
    expect(providers['openai']?.apiKey).toBe('sk-old');

    await imports.importModelsDevProvider({ catalogId: 'openai', apiKey: 'sk-new' });
    providers = config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue ?? {};
    expect(providers['openai']?.apiKey).toBe('sk-new');
  });

  it('rejects importing over an OAuth-managed provider', async () => {
    setModelsDevUpstreamForTest({ fetchImpl: fetchJson(CATALOG) });
    const { imports } = createHost({
      providers: { openai: { type: 'openai', oauth: { storage: 'file', key: 'oauth/openai' } } },
    });
    await expectError2(
      imports.importModelsDevProvider({ catalogId: 'openai' }),
      codes.PROVIDER_OAUTH_MANAGED,
    );
  });

  it('rejects non-importable entries and needs-base-url entries without a base_url', async () => {
    setModelsDevUpstreamForTest({ fetchImpl: fetchJson(CATALOG) });
    const { imports } = createHost();
    await expectError2(
      imports.importModelsDevProvider({ catalogId: 'bedrock' }),
      codes.CATALOG_IMPORT_INVALID,
    );
    const err = await expectError2(
      imports.importModelsDevProvider({ catalogId: 'gateway' }),
      codes.CATALOG_IMPORT_INVALID,
    );
    expect(err.message).toContain('requires a base_url');
  });

  it('imports a custom registry with a source blob and drops providers vanished upstream', async () => {
    setModelsDevUpstreamForTest({ fetchImpl: fetchJson(REGISTRY_DOC) });
    const { config, imports } = createHost({
      providers: {
        'acme-old': {
          type: 'openai',
          source: { kind: 'apiJson', url: REGISTRY_URL, apiKey: 'tok-1' },
        },
        kimi: { type: 'kimi', apiKey: 'sk-kimi' },
      },
      models: {
        'acme-old/gpt-y': { provider: 'acme-old', model: 'gpt-y', maxContextSize: 128000 },
      },
    });

    const result = await imports.importCustomRegistry({ url: REGISTRY_URL, apiKey: 'tok-2' });
    expect(result.modelsImported).toBe(1);
    expect(result.providers.map((provider) => provider.id)).toEqual(['acme-gpt']);

    const providers = config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue ?? {};
    expect(providers['acme-old']).toBeUndefined();
    expect(providers['kimi']).toMatchObject({ type: 'kimi' });
    expect(providers['acme-gpt']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://acme.example/v1',
      source: { kind: 'apiJson', url: REGISTRY_URL, apiKey: 'tok-2' },
    });
    const models = config.inspect<ModelsSection>(MODELS_SECTION).userValue ?? {};
    expect(models['acme-old/gpt-y']).toBeUndefined();
    expect(models['acme-gpt/gpt-x']).toMatchObject({ provider: 'acme-gpt', model: 'gpt-x' });
  });

  it('rejects a registry import that would rewrite an OAuth-managed provider', async () => {
    setModelsDevUpstreamForTest({ fetchImpl: fetchJson(REGISTRY_DOC) });
    const { imports } = createHost({
      providers: { 'acme-gpt': { type: 'openai', oauth: { storage: 'file', key: 'oauth/x' } } },
    });
    await expectError2(
      imports.importCustomRegistry({ url: REGISTRY_URL }),
      codes.PROVIDER_OAUTH_MANAGED,
    );
  });

  it('maps an unreachable registry to provider.registry_import_invalid', async () => {
    setModelsDevUpstreamForTest({ fetchImpl: fetchFail() });
    const { imports } = createHost();
    await expectError2(
      imports.importCustomRegistry({ url: REGISTRY_URL }),
      codes.REGISTRY_IMPORT_INVALID,
    );
  });
});
