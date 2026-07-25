import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { authSummarySchema, type AuthSummary } from '@moonshot-ai/agent-core-v2/app/authLegacy/authLegacy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-auth-'));
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  async function boot(toml?: string): Promise<void> {
    if (toml !== undefined) {
      await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
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

  it('returns ready=false with an empty snapshot on empty config', async () => {
    await boot();
    expect(await getAuth()).toEqual({
      ready: false,
      providers_count: 0,
      default_model: null,
      managed_provider: null,
    });
  });

  it('returns ready=true when provider + api_key + default_model are set', async () => {
    await boot(
      [
        'default_model = "x"',
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
    expect(await getAuth()).toEqual({
      ready: true,
      providers_count: 1,
      default_model: 'x',
      managed_provider: null,
    });
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
    expect(summary.providers_count).toBe(1);
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
