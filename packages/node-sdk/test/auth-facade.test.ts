import { mkdirSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileTokenStorage, KIMI_CODE_PROVIDER_NAME, type TokenInfo } from '@moonshot-ai/kimi-code-oauth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KimiHarness } from '#/index';

import { resolveRuntimeProviderWithOAuth } from '../../agent-core/src/providers/runtime-provider';
import { TEST_IDENTITY } from './test-identity';

let homeDir: string;

type FetchMock = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

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

beforeEach(() => {
  homeDir = join(tmpdir(), `kimi-sdk-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(homeDir, { recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(homeDir, { recursive: true, force: true });
});

describe('KimiHarness.auth', () => {
  it('can construct auth facade without host identity', () => {
    expect(() => new KimiHarness({ homeDir })).not.toThrow();
  });

  it('exposes a cached access token without refreshing auth state', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    const harness = new KimiHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.getCachedAccessToken()).resolves.toBe('oauth-access-token');
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

    const harness = new KimiHarness({ homeDir, identity: TEST_IDENTITY });
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
    await expect(
      resolveRuntimeProviderWithOAuth({
        config,
        resolveOAuthTokenProvider: () => ({
          getAccessToken: vi.fn().mockResolvedValue('fresh-oauth-token'),
        }),
      }),
    ).resolves.toMatchObject({
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

  it('fails clearly when a configured model alias does not have max_context_size', async () => {
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

    expect(() => new KimiHarness({ homeDir, identity: TEST_IDENTITY })).toThrow(
      /Model "kimi-code\/kimi-for-coding" must define a positive max_context_size/,
    );
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

    const harness = new KimiHarness({ homeDir, identity: TEST_IDENTITY });

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

    const harness = new KimiHarness({ homeDir });
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

  it('submitFeedback maps camelCase input to snake_case body and posts with bearer auth', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    const fetchMock = vi.fn<FetchMock>(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const harness = new KimiHarness({ homeDir });
    const result = await harness.auth.submitFeedback({
      content: 'great tool',
      sessionId: 'sess-42',
      version: 'kimi-code-0.1.1',
      os: 'Darwin 25.3.0',
      model: 'kimi-code/kimi-for-coding',
    });

    expect(result).toEqual({ kind: 'ok' });

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

    const harness = new KimiHarness({ homeDir });
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
