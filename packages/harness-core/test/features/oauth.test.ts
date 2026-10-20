import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { useCollection, useInject, type ComputedRef, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import { FileTokenStorage } from '@moonshot-ai/kimi-code-oauth';

import { ConfigRef, createConfig, type ConfigPersist, type ConfigStore } from '#/features/config/index';
import { createKimi } from '#/features/kimi/index';
import { OAuthTokensRef, type OAuthTokens } from '#/features/kimi/oauth/index';
import {
  CatalogModels,
  CredentialResolvers,
  matchCatalogBinding,
  providerCatalog,
  resolveCredentialProvider,
  useProviderCatalog,
  type CatalogModelBinding,
  type CredentialResolverContribution,
  type ProviderCatalogFace,
} from '#/features/provider-catalog/index';
import { createHarness, memoryHarnessSpace, type Harness } from '#/runtime/index';

const homes: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function setupHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'harness-oauth-'));
  homes.push(home);
  await new FileTokenStorage(join(home, 'credentials')).save('kimi-code', {
    accessToken: 'sk-managed',
    refreshToken: 'refresh-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: '',
    tokenType: 'Bearer',
    expiresIn: 3600,
  });
  return home;
}

async function setupEmptyHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'harness-oauth-'));
  homes.push(home);
  return home;
}

