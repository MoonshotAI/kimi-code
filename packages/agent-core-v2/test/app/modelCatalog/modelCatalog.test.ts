/**
 * `modelCatalog` domain tests — covers the catalog projection, default-model
 * selection, and coded not-found errors.
 *
 * Uses the flat `TestInstantiationService` harness with real `ModelService` /
 * `ProviderService` collaborators over an in-memory config stub, a stubbed
 * `IOAuthService`, and the SUT registered by interface. The managed-provider
 * refresh is covered in `auth/auth.test.ts`.
 */

import { KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IOAuthService } from '#/app/auth/auth';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry } from '#/app/config/configService';
import { isError2 } from '#/errors';
import { IEventService } from '#/app/event/event';
import { MODEL_CATALOG_SECTION } from '#/app/modelCatalog/configSection';
import { IModelCatalogService } from '#/app/modelCatalog/modelCatalog';
import { ModelCatalogService } from '#/app/modelCatalog/modelCatalogService';
import { IModelService, type ModelAlias } from '#/app/model/model';
import { HostRequestHeaders, IHostRequestHeaders } from '#/app/model/hostRequestHeaders';
import { ModelService } from '#/app/model/modelService';
import { IProviderService, type ProviderConfig } from '#/app/provider/provider';
import { ProviderService } from '#/app/provider/providerService';

interface Backing {
  providers: Record<string, ProviderConfig>;
  models: Record<string, ModelAlias>;
  defaultModel?: string;
  thinking?: { enabled?: boolean; effort?: string };
}

function seedBacking(): Backing {
  return {
    providers: {
      kimi: {
        type: 'kimi',
        apiKey: 'sk-test',
        baseUrl: 'https://api.example.test/v1',
      },
      openai: { type: 'openai' },
    },
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
        displayName: 'Kimi Turbo',
      },
      gpt4o: { provider: 'openai', model: 'gpt-4o', maxContextSize: 128000 },
    },
    defaultModel: 'k2',
  };
}

