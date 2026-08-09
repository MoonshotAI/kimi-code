import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { authSummarySchema, type AuthSummary } from '../src/protocol/rest-auth';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authedFetch } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('server-v2 GET /api/v1/auth', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  // The Rust engine process is a module-level singleton: `KIMI_CONFIG_PATH`
  // freezes at the first spawn, so all cases must share one home dir (the
  // engine re-reads the config file on every `config/get`, but the path must
  // not be deleted mid-suite). Each `boot` resets the config file instead.
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-auth-'));
  });

  afterAll(async () => {
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  async function boot(toml?: string): Promise<void> {
    const configPath = join(home as string, 'config.toml');
    if (toml !== undefined) {
      await writeFile(configPath, toml, 'utf-8');
    } else {
      // Reset to an empty config: remove the file so the engine falls back to
      // its built-in models.dev defaults.
      await rm(configPath, { force: true });
    }
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function getAuth(): Promise<AuthSummary> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/auth');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<AuthSummary>;
    expect(body.code).toBe(0);
    return authSummarySchema.parse(body.data);
  }

  it('returns ready=false with a provider but no default model', async () => {
    // The Rust engine validates configs and rejects an empty provider set,
    // so the "not ready" case is a provider without a default model.
    await boot(`
      [providers.kimi]
      api_key = "sk-test"
    `);
    const summary = await getAuth();
    expect(summary.ready).toBe(false);
    expect(summary.providers_count).toBeGreaterThanOrEqual(1);
    expect(summary.default_model).toBeNull();
    expect(summary.managed_provider).toBeNull();
  });

  it('returns ready=true when provider + api_key + default_model are set', async () => {
    await boot(
      [
        'defaultModel = "x"',
        '',
        '[providers.x]',
        'type = "kimi"',
        'api_key = "sk-test"',
        '',
        '[models.x]',
        'provider = "x"',
        'model = "x"',
        'max_context_size = 1000',
        '',
      ].join('\n'),
    );
    const summary = await getAuth();
    // The engine config carries built-in models.dev providers alongside the
    // configured one; readiness + default_model are the engine projection.
    expect(summary.ready).toBe(true);
    expect(summary.providers_count).toBeGreaterThanOrEqual(1);
    expect(summary.default_model).toBe('x');
    expect(summary.managed_provider).toBeNull();
  });

  it('returns ready=false when a provider exists but default_model is missing', async () => {
    await boot(
      [
        '[providers.x]',
        'type = "kimi"',
        'api_key = "sk-test"',
        '',
        '[models.x]',
        'provider = "x"',
        'model = "x"',
        'max_context_size = 1000',
        '',
      ].join('\n'),
    );
    const summary = await getAuth();
    expect(summary.ready).toBe(false);
    expect(summary.providers_count).toBeGreaterThanOrEqual(1);
    expect(summary.default_model).toBeNull();
    expect(summary.managed_provider).toBeNull();
  });

  it('surfaces managed_provider.unauthenticated without a cached token', async () => {
    await boot(
      [
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
        'base_url = "https://example.test/v1"',
        '',
        '[providers."managed:kimi-code".oauth]',
        'storage = "file"',
        'key = "oauth/kimi-code"',
        '',
      ].join('\n'),
    );
    const summary = await getAuth();
    expect(summary.managed_provider).toEqual({
      name: 'managed:kimi-code',
      status: 'unauthenticated',
    });
    // No default_model → still not ready, even though the provider exists.
    expect(summary.ready).toBe(false);
  });
});
