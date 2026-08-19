import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo as HttpAddress } from 'node:net';

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  META_SUFFIX,
  type McpOAuthClientProvider,
  type McpOAuthStoreMeta,
} from '#/mcpCore/oauth/provider';
import {
  AlreadyAuthorizedError,
  McpOAuthService,
  type BeginAuthorizationResult,
  type McpOAuthEvent,
} from '#/mcpCore/oauth/service';
import { mcpOAuthStoreKey, type McpOAuthStore } from '#/mcpCore/oauth/store';

import { createMemoryMcpOAuthStore } from '../stubs';

const SERVER_NAME = 'notion';
const SERVER_URL = 'https://mcp.example.test/mcp';

interface Fixture {
  readonly service: McpOAuthService;
  readonly store: McpOAuthStore;
  readonly events: McpOAuthEvent[];
}

function makeFixture(store: McpOAuthStore = createMemoryMcpOAuthStore()): Fixture {
  const events: McpOAuthEvent[] = [];
  const service = new McpOAuthService({ store });
  service.onEvent((event) => events.push(event));
  return { service, store, events };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function listMetaKeys(store: McpOAuthStore): Promise<readonly string[]> {
  return (await store.list()).filter((key) => key.endsWith(META_SUFFIX));
}

async function readyProvider(fixture: Fixture): Promise<McpOAuthClientProvider> {
  const provider = fixture.service.getProvider(SERVER_NAME, SERVER_URL);
  await provider.ready;
  return provider;
}

interface FakeAuthServer {
  readonly url: string;
  readonly counts: { register: number; exchange: number; refresh: number };
}

async function startFakeAuthServer(
  options: { readonly rejectRefreshToken?: boolean } = {},
): Promise<FakeAuthServer> {
  const counts = { register: 0, exchange: 0, refresh: 0 };
  const httpServer: HttpServer = createHttpServer((req, res) => {
    if (req.method !== 'POST' || (req.url !== '/token' && req.url !== '/register')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      if (req.url === '/register') {
        counts.register += 1;
        const metadata = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...metadata, client_id: `test-client-${counts.register}` }));
        return;
      }
      const grantType = new URLSearchParams(body).get('grant_type');
      if (grantType === 'authorization_code') counts.exchange += 1;
      if (grantType === 'refresh_token') {
        counts.refresh += 1;
        if (options.rejectRefreshToken === true) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ access_token: 'fresh-token', token_type: 'Bearer', expires_in: 3600 }),
      );
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  );
  const port = (httpServer.address() as HttpAddress).port;
  return { url: `http://127.0.0.1:${port}`, counts };
}