function fakePersist(initial?: string): { saved: string[]; persist: ConfigPersist } {
  const saved: string[] = [];
  let text = initial;
  return {
    saved,
    persist: {
      load: () => Promise.resolve(text),
      save: (value) => {
        saved.push(value);
        text = value;
        return Promise.resolve();
      },
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

interface Capture {
  oauth?: Readonly<ShallowRef<OAuthTokens | undefined>>;
  catalog?: Readonly<ShallowRef<ProviderCatalogFace | undefined>>;
  config?: Readonly<ShallowRef<ConfigStore | undefined>>;
  bindings?: ComputedRef<readonly CatalogModelBinding[]>;
  credentials?: ComputedRef<readonly CredentialResolverContribution[]>;
}

function oauthProbe(capture: Capture) {
  return createFeature('probe', {
    app() {
      capture.oauth = useInject(OAuthTokensRef);
      capture.catalog = useProviderCatalog();
      capture.config = useInject(ConfigRef);
      capture.bindings = useCollection(CatalogModels);
      capture.credentials = useCollection(CredentialResolvers);
    },
  });
}

interface OauthApp {
  readonly harness: Harness;
  readonly capture: Capture;
  readonly tokens: OAuthTokens;
  readonly catalog: ProviderCatalogFace;
  readonly config: ConfigStore;
}

async function mountOauthApp(options: {
  home: string;
  fetchImpl?: typeof fetch;
  file: { saved: string[]; persist: ConfigPersist };
}): Promise<OauthApp> {
  const capture: Capture = {};
  const harness = createHarness({ space: memoryHarnessSpace() });
  harness.app.features.add(createConfig({ persist: options.file.persist }));
  harness.app.features.add(providerCatalog);
  harness.app.features.add(createKimi({ oauth: { home: options.home, fetchImpl: options.fetchImpl } }));
  harness.app.features.add(oauthProbe(capture));
  await tick();
  const tokens = capture.oauth?.value;
  const catalog = capture.catalog?.value;
  const config = capture.config?.value;
  if (tokens === undefined || catalog === undefined || config === undefined) {
    throw new Error('oauth, catalog or config face was not exposed');
  }
  return { harness, capture, tokens, catalog, config };
}

interface ModelsCall {
  readonly url: string;
  readonly authorization?: string;
}

function stubCatalogFetch(payload: readonly unknown[]): {
  calls: ModelsCall[];
  fetchImpl: typeof fetch;
} {
  const calls: ModelsCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: (init?.headers as Record<string, string> | undefined)?.['Authorization'],
    });
    return new Response(JSON.stringify({ data: payload }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const managedModelsPayload = [
  {
    id: 'kimi-for-coding',
    context_length: 262144,
    supports_reasoning: true,
    supports_image_in: true,
    supports_video_in: false,
    supports_tool_use: true,
  },
  {
    id: 'kimi-latest',
    context_length: 131072,
    supports_reasoning: false,
    supports_image_in: false,
    supports_video_in: false,
    supports_tool_use: true,
  },
];

const MANAGED_PROVIDER_TOML =
  '[providers."managed:kimi-code"]\n' +
  'type = "kimi"\n' +
  'base_url = "https://managed.example.com"\n' +
  'model_source = "oauth-catalog"\n\n' +
  '[providers."managed:kimi-code".oauth]\n' +
  'storage = "file"\n' +
  'key = "oauth/kimi-code"\n';

const MANAGED_PROVIDER_LEGACY_TOML =
  '[providers."managed:kimi-code"]\n' +
  'type = "kimi"\n' +
  'base_url = "https://managed.example.com"\n' +
  'api_key = ""\n' +
  'alias_scope = "kimi-code"\n\n' +
  '[providers."managed:kimi-code".oauth]\n' +
  'storage = "file"\n' +
  'key = "oauth/kimi-code"\n';

describe('oauth feature', () => {
  it('resolves bearer tokens through the facade', async () => {
    const home = await setupHome();
    const { harness, tokens } = await mountOauthApp({ home, file: fakePersist() });

    const token = tokens.resolve({ storage: 'file', key: 'oauth/kimi-code' });
    expect(token).toBeDefined();
    await expect(token!.getAccessToken()).resolves.toBe('sk-managed');

    expect(tokens.resolve({ storage: 'keyring', key: 'oauth/kimi-code' })).toBeUndefined();

    const missing = tokens.resolve({ storage: 'file', key: 'oauth/unknown-slot' });
    await expect(missing!.getAccessToken()).rejects.toThrow(/No token/);
    await harness.close();
  });

  it('materializes oauth-catalog providers, writes models back under the kimi-code scope, and resolves oauth credentials', async () => {
    const home = await setupHome();
    const { calls, fetchImpl } = stubCatalogFetch(managedModelsPayload);
    const file = fakePersist(
      `${MANAGED_PROVIDER_TOML}\n[model_catalog]\nrefresh_on_start = false\nrefresh_interval_ms = 0\n`,
    );
    const { harness, capture, catalog } = await mountOauthApp({ home, fetchImpl, file });
    await until(() => catalog.models('managed:kimi-code').length === 2);
    expect(catalog.isLive('managed:kimi-code')).toBe(true);
    const models = catalog.models('managed:kimi-code');
    expect(models.map((model) => model.id)).toEqual(['kimi-for-coding', 'kimi-latest']);
    expect(models[0]?.maxContextSize).toBe(262144);
    expect(models[0]?.capability.thinking).toBe(true);
    expect(models[0]?.capability.image_in).toBe(true);
    expect(models[1]?.capability.thinking).toBe(false);

    const readSaved = (): Record<string, Record<string, Record<string, unknown>>> =>
      parseToml(file.saved.at(-1)!) as Record<string, Record<string, Record<string, unknown>>>;
    await until(
      () =>
        file.saved.length > 0 &&
        readSaved()['models']?.['kimi-code/kimi-for-coding'] !== undefined &&
        readSaved()['providers']?.['managed:kimi-code']?.['alias_scope'] === 'kimi-code',
    );
    const saved = readSaved();
    expect(saved['models']?.['kimi-code/kimi-for-coding']).toMatchObject({
      provider: 'managed:kimi-code',
      model: 'kimi-for-coding',
      max_context_size: 262144,
    });
    expect(saved['models']?.['kimi-code/kimi-latest']).toBeDefined();
    expect(
      Object.keys(saved['models'] ?? {}).some((key) => key.startsWith('managed:kimi-code/')),
    ).toBe(false);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.url).toBe('https://managed.example.com/models');
    expect(calls[0]?.authorization).toBe('Bearer sk-managed');

    const resolvers = capture.credentials?.value ?? [];
    const info = catalog.providerInfo('managed:kimi-code');
    expect(info?.oauth).toBeDefined();
    const oauthCredential = resolveCredentialProvider(info!, resolvers);
    expect(await oauthCredential?.resolve()).toEqual({ apiKey: 'sk-managed' });
    expect(await resolveCredentialProvider({ apiKey: 'sk-x' }, resolvers)?.resolve()).toEqual({
      apiKey: 'sk-x',
    });

    const settled = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls.length).toBe(settled);
    await harness.close();
  });

  it('refreshes once on start when refreshOnStart is set and again through the facade', async () => {
    const home = await setupHome();
    const { calls, fetchImpl } = stubCatalogFetch(managedModelsPayload);
    const { harness, tokens } = await mountOauthApp({
      home,
      fetchImpl,
      file: fakePersist(
        `${MANAGED_PROVIDER_TOML}\n[model_catalog]\nrefresh_on_start = true\nrefresh_interval_ms = 0\n`,
      ),
    });
    await until(() => calls.length >= 2);
    expect(calls.every((call) => call.url === 'https://managed.example.com/models')).toBe(true);

    void tokens.refresh();
    await until(() => calls.length >= 3);
    await harness.close();
  });

  it('reports refresh results, applies models in a single fetch, and detects in-place drift', async () => {
    const home = await setupHome();
    const payload = [...managedModelsPayload];
    const { calls, fetchImpl } = stubCatalogFetch(payload);
    const file = fakePersist(
      `${MANAGED_PROVIDER_TOML}\n[model_catalog]\nrefresh_on_start = false\nrefresh_interval_ms = 0\n`,
    );
    const { harness, tokens, catalog } = await mountOauthApp({ home, fetchImpl, file });
    await until(() => catalog.models('managed:kimi-code').length === 2);
    await until(() => file.saved.at(-1)?.includes('kimi-code/kimi-for-coding') === true);
    const settled = calls.length;

    const first = await tokens.refresh();
    expect(first).toEqual({ changed: [], unchanged: ['managed:kimi-code'], failed: [] });
    expect(calls.length).toBe(settled + 1);

    payload.splice(1, 1, {
      id: 'kimi-coding-plus',
      context_length: 131072,
      supports_reasoning: true,
      supports_image_in: false,
      supports_video_in: false,
      supports_tool_use: true,
    });
    const second = await tokens.refresh();
    expect(second).toEqual({
      changed: [
        { provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 1, removed: 1 },
      ],
      unchanged: [],
      failed: [],
    });
    await until(
      () =>
        catalog.models('managed:kimi-code').some((model) => model.id === 'kimi-coding-plus') &&
        file.saved.at(-1)?.includes('kimi-code/kimi-coding-plus') === true &&
        file.saved.at(-1)?.includes('kimi-latest') === false,
    );
    expect(calls.length).toBe(settled + 2);

    const third = await tokens.refresh();
    expect(third).toEqual({ changed: [], unchanged: ['managed:kimi-code'], failed: [] });

    payload[0] = { ...payload[0]!, context_length: 65536 };
    const drift = await tokens.refresh();
    expect(drift).toEqual({
      changed: [
        { provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 0, removed: 0 },
      ],
      unchanged: [],
      failed: [],
    });
    await until(
      () =>
        catalog.models('managed:kimi-code').find((model) => model.id === 'kimi-for-coding')
          ?.maxContextSize === 65536,
    );
    await harness.close();
  });

  it('reports failed providers when the token is missing and an empty report without oauth providers', async () => {
    const emptyHome = await setupEmptyHome();
    const { fetchImpl } = stubCatalogFetch(managedModelsPayload);
    const missing = await mountOauthApp({
      home: emptyHome,
      fetchImpl,
      file: fakePersist(
        `${MANAGED_PROVIDER_TOML}\n[model_catalog]\nrefresh_on_start = false\nrefresh_interval_ms = 0\n`,
      ),
    });
    const failed = await missing.tokens.refresh();
    expect(failed.changed).toEqual([]);
    expect(failed.unchanged).toEqual([]);
    expect(failed.failed).toHaveLength(1);
    expect(failed.failed[0]?.provider).toBe('managed:kimi-code');
    expect(failed.failed[0]?.reason).toContain('No token');
    await missing.harness.close();

    const home = await setupHome();
    const bare = await mountOauthApp({ home, fetchImpl, file: fakePersist() });
    await expect(bare.tokens.refresh()).resolves.toEqual({
      changed: [],
      unchanged: [],
      failed: [],
    });
    await bare.harness.close();
  });

  it('materializes and refreshes a provider whose config entry carries oauth without model_source', async () => {
    const home = await setupHome();
    const { calls, fetchImpl } = stubCatalogFetch(managedModelsPayload);
    const file = fakePersist(
      `${MANAGED_PROVIDER_LEGACY_TOML}\n[model_catalog]\nrefresh_on_start = false\nrefresh_interval_ms = 0\n`,
    );
    const { harness, tokens, catalog } = await mountOauthApp({ home, fetchImpl, file });
    await until(() => catalog.models('managed:kimi-code').length === 2);
    expect(catalog.isLive('managed:kimi-code')).toBe(true);
    await until(() => file.saved.at(-1)?.includes('kimi-code/kimi-for-coding') === true);

    const report = await tokens.refresh();
    expect(report).toEqual({ changed: [], unchanged: ['managed:kimi-code'], failed: [] });
    expect(calls.every((call) => call.url === 'https://managed.example.com/models')).toBe(true);
    await harness.close();
  });
});

interface LoginFetchCall {
  readonly url: string;
  readonly body: string;
  readonly authorization?: string;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubLoginFetch(options: {
  polls?: readonly (() => Response)[];
  modelsPayload?: readonly unknown[];
  usagePayload?: unknown;
  userinfoPayload?: unknown;
} = {}): { calls: LoginFetchCall[] } {
  const calls: LoginFetchCall[] = [];
  let pollIndex = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      body: typeof init?.body === 'string' ? init.body : '',
      authorization: headers['Authorization'],
    });
    if (url.endsWith('/api/oauth/device_authorization')) {
      return jsonResponse({
        user_code: 'ABCD-EFGH',
        device_code: 'device-code-1',
        verification_uri: 'https://auth.example.com/device',
        verification_uri_complete: 'https://auth.example.com/device?user_code=ABCD-EFGH',
        expires_in: 900,
        interval: 1,
      });
    }
    if (url.endsWith('/api/oauth/token')) {
      const polls = options.polls;
      const next =
        polls === undefined
          ? () =>
              jsonResponse({
                access_token: 'sk-new-access',
                refresh_token: 'refresh-new',
                expires_in: 3600,
              })
          : polls[Math.min(pollIndex, polls.length - 1)];
      pollIndex += 1;
      return next();
    }
    if (url.endsWith('/models')) {
      return jsonResponse({ data: options.modelsPayload ?? managedModelsPayload });
    }
    if (url.endsWith('/usages')) {
      return jsonResponse(
        options.usagePayload ?? {
          usages: { limit_5h: { used_ratio: 0.25, reset_time: '2026-09-30T12:00:00Z' } },
          boosterWallet: null,
        },
      );
    }
    if (url.endsWith('/me')) {
      return jsonResponse(
        options.userinfoPayload ?? {
          user_id: 'u_123',
          nickname: 'moonwalker',
          status: 'USER_STATUS_NORMAL',
          region: 'REGION_CN',
          user_level: 30,
          user_level_name: 'Vivace',
          domain: 1,
          domain_name: 'DOMAIN_EXAMPLE',
        },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return { calls };
}

const MANAGED_PROVIDER_STATIC_TOML =
  'default_model = "kimi-code/kimi-for-coding"\n\n' +
  '[providers."managed:kimi-code"]\n' +
  'type = "kimi"\n' +
  'base_url = "https://api.kimi.com/coding/v1"\n\n' +
  '[providers."managed:kimi-code".oauth]\n' +
  'storage = "file"\n' +
  'key = "oauth/kimi-code"\n\n' +
  '[models."kimi-code/kimi-for-coding"]\n' +
  'provider = "managed:kimi-code"\n' +
  'model = "kimi-for-coding"\n' +
  'max_context_size = 262144\n\n' +
  '[services.moonshot_search]\n' +
  'base_url = "https://api.kimi.com/coding/v1/search"\n\n' +
  '[services.moonshot_fetch]\n' +
  'base_url = "https://api.kimi.com/coding/v1/fetch"\n';

describe('oauth login flows', () => {
  it('runs the device flow to authenticated and provisions the managed provider', async () => {
    const home = await setupEmptyHome();
    const { calls } = stubLoginFetch();
    const file = fakePersist();
    const { harness, capture, tokens, catalog, config } = await mountOauthApp({ home, file });

    const start = await tokens.loginStart();
    expect(start.status).toBe('pending');
    if (start.status !== 'pending') throw new Error('expected a pending flow');
    expect(start).toMatchObject({
      provider: 'managed:kimi-code',
      verification_uri: 'https://auth.example.com/device',
      verification_uri_complete: 'https://auth.example.com/device?user_code=ABCD-EFGH',
      user_code: 'ABCD-EFGH',
      expires_in: 900,
      interval: 1,
    });
    expect(start.flow_id).toMatch(/^oauth_/);
    expect(Number.isNaN(Date.parse(start.expires_at))).toBe(false);

    await until(() => tokens.loginStatus()?.status === 'authenticated');
    const snapshot = tokens.loginStatus();
    expect(snapshot).toMatchObject({ status: 'authenticated', user_code: 'ABCD-EFGH' });
    expect(typeof snapshot?.resolved_at).toBe('string');

    const stored = await new FileTokenStorage(join(home, 'credentials')).load('kimi-code');
    expect(stored?.accessToken).toBe('sk-new-access');

    await until(() => catalog.models('managed:kimi-code').length === 2);
    expect(
      calls.some(
        (call) =>
          call.url === 'https://api.kimi.com/coding/v1/models' &&
          call.authorization === 'Bearer sk-new-access',
      ),
    ).toBe(true);

    await until(() => config.get('defaultModel') === 'kimi-code/kimi-for-coding');
    await until(
      () => file.saved.at(-1) !== undefined && file.saved.at(-1)!.includes('kimi-code/kimi-latest'),
    );
    await until(
      () =>
        matchCatalogBinding('kimi-code/kimi-for-coding', capture.bindings?.value ?? []) !==
        undefined,
    );

    const summary = await tokens.summary();
    expect(summary).toEqual({
      models_ready: true,
      providers_count: 1,
      managed_provider: { name: 'managed:kimi-code', status: 'authenticated' },
    });
    await harness.close();
  });

  it('skips the device flow when a valid token already exists', async () => {
    const home = await setupHome();
    const { calls } = stubLoginFetch();
    const { harness, tokens, catalog } = await mountOauthApp({ home, file: fakePersist() });

    const start = await tokens.loginStart();
    expect(start).toEqual({
      flow_id: start.flow_id,
      provider: 'managed:kimi-code',
      status: 'authenticated',
    });
    expect(calls.some((call) => call.url.endsWith('/api/oauth/device_authorization'))).toBe(false);
    expect(tokens.loginStatus()).toBeUndefined();

    await until(() => catalog.models('managed:kimi-code').length === 2);
    expect(
      calls.some(
        (call) =>
          call.url === 'https://api.kimi.com/coding/v1/models' &&
          call.authorization === 'Bearer sk-managed',
      ),
    ).toBe(true);
    await harness.close();
  });

  it('cancels a pending flow and keeps the terminal snapshot', async () => {
    const home = await setupEmptyHome();
    stubLoginFetch({
      polls: [() => jsonResponse({ error: 'authorization_pending' }, 400)],
    });
    const { harness, tokens } = await mountOauthApp({ home, file: fakePersist() });

    const start = await tokens.loginStart();
    expect(start.status).toBe('pending');
    expect(tokens.loginStatus()?.status).toBe('pending');

    expect(tokens.loginCancel()).toEqual({ cancelled: true, status: 'cancelled' });
    const snapshot = tokens.loginStatus();
    expect(snapshot?.status).toBe('cancelled');
    expect(typeof snapshot?.resolved_at).toBe('string');
    expect(tokens.loginCancel()).toEqual({ cancelled: false, status: 'cancelled' });
    await harness.close();
  });

  it('marks the flow denied when the user refuses authorization', async () => {
    const home = await setupEmptyHome();
    stubLoginFetch({
      polls: [() => jsonResponse({ error: 'access_denied', error_description: 'user said no' }, 400)],
    });
    const { harness, tokens } = await mountOauthApp({ home, file: fakePersist() });

    const start = await tokens.loginStart();
    expect(start.status).toBe('pending');
    await until(() => tokens.loginStatus()?.status === 'denied');
    expect(tokens.loginStatus()).toMatchObject({
      status: 'denied',
      error_message: 'Authorization denied: user said no',
    });
    await harness.close();
  });

  it('logs out by deleting the stored token and deprovisioning managed config', async () => {
    const home = await setupHome();
    stubLoginFetch();
    const file = fakePersist(MANAGED_PROVIDER_STATIC_TOML);
    const { harness, tokens, config } = await mountOauthApp({ home, file });

    const result = await tokens.logout();
    expect(result).toEqual({ logged_out: true, provider: 'managed:kimi-code' });

    const stored = await new FileTokenStorage(join(home, 'credentials')).load('kimi-code');
    expect(stored).toBeUndefined();

    const providers = config.get('providers') as Record<string, unknown>;
    expect(providers['managed:kimi-code']).toBeUndefined();
    const models = config.get('models') as Record<string, unknown>;
    expect(models['kimi-code/kimi-for-coding']).toBeUndefined();
    const services = config.get('services') as Record<string, unknown> | undefined;
    expect(services?.['moonshot_search']).toBeUndefined();
    expect(services?.['moonshot_fetch']).toBeUndefined();
    expect(config.get('defaultModel')).toBeUndefined();
    expect(config.get('thinking')).toEqual({});
    await harness.close();
  });

  it('serves usage, userinfo, region and the auth summary', async () => {
    const home = await setupHome();
    stubLoginFetch();
    const { harness, capture, tokens } = await mountOauthApp({
      home,
      file: fakePersist(MANAGED_PROVIDER_STATIC_TOML),
    });

    const usage = await tokens.usage();
    expect(usage).toEqual({
      kind: 'ok',
      quota: {
        usages: { limit5h: { usedRatio: 0.25, resetAt: '2026-09-30T12:00:00Z' } },
        extraUsage: null,
      },
    });

    const userinfo = await tokens.userinfo();
    expect(userinfo).toMatchObject({
      kind: 'ok',
      userInfo: {
        userId: 'u_123',
        nickname: 'moonwalker',
        status: 'USER_STATUS_NORMAL',
        region: 'REGION_CN',
        userLevel: 30,
        userLevelName: 'Vivace',
        domain: 1,
        domainName: 'DOMAIN_EXAMPLE',
      },
    });

    expect(tokens.region()).toBe('mainland-cn');

    await until(
      () =>
        matchCatalogBinding('kimi-code/kimi-for-coding', capture.bindings?.value ?? []) !==
        undefined,
    );
    const summary = await tokens.summary();
    expect(summary).toEqual({
      models_ready: true,
      providers_count: 1,
      managed_provider: { name: 'managed:kimi-code', status: 'authenticated' },
    });
    await harness.close();

    const emptyHome = await setupEmptyHome();
    stubLoginFetch();
    const bare = await mountOauthApp({
      home: emptyHome,
      file: fakePersist(MANAGED_PROVIDER_STATIC_TOML),
    });
    expect(await bare.tokens.usage()).toEqual({
      kind: 'error',
      message: 'No token for "kimi-code". Run /login to authenticate.',
    });
    await until(
      () =>
        matchCatalogBinding('kimi-code/kimi-for-coding', bare.capture.bindings?.value ?? []) !==
        undefined,
    );
    expect(await bare.tokens.summary()).toEqual({
      models_ready: true,
      providers_count: 1,
      managed_provider: { name: 'managed:kimi-code', status: 'unauthenticated' },
    });
    await bare.harness.close();
  });

  it('resolves the global region from the configured oauth host', async () => {
    const home = await setupEmptyHome();
    stubLoginFetch();
    const toml =
      '[providers."managed:kimi-code"]\n' +
      'type = "kimi"\n' +
      'baseUrl = "https://api.kimi.ai/coding/v1"\n\n' +
      '[providers."managed:kimi-code".oauth]\n' +
      'storage = "file"\n' +
      'key = "oauth/kimi-code-env-0123456789abcdef"\n' +
      'oauthHost = "https://auth.kimi.ai"\n';
    const { harness, tokens } = await mountOauthApp({ home, file: fakePersist(toml) });
    expect(tokens.region()).toBe('global');
    await harness.close();
  });
});
