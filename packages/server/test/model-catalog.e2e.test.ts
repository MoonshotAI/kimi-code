import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IModelCatalogService, type IModelCatalogService as ModelCatalogServiceShape } from '@moonshot-ai/agent-core';

import { IRestGateway, startServer, type RunningServer, type ServerStartOptions } from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-model-catalog-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-model-catalog-home-'));
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    // ignore
  }
  server = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function bootDaemon(
  serviceOverrides?: ServerStartOptions['serviceOverrides'],
): Promise<RunningServer> {
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
    serviceOverrides,
  });
  return server;
}

function appOf(r: RunningServer): {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
} {
  return r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
      inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
    };
  });
}

function envelopeOf<T>(body: unknown): {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
} {
  return body as {
    code: number;
    msg: string;
    data: T | null;
    request_id: string;
  };
}

function seedConfig(toml: string): void {
  writeFileSync(join(bridgeHome, 'config.toml'), toml, 'utf-8');
}

function seedCatalogConfig(): void {
  seedConfig(
    [
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
    ].join('\n'),
  );
}

describe('model/provider catalog routes', () => {
  it('lists configured models as selectable aliases', async () => {
    seedCatalogConfig();
    const r = await bootDaemon();
    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/models' });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<{ items: unknown[] }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data?.items).toEqual([
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

  it('lists providers and returns a single provider by id', async () => {
    seedCatalogConfig();
    const r = await bootDaemon();

    const list = await appOf(r).inject({ method: 'GET', url: '/api/v1/providers' });
    const listEnv = envelopeOf<{ items: unknown[] }>(list.json());
    expect(listEnv.code).toBe(0);
    expect(listEnv.data?.items).toEqual([
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

    const single = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/providers/kimi',
    });
    const singleEnv = envelopeOf<unknown>(single.json());
    expect(singleEnv.code).toBe(0);
    expect(singleEnv.data).toEqual({
      id: 'kimi',
      type: 'kimi',
      base_url: 'https://api.example.test/v1',
      default_model: 'k2',
      has_api_key: true,
      status: 'connected',
      models: ['k2', 'turbo'],
    });
  });

  it('sets the global default model and updates /auth', async () => {
    seedCatalogConfig();
    const r = await bootDaemon();

    const setDefault = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/models/turbo:set_default',
      payload: {},
    });
    const setEnv = envelopeOf<unknown>(setDefault.json());
    expect(setEnv.code).toBe(0);
    expect(setEnv.data).toEqual({
      default_model: 'turbo',
      model: {
        provider: 'kimi',
        model: 'turbo',
        display_name: 'Kimi Turbo',
        max_context_size: 32768,
      },
    });

    const auth = await appOf(r).inject({ method: 'GET', url: '/api/v1/auth' });
    const authEnv = envelopeOf<{ default_model: string | null }>(auth.json());
    expect(authEnv.code).toBe(0);
    expect(authEnv.data?.default_model).toBe('turbo');
  });

  it('maps unknown provider and model ids to catalog not-found error codes', async () => {
    seedCatalogConfig();
    const r = await bootDaemon();

    const provider = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/providers/missing',
    });
    expect(envelopeOf<unknown>(provider.json()).code).toBe(40412);

    const model = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/models/missing:set_default',
      payload: {},
    });
    expect(envelopeOf<unknown>(model.json()).code).toBe(40413);
  });

  it('refreshes OAuth provider models through the catalog route', async () => {
    const stub: ModelCatalogServiceShape = {
      _serviceBrand: undefined,
      listModels: async () => [],
      listProviders: async () => [],
      getProvider: async () => {
        throw new Error('unused');
      },
      setDefaultModel: async () => {
        throw new Error('unused');
      },
      refreshOAuthProviderModels: async () => ({
        changed: [
          {
            provider_id: 'managed:kimi-code',
            provider_name: 'Kimi Code',
            added: 1,
            removed: 0,
          },
        ],
        unchanged: [],
        failed: [],
      }),
    };
    const r = await bootDaemon([[IModelCatalogService, stub]]);

    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/providers:refresh_oauth',
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    expect(env.data).toEqual({
      changed: [
        {
          provider_id: 'managed:kimi-code',
          provider_name: 'Kimi Code',
          added: 1,
          removed: 0,
        },
      ],
      unchanged: [],
      failed: [],
    });
  });
});
