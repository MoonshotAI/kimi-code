import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IConfigService,
  IModelCatalog,
  IOAuthService,
  IProviderDiscoveryService,
  type IModelCatalog as IModelCatalogType,
  type IOAuthService as IOAuthServiceType,
  type IProviderDiscoveryService as IProviderDiscoveryServiceType,
  type ModelCatalogConfig,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

const CATALOG_TOML = [
  'default_model = "k2"',
  '',
  '[providers.kimi]',
  'type = "kimi"',
  'api_key = "sk-test"',
  'base_url = "https://api.example.test/v1"',
  '',
  '[providers.openai]',
  'type = "openai"',
  '',
  '[models.k2]',
  'provider = "kimi"',
  'model = "kimi-k2"',
  'max_context_size = 131072',
  'display_name = "Kimi K2"',
  'capabilities = ["thinking"]',
  '',
  '[models.turbo]',
  'provider = "kimi"',
  'model = "kimi-turbo"',
  'max_context_size = 32768',
  'display_name = "Kimi Turbo"',
  '',
  '[models.gpt4o]',
  'provider = "openai"',
  'model = "gpt-4o"',
  'max_context_size = 128000',
  '',
].join('\n');

describe('server-v2 /api/v1 model/provider catalog', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-model-catalog-'));
    // Disable the background refresh scheduler so its startup refresh never
    // races the route-level assertions below (it shares the IProviderDiscoveryService
    // binding that the stub tests override).
    process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START'] = '0';
    process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS'] = '0';
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
    delete process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START'];
    delete process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS'];
  });

  async function boot(toml?: string, seeds?: ScopeSeed): Promise<void> {
    if (toml !== undefined) {
      await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
    }
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds,
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(
        server as RunningServer,
        body === undefined ? {} : { 'content-type': 'application/json' },
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('lists configured models as selectable aliases', async () => {
    await boot(CATALOG_TOML);
    const { status, body } = await getJson<{ items: unknown[] }>('/api/v1/models');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([
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

  it('lists models without refreshing providers', async () => {
    const refreshProviderModels = vi.fn(async () => ({
      changed: [],
      unchanged: [],
      failed: [],
    }));
    const seeds = [
      [IModelCatalog, catalogStub()],
      [IProviderDiscoveryService, discoveryStub(refreshProviderModels)],
    ] as unknown as ScopeSeed;
    await boot(CATALOG_TOML, seeds);

    const { status, body } = await getJson<{ items: unknown[] }>('/api/v1/models');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
    expect(refreshProviderModels).not.toHaveBeenCalled();
  });

  it('lists providers and returns a single provider by id', async () => {
    await boot(CATALOG_TOML);
    const list = await getJson<{ items: unknown[] }>('/api/v1/providers');
    expect(list.body.code).toBe(0);
    expect(list.body.data.items).toEqual([
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

    const single = await getJson<unknown>('/api/v1/providers/kimi');
    expect(single.body.code).toBe(0);
    expect(single.body.data).toEqual({
      id: 'kimi',
      type: 'kimi',
      base_url: 'https://api.example.test/v1',
      default_model: 'k2',
      has_api_key: true,
      status: 'connected',
      models: ['k2', 'turbo'],
    });
  });

  it('sets the global default model and reflects it in /auth', async () => {
    await boot(CATALOG_TOML);
    const { body } = await postJson<unknown>('/api/v1/models/turbo:set_default', {});
    expect(body.code).toBe(0);
    expect(body.data).toEqual({
      default_model: 'turbo',
      model: {
        provider: 'kimi',
        model: 'turbo',
        display_name: 'Kimi Turbo',
        max_context_size: 32768,
      },
    });

    const auth = await getJson<{ default_model: string | null }>('/api/v1/auth');
    expect(auth.body.code).toBe(0);
    expect(auth.body.data.default_model).toBe('turbo');
  });

  it('maps unknown provider and model ids to catalog not-found codes', async () => {
    await boot(CATALOG_TOML);
    const provider = await getJson<unknown>('/api/v1/providers/missing');
    expect(provider.body.code).toBe(40412);

    const model = await postJson<unknown>('/api/v1/models/missing:set_default', {});
    expect(model.body.code).toBe(40413);
  });

  it('returns an empty refresh result through the catalog route', async () => {
    await boot(CATALOG_TOML);
    const { status, body } = await postJson<{
      changed: unknown[];
      unchanged: unknown[];
      failed: unknown[];
    }>('/api/v1/providers:refresh_oauth', {});
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ changed: [], unchanged: [], failed: [] });
  });

  it('returns an empty refresh result through the providers:refresh route', async () => {
    await boot(CATALOG_TOML);
    const { status, body } = await postJson<{
      changed: unknown[];
      unchanged: unknown[];
      failed: unknown[];
    }>('/api/v1/providers:refresh', {});
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ changed: [], unchanged: [], failed: [] });
  });

  function catalogStub(): IModelCatalogType {
    return {
      _serviceBrand: undefined,
      get: () => {
        throw new Error('unused');
      },
      getRequester: () => {
        throw new Error('unused');
      },
      inspect: () => {
        throw new Error('unused');
      },
      ping: async () => {
        throw new Error('unused');
      },
      findByName: () => [],
      listModels: async () => [],
      listProviders: async () => [],
      getProvider: async () => {
        throw new Error('unused');
      },
      setDefaultModel: async () => {
        throw new Error('unused');
      },
    };
  }

  function discoveryStub(
    refreshProviderModels: IProviderDiscoveryServiceType['refreshProviderModels'],
  ): IProviderDiscoveryServiceType {
    return { _serviceBrand: undefined, refreshProviderModels };
  }

  function oauthStub(
    refreshOAuthProviderModels: IOAuthServiceType['refreshOAuthProviderModels'],
  ): IOAuthServiceType {
    return {
      _serviceBrand: undefined,
      startLogin: async () => {
        throw new Error('unused');
      },
      getFlow: () => undefined,
      cancelLogin: async () => {
        throw new Error('unused');
      },
      logout: async () => {
        throw new Error('unused');
      },
      status: async () => ({ loggedIn: false }),
      refreshOAuthProviderModels,
      getManagedUsage: async () => ({ kind: 'error' as const, message: 'unused' }),
      resolveTokenProvider: () => undefined,
      getCachedAccessToken: async () => undefined,
    };
  }

  it('refreshes OAuth provider models through POST /providers:refresh_oauth', async () => {
    const refreshOAuthProviderModels = vi.fn(async () => ({
      changed: [
        { provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 1, removed: 0 },
      ],
      unchanged: [],
      failed: [],
    }));
    const seeds = [[IOAuthService, oauthStub(refreshOAuthProviderModels)]] as unknown as ScopeSeed;
    await boot(CATALOG_TOML, seeds);

    const { status, body } = await postJson<{
      changed: unknown[];
      unchanged: unknown[];
      failed: unknown[];
    }>('/api/v1/providers:refresh_oauth', {});

    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({
      changed: [
        { provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 1, removed: 0 },
      ],
      unchanged: [],
      failed: [],
    });
    expect(refreshOAuthProviderModels).toHaveBeenCalledTimes(1);
  });

  it('refreshes all provider models through POST /providers:refresh', async () => {
    const refreshProviderModels = vi.fn(async () => ({
      changed: [
        { provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 2, removed: 1 },
      ],
      unchanged: ['moonshot-cn'],
      failed: [],
    }));
    const seeds = [[IProviderDiscoveryService, discoveryStub(refreshProviderModels)]] as unknown as ScopeSeed;
    await boot(CATALOG_TOML, seeds);

    const { status, body } = await postJson('/api/v1/providers:refresh', {});
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(refreshProviderModels).toHaveBeenCalledWith({ scope: 'all' });
  });

  it('refreshes a single provider through POST /providers/{id}:refresh', async () => {
    const refreshProviderModels = vi.fn(async () => ({
      changed: [],
      unchanged: [],
      failed: [],
    }));
    const seeds = [[IProviderDiscoveryService, discoveryStub(refreshProviderModels)]] as unknown as ScopeSeed;
    await boot(CATALOG_TOML, seeds);

    const { status, body } = await postJson('/api/v1/providers/managed%3Akimi-code:refresh', {});
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(refreshProviderModels).toHaveBeenCalledWith({ providerId: 'managed:kimi-code' });
  });

  it('rejects unsupported provider actions with 40001', async () => {
    const refreshProviderModels = vi.fn(async () => ({
      changed: [],
      unchanged: [],
      failed: [],
    }));
    const seeds = [[IProviderDiscoveryService, discoveryStub(refreshProviderModels)]] as unknown as ScopeSeed;
    await boot(CATALOG_TOML, seeds);

    const { body } = await postJson('/api/v1/providers/foo:bogus', {});
    expect(body.code).toBe(40001);
    expect(refreshProviderModels).not.toHaveBeenCalled();
  });

  it('loads the [model_catalog] config section from TOML', async () => {
    await boot(
      ['[model_catalog]', 'refresh_interval_ms = 1000', 'refresh_on_start = false', ''].join('\n'),
    );
    const cfg = server!.core.accessor.get(IConfigService);
    await cfg.ready;
    const value = cfg.get<ModelCatalogConfig | undefined>('modelCatalog');
    expect(value).toEqual({ refreshIntervalMs: 1000, refreshOnStart: false });
  });
});
