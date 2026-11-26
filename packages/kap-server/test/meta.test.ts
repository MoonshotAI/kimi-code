import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IConfigService } from '@moonshot-ai/agent-core-v2';
import { IFeatureManager } from '@moonshot-ai/agent-core-v2/app/feature/featureManager';
import { getFeatureRecipes } from '@moonshot-ai/agent-core-v2/features/featureRegistry';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  metaCapabilitiesSchema,
  type MetaExperimentalBeta,
  type MetaExperimentalFeature,
} from '../src/protocol/rest-meta';
import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';

interface MetaBody {
  code: number;
  data: {
    kimi_agent_protocol_version?: string;
    home_dir?: string;
    experimental_flags?: Record<string, boolean>;
    experimental_beta?: MetaExperimentalBeta;
    experimental_features?: MetaExperimentalFeature[];
  };
}

describe('/api/v1/meta experimental_flags', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-meta-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
  });

  beforeEach(() => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_NOTIFY_USER', undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
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
    await writeFile(join(home as string, 'config.toml'), toml ?? '', 'utf-8');
    await (server as RunningServer).core.accessor.get(IConfigService).reload();
    return `http://127.0.0.1:${(server as RunningServer).port}`;
  }

  async function getMetaFlags(base: string): Promise<Record<string, boolean>> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/meta');
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetaBody;
    expect(body.code).toBe(0);
    expect(body.data.kimi_agent_protocol_version).toBe('1.0.0');
    expect(body.data).not.toHaveProperty('backend');
    expect(body.data.experimental_flags).toBeDefined();
    return body.data.experimental_flags as Record<string, boolean>;
  }

  it('reports registered flags as off by default', async () => {
    const base = await boot();
    const flags = await getMetaFlags(base);
    expect(flags['notify_user']).toBe(false);
  });

  it('reports the data directory the server runs on as home_dir', async () => {
    const base = await boot();
    const res = await authedFetch(server as RunningServer, base, '/api/v1/meta');
    const body = (await res.json()) as MetaBody;
    expect(body.data.home_dir).toBe(home);
  });

  it('reports a config-enabled flag from the very first response', async () => {
    const base = await boot('[experimental]\nnotify_user = true\n');
    const flags = await getMetaFlags(base);
    expect(flags['notify_user']).toBe(true);
  });

  it('reflects a flag enabled via its KIMI_CODE_EXPERIMENTAL_* env var', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_NOTIFY_USER', '1');
    const base = await boot();
    const flags = await getMetaFlags(base);
    expect(flags['notify_user']).toBe(true);
  });

  it('flips live when the [experimental] config section is written via POST /config', async () => {
    const base = await boot();
    expect((await getMetaFlags(base))['notify_user']).toBe(false);

    const res = await authedFetch(server as RunningServer, base, '/api/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ experimental: { 'notify_user': true } }),
    });
    expect(res.status).toBe(200);

    expect((await getMetaFlags(base))['notify_user']).toBe(true);
  });

  it('keeps an env-forced flag on when the config section disables it', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_NOTIFY_USER', '1');
    const base = await boot();

    const res = await authedFetch(server as RunningServer, base, '/api/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ experimental: { 'notify_user': false } }),
    });
    expect(res.status).toBe(200);

    expect((await getMetaFlags(base))['notify_user']).toBe(true);
  });

  it('publishes surface-scoped experimental_beta and experimental_features and applies beta master non-destructively', async () => {
    const base = await boot('[experimental]\nprompt_prediction = false\n');
    const initialRes = await authedFetch(server as RunningServer, base, '/api/v1/meta');
    const initialBody = (await initialRes.json()) as MetaBody;
    expect(initialBody.data.experimental_beta).toEqual({
      enabled: false,
      source: 'default',
      env: 'KIMI_CODE_EXPERIMENTAL_FLAG',
    });
    const initialIds = (initialBody.data.experimental_features ?? []).map((f) => f.id);
    expect(initialIds).toContain('context_inspector');
    expect(initialIds).toContain('prompt_prediction');
    expect(initialIds).toContain('auto_review');
    expect(initialIds).toContain('notify_user_app');
    expect(initialIds).toContain('session_mentions');
    expect(initialIds).toContain('sidebar_multi_tab');
    expect(initialIds).toContain('tower');
    expect(initialIds).not.toContain('notify_user');
    expect(initialIds).not.toContain('wait_for');
    expect(initialIds).not.toContain('worktree');

    const enableBetaRes = await authedFetch(server as RunningServer, base, '/api/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ experimental: { beta: true, prompt_prediction: false } }),
    });
    expect(enableBetaRes.status).toBe(200);

    const betaRes = await authedFetch(server as RunningServer, base, '/api/v1/meta');
    const betaBody = (await betaRes.json()) as MetaBody;
    expect(betaBody.data.experimental_beta).toMatchObject({
      enabled: true,
      source: 'config',
      config_value: true,
    });
    const promptPredictionFeature = betaBody.data.experimental_features?.find(
      (f) => f.id === 'prompt_prediction',
    );
    const autoReviewFeature = betaBody.data.experimental_features?.find(
      (f) => f.id === 'auto_review',
    );
    const notifyAppFeature = betaBody.data.experimental_features?.find(
      (f) => f.id === 'notify_user_app',
    );
    const towerFeature = betaBody.data.experimental_features?.find((f) => f.id === 'tower');
    expect(promptPredictionFeature).toMatchObject({
      stage: 'beta',
      effect_timing: 'immediate',
      enabled: true,
      active: true,
      source: 'beta-config',
      config_value: false,
    });
    expect(autoReviewFeature).toMatchObject({
      stage: 'beta',
      effect_timing: 'immediate',
      enabled: true,
      active: true,
      source: 'beta-config',
    });
    expect(notifyAppFeature).toMatchObject({
      stage: 'experimental',
      effect_timing: 'next-session',
      enabled: false,
      active: false,
      source: 'default',
    });
    expect(towerFeature).toMatchObject({
      stage: 'experimental',
      effect_timing: 'restart',
      enabled: false,
      active: false,
      source: 'default',
    });

    const enableTowerRes = await authedFetch(server as RunningServer, base, '/api/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ experimental: { tower: true } }),
    });
    expect(enableTowerRes.status).toBe(200);

    const pendingTowerRes = await authedFetch(server as RunningServer, base, '/api/v1/meta');
    const pendingTowerBody = (await pendingTowerRes.json()) as MetaBody;
    expect(
      pendingTowerBody.data.experimental_features?.find((f) => f.id === 'tower'),
    ).toMatchObject({
      enabled: true,
      active: false,
      source: 'config',
      config_value: true,
    });
  });
});

