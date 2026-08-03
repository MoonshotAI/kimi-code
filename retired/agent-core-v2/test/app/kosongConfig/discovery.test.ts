/**
 * `app/kosongConfig` discovery tests — `IProviderDiscoveryService`:
 *
 *  - `refreshProviderModels` short-circuits `modelSource: 'static'`: a scoped
 *    refresh answers `unchanged` without any I/O, and an unscoped refresh
 *    hides the static entries from the orchestrator and merges them back
 *    verbatim — the static provider, its models, and a default model pointing
 *    at them all survive;
 *  - concurrent refreshes serialize (never overlap);
 *  - custom-registry fetches carry the host `User-Agent`;
 *  - provider/model patches land in kosong's in-memory registries via
 *    `replaceAll` (the persistence bridge writes them back to config),
 *    merging discovered aliases into user-owned provider records, while
 *    `defaultModel` / `thinking` still go through `config.replace` directly —
 *    restoring a surviving default selection and CLEARing a default (plus its
 *    thinking) whose alias the upstream dropped, never a dangling `set`;
 *  - the `[modelCatalog]` config section self-registers and validates.
 */

import { KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createScopedTestHost } from '#/_base/di/test';
import { isError2 } from '#/_base/errors/errors';
import { IOAuthService } from '#/app/auth/auth';
import { IConfigService } from '#/app/config/config';
import { ConfigRegistry } from '#/app/config/configService';
import { IEventService } from '#/app/event/event';
import { IProviderDiscoveryService } from '#/app/kosongConfig/discovery';
import '#/app/kosongConfig/discoveryService';
import { MODEL_CATALOG_SECTION } from '#/app/kosongConfig/configSection';
import '#/kosong/model/errors';
import { HostRequestHeaders, IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import {
  IModelService,
  type ModelRecord,
  type ModelsSection,
} from '#/kosong/model/model';
import '#/kosong/model/modelService';
import {
  IProviderService,
  type ProviderConfig,
  type ProvidersSection,
} from '#/kosong/provider/provider';
import '#/kosong/provider/providerService';
import '#/kosong/provider/providers/kimi/kimi.contrib';
import '#/kosong/provider/providers/standard.contrib';

import { StubConfigService, stubOAuthService, stubTokenProvider } from '../../kosong/stubs';

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

function createHost(
  sections: Record<string, unknown> = {},
  oauth: IOAuthService = stubOAuthService(),
): {
  host: ReturnType<typeof createScopedTestHost>;
  config: StubConfigService;
  events: ReturnType<typeof stubEvents>;
  discovery: IProviderDiscoveryService;
  providers: IProviderService;
  models: IModelService;
} {
  const config = new StubConfigService(sections);
  const events = stubEvents();
  const host = createScopedTestHost([
    [IConfigService, config],
    [IOAuthService, oauth],
    [IEventService, events],
    [IHostRequestHeaders, new HostRequestHeaders({ 'User-Agent': 'kimi-test/1.0' })],
  ]);
  // Seed the in-memory registries from the fixture sections (the persistence
  // bridge that normally does this is not instantiated here).
  const providers = host.app.accessor.get(IProviderService);
  providers.loadAll(
    (sections['providers'] ?? {}) as ProvidersSection,
    sections['defaultProvider'] as string | undefined,
  );
  const models = host.app.accessor.get(IModelService);
  models.loadAll(
    (sections['models'] ?? {}) as ModelsSection,
    sections['defaultModel'] as string | undefined,
  );
  return {
    host,
    config,
    events,
    discovery: host.app.accessor.get(IProviderDiscoveryService),
    providers,
    models,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

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

describe('refreshProviderModels modelSource short-circuit', () => {
  it('answers scoped refreshes of static providers with unchanged and no I/O', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { host, discovery } = createHost(staticSections);
    try {
      const result = await discovery.refreshProviderModels({ providerId: 'static-p' });
      expect(result).toEqual({ changed: [], unchanged: ['static-p'], failed: [] });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      host.dispose();
    }
  });

  it('returns an empty result when nothing is refreshable', async () => {
    const { host, discovery, events } = createHost(staticSections);
    try {
      const result = await discovery.refreshProviderModels({ scope: 'all' });
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

    const { host, config, discovery, events, providers, models } = createHost({
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
      const result = await discovery.refreshProviderModels({ scope: 'all' });
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
      // all survived the orchestrator's whole-section writes. Providers and
      // models land in the in-memory registries (the persistence bridge owns
      // the config write-back); defaultModel/thinking go through config.
      const providerRecords = providers.list();
      expect(Object.keys(providerRecords).toSorted()).toEqual(['acme', 'static-p']);
      expect(providerRecords['static-p']).toEqual({ type: 'openai', modelSource: 'static', apiKey: 'sk-static' });
      const modelRecords = models.list();
      expect(modelRecords['s1']).toEqual({ provider: 'static-p', model: 'static-model', maxContextSize: 1000 });
      expect(modelRecords['acme/m1']).toBeDefined();
      expect(config.get<string>('defaultModel')).toBe('s1');
      expect(config.get('thinking')).toEqual({ enabled: true });
    } finally {
      host.dispose();
    }
  });

  it('throws provider.not_found for an unknown scoped provider', async () => {
    const { host, discovery } = createHost(staticSections);
    try {
      await expect(discovery.refreshProviderModels({ providerId: 'missing' })).rejects.toSatisfy(
        (error) => isError2(error) && error.code === 'provider.not_found',
      );
    } finally {
      host.dispose();
    }
  });
});

describe('refreshProviderModels write behavior', () => {
  it('serializes concurrent runs so they never overlap', async () => {
    const { host, discovery } = createHost(
      {
        providers: {
          [KIMI_CODE_PROVIDER_NAME]: {
            type: 'kimi',
            baseUrl: 'https://api.example.test/v1',
            oauth: { storage: 'file', key: 'oauth/kimi-code' },
          },
        },
        models: {},
      },
      stubOAuthService(stubTokenProvider(['access-token'])),
    );
    try {
      let inFlight = 0;
      let maxInFlight = 0;
      const fetchMock = vi.fn().mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        return {
          ok: true,
          json: async () => ({
            data: [
              {
                id: 'kimi-k2',
                context_length: 131072,
                supports_reasoning: true,
                display_name: 'Kimi K2',
              },
            ],
          }),
        };
      });
      vi.stubGlobal('fetch', fetchMock);

      await Promise.all([
        discovery.refreshProviderModels({ scope: 'all' }),
        discovery.refreshProviderModels({ scope: 'all' }),
      ]);

      expect(maxInFlight).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      host.dispose();
    }
  });

  it('sends the host User-Agent on custom-registry fetches', async () => {
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
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { host, discovery } = createHost({
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
    });
    try {
      await discovery.refreshProviderModels({ scope: 'all' });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://registry.example.test/api.json',
        expect.objectContaining({
          headers: expect.objectContaining({ 'User-Agent': 'kimi-test/1.0' }),
        }),
      );
    } finally {
      host.dispose();
    }
  });

  it('refreshes a hand-configured API-key provider at the managed endpoint', async () => {
    const baseUrl = 'https://api.managed.example.test/coding/v1';
    vi.stubEnv('KIMI_CODE_BASE_URL', baseUrl);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'kimi-k2',
                context_length: 262144,
                supports_reasoning: true,
                display_name: 'Fresh K2',
              },
              { id: 'kimi-k2.5', context_length: 131072 },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { host, config, discovery, events, providers, models } = createHost({
      providers: {
        'my-kimi': { type: 'kimi', baseUrl, apiKey: 'sk-distributed-key' },
      },
      models: {
        'my-kimi/kimi-k2': {
          provider: 'my-kimi',
          model: 'kimi-k2',
          maxContextSize: 262144,
          displayName: 'Old K2',
        },
      },
      defaultModel: 'my-kimi/kimi-k2',
    });
    try {
      const result = await discovery.refreshProviderModels({ scope: 'all' });

      expect(result.failed).toEqual([]);
      expect(result.changed).toEqual([
        { provider_id: 'my-kimi', provider_name: 'my-kimi', added: 1, removed: 0 },
      ]);
      expect(events.published).toEqual([
        expect.objectContaining({ type: 'event.model_catalog.changed' }),
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/models`,
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer sk-distributed-key' }),
        }),
      );
      // The user-owned provider record survives; only model aliases are merged.
      expect(providers.list()['my-kimi']).toEqual({
        type: 'kimi',
        baseUrl,
        apiKey: 'sk-distributed-key',
      });
      const modelRecords = models.list();
      expect(modelRecords['my-kimi/kimi-k2']?.displayName).toBe('Fresh K2');
      expect(modelRecords['my-kimi/kimi-k2.5']).toBeDefined();
      // The surviving default selection is written back, not cleared.
      expect(config.get<string>('defaultModel')).toBe('my-kimi/kimi-k2');
    } finally {
      host.dispose();
    }
  });

  it('clears a stale defaultModel whose alias upstream dropped', async () => {
    const baseUrl = 'https://api.managed.example.test/coding/v1';
    vi.stubEnv('KIMI_CODE_BASE_URL', baseUrl);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'kimi-k3', context_length: 1048576, supports_reasoning: true }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { host, config, discovery, models } = createHost({
      providers: {
        'my-kimi': { type: 'kimi', baseUrl, apiKey: 'sk-distributed-key' },
      },
      models: {
        'my-kimi/kimi-k2': {
          provider: 'my-kimi',
          model: 'kimi-k2',
          maxContextSize: 262144,
          displayName: 'Old K2',
        },
      },
      defaultModel: 'my-kimi/kimi-k2',
      thinking: { enabled: true },
    });
    try {
      const result = await discovery.refreshProviderModels({ scope: 'all' });

      expect(result.failed).toEqual([]);
      expect(result.changed).toEqual([
        { provider_id: 'my-kimi', provider_name: 'my-kimi', added: 1, removed: 1 },
      ]);
      // The dropped alias was the default: an explicit undefined in the patch
      // must clear the section instead of leaving the default dangling. It has
      // to go through `replace` — `set()`'s deepMerge would resolve undefined
      // back to the stale base value.
      expect(config.get('defaultModel')).toBeUndefined();
      expect(config.get('thinking')).toBeUndefined();
      const modelRecords = models.list();
      expect(modelRecords['my-kimi/kimi-k3']).toBeDefined();
      expect(modelRecords['my-kimi/kimi-k2']).toBeUndefined();
    } finally {
      host.dispose();
    }
  });
});

describe('modelCatalog config section', () => {
  it('self-registers and validates', () => {
    const registry = new ConfigRegistry();
    expect(registry.getSection(MODEL_CATALOG_SECTION)).toBeDefined();
    expect(
      registry.validate(MODEL_CATALOG_SECTION, {
        refreshIntervalMs: 1000,
        refreshOnStart: false,
      }),
    ).toEqual({ refreshIntervalMs: 1000, refreshOnStart: false });
    expect(() => registry.validate(MODEL_CATALOG_SECTION, { refreshIntervalMs: -1 })).toThrow();
  });
});
