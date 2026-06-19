import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IRestGateway, startServer, type RunningServer } from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-config-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-config-home-'));
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

async function bootDaemon(): Promise<RunningServer> {
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
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
      '',
    ].join('\n'),
  );
}

describe('config routes', () => {
  it('GET /config returns redacted config without api_key', async () => {
    seedCatalogConfig();
    const r = await bootDaemon();

    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/config' });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<{
      default_model: string;
      providers: Record<string, unknown>;
    }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data?.default_model).toBe('k2');
    expect(env.data?.providers).toEqual({
      kimi: {
        type: 'kimi',
        base_url: 'https://api.example.test/v1',
        has_api_key: true,
      },
      openai: {
        type: 'openai',
        has_api_key: false,
      },
    });
  });

  it('POST /config merges changes and persists to disk', async () => {
    seedCatalogConfig();
    const r = await bootDaemon();

    const setRes = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/config',
      payload: { default_model: 'gpt4o' },
    });
    const setEnv = envelopeOf<{ default_model: string }>(setRes.json());
    expect(setEnv.code).toBe(0);
    expect(setEnv.data?.default_model).toBe('gpt4o');

    const text = readFileSync(join(bridgeHome, 'config.toml'), 'utf-8');
    expect(text).toContain('default_model = "gpt4o"');

    const getRes = await appOf(r).inject({ method: 'GET', url: '/api/v1/config' });
    const getEnv = envelopeOf<{ default_model: string }>(getRes.json());
    expect(getEnv.code).toBe(0);
    expect(getEnv.data?.default_model).toBe('gpt4o');
  });

  it('POST /config rejects invalid config values', async () => {
    seedCatalogConfig();
    const r = await bootDaemon();

    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/config',
      payload: { default_provider: 123 },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });
});
