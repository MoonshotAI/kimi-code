import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IFeatureManager } from '@moonshot-ai/agent-core-v2/app/feature/featureManager';
import { getFeatureRecipes } from '@moonshot-ai/agent-core-v2/features/featureRegistry';
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
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_TOOL_SELECT', undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
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
    expect(flags['tool-select']).toBe(false);
  });

  it('reports a config-enabled flag from the very first response', async () => {
    const base = await boot('[experimental]\ntool-select = true\n');
    const flags = await getMetaFlags(base);
    expect(flags['tool-select']).toBe(true);
  });

  it('reflects a flag enabled via its KIMI_CODE_EXPERIMENTAL_* env var', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_TOOL_SELECT', '1');
    const base = await boot();
    const flags = await getMetaFlags(base);
    expect(flags['tool-select']).toBe(true);
  });

  it('flips live when the [experimental] config section is written via POST /config', async () => {
    const base = await boot();
    expect((await getMetaFlags(base))['tool-select']).toBe(false);

    const res = await authedFetch(server as RunningServer, base, '/api/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ experimental: { 'tool-select': true } }),
    });
    expect(res.status).toBe(200);

    expect((await getMetaFlags(base))['tool-select']).toBe(true);
  });

  it('keeps an env-forced flag on when the config section disables it', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_TOOL_SELECT', '1');
    const base = await boot();

    const res = await authedFetch(server as RunningServer, base, '/api/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ experimental: { 'tool-select': false } }),
    });
    expect(res.status).toBe(200);

    expect((await getMetaFlags(base))['tool-select']).toBe(true);
  });
});

describe('/api/v1/meta web_title', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      home = undefined;
    }
  });

  async function bootWithWebTitle(
    webTitle?: string,
  ): Promise<{ base: string; body: { data: { web_title?: string } } }> {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-meta-title-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      webTitle,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const res = await authedFetch(server, base, '/api/v1/meta');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: { web_title?: string } };
    expect(body.code).toBe(0);
    return { base, body };
  }

  it('surfaces the boot-time webTitle as web_title', async () => {
    const { body } = await bootWithWebTitle('My Dev Box');
    expect(body.data.web_title).toBe('My Dev Box');
  });

  it('omits web_title when no webTitle was passed', async () => {
    const { body } = await bootWithWebTitle();
    expect(body.data.web_title).toBeUndefined();
  });
});

describe('/api/v1/meta features', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  interface FeatureWire {
    name: string;
    state: string;
    meta: Record<string, unknown>;
  }

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      home = undefined;
    }
  });

  async function boot(): Promise<string> {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-meta-features-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    return `http://127.0.0.1:${server.port}`;
  }

  async function getMetaFeatures(base: string): Promise<FeatureWire[]> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/meta');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: { features?: FeatureWire[] } };
    expect(body.code).toBe(0);
    expect(body.data.features).toBeDefined();
    return body.data.features as FeatureWire[];
  }

  it('lists every registered built-in feature as Active with an empty meta', async () => {
    const base = await boot();
    const features = await getMetaFeatures(base);
    const expected = getFeatureRecipes()
      .map((recipe) => recipe.name)
      .sort();
    expect(features.map((feature) => feature.name).sort()).toEqual(expected);
    for (const feature of features) {
      expect(feature.state).toBe('Active');
      expect(feature.meta).toEqual({});
    }
  });

  it('drops a feature from the response after it is unprovided at runtime', async () => {
    const base = await boot();
    const before = await getMetaFeatures(base);
    expect(before.some((feature) => feature.name === 'plan')).toBe(true);

    await (server as RunningServer).core.accessor.get(IFeatureManager).unprovideUnit('plan');

    const after = await getMetaFeatures(base);
    expect(after.some((feature) => feature.name === 'plan')).toBe(false);
    expect(after).toHaveLength(before.length - 1);
  });
});
