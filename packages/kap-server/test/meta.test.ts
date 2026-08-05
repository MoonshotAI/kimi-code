/**
 * `/api/v1/meta` tests — the static server-self fields are covered by
 * `boot.test.ts`; these focus on `experimental_flags`, the effective
 * experimental-flag map resolved per request from every flag source (env,
 * master env, the `[experimental]` config section, defaults).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';

interface MetaBody {
  code: number;
  data: { experimental_flags?: Record<string, boolean> };
}

describe('/api/v1/meta experimental_flags', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  beforeEach(() => {
    // Neutralize flag env vars leaking from the developer shell (e.g. a
    // globally exported KIMI_CODE_EXPERIMENTAL_FLAG=1) so each test starts
    // from the default-off baseline. The master env can be pinned to '0' (it
    // only forces ON), but the per-flag env must be fully ABSENT — an
    // explicit '0' is an env override that outranks the config section.
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL', undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      // The query-store cache can still be flushing while we clean up; retry
      // instead of flaking on ENOTEMPTY.
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      home = undefined;
    }
  });

  async function boot(toml?: string): Promise<string> {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-meta-'));
    if (toml !== undefined) {
      await writeFile(join(home, 'config.toml'), toml, 'utf-8');
    }
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    return `http://127.0.0.1:${server.port}`;
  }

  async function getMetaFlags(base: string): Promise<Record<string, boolean>> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/meta');
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetaBody;
    expect(body.code).toBe(0);
    expect(body.data.experimental_flags).toBeDefined();
    return body.data.experimental_flags as Record<string, boolean>;
  }

  it('reports registered flags as off by default', async () => {
    const base = await boot();
    const flags = await getMetaFlags(base);
    expect(flags['secondary-model']).toBe(false);
  });

  it('reports a config-enabled flag from the very first response', async () => {
    // Regression for the startup race: FlagService reads the `[experimental]`
    // section from a config that loads asynchronously, so the handler awaits
    // IConfigService.ready before snapshotting — a persisted flag must be
    // visible even to the earliest request.
    const base = await boot('[experimental]\nsecondary-model = true\n');
    const flags = await getMetaFlags(base);
    expect(flags['secondary-model']).toBe(true);
  });

  it('reflects a flag enabled via its KIMI_CODE_EXPERIMENTAL_* env var', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL', '1');
    const base = await boot();
    const flags = await getMetaFlags(base);
    expect(flags['secondary-model']).toBe(true);
  });

  it('flips live when the [experimental] config section is written via POST /config', async () => {
    const base = await boot();
    expect((await getMetaFlags(base))['secondary-model']).toBe(false);

    const res = await authedFetch(server as RunningServer, base, '/api/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ experimental: { 'secondary-model': true } }),
    });
    expect(res.status).toBe(200);

    expect((await getMetaFlags(base))['secondary-model']).toBe(true);
  });

  it('keeps an env-forced flag on when the config section disables it', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL', '1');
    const base = await boot();

    const res = await authedFetch(server as RunningServer, base, '/api/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ experimental: { 'secondary-model': false } }),
    });
    expect(res.status).toBe(200);

    // Env outranks the config section in FlagService resolution.
    expect((await getMetaFlags(base))['secondary-model']).toBe(true);
  });
});
