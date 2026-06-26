import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileTokenStorage,
  KIMI_CODE_PROVIDER_NAME,
  KimiOAuthToolkit,
  OAuthConnectionError,
  OAuthError,
  RetryableRefreshError,
  resolveKimiCodeOAuthKey,
  resolveKimiTokenStorageName,
  type TokenInfo,
} from '@moonshot-ai/kimi-code-oauth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKimiHarness, ErrorCodes, KimiError } from '#/index';

import { ProviderManager } from '../../agent-core/src/session/provider-manager';
import { TEST_IDENTITY } from './test-identity';

let homeDir: string;

type FetchMock = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function freshToken(): TokenInfo {
  return {
    accessToken: 'oauth-access-token',
    refreshToken: 'oauth-refresh-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: '',
    tokenType: 'Bearer',
    expiresIn: 3600,
  };
}

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-auth-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true });
});

describe('KimiHarness.auth', () => {
  it('can construct auth facade without host identity', () => {
    expect(() => createKimiHarness({ homeDir })).not.toThrow();
  });

  it('exposes a cached access token without refreshing auth state', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.getCachedAccessToken()).resolves.toBe('oauth-access-token');
  });

  it('maps missing runtime OAuth tokens to login-required errors', async () => {
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(
      harness.auth.resolveOAuthTokenProvider(KIMI_CODE_PROVIDER_NAME).getAccessToken(),
    ).rejects.toMatchObject({
      code: ErrorCodes.AUTH_LOGIN_REQUIRED,
    });
  });

  it('maps transient OAuth token failures to provider connection errors', async () => {
    const tokenErrors = [
      new OAuthConnectionError('OAuth request failed: fetch failed'),
      new RetryableRefreshError('Token refresh failed (HTTP 503).'),
    ];

    for (const tokenError of tokenErrors) {
      const tokenProviderSpy = vi
        .spyOn(KimiOAuthToolkit.prototype, 'tokenProvider')
        .mockReturnValue({
          async getAccessToken() {
            throw tokenError;
          },
        });
      try {
        const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

        const error = await harness.auth
          .resolveOAuthTokenProvider(KIMI_CODE_PROVIDER_NAME)
          .getAccessToken()
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(KimiError);
        expect(error).toMatchObject({
          code: ErrorCodes.PROVIDER_CONNECTION_ERROR,
          message: expect.stringContaining(tokenError.message),
          cause: tokenError,
        });
      } finally {
        tokenProviderSpy.mockRestore();
      }
    }
  });

  it('preserves non-retryable OAuth refresh failures', async () => {
    const oauthError = new OAuthError('bad client id');
    const tokenProviderSpy = vi
      .spyOn(KimiOAuthToolkit.prototype, 'tokenProvider')
      .mockReturnValue({
        async getAccessToken() {
          throw oauthError;
        },
      });
    try {
      const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

      await expect(
        harness.auth.resolveOAuthTokenProvider(KIMI_CODE_PROVIDER_NAME).getAccessToken(),
      ).rejects.toBe(oauthError);
    } finally {
      tokenProviderSpy.mockRestore();
    }
  });

  it('resolves managed auth from a partially invalid config without throwing', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[providers."managed:kimi-code"]
type = "kimi"
api_key = ""

[loop_control]
max_steps_per_turn = "abc"
`,
    );
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    // Token resolution is a read path: a broken section elsewhere in
    // config.toml must degrade, not break OAuth-backed sessions.
    await expect(harness.auth.getCachedAccessToken()).resolves.toBe('oauth-access-token');
    await expect(harness.auth.status()).resolves.toMatchObject({
      providers: [{ providerName: KIMI_CODE_PROVIDER_NAME, hasToken: true }],
    });
  });

  it('resolves cached access tokens from the configured scoped OAuth ref', async () => {
    const oauthKey = resolveKimiCodeOAuthKey({
      oauthHost: 'https://auth.dev.example.test',
      baseUrl: 'https://api.dev.example.test/coding/v1',
    });
    const storageName = resolveKimiTokenStorageName({ oauthKey });
    const storage = new FileTokenStorage(join(homeDir, 'credentials'));
    await storage.save('kimi-code', freshToken());
    await storage.save(storageName, { ...freshToken(), accessToken: 'dev-access-token' });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.dev.example.test/coding/v1"
api_key = ""
oauth = { storage = "file", key = "${oauthKey}", oauth_host = "https://auth.dev.example.test" }
`,
    );
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.getCachedAccessToken()).resolves.toBe('dev-access-token');
  });

  it('reports auth status from the configured scoped OAuth ref', async () => {
    const oauthKey = resolveKimiCodeOAuthKey({
      oauthHost: 'https://auth.dev.example.test',
      baseUrl: 'https://api.dev.example.test/coding/v1',
    });
    await new FileTokenStorage(join(homeDir, 'credentials')).save(
      resolveKimiTokenStorageName({ oauthKey }),
      { ...freshToken(), accessToken: 'dev-access-token' },
    );
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.dev.example.test/coding/v1"
api_key = ""
oauth = { storage = "file", key = "${oauthKey}", oauth_host = "https://auth.dev.example.test" }
`,
    );
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.status()).resolves.toEqual({
      providers: [{ providerName: KIMI_CODE_PROVIDER_NAME, hasToken: true }],
    });
  });

  it('provisions SDK config using an existing Kimi OAuth token', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    const fetchMock = vi.fn<FetchMock>(
      async (_input, _init) =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'kimi-for-coding',
                context_length: 262144,
                supports_reasoning: true,
                supports_image_in: true,
                supports_video_in: true,
                display_name: 'Kimi for Coding',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    const result = await harness.auth.login();
    const config = await harness.getConfig({ reload: true });

    expect(result).toMatchObject({
      providerName: KIMI_CODE_PROVIDER_NAME,
      ok: true,
      defaultModel: 'kimi-code/kimi-for-coding',
      defaultThinking: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.kimi.com/coding/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-access-token',
        }),
      }),
    );
    expect(config.defaultModel).toBe('kimi-code/kimi-for-coding');
    expect(config.models?.['kimi-code/kimi-for-coding']).toMatchObject({
      capabilities: ['thinking', 'image_in', 'video_in', 'tool_use'],
      displayName: 'Kimi for Coding',
    });
    expect(new ProviderManager({ config }).resolveProviderConfig(config.defaultModel!)).toMatchObject({
      modelCapabilities: {
        tool_use: true,
      },
    });
    expect(config.providers[KIMI_CODE_PROVIDER_NAME]).toMatchObject({
      type: 'kimi',
      apiKey: '',
      oauth: { storage: 'file', key: 'oauth/kimi-code' },
    });
    expect(config.services?.moonshotSearch?.oauth).toEqual({
      storage: 'file',
      key: 'oauth/kimi-code',
    });
  });

  it('logs in against the configured scoped OAuth host and base URL when env is absent', async () => {
    const baseUrl = 'https://api.dev.example.test/coding/v1';
    const oauthHost = 'https://auth.dev.example.test';
    const oauthKey = resolveKimiCodeOAuthKey({ oauthHost, baseUrl });
    const storageName = resolveKimiTokenStorageName({ oauthKey });
    const storage = new FileTokenStorage(join(homeDir, 'credentials'));
    await storage.save(storageName, {
      ...freshToken(),
      accessToken: 'expired-dev-access-token',
      refreshToken: 'dev-refresh-token',
      expiresAt: 1,
    });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "${baseUrl}"
api_key = ""
oauth = { storage = "file", key = "${oauthKey}", oauth_host = "${oauthHost}" }
`,
    );
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      const url = fetchInputUrl(input);
      if (url === `${oauthHost}/api/oauth/token`) {
        if (typeof init?.body !== 'string') throw new TypeError('expected form body');
        const body = new URLSearchParams(init.body);
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.get('refresh_token')).toBe('dev-refresh-token');
        return new Response(
          JSON.stringify({
            access_token: 'rotated-dev-access-token',
            refresh_token: 'rotated-dev-refresh-token',
            expires_in: 3600,
            scope: '',
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === `${baseUrl}/models`) {
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer rotated-dev-access-token',
        );
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'kimi-for-coding',
                context_length: 262144,
                supports_reasoning: true,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.login()).resolves.toMatchObject({
      providerName: KIMI_CODE_PROVIDER_NAME,
      ok: true,
      defaultModel: 'kimi-code/kimi-for-coding',
    });
    await expect(storage.load(storageName)).resolves.toMatchObject({
      accessToken: 'rotated-dev-access-token',
    });
    const config = await harness.getConfig({ reload: true });
    expect(config.providers[KIMI_CODE_PROVIDER_NAME]).toMatchObject({
      baseUrl,
      oauth: { storage: 'file', key: oauthKey, oauthHost },
    });
    expect(fetchMock.mock.calls.map((call) => fetchInputUrl(call[0]))).toEqual([
      `${oauthHost}/api/oauth/token`,
      `${baseUrl}/models`,
    ]);
  });

  it('recomputes legacy managed OAuth refs during login for non-default base URLs', async () => {
    const baseUrl = 'https://api.example.test/coding/v1';
    const oauthKey = resolveKimiCodeOAuthKey({ baseUrl });
    const scopedStorageName = resolveKimiTokenStorageName({ oauthKey });
    const storage = new FileTokenStorage(join(homeDir, 'credentials'));
    await storage.save('kimi-code', { ...freshToken(), accessToken: 'legacy-access-token' });
    await storage.save(scopedStorageName, {
      ...freshToken(),
      accessToken: 'scoped-access-token',
    });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "${baseUrl}"
api_key = ""
oauth = { storage = "file", key = "oauth/kimi-code" }
`,
    );
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe(`${baseUrl}/models`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer scoped-access-token');
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'kimi-for-coding',
              context_length: 262144,
              supports_reasoning: true,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.login()).resolves.toMatchObject({
      providerName: KIMI_CODE_PROVIDER_NAME,
      ok: true,
      defaultModel: 'kimi-code/kimi-for-coding',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const config = await harness.getConfig({ reload: true });
    expect(config.providers[KIMI_CODE_PROVIDER_NAME]).toMatchObject({
      baseUrl,
      oauth: { storage: 'file', key: oauthKey, oauthHost: 'https://auth.kimi.com' },
    });
  });

  it('logs in against environment OAuth host and base URL over persisted config', async () => {
    const configuredBaseUrl = 'https://api.configured.example.test/coding/v1';
    const envBaseUrl = 'https://api.env.example.test/coding/v1';
    const envOauthHost = 'https://auth.env.example.test';
    const configuredOauthKey = resolveKimiCodeOAuthKey({ baseUrl: configuredBaseUrl });
    const envOauthKey = resolveKimiCodeOAuthKey({ oauthHost: envOauthHost, baseUrl: envBaseUrl });
    const storage = new FileTokenStorage(join(homeDir, 'credentials'));
    await storage.save(resolveKimiTokenStorageName({ oauthKey: configuredOauthKey }), {
      ...freshToken(),
      accessToken: 'configured-access-token',
    });
    await storage.save(resolveKimiTokenStorageName({ oauthKey: envOauthKey }), {
      ...freshToken(),
      accessToken: 'env-access-token',
    });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "${configuredBaseUrl}"
api_key = ""
oauth = { storage = "file", key = "${configuredOauthKey}", oauth_host = "https://auth.kimi.com" }
`,
    );
    vi.stubEnv('KIMI_CODE_BASE_URL', envBaseUrl);
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', envOauthHost);
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe(`${envBaseUrl}/models`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer env-access-token');
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'kimi-for-coding',
              context_length: 262144,
              supports_reasoning: true,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.login()).resolves.toMatchObject({
      providerName: KIMI_CODE_PROVIDER_NAME,
      ok: true,
      defaultModel: 'kimi-code/kimi-for-coding',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const config = await harness.getConfig({ reload: true });
    expect(config.providers[KIMI_CODE_PROVIDER_NAME]).toMatchObject({
      baseUrl: envBaseUrl,
      oauth: { storage: 'file', key: envOauthKey, oauthHost: envOauthHost },
    });
  });

  it('starts degraded when a configured model alias does not have max_context_size', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
api_key = ""

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
`,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'kimi-for-coding',
                  context_length: 262144,
                  supports_reasoning: true,
                  supports_image_in: true,
                  supports_video_in: true,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    // A broken config must not prevent startup: the invalid model alias is
    // dropped, the rest of the config survives, and a warning is reported.
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    const config = await harness.getConfig();
    expect(config.models?.['kimi-code/kimi-for-coding']).toBeUndefined();
    expect(config.providers[KIMI_CODE_PROVIDER_NAME]).toBeDefined();
    const { warnings } = await harness.getConfigDiagnostics();
    expect(warnings.some((w) => w.includes('models.kimi-code/kimi-for-coding'))).toBe(true);
  });

  it('removes managed Kimi config on logout', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
api_key = ""
oauth = { storage = "file", key = "oauth/kimi-code" }

[providers.custom]
type = "kimi"
api_key = "sk-existing"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144

[models.custom-default]
provider = "custom"
model = "custom-model"
max_context_size = 1000

[services.moonshot_search]
base_url = "https://api.kimi.com/coding/v1/search"
api_key = ""
oauth = { storage = "file", key = "oauth/kimi-code" }

[services.moonshot_fetch]
base_url = "https://api.kimi.com/coding/v1/fetch"
api_key = ""
oauth = { storage = "file", key = "oauth/kimi-code" }
`,
    );

    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.logout()).resolves.toMatchObject({
      providerName: KIMI_CODE_PROVIDER_NAME,
      ok: true,
    });

    const config = await harness.getConfig({ reload: true });
    expect(config.defaultModel).toBeUndefined();
    expect(config.providers[KIMI_CODE_PROVIDER_NAME]).toBeUndefined();
    expect(config.providers['custom']).toMatchObject({ apiKey: 'sk-existing' });
    expect(config.models?.['kimi-code/kimi-for-coding']).toBeUndefined();
    expect(config.models?.['custom-default']).toMatchObject({ provider: 'custom' });
    expect(config.services?.moonshotSearch).toBeUndefined();
    expect(config.services?.moonshotFetch).toBeUndefined();
    await expect(
      new FileTokenStorage(join(homeDir, 'credentials')).load('kimi-code'),
    ).resolves.toBeUndefined();

    const text = await readFile(join(homeDir, 'config.toml'), 'utf-8');
    expect(text).not.toContain('managed:kimi-code');
    expect(text).not.toContain('kimi-code/kimi-for-coding');
    expect(text).not.toContain('moonshot_search');
  });

  it('removes the configured scoped OAuth token on logout without touching the production token', async () => {
    const oauthKey = resolveKimiCodeOAuthKey({
      oauthHost: 'https://auth.dev.example.test',
      baseUrl: 'https://api.dev.example.test/coding/v1',
    });
    const storageName = resolveKimiTokenStorageName({ oauthKey });
    const storage = new FileTokenStorage(join(homeDir, 'credentials'));
    await storage.save('kimi-code', freshToken());
    await storage.save(storageName, { ...freshToken(), accessToken: 'dev-access-token' });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.dev.example.test/coding/v1"
api_key = ""
oauth = { storage = "file", key = "${oauthKey}", oauth_host = "https://auth.dev.example.test" }

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
`,
    );
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.logout()).resolves.toMatchObject({
      providerName: KIMI_CODE_PROVIDER_NAME,
      ok: true,
    });

    await expect(storage.load(storageName)).resolves.toBeUndefined();
    await expect(storage.load('kimi-code')).resolves.toMatchObject({
      accessToken: 'oauth-access-token',
    });
  });

  it('recomputes legacy managed OAuth refs during logout for non-default base URLs', async () => {
    const baseUrl = 'https://api.example.test/coding/v1';
    const oauthKey = resolveKimiCodeOAuthKey({ baseUrl });
    const scopedStorageName = resolveKimiTokenStorageName({ oauthKey });
    const storage = new FileTokenStorage(join(homeDir, 'credentials'));
    await storage.save('kimi-code', freshToken());
    await storage.save(scopedStorageName, {
      ...freshToken(),
      accessToken: 'scoped-access-token',
    });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "${baseUrl}"
api_key = ""
oauth = { storage = "file", key = "oauth/kimi-code" }

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
`,
    );
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.logout()).resolves.toMatchObject({
      providerName: KIMI_CODE_PROVIDER_NAME,
      ok: true,
    });

    await expect(storage.load(scopedStorageName)).resolves.toBeUndefined();
    await expect(storage.load('kimi-code')).resolves.toMatchObject({
      accessToken: 'oauth-access-token',
    });
  });

  it('gets managed usage without host identity and sends only auth headers', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    const fetchMock = vi.fn<FetchMock>(
      async (_input, _init) =>
        new Response(
          JSON.stringify({
            usage: { used: 1, limit: 10, name: 'Weekly limit' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const harness = createKimiHarness({ homeDir });
    const result = await harness.auth.getManagedUsage();

    expect(result).toMatchObject({
      kind: 'ok',
      summary: { label: 'Weekly limit', used: 1, limit: 10 },
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers((init.headers ?? {}) as Record<string, string>);
    expect(headers.get('authorization')).toBe('Bearer oauth-access-token');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('user-agent')).toBeNull();
    expect(headers.get('x-msh-platform')).toBeNull();
  });

  it('uses configured scoped OAuth refs and base URLs for managed usage and feedback', async () => {
    const baseUrl = 'https://api.dev.example.test/coding/v1';
    const oauthKey = resolveKimiCodeOAuthKey({
      oauthHost: 'https://auth.dev.example.test',
      baseUrl,
    });
    const storageName = resolveKimiTokenStorageName({ oauthKey });
    await new FileTokenStorage(join(homeDir, 'credentials')).save(storageName, {
      ...freshToken(),
      accessToken: 'dev-access-token',
    });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "${baseUrl}"
api_key = ""
oauth = { storage = "file", key = "${oauthKey}", oauth_host = "https://auth.dev.example.test" }
`,
    );
    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = fetchInputUrl(input);
      if (url.endsWith('/usages')) {
        return new Response(
          JSON.stringify({ usage: { used: 2, limit: 10, name: 'Dev limit' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ feedback_id: 3 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const harness = createKimiHarness({ homeDir });

    await expect(harness.auth.getManagedUsage()).resolves.toMatchObject({
      kind: 'ok',
      summary: { label: 'Dev limit', used: 2, limit: 10 },
    });
    await expect(
      harness.auth.submitFeedback({
        content: 'dev feedback',
        sessionId: 'sess-dev',
        version: 'kimi-code-0.1.1',
        os: 'Darwin 25.3.0',
        model: 'kimi-code/kimi-for-coding',
      }),
    ).resolves.toEqual({ kind: 'ok', feedbackId: 3 });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${baseUrl}/usages`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${baseUrl}/feedback`);
    for (const call of fetchMock.mock.calls) {
      const init = call[1];
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer dev-access-token');
    }
  });

  it('uses environment managed endpoints for usage and feedback over persisted config', async () => {
    const configuredBaseUrl = 'https://api.configured.example.test/coding/v1';
    const envBaseUrl = 'https://api.env.example.test/coding/v1';
    const envOauthHost = 'https://auth.env.example.test';
    const configuredOauthKey = resolveKimiCodeOAuthKey({ baseUrl: configuredBaseUrl });
    const envOauthKey = resolveKimiCodeOAuthKey({
      oauthHost: envOauthHost,
      baseUrl: envBaseUrl,
    });
    const storage = new FileTokenStorage(join(homeDir, 'credentials'));
    await storage.save(resolveKimiTokenStorageName({ oauthKey: configuredOauthKey }), {
      ...freshToken(),
      accessToken: 'configured-access-token',
    });
    await storage.save(resolveKimiTokenStorageName({ oauthKey: envOauthKey }), {
      ...freshToken(),
      accessToken: 'env-access-token',
    });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "${configuredBaseUrl}"
api_key = ""
oauth = { storage = "file", key = "${configuredOauthKey}", oauth_host = "https://auth.kimi.com" }
`,
    );
    vi.stubEnv('KIMI_CODE_BASE_URL', envBaseUrl);
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', envOauthHost);
    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = fetchInputUrl(input);
      if (url.endsWith('/usages')) {
        return new Response(
          JSON.stringify({ usage: { used: 3, limit: 10, name: 'Env limit' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ feedback_id: 3 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const harness = createKimiHarness({ homeDir });

    await expect(harness.auth.status()).resolves.toEqual({
      providers: [{ providerName: KIMI_CODE_PROVIDER_NAME, hasToken: true }],
    });
    await expect(harness.auth.getCachedAccessToken()).resolves.toBe('env-access-token');
    await expect(
      harness.auth.resolveOAuthTokenProvider(KIMI_CODE_PROVIDER_NAME).getAccessToken(),
    ).resolves.toBe('env-access-token');
    await expect(
      harness.auth
        .resolveOAuthTokenProvider(KIMI_CODE_PROVIDER_NAME, {
          storage: 'file',
          key: configuredOauthKey,
          oauthHost: 'https://auth.kimi.com',
        })
        .getAccessToken(),
    ).resolves.toBe('env-access-token');
    await expect(harness.auth.getManagedUsage()).resolves.toMatchObject({
      kind: 'ok',
      summary: { label: 'Env limit', used: 3, limit: 10 },
    });
    await expect(
      harness.auth.submitFeedback({
        content: 'env feedback',
        sessionId: 'sess-env',
        version: 'kimi-code-0.1.1',
        os: 'Darwin 25.3.0',
        model: 'kimi-code/kimi-for-coding',
      }),
    ).resolves.toEqual({ kind: 'ok', feedbackId: 3 });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${envBaseUrl}/usages`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${envBaseUrl}/feedback`);
    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1]?.headers).get('authorization')).toBe('Bearer env-access-token');
    }
  });

  it('submitFeedback maps camelCase input to snake_case body and posts with bearer auth', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(JSON.stringify({ feedback_id: 3 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const harness = createKimiHarness({ homeDir });
    const result = await harness.auth.submitFeedback({
      content: 'great tool',
      sessionId: 'sess-42',
      version: 'kimi-code-0.1.1',
      os: 'Darwin 25.3.0',
      model: 'kimi-code/kimi-for-coding',
      contact: 'test@example.com',
      info: { codebase: { file_name: 'repo.zip' } },
    });

    expect(result).toEqual({ kind: 'ok', feedbackId: 3 });

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    const [url, init] = calls[0]!;
    expect(url).toBe('https://api.kimi.com/coding/v1/feedback');
    expect(init?.method).toBe('POST');

    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    expect(headers.get('authorization')).toBe('Bearer oauth-access-token');
    expect(headers.get('content-type')).toBe('application/json');

    expect(JSON.parse(init?.body as string)).toEqual({
      session_id: 'sess-42',
      content: 'great tool',
      version: 'kimi-code-0.1.1',
      os: 'Darwin 25.3.0',
      model: 'kimi-code/kimi-for-coding',
      contact: 'test@example.com',
      info: { codebase: { file_name: 'repo.zip' } },
    });
  });

  it('createFeedbackUploadUrl maps SDK input and returns camelCase upload parts', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(
        JSON.stringify({
          upload: {
            id: 28,
            parts: [
              {
                part_number: 1,
                url: 'https://upload.example.test/part-1',
                method: 'PUT',
                size: 1024,
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const harness = createKimiHarness({ homeDir });
    const result = await harness.auth.createFeedbackUploadUrl({
      feedbackId: 3,
      filename: 'session.zip',
      size: 1024,
      sha256: 'abc123',
    });

    expect(result).toEqual({
      kind: 'ok',
      uploadId: 28,
      parts: [
        {
          partNumber: 1,
          url: 'https://upload.example.test/part-1',
          method: 'PUT',
          size: 1024,
        },
      ],
    });

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    const [url, init] = calls[0]!;
    expect(url).toBe('https://api.kimi.com/coding/v1/feedback/upload_url');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      feedback_id: 3,
      file_name: 'session.zip',
      file_size: 1024,
      file_hash: 'abc123',
    });
  });

  it('submitFeedback surfaces HTTP errors without throwing', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    vi.stubGlobal(
      'fetch',
      vi.fn<FetchMock>(
        async () =>
          new Response(JSON.stringify({ message: 'feedback API rejected the request' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const harness = createKimiHarness({ homeDir });
    const result = await harness.auth.submitFeedback({
      content: 'x',
      sessionId: 's',
      version: 'kimi-code-0.0.0',
      os: 'Darwin 25.3.0',
      model: null,
    });

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBe(401);
    expect(result.message).toBe('feedback API rejected the request');
  });
});