describe('/api/v1/meta legacy master env tower migration', () => {
  let migratedServer: RunningServer | undefined;
  let migratedHome: string | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (migratedServer !== undefined) {
      await migratedServer.close();
      migratedServer = undefined;
    }
    if (migratedHome !== undefined) {
      await rm(migratedHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      migratedHome = undefined;
    }
  });

  it('migrates KIMI_CODE_EXPERIMENTAL_FLAG=1 on an existing installation so tower assembles on startup', async () => {
    migratedHome = await mkdtemp(join(tmpdir(), 'kimi-server-v2-meta-tower-mig-'));
    await writeFile(join(migratedHome, 'config.toml'), 'default_model = "kimi-k2"\n', 'utf-8');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '1');

    migratedServer = await startServer({
      hostIdentity: {
        ...TEST_HOST_IDENTITY,
        platform: 'kimi_code_desktop',
      },
      host: '127.0.0.1',
      port: 0,
      homeDir: migratedHome,
      logLevel: 'silent',
    });

    const base = `http://127.0.0.1:${migratedServer.port}`;
    const res = await authedFetch(migratedServer, base, '/api/v1/meta');
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetaBody;
    expect(body.data.experimental_beta).toMatchObject({
      enabled: true,
      source: 'env',
    });
    expect(body.data.experimental_features?.find((f) => f.id === 'tower')).toMatchObject({
      stage: 'experimental',
      effect_timing: 'restart',
      enabled: true,
      active: true,
      source: 'config',
      config_value: true,
    });
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

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-meta-features-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
  });

  afterAll(async () => {
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
    return `http://127.0.0.1:${(server as RunningServer).port}`;
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
      .toSorted();
    expect(features.map((feature) => feature.name).toSorted()).toEqual(expected);
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

  it('surfaces hostIdentity.productName as product on /api/v1/meta', async () => {
    const base = await boot();
    const res = await authedFetch(server as RunningServer, base, '/api/v1/meta');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: { product?: string } };
    expect(body.code).toBe(0);
    expect(body.data.product).toBe(TEST_HOST_IDENTITY.productName);
  });

  it('advertises supported capabilities, accepts older hosts, and serves authenticated GET /api/v1/kap.md', async () => {
    const base = await boot();
    const metaRes = await authedFetch(server as RunningServer, base, '/api/v1/meta');
    const metaBody = (await metaRes.json()) as {
      code: number;
      data: { capabilities: Record<string, boolean> };
    };
    expect(metaBody.code).toBe(0);
    expect(metaBody.data.capabilities['interactions_list']).toBe(true);
    expect(metaBody.data.capabilities['session_wait']).toBe(true);
    const { feedback, ...olderHost } = metaBody.data.capabilities;
    expect(feedback).toBe(true);
    expect(metaCapabilitiesSchema.parse(olderHost)).toEqual(olderHost);

    const unauthed = await fetch(`${base}/api/v1/kap.md`);
    expect(unauthed.status).toBe(401);

    const specRes = await authedFetch(server as RunningServer, base, '/api/v1/kap.md');
    expect(specRes.status).toBe(200);
    expect(specRes.headers.get('content-type')).toContain('text/markdown');
    const text = await specRes.text();
    expect(text.startsWith('# Kimi Agent Protocol (KAP) Runtime Guide')).toBe(true);
    expect(text).toContain('POST /api/v1/sessions/{session_id}:wait');
    expect(text).toContain('POST /api/v1/feedback');
  });
});