function authServerState(authServerUrl: string) {
  return {
    discovery: {
      authorizationServerUrl: authServerUrl,
      authorizationServerMetadata: {
        issuer: authServerUrl,
        authorization_endpoint: `${authServerUrl}/authorize`,
        token_endpoint: `${authServerUrl}/token`,
        registration_endpoint: `${authServerUrl}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      },
    },
    client: {
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull,
  };
}

async function deliverCallback(flow: BeginAuthorizationResult): Promise<void> {
  const redirectUri = flow.authorizationUrl.searchParams.get('redirect_uri');
  const state = flow.authorizationUrl.searchParams.get('state');
  expect(redirectUri).toBeTruthy();
  const callbackUrl = new URL(redirectUri!);
  callbackUrl.searchParams.set('code', 'test-auth-code');
  if (state !== null) callbackUrl.searchParams.set('state', state);
  const response = await fetch(callbackUrl);
  expect(response.status).toBe(200);
  await response.text();
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('McpOAuthService credential bookkeeping', () => {
  it('stamps token writes with obtained_at and a name/url meta record', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    const before = Date.now();
    await fixture.service
      .getProvider(SERVER_NAME, SERVER_URL)
      .saveTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 });

    const state = await fixture.service.tokenState(SERVER_NAME, SERVER_URL);
    expect(state.hasTokens).toBe(true);
    expect(state.expired).toBe(false);
    expect(state.expiresAt).toBeDefined();
    expect(state.expiresAt!).toBeGreaterThanOrEqual(before + 3600_000);
    expect(state.expiresAt!).toBeLessThanOrEqual(Date.now() + 3600_000);

    const metaFiles = await listMetaKeys(fixture.store);
    expect(metaFiles).toHaveLength(1);
    expect(await fixture.store.read<McpOAuthStoreMeta>(metaFiles[0]!)).toEqual({
      serverName: SERVER_NAME,
      serverUrl: SERVER_URL,
    });

    expect(fixture.events).toEqual([
      { type: 'tokens-saved', serverName: SERVER_NAME, serverUrl: SERVER_URL },
    ]);
  });

  it('treats tokens without expiry data as non-expiring', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    expect(await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).toEqual({
      hasTokens: false,
      hasRefreshToken: false,
      expired: false,
    });

    await fixture.service
      .getProvider(SERVER_NAME, SERVER_URL)
      .saveTokens({ access_token: 'a', token_type: 'Bearer' });
    expect(await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).toMatchObject({
      hasTokens: true,
      expired: false,
      expiresAt: undefined,
    });
  });

  it('treats a grant saved with a negative expires_in as expired', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    await fixture.service.getProvider(SERVER_NAME, SERVER_URL).saveTokens({
      access_token: 'a',
      token_type: 'Bearer',
      expires_in: -60,
    });
    expect(await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).toMatchObject({
      hasTokens: true,
      hasRefreshToken: false,
      expired: true,
    });
  });

  it('emits tokens-invalidated and drops the meta record when credentials are cleared', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    await fixture.service
      .getProvider(SERVER_NAME, SERVER_URL)
      .saveTokens({ access_token: 'a', token_type: 'Bearer' });
    expect(await listMetaKeys(fixture.store)).toHaveLength(1);

    await fixture.service.invalidate(SERVER_NAME, SERVER_URL, 'tokens');
    expect((await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).hasTokens).toBe(false);
    expect(await listMetaKeys(fixture.store)).toHaveLength(0);
    expect(fixture.events).toContainEqual({
      type: 'tokens-invalidated',
      serverName: SERVER_NAME,
      serverUrl: SERVER_URL,
      scope: 'tokens',
    });
  });
});

describe('McpOAuthService single-flight refresh', () => {
  it('shares one in-flight refresh across concurrent callers', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    let tokenRequests = 0;
    const httpServer: HttpServer = createHttpServer((req, res) => {
      if (req.url === '/token' && req.method === 'POST') {
        tokenRequests += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ access_token: 'fresh-token', token_type: 'Bearer', expires_in: 3600 }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          httpServer.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        }),
    );
    const port = (httpServer.address() as HttpAddress).port;
    const authServerUrl = `http://127.0.0.1:${port}`;

    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState({
      authorizationServerUrl: authServerUrl,
      authorizationServerMetadata: {
        issuer: authServerUrl,
        authorization_endpoint: `${authServerUrl}/authorize`,
        token_endpoint: `${authServerUrl}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      },
    });
    await provider.saveClientInformation({
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull);
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
    });

    await Promise.all([
      fixture.service.refresh(SERVER_NAME, SERVER_URL),
      fixture.service.refresh(SERVER_NAME, SERVER_URL),
    ]);
    expect(tokenRequests).toBe(1);
    expect(await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).toMatchObject({
      hasTokens: true,
      expired: false,
    });
    expect(fixture.events.filter((event) => event.type === 'tokens-saved')).toHaveLength(2);
  }, 15000);

  it('rejects when no refresh token is stored', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    await expect(fixture.service.refresh(SERVER_NAME, SERVER_URL)).rejects.toThrow(
      /no refreshable OAuth grant/,
    );
  });

  it('routes the token request through the credential-serialized fetch', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);
    await provider.saveClientInformation({
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull);
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
    });

    const fetchSpy = vi.spyOn(provider, 'createOAuthFetch');
    await fixture.service.refresh(SERVER_NAME, SERVER_URL);
    expect(fetchSpy).toHaveBeenCalled();
    expect(authServer.counts.refresh).toBe(1);
  }, 15000);

  it('emits tokens-invalidated when the SDK invalidates a rejected refresh grant', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer({ rejectRefreshToken: true });
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);
    await provider.saveClientInformation(authServerState(authServer.url).client);
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
    });

    await expect(fixture.service.refresh(SERVER_NAME, SERVER_URL)).rejects.toThrow(
      /requires an interactive login/,
    );
    expect((await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).hasTokens).toBe(false);
    expect(fixture.events).toContainEqual({
      type: 'tokens-invalidated',
      serverName: SERVER_NAME,
      serverUrl: SERVER_URL,
      scope: 'tokens',
    });
  }, 15000);

  it('does not resurrect tokens cleared between a grant fetch and the SDK save', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    const grant = {
      access_token: 'rotated-access',
      refresh_token: 'rotated-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
    };
    const httpServer: HttpServer = createHttpServer((req, res) => {
      if (req.url === '/token' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(grant));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          httpServer.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        }),
    );
    const authServerUrl = `http://127.0.0.1:${(httpServer.address() as HttpAddress).port}`;

    const provider = await readyProvider(fixture);
    const state = authServerState(authServerUrl);
    await provider.saveDiscoveryState(state.discovery);
    await provider.saveClientInformation(state.client);
    await provider.saveTokens({
      access_token: 'seed-access',
      refresh_token: 'seed-refresh',
      token_type: 'Bearer',
    });

    const res = await provider.createOAuthFetch()(`${authServerUrl}/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'seed-refresh' }),
    });
    const granted = (await res.json()) as Parameters<typeof provider.saveTokens>[0];

    await provider.clearCredentials('all');
    expect(await provider.tokens()).toBeUndefined();

    await provider.saveTokens(granted);
    expect(await provider.tokens()).toBeUndefined();
  }, 15000);
});

describe('McpOAuthService interactive flow serialization', () => {
  it('joins a concurrent flow for the same credential instead of resetting PKCE state', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);

    const first = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    const second = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL, {
      clientLabel: 'other-client',
    });
    expect(second.authorizationUrl.toString()).toBe(first.authorizationUrl.toString());

    const firstComplete = first.complete({ timeoutMs: 10_000 });
    await deliverCallback(first);
    await firstComplete;
    await second.complete();
    expect(authServer.counts.exchange).toBe(1);
    expect((await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).hasTokens).toBe(true);
  }, 15000);

  it('skips a refresh that fires while an interactive flow owns the credential', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer({ rejectRefreshToken: true });
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    const flow = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    const complete = flow.complete({ timeoutMs: 10_000 });
    await expect(fixture.service.refresh(SERVER_NAME, SERVER_URL)).resolves.toBeUndefined();
    await deliverCallback(flow);
    await complete;
    expect(authServer.counts.exchange).toBe(1);
    expect((await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).hasTokens).toBe(true);
  }, 15000);

  it('skips a refresh whose token read straddles the start of an interactive flow', async () => {
    const memory = createMemoryMcpOAuthStore();
    let releaseTokensRead: () => void = () => undefined;
    const tokensReadGate = new Promise<void>((resolve) => {
      releaseTokensRead = resolve;
    });
    let signalReadHeld: () => void = () => undefined;
    const tokensReadHeld = new Promise<void>((resolve) => {
      signalReadHeld = resolve;
    });
    let gateArmed = false;
    const store: McpOAuthStore = {
      ...memory,
      async read<T>(key: string): Promise<T | undefined> {
        if (gateArmed && key.endsWith('-tokens.json')) {
          gateArmed = false;
          signalReadHeld();
          await tokensReadGate;
        }
        return memory.read<T>(key);
      },
    };
    const fixture = makeFixture(store);
    cleanups.push(() => fixture.service.dispose());
    cleanups.push(() => releaseTokensRead());
    const authServer = await startFakeAuthServer({ rejectRefreshToken: true });
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);
    await provider.saveClientInformation(authServerState(authServer.url).client);
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    gateArmed = true;
    const refresh = fixture.service.refresh(SERVER_NAME, SERVER_URL);
    await tokensReadHeld;

    const flow = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    const complete = flow.complete({ timeoutMs: 10_000 });
    expect(authServer.counts.refresh).toBe(1);

    releaseTokensRead();
    await expect(refresh).resolves.toBeUndefined();
    expect(authServer.counts.refresh).toBe(1);

    await deliverCallback(flow);
    await complete;
    expect(authServer.counts.exchange).toBe(1);
    expect((await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).hasTokens).toBe(true);
  }, 15000);

  it('lets only the initiating handle cancel the shared flow', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);

    const first = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    const second = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);

    await second.cancel();
    await expect(second.complete()).rejects.toThrow(/already completed or cancelled/);

    const firstComplete = first.complete({ timeoutMs: 10_000 });
    await deliverCallback(first);
    await firstComplete;
    expect(authServer.counts.exchange).toBe(1);
  }, 15000);

  it('rejects joiners when the initiator cancels, then allows a fresh flow', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);

    const first = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    const second = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    await first.cancel();
    await expect(second.complete()).rejects.toThrow(/already completed or cancelled/);

    const third = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    expect(third.authorizationUrl.toString()).not.toBe(first.authorizationUrl.toString());
    const thirdComplete = third.complete({ timeoutMs: 10_000 });
    await deliverCallback(third);
    await thirdComplete;
    expect(authServer.counts.exchange).toBe(1);
    expect((await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).hasTokens).toBe(true);
  }, 15000);

  it('leaves no shared flow behind when begin reports already-authorized', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
    });

    await expect(
      fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL),
    ).rejects.toBeInstanceOf(AlreadyAuthorizedError);
    await expect(
      fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL),
    ).rejects.toBeInstanceOf(AlreadyAuthorizedError);
    expect(authServer.counts.refresh).toBe(2);
  }, 15000);
});

describe('McpOAuthService sweepProactiveRefresh resilience', () => {
  it('skips malformed meta sidecars and still schedules the valid credential', async () => {
    const memory = createMemoryMcpOAuthStore();
    const store: McpOAuthStore = {
      ...memory,
      async read<T>(key: string): Promise<T | undefined> {
        if (key === 'corrupt-meta.json') return undefined;
        return memory.read<T>(key);
      },
    };
    const fixture = makeFixture(store);
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();

    const state = authServerState(authServer.url);
    const storeKey = mcpOAuthStoreKey(SERVER_NAME, SERVER_URL);
    await fixture.store.write(`${storeKey}-discovery.json`, state.discovery);
    await fixture.store.write(`${storeKey}-client.json`, state.client);
    await fixture.store.write(`${storeKey}-tokens.json`, {
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
      expires_in: 60,
      obtained_at: Date.now(),
    });
    await fixture.store.write(`${storeKey}-meta.json`, {
      serverName: SERVER_NAME,
      serverUrl: SERVER_URL,
    } satisfies McpOAuthStoreMeta);

    await fixture.store.write('broken-empty-meta.json', {});
    await fixture.store.write('broken-types-meta.json', { serverName: 1, serverUrl: 42 });
    await fixture.store.write('broken-url-meta.json', { serverName: 'x', serverUrl: 'not a url' });
    await fixture.store.write('corrupt-meta.json', '{not json');

    await expect(fixture.service.sweepProactiveRefresh()).resolves.toBeUndefined();
    await waitFor(
      () => authServer.counts.refresh === 1,
      'the swept credential to refresh immediately',
    );
  }, 15000);
});

describe('McpOAuthService proactive refresh scheduling', () => {
  it('refreshes immediately when a stored grant is already inside the refresh window', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();

    const provider = await readyProvider(fixture);
    const state = authServerState(authServer.url);
    await provider.saveDiscoveryState(state.discovery);
    await provider.saveClientInformation(state.client);
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
      expires_in: 60,
    });

    await waitFor(() => authServer.counts.refresh === 1, 'an immediate proactive refresh');
    expect(fixture.events.filter((event) => event.type === 'tokens-saved')).toHaveLength(2);
  }, 15000);

  it('re-arms scheduling for expiries beyond the setTimeout limit', async () => {
    const fixture = makeFixture();
    cleanups.push(() => {
      vi.useRealTimers();
    });
    cleanups.push(() => fixture.service.dispose());
    vi.useFakeTimers();
    const maxTimerDelayMs = 0x7fffffff;
    const refreshSpy = vi
      .spyOn(fixture.service, 'refresh')
      .mockRejectedValue(new Error('refresh unavailable in test'));

    await fixture.service.getProvider(SERVER_NAME, SERVER_URL).saveTokens({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: Math.ceil(maxTimerDelayMs / 1000) + 600,
    });
    const expiresAt = (await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).expiresAt!;

    await vi.advanceTimersByTimeAsync(maxTimerDelayMs);
    expect(refreshSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(expiresAt - Date.now() - 120_000);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(fixture.events).toContainEqual({
      type: 'refresh-failed',
      serverName: SERVER_NAME,
      serverUrl: SERVER_URL,
      error: 'refresh unavailable in test',
    });
  });

  it('does not proactively refresh an already-expired grant', async () => {
    const fixture = makeFixture();
    cleanups.push(() => {
      vi.useRealTimers();
    });
    cleanups.push(() => fixture.service.dispose());
    vi.useFakeTimers();
    const refreshSpy = vi.spyOn(fixture.service, 'refresh');

    await fixture.service.getProvider(SERVER_NAME, SERVER_URL).saveTokens({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: -60,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe('McpOAuthService shutdown', () => {
  it('cancels active flows on shutdown', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);

    const flow = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);

    await fixture.service.shutdown();

    await expect(flow.complete()).rejects.toThrow(/already completed or cancelled/);
  }, 15000);

  it('clears event listeners and cached providers on shutdown', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const providerBefore = fixture.service.getProvider(SERVER_NAME, SERVER_URL);

    await fixture.service.shutdown();

    const eventCount = fixture.events.length;
    await fixture.service
      .getProvider(SERVER_NAME, SERVER_URL)
      .saveTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 });
    expect(fixture.events).toHaveLength(eventCount);

    expect(fixture.service.getProvider(SERVER_NAME, SERVER_URL)).not.toBe(providerBefore);
  });

  it('is idempotent across repeated shutdown calls', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    await fixture.service.shutdown();
    await expect(fixture.service.shutdown()).resolves.toBeUndefined();
  });

  it('clears pending proactive-refresh timers', async () => {
    const fixture = makeFixture();
    cleanups.push(() => {
      vi.useRealTimers();
    });
    cleanups.push(() => fixture.service.dispose());
    vi.useFakeTimers();

    await fixture.service.getProvider(SERVER_NAME, SERVER_URL).saveTokens({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const refreshSpy = vi.spyOn(fixture.service, 'refresh');

    await fixture.service.shutdown();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