describe('ModelCatalogService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let backing: Backing;
  let configSet: ReturnType<typeof vi.fn>;
  let configReplace: ReturnType<typeof vi.fn>;
  let getCachedAccessToken: ReturnType<typeof vi.fn>;
  let resolveTokenProvider: ReturnType<typeof vi.fn>;
  let publishEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    backing = seedBacking();
    configSet = vi.fn().mockImplementation(async (domain: string, patch: unknown) => {
      const current = (backing as unknown as Record<string, unknown>)[domain];
      (backing as unknown as Record<string, unknown>)[domain] =
        current !== null && typeof current === 'object' && typeof patch === 'object' && patch !== null
          ? { ...(current as object), ...(patch as object) }
          : patch;
    });
    getCachedAccessToken = vi.fn<IOAuthService['getCachedAccessToken']>().mockResolvedValue(undefined);
    resolveTokenProvider = vi.fn<IOAuthService['resolveTokenProvider']>().mockReturnValue(undefined);
    configReplace = vi.fn().mockImplementation(async (domain: string, value: unknown) => {
      (backing as unknown as Record<string, unknown>)[domain] = value;
    });
    publishEvent = vi.fn();

    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IConfigRegistry, new ConfigRegistry());
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) => (backing as unknown as Record<string, unknown>)[domain]) as IConfigService['get'],
          inspect: ((domain: string) => ({
            value: (backing as unknown as Record<string, unknown>)[domain],
            defaultValue: undefined,
            userValue: (backing as unknown as Record<string, unknown>)[domain],
            memoryValue: undefined,
          })) as IConfigService['inspect'],
          set: configSet as unknown as IConfigService['set'],
          replace: configReplace as unknown as IConfigService['replace'],
          reload: vi.fn().mockResolvedValue(undefined) as unknown as IConfigService['reload'],
          onDidChangeConfiguration: (() => ({ dispose: () => {} })) as IConfigService['onDidChangeConfiguration'],
          onDidSectionChange: (() => ({ dispose: () => {} })) as IConfigService['onDidSectionChange'],
        });
        reg.definePartialInstance(IOAuthService, {
          getCachedAccessToken: getCachedAccessToken as unknown as IOAuthService['getCachedAccessToken'],
          resolveTokenProvider:
            resolveTokenProvider as unknown as IOAuthService['resolveTokenProvider'],
        });
        reg.definePartialInstance(IEventService, {
          publish: publishEvent as unknown as IEventService['publish'],
        });
        reg.define(IModelService, ModelService);
        reg.define(IProviderService, ProviderService);
        reg.define(IModelCatalogService, ModelCatalogService);
        reg.defineInstance(
          IHostRequestHeaders,
          new HostRequestHeaders({ 'User-Agent': 'kimi-code-cli/test' }),
        );
      },
    });
  });
  afterEach(() => {
    disposables.dispose();
    vi.unstubAllGlobals();
  });

  function catalog(): IModelCatalogService {
    return ix.get(IModelCatalogService);
  }

  it('lists configured models as selectable aliases', async () => {
    await expect(catalog().listModels()).resolves.toEqual([
      {
        provider: 'kimi',
        model: 'k2',
        display_name: 'Kimi K2',
        max_context_size: 131072,
        capabilities: ['thinking'],
      },
      {
        provider: 'kimi',
        model: 'turbo',
        display_name: 'Kimi Turbo',
        max_context_size: 32768,
      },
      {
        provider: 'openai',
        model: 'gpt4o',
        display_name: 'gpt-4o',
        max_context_size: 128000,
      },
    ]);
  });

  it('lists providers with per-provider models, default model, and credential state', async () => {
    await expect(catalog().listProviders()).resolves.toEqual([
      {
        id: 'kimi',
        type: 'kimi',
        base_url: 'https://api.example.test/v1',
        default_model: 'k2',
        has_api_key: true,
        status: 'connected',
        models: ['k2', 'turbo'],
      },
      {
        id: 'openai',
        type: 'openai',
        has_api_key: false,
        status: 'unconfigured',
        models: ['gpt4o'],
      },
    ]);
  });

  it('gets a single provider by id', async () => {
    await expect(catalog().getProvider('kimi')).resolves.toMatchObject({
      id: 'kimi',
      default_model: 'k2',
      models: ['k2', 'turbo'],
    });
  });

  it('throws provider.not_found for an unknown provider', async () => {
    await catalog().getProvider('missing').then(
      () => {
        throw new Error('expected rejection');
      },
      (err) => {
        expect(isError2(err)).toBe(true);
        expect((err as { code: string }).code).toBe('provider.not_found');
      },
    );
  });

  it('sets the global default model and returns the selected model', async () => {
    await expect(catalog().setDefaultModel('turbo')).resolves.toEqual({
      default_model: 'turbo',
      model: {
        provider: 'kimi',
        model: 'turbo',
        display_name: 'Kimi Turbo',
        max_context_size: 32768,
      },
    });
    expect(configSet).toHaveBeenCalledWith('defaultModel', 'turbo');
  });

  it('throws model.not_found when setting an unknown default model', async () => {
    await catalog().setDefaultModel('missing').then(
      () => {
        throw new Error('expected rejection');
      },
      (err) => {
        expect(isError2(err)).toBe(true);
        expect((err as { code: string }).code).toBe('model.not_found');
      },
    );
  });

  it('marks an OAuth provider connected when a cached token exists', async () => {
    backing.providers = {
      acme: {
        type: 'kimi',
        oauth: { storage: 'file', key: 'oauth/acme' },
      },
    };
    getCachedAccessToken.mockResolvedValue('cached-token');
    const [provider] = await catalog().listProviders();
    expect(provider).toMatchObject({ id: 'acme', has_api_key: false, status: 'connected' });
  });

  it('registers and validates the modelCatalog config section', () => {
    catalog();
    const registry = ix.get(IConfigRegistry);
    expect(registry.getSection(MODEL_CATALOG_SECTION)).toBeDefined();
    expect(
      registry.validate(MODEL_CATALOG_SECTION, {
        refreshIntervalMs: 1000,
        refreshOnStart: false,
      }),
    ).toEqual({ refreshIntervalMs: 1000, refreshOnStart: false });
    expect(() => registry.validate(MODEL_CATALOG_SECTION, { refreshIntervalMs: -1 })).toThrow();
  });

  it('refreshProviderModels throws provider.not_found for an unknown provider', async () => {
    await catalog()
      .refreshProviderModels({ providerId: 'missing' })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (err) => {
          expect(isError2(err)).toBe(true);
          expect((err as { code: string }).code).toBe('provider.not_found');
        },
      );
  });

  it('refreshProviderModels returns an empty result and stays silent when nothing is refreshable', async () => {
    const result = await catalog().refreshProviderModels({ scope: 'all' });
    expect(result).toEqual({ changed: [], unchanged: [], failed: [] });
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('serializes concurrent refreshProviderModels runs so they never overlap', async () => {
    backing.providers = {
      [KIMI_CODE_PROVIDER_NAME]: {
        type: 'kimi',
        baseUrl: 'https://api.example.test/v1',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    };
    backing.models = {};
    resolveTokenProvider.mockReturnValue({ getAccessToken: async () => 'access-token' });

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
      catalog().refreshProviderModels({ scope: 'all' }),
      catalog().refreshProviderModels({ scope: 'all' }),
    ]);

    expect(maxInFlight).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refreshProviderModels sends the host User-Agent on custom-registry fetches', async () => {
    backing.providers = {
      acme: {
        type: 'openai',
        apiKey: 'sk-acme',
        source: {
          kind: 'apiJson',
          url: 'https://registry.example.test/api.json',
          apiKey: 'sk-registry',
        },
      },
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
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await catalog().refreshProviderModels({ scope: 'all' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://registry.example.test/api.json',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'kimi-code-cli/test' }),
      }),
    );
  });
});
