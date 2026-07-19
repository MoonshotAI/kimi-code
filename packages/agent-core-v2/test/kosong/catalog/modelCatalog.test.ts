/**
 * `kosong/catalog` tests — the wire projection and `IModelCatalogService`:
 *
 *  - `toProtocolModel` / `toProtocolProvider` / `modelIdsForProvider` /
 *    `globalDefaultForProvider` project config into the snake_case wire
 *    shapes;
 *  - credential state resolves through the provider-definition registry (the
 *    vendor's declared `apiKeyEnv` chain against the config env bag);
 *  - `setDefaultModel` persists through config and reports coded not-founds;
 *  - `refreshProviderModels` short-circuits `modelSource: 'static'`: a scoped
 *    refresh answers `unchanged` without any I/O, and an unscoped refresh
 *    hides the static entries from the orchestrator and merges them back
 *    verbatim — the static provider, its models, and a default model pointing
 *    at them all survive.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createScopedTestHost } from '#/_base/di/test';
import { isError2 } from '#/_base/errors/errors';
import { isErrorCode } from '#/_base/errors/codes';
import { IOAuthService } from '#/app/auth/auth';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import {
  globalDefaultForProvider,
  IModelCatalogService,
  modelIdsForProvider,
  toProtocolModel,
  toProtocolProvider,
} from '#/kosong/catalog/modelCatalog';
import '#/kosong/catalog/modelCatalogService';
import '#/kosong/catalog/errors';
import { HostRequestHeaders, IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import type { ModelRecord } from '#/kosong/model/model';
import '#/kosong/model/modelService';
import type { ProviderConfig } from '#/kosong/provider/provider';
import '#/kosong/provider/providerService';
import '#/kosong/provider/providers/kimi/kimi.contrib';
import '#/kosong/provider/providers/standard.contrib';

import { StubConfigService, stubOAuthService } from '../stubs';

function stubEvents(): IEventService & { published: Array<{ type: string; payload: unknown }> } {
  const published: Array<{ type: string; payload: unknown }> = [];
  return {
    published,
    _serviceBrand: undefined,
    onDidPublish: () => ({ dispose: () => {} }),
    publish: (event: { type: string; payload: unknown }) => {
      published.push(event);
    },
    subscribe: () => ({ dispose: () => {} }),
  } as unknown as IEventService & { published: Array<{ type: string; payload: unknown }> };
}

function createHost(sections: Record<string, unknown> = {}): {
  host: ReturnType<typeof createScopedTestHost>;
  config: StubConfigService;
  events: ReturnType<typeof stubEvents>;
  catalog: IModelCatalogService;
} {
  const config = new StubConfigService(sections);
  const events = stubEvents();
  const host = createScopedTestHost([
    [IConfigService, config],
    [IOAuthService, stubOAuthService()],
    [IEventService, events],
    [IHostRequestHeaders, new HostRequestHeaders({ 'User-Agent': 'kimi-test/1.0' })],
  ]);
  return { host, config, events, catalog: host.app.accessor.get(IModelCatalogService) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const k2Record: ModelRecord = {
  provider: 'kimi',
  model: 'kimi-k2',
  maxContextSize: 131072,
  displayName: 'Kimi K2',
  capabilities: ['thinking'],
};

const baseSections: Record<string, unknown> = {
  providers: {
    kimi: { type: 'kimi', apiKey: 'sk-test', baseUrl: 'https://api.example.test/v1' },
  },
  models: { k2: k2Record },
};

const staticProviders: Record<string, ProviderConfig> = {
  'static-p': { type: 'openai', modelSource: 'static', apiKey: 'sk-static' },
};

const staticModels: Record<string, ModelRecord> = {
  s1: { provider: 'static-p', model: 'static-model', maxContextSize: 1000 },
};

const staticSections: Record<string, unknown> = {
  providers: staticProviders,
  models: staticModels,
  defaultModel: 's1',
};

describe('wire projection (pure)', () => {
  it('toProtocolModel maps the record into the snake_case wire shape', () => {
    expect(toProtocolModel('k2', k2Record, 'kimi')).toEqual({
      provider: 'kimi',
      model: 'k2',
      display_name: 'Kimi K2',
      max_context_size: 131072,
      capabilities: ['thinking'],
      support_efforts: undefined,
      default_effort: undefined,
    });
  });

  it('modelIdsForProvider and globalDefaultForProvider group models by provider', () => {
    const models: Record<string, ModelRecord> = {
      a: { provider: 'p1', model: 'm-a' },
      b: { provider: 'p2', model: 'm-b' },
      c: { providerId: 'p1', model: 'm-c' },
    };
    expect(modelIdsForProvider(models, 'p1')).toEqual(['a']);
    expect(globalDefaultForProvider(models, 'a', 'p1')).toBe('a');
    expect(globalDefaultForProvider(models, 'a', 'p2')).toBeUndefined();
    expect(globalDefaultForProvider(models, undefined, 'p1')).toBeUndefined();
  });

  it('toProtocolProvider prefers the provider default, then the global default', () => {
    const models: Record<string, ModelRecord> = { a: { provider: 'p1', model: 'm-a' } };
    const provider: ProviderConfig = { type: 'openai', baseUrl: 'https://x.test/v1' };
    expect(
      toProtocolProvider('p1', provider, models, 'a', { hasApiKey: true, hasOAuthToken: false }),
    ).toEqual({
      id: 'p1',
      type: 'openai',
      base_url: 'https://x.test/v1',
      default_model: 'a',
      has_api_key: true,
      status: 'connected',
      models: ['a'],
    });
    expect(
      toProtocolProvider('p1', { ...provider, defaultModel: 'own' }, models, 'a', {
        hasApiKey: false,
        hasOAuthToken: false,
      }).default_model,
    ).toBe('own');
    expect(
      toProtocolProvider('p1', { ...provider, type: undefined }, models, undefined, {
        hasApiKey: false,
        hasOAuthToken: false,
      }),
    ).toMatchObject({ type: 'openai', status: 'unconfigured', default_model: undefined });
  });
});

describe('ModelCatalogService reads', () => {
  it('listModels and listProviders project the registries', async () => {
    const { host, catalog } = createHost(baseSections);
    try {
      const models = await catalog.listModels();
      expect(models).toEqual([
        expect.objectContaining({ model: 'k2', display_name: 'Kimi K2', max_context_size: 131072 }),
      ]);
      const providers = await catalog.listProviders();
      expect(providers).toEqual([
        expect.objectContaining({ id: 'kimi', type: 'kimi', has_api_key: true, status: 'connected', models: ['k2'] }),
      ]);
    } finally {
      host.dispose();
    }
  });

  it('detects env-bag credentials through the vendor endpoint declarations', async () => {
    const { host, catalog } = createHost({
      providers: {
        kimi: { type: 'kimi', env: { KIMI_API_KEY: 'kimi-env-key' } },
        claude: { type: 'anthropic', env: { ANTHROPIC_API_KEY: 'anthropic-env-key' } },
        empty: { type: 'openai' },
      },
      models: {},
    });
    try {
      const providers = await catalog.listProviders();
      const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
      expect(byId['kimi']).toMatchObject({ has_api_key: true, status: 'connected' });
      expect(byId['claude']).toMatchObject({ has_api_key: true, status: 'connected' });
      expect(byId['empty']).toMatchObject({ has_api_key: false, status: 'unconfigured' });
    } finally {
      host.dispose();
    }
  });

  it('getProvider and setDefaultModel report coded not-founds', async () => {
    const { host, catalog } = createHost(baseSections);
    try {
      await expect(catalog.getProvider('missing')).rejects.toSatisfy(
        (error) => isError2(error) && error.code === 'provider.not_found',
      );
      await expect(catalog.setDefaultModel('missing')).rejects.toSatisfy(
        (error) => isError2(error) && error.code === 'model.not_found',
      );
      expect(isErrorCode('provider.not_found')).toBe(true);
      expect(isErrorCode('model.not_found')).toBe(true);
    } finally {
      host.dispose();
    }
  });

  it('setDefaultModel persists through config and returns the wire model', async () => {
    const { host, config, catalog } = createHost(baseSections);
    try {
      const response = await catalog.setDefaultModel('k2');
      expect(response.default_model).toBe('k2');
      expect(response.model).toMatchObject({ model: 'k2', display_name: 'Kimi K2' });
      expect(config.get<string>('defaultModel')).toBe('k2');
    } finally {
      host.dispose();
    }
  });
});

describe('refreshProviderModels modelSource short-circuit', () => {
  it('answers scoped refreshes of static providers with unchanged and no I/O', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { host, catalog } = createHost(staticSections);
    try {
      const result = await catalog.refreshProviderModels({ providerId: 'static-p' });
      expect(result).toEqual({ changed: [], unchanged: ['static-p'], failed: [] });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      host.dispose();
    }
  });

  it('returns an empty result when nothing is refreshable', async () => {
    const { host, catalog, events } = createHost(staticSections);
    try {
      const result = await catalog.refreshProviderModels({ scope: 'all' });
      expect(result).toEqual({ changed: [], unchanged: [], failed: [] });
      expect(events.published).toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it('hides static entries from the orchestrator and merges them back verbatim', async () => {
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
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { host, config, catalog, events } = createHost({
      providers: {
        ...staticProviders,
        acme: {
          type: 'openai',
          apiKey: 'sk-acme',
          source: { kind: 'apiJson', url: 'https://registry.example.test/api.json', apiKey: 'sk-registry' },
        },
      },
      models: staticModels,
      defaultModel: 's1',
      thinking: { enabled: true },
    });
    try {
      const result = await catalog.refreshProviderModels({ scope: 'all' });
      // The registry provider refreshed; the static one is nowhere in the result.
      expect(result.changed).toEqual([
        { provider_id: 'acme', provider_name: 'Acme', added: 1, removed: 0 },
      ]);
      expect(result.unchanged).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(events.published).toEqual([
        expect.objectContaining({ type: 'event.model_catalog.changed' }),
      ]);

      // Static provider, its model, the default selection, and its thinking
      // all survived the orchestrator's whole-section writes.
      const providers = config.get<Record<string, ProviderConfig>>('providers');
      expect(Object.keys(providers).toSorted()).toEqual(['acme', 'static-p']);
      expect(providers['static-p']).toEqual({ type: 'openai', modelSource: 'static', apiKey: 'sk-static' });
      const models = config.get<Record<string, ModelRecord>>('models');
      expect(models['s1']).toEqual({ provider: 'static-p', model: 'static-model', maxContextSize: 1000 });
      expect(models['acme/m1']).toBeDefined();
      expect(config.get<string>('defaultModel')).toBe('s1');
      expect(config.get('thinking')).toEqual({ enabled: true });
    } finally {
      host.dispose();
    }
  });

  it('throws provider.not_found for an unknown scoped provider', async () => {
    const { host, catalog } = createHost(staticSections);
    try {
      await expect(catalog.refreshProviderModels({ providerId: 'missing' })).rejects.toSatisfy(
        (error) => isError2(error) && error.code === 'provider.not_found',
      );
    } finally {
      host.dispose();
    }
  });
});
