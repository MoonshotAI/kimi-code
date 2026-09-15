import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo as HttpAddress } from 'node:net';

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ILogger as Logger } from '#/_base/log/log';
import * as callbackServerModule from '#/mcpCore/oauth/callback-server';
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

import { createMemoryMcpOAuthStore, ManualMcpOAuthScheduler } from '../stubs';

const SERVER_NAME = 'notion';
const SERVER_URL = 'https://mcp.example.test/mcp';

interface Fixture {
  readonly service: McpOAuthService;
  readonly store: McpOAuthStore;
  readonly events: McpOAuthEvent[];
  readonly scheduler: ManualMcpOAuthScheduler;
}

function makeFixture(
  store: McpOAuthStore = createMemoryMcpOAuthStore(),
  options: {
    readonly authRequestTimeoutMs?: number;
    readonly shutdownDrainTimeoutMs?: number;
    readonly log?: Logger;
  } = {},
): Fixture {
  const events: McpOAuthEvent[] = [];
  const scheduler = new ManualMcpOAuthScheduler(1_000_000);
  const service = new McpOAuthService({ store, scheduler, ...options });
  service.onEvent((event) => events.push(event));
  return { service, store, events, scheduler };
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
  options: { readonly rejectRefreshToken?: boolean; readonly refreshExpiresIn?: number } = {},
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
        JSON.stringify({
          access_token: 'fresh-token',
          token_type: 'Bearer',
          expires_in: options.refreshExpiresIn ?? 3600,
        }),
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

async function startHangingServer(): Promise<{ readonly url: string; readonly counts: { requests: number } }> {
  const counts = { requests: 0 };
  const httpServer: HttpServer = createHttpServer(() => {
    counts.requests += 1;
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

interface GatedExchangeAuthServer {
  readonly url: string;
  readonly counts: { register: number; exchange: number };
  readonly exchangeStarted: Promise<void>;
  readonly releaseExchange: () => void;
}

async function startGatedExchangeAuthServer(): Promise<GatedExchangeAuthServer> {
  const counts = { register: 0, exchange: 0 };
  let signalExchangeStarted: () => void = () => undefined;
  const exchangeStarted = new Promise<void>((resolve) => {
    signalExchangeStarted = resolve;
  });
  let releaseExchange: () => void = () => undefined;
  const exchangeReleased = new Promise<void>((resolve) => {
    releaseExchange = resolve;
  });
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
      if (new URLSearchParams(body).get('grant_type') !== 'authorization_code') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
        return;
      }
      counts.exchange += 1;
      signalExchangeStarted();
      res.on('error', () => undefined);
      void exchangeReleased.then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ access_token: 'fresh-token', token_type: 'Bearer', expires_in: 3600 }),
        );
      });
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
  return { url: `http://127.0.0.1:${port}`, counts, exchangeStarted, releaseExchange };
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

async function blockedRefreshFixture(options?: {
  readonly shutdownDrainTimeoutMs?: number;
}): Promise<{
  readonly fixture: Fixture;
  readonly authServer: FakeAuthServer;
  readonly writeStarted: Promise<void>;
  readonly releaseWrite: () => void;
  readonly armMetaGate: () => void;
  readonly metaWriteStarted: Promise<void>;
  readonly releaseMetaWrite: () => void;
}> {
  const memory = createMemoryMcpOAuthStore();
  let signalWriteStarted: () => void = () => undefined;
  const writeStarted = new Promise<void>((resolve) => {
    signalWriteStarted = resolve;
  });
  let releaseWrite: () => void = () => undefined;
  const writeReleased = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let gateMeta = false;
  let signalMetaStarted: () => void = () => undefined;
  const metaWriteStarted = new Promise<void>((resolve) => {
    signalMetaStarted = resolve;
  });
  let releaseMetaWrite: () => void = () => undefined;
  const metaReleased = new Promise<void>((resolve) => {
    releaseMetaWrite = resolve;
  });
  const store: McpOAuthStore = {
    ...memory,
    async write(key: string, value: unknown): Promise<void> {
      const accessToken =
        typeof value === 'object' && value !== null
          ? (value as { readonly access_token?: unknown }).access_token
          : undefined;
      if (accessToken === 'fresh-token') {
        signalWriteStarted();
        await writeReleased;
      }
      if (gateMeta && key.endsWith(META_SUFFIX)) {
        signalMetaStarted();
        await metaReleased;
      }
      await memory.write(key, value);
    },
  };
  const fixture = makeFixture(store, options ?? {});
  cleanups.push(() => fixture.service.dispose());
  const authServer = await startFakeAuthServer({ refreshExpiresIn: 60 });
  const provider = await readyProvider(fixture);
  const state = authServerState(authServer.url);
  await provider.saveDiscoveryState(state.discovery);
  await provider.saveClientInformation(state.client);
  await provider.saveTokens({
    access_token: 'stale-access-token',
    refresh_token: 'stale-refresh-token',
    token_type: 'Bearer',
  });
  return {
    fixture,
    authServer,
    writeStarted,
    releaseWrite,
    armMetaGate: () => {
      gateMeta = true;
    },
    metaWriteStarted,
    releaseMetaWrite,
  };
}

async function metaGatedGrantFixture(): Promise<{
  readonly fixture: Fixture;
  readonly provider: McpOAuthClientProvider;
  readonly tokenUrl: string;
  readonly armMetaGate: () => void;
  readonly metaWriteStarted: Promise<void>;
  readonly releaseMetaWrite: () => void;
}> {
  const memory = createMemoryMcpOAuthStore();
  let gateMeta = false;
  let signalMetaStarted: () => void = () => undefined;
  const metaWriteStarted = new Promise<void>((resolve) => {
    signalMetaStarted = resolve;
  });
  let releaseMetaWrite: () => void = () => undefined;
  const metaReleased = new Promise<void>((resolve) => {
    releaseMetaWrite = resolve;
  });
  const store: McpOAuthStore = {
    ...memory,
    async write(key: string, value: unknown): Promise<void> {
      if (gateMeta && key.endsWith(META_SUFFIX)) {
        signalMetaStarted();
        await metaReleased;
      }
      await memory.write(key, value);
    },
  };
  const fixture = makeFixture(store);
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
  });
  return {
    fixture,
    provider,
    tokenUrl: `${authServer.url}/token`,
    armMetaGate: () => {
      gateMeta = true;
    },
    metaWriteStarted,
    releaseMetaWrite,
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

describe('McpOAuthService credential bookkeeping', () => {
  it('stamps token writes with obtained_at and a name/url meta record', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    await fixture.service
      .getProvider(SERVER_NAME, SERVER_URL)
      .saveTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 });

    const state = await fixture.service.tokenState(SERVER_NAME, SERVER_URL);
    expect(state.hasTokens).toBe(true);
    expect(state.expired).toBe(false);
    expect(state.expiresAt).toBe(4_600_000);

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

  it('keeps the meta sidecar consistent with the final tokens when save and clear race', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const provider = await readyProvider(fixture);

    await Promise.all([
      provider.saveTokens({ access_token: 'a', token_type: 'Bearer' }),
      provider.clearCredentials('tokens'),
    ]);
    expect(await provider.tokens()).toBeUndefined();
    expect(await listMetaKeys(fixture.store)).toHaveLength(0);

    await Promise.all([
      provider.clearCredentials('tokens'),
      provider.saveTokens({ access_token: 'b', token_type: 'Bearer' }),
    ]);
    expect(await provider.tokens()).toMatchObject({ access_token: 'b' });
    expect(await listMetaKeys(fixture.store)).toHaveLength(1);
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

  it('bounds a hung authorization-server request by the configured request timeout', async () => {
    const hanging = await startHangingServer();
    const fixture = makeFixture(createMemoryMcpOAuthStore(), { authRequestTimeoutMs: 50 });
    cleanups.push(() => fixture.service.dispose());
    const provider = fixture.service.getProvider(SERVER_NAME, hanging.url);
    await provider.ready;
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
    });

    await expect(fixture.service.refresh(SERVER_NAME, hanging.url)).rejects.toThrow();
    expect(hanging.counts.requests).toBeGreaterThan(0);
  });

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
  it('closes the callback listener when stale registration cleanup fails', async () => {
    const memory = createMemoryMcpOAuthStore();
    const store: McpOAuthStore = {
      ...memory,
      async remove(key: string): Promise<void> {
        if (key.endsWith('-client.json')) throw new Error('disk full');
        await memory.remove(key);
      },
    };
    const fixture = makeFixture(store);
    cleanups.push(() => fixture.service.dispose());
    const provider = await readyProvider(fixture);
    await provider.saveClientInformation({
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull);

    const callbackServer: callbackServerModule.CallbackServer = {
      redirectUri: 'http://127.0.0.1:45679/callback',
      waitForCode: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const startSpy = vi
      .spyOn(callbackServerModule, 'startCallbackServer')
      .mockResolvedValue(callbackServer);
    cleanups.push(() => startSpy.mockRestore());

    await expect(
      fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL),
    ).rejects.toThrow(/failed to start OAuth flow/);
    expect(callbackServer.close).toHaveBeenCalledOnce();
  });

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

  it('serializes an interactive flow behind a refresh whose token read is in flight', async () => {
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

    let began = false;
    const begin = fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL).then((flow) => {
      began = true;
      return flow;
    });
    await Promise.resolve();
    expect(began).toBe(false);

    releaseTokensRead();
    await expect(refresh).rejects.toThrow(/requires an interactive login/);
    expect(authServer.counts.refresh).toBe(1);

    const flow = await begin;
    const complete = flow.complete({ timeoutMs: 10_000 });
    await deliverCallback(flow);
    await complete;
    expect(authServer.counts.exchange).toBe(1);
    expect((await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).hasTokens).toBe(true);
  }, 15000);

  it('waits for an in-flight refresh before starting an interactive flow', async () => {
    const { fixture, authServer, writeStarted, releaseWrite } = await blockedRefreshFixture();
    cleanups.push(() => {
      releaseWrite();
    });
    const provider = await readyProvider(fixture);
    const resetFlow = vi.spyOn(provider, 'resetFlow');

    const refresh = fixture.service.refresh(SERVER_NAME, SERVER_URL);
    await writeStarted;
    const resetCountDuringRefresh = resetFlow.mock.calls.length;

    const begin = fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    await Promise.resolve();
    expect(resetFlow).toHaveBeenCalledTimes(resetCountDuringRefresh);

    releaseWrite();
    await refresh;
    await expect(begin).rejects.toBeInstanceOf(AlreadyAuthorizedError);
    expect(resetFlow.mock.calls.length).toBeGreaterThan(resetCountDuringRefresh);
    expect(authServer.counts.exchange).toBe(0);
  }, 15000);

  it('keeps the shared flow active when a joined handle cancels, so the first handle completes', async () => {
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

  it('keeps the shared flow active when the first handle cancels, so a joined handle completes', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);

    const first = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    const second = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    await first.cancel();

    const secondComplete = second.complete({ timeoutMs: 10_000 });
    await deliverCallback(second);
    await secondComplete;
    expect(authServer.counts.exchange).toBe(1);
    expect((await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).hasTokens).toBe(true);
  }, 15000);

  it('closes the shared flow when its final handle cancels, so the next begin starts fresh', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);

    const first = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    const second = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    await first.cancel();
    await second.cancel();

    const third = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    expect(third.authorizationUrl.toString()).not.toBe(first.authorizationUrl.toString());
    await third.cancel();
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
    const tokensSavedBefore = fixture.events.filter((event) => event.type === 'tokens-saved').length;

    await expect(
      fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL),
    ).rejects.toBeInstanceOf(AlreadyAuthorizedError);
    await expect(
      fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL),
    ).rejects.toBeInstanceOf(AlreadyAuthorizedError);
    expect(authServer.counts.refresh).toBe(2);
    expect(fixture.events.filter((event) => event.type === 'tokens-saved')).toHaveLength(
      tokensSavedBefore + 2,
    );
  }, 15000);

  it('bounds a hanging protected-resource-metadata request during completion', async () => {
    const hanging = await startHangingServer();
    const authServer = await startFakeAuthServer();
    const fixture = makeFixture(createMemoryMcpOAuthStore(), { authRequestTimeoutMs: 50 });
    cleanups.push(() => fixture.service.dispose());
    const provider = fixture.service.getProvider(SERVER_NAME, hanging.url);
    await provider.ready;
    const state = authServerState(authServer.url);
    await provider.saveDiscoveryState(state.discovery);
    await provider.saveClientInformation(state.client);

    const flow = await fixture.service.beginAuthorization(SERVER_NAME, hanging.url);
    const complete = flow.complete({ timeoutMs: 10_000 });
    await deliverCallback(flow);
    await complete;

    expect(hanging.counts.requests).toBeGreaterThan(0);
    expect(authServer.counts.exchange).toBe(1);
    expect((await fixture.service.tokenState(SERVER_NAME, hanging.url)).hasTokens).toBe(true);
  }, 15000);

  it('rejects completion without writing tokens when the caller aborts after the callback', async () => {
    const gated = await startGatedExchangeAuthServer();
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    cleanups.push(() => gated.releaseExchange());
    const provider = fixture.service.getProvider(SERVER_NAME, gated.url);
    await provider.ready;
    const state = authServerState(gated.url);
    await provider.saveDiscoveryState(state.discovery);
    await provider.saveClientInformation(state.client);

    const flow = await fixture.service.beginAuthorization(SERVER_NAME, gated.url);
    const controller = new AbortController();
    const complete = flow.complete({ signal: controller.signal, timeoutMs: 10_000 });
    await deliverCallback(flow);
    await gated.exchangeStarted;

    controller.abort();
    await expect(complete).rejects.toThrow(/OAuth flow for "notion" failed/);
    expect(gated.counts.exchange).toBe(1);
    expect((await fixture.service.tokenState(SERVER_NAME, gated.url)).hasTokens).toBe(false);
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
      obtained_at: fixture.scheduler.now(),
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
    await fixture.scheduler.advanceBy(30_000);
    expect(authServer.counts.refresh).toBe(1);
  }, 15000);
});

describe('McpOAuthService proactive refresh scheduling', () => {
  it('delays a 60-second grant refresh until its midpoint', async () => {
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

    await fixture.scheduler.advanceBy(29_999);
    expect(authServer.counts.refresh).toBe(0);

    await fixture.scheduler.advanceBy(1);
    expect(authServer.counts.refresh).toBe(1);
    expect(fixture.events.filter((event) => event.type === 'tokens-saved')).toHaveLength(2);
  }, 15000);

  it('waits another midpoint after refreshing into another 60-second grant', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer({ refreshExpiresIn: 60 });

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

    await fixture.scheduler.advanceBy(30_000);
    expect(authServer.counts.refresh).toBe(1);
    expect((await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).hasRefreshToken).toBe(true);

    await fixture.scheduler.advanceBy(0);
    expect(authServer.counts.refresh).toBe(1);

    await fixture.scheduler.advanceBy(30_000);
    expect(authServer.counts.refresh).toBe(2);
  }, 15000);

  it('re-arms scheduling for expiries beyond the setTimeout limit', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
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

    await fixture.scheduler.advanceBy(maxTimerDelayMs);
    expect(refreshSpy).not.toHaveBeenCalled();

    await fixture.scheduler.advanceBy(expiresAt - fixture.scheduler.now() - 120_000);
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
    cleanups.push(() => fixture.service.dispose());
    const refreshSpy = vi.spyOn(fixture.service, 'refresh');

    await fixture.service.getProvider(SERVER_NAME, SERVER_URL).saveTokens({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: -60,
    });

    await fixture.scheduler.advanceBy(10_000);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('does not schedule an expiring grant without a refresh token', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const refreshSpy = vi.spyOn(fixture.service, 'refresh');

    await fixture.service.getProvider(SERVER_NAME, SERVER_URL).saveTokens({
      access_token: 'a',
      token_type: 'Bearer',
      expires_in: 60,
    });

    await fixture.scheduler.advanceBy(60_000);
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(fixture.events.some((event) => event.type === 'refresh-failed')).toBe(false);
  });
});

describe('McpOAuthService shutdown', () => {
  it('keeps shutdown pending while a token refresh is in flight', async () => {
    const { fixture, writeStarted, releaseWrite } = await blockedRefreshFixture();
    const refresh = fixture.service.refresh(SERVER_NAME, SERVER_URL);
    await writeStarted;

    const shutdown = fixture.service.shutdown();
    let shutdownSettled = false;
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    const pendingWhileRefreshInFlight = !shutdownSettled;

    releaseWrite();
    await Promise.all([refresh, shutdown]);
    expect(pendingWhileRefreshInFlight).toBe(true);
  }, 15000);

  it('caps the shutdown drain when an in-flight refresh outlives the drain timeout', async () => {
    const { fixture, writeStarted, releaseWrite } = await blockedRefreshFixture({
      shutdownDrainTimeoutMs: 50,
    });
    const refresh = fixture.service.refresh(SERVER_NAME, SERVER_URL);
    await writeStarted;

    const shutdown = fixture.service.shutdown();
    await fixture.scheduler.advanceBy(60);
    const settledBeforeRelease = await Promise.race([
      shutdown.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    releaseWrite();
    await Promise.all([refresh, shutdown]);

    expect(settledBeforeRelease).toBe(true);
  }, 15000);

  it('prevents a completing refresh from scheduling work after shutdown', async () => {
    const { fixture, authServer, writeStarted, releaseWrite } = await blockedRefreshFixture();
    const refresh = fixture.service.refresh(SERVER_NAME, SERVER_URL);
    await writeStarted;

    const shutdown = fixture.service.shutdown();
    releaseWrite();
    await Promise.all([refresh, shutdown]);
    await fixture.scheduler.advanceBy(30_000);

    expect(authServer.counts.refresh).toBe(1);
  }, 15000);

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
    cleanups.push(() => fixture.service.dispose());

    await fixture.service.getProvider(SERVER_NAME, SERVER_URL).saveTokens({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const refreshSpy = vi.spyOn(fixture.service, 'refresh');

    await fixture.service.shutdown();
    await fixture.scheduler.advanceBy(3600_000);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('waits for an in-flight transport-driven grant before completing shutdown', async () => {
    const {
      fixture,
      authServer,
      writeStarted,
      releaseWrite,
      armMetaGate,
      metaWriteStarted,
      releaseMetaWrite,
    } = await blockedRefreshFixture();
    cleanups.push(() => {
      releaseWrite();
      releaseMetaWrite();
    });
    const provider = fixture.service.getProvider(SERVER_NAME, SERVER_URL);

    const grant = provider.createOAuthFetch()(`${authServer.url}/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'stale-refresh-token',
      }),
    });
    await writeStarted;
    armMetaGate();
    const save = provider.saveTokens({
      access_token: 'fresh-token',
      token_type: 'Bearer',
      expires_in: 60,
    });

    const shutdown = fixture.service.shutdown();
    let shutdownSettled = false;
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const pendingWhileGrantInFlight = !shutdownSettled;

    releaseWrite();
    const response = await grant;
    await metaWriteStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const pendingWhileMetaWriteInFlight = !shutdownSettled;

    releaseMetaWrite();
    await save;
    await shutdown;

    expect(response.status).toBe(200);
    expect(pendingWhileGrantInFlight).toBe(true);
    expect(pendingWhileMetaWriteInFlight).toBe(true);
  }, 15000);

  it('drains an SDK save continuation that starts after shutdown began', async () => {
    const {
      fixture,
      provider,
      tokenUrl,
      armMetaGate,
      metaWriteStarted,
      releaseMetaWrite,
    } = await metaGatedGrantFixture();
    cleanups.push(() => {
      releaseMetaWrite();
    });

    const grant = provider.createOAuthFetch()(tokenUrl, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'stale-refresh-token',
      }),
    });
    const response = await grant;
    armMetaGate();

    const shutdown = fixture.service.shutdown();
    let shutdownSettled = false;
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    const save = (async () =>
      provider.saveTokens((await response.json()) as Parameters<typeof provider.saveTokens>[0]))();

    await metaWriteStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const pendingWhileMetaWriteInFlight = !shutdownSettled;

    releaseMetaWrite();
    await save;
    await shutdown;

    expect(response.status).toBe(200);
    expect(pendingWhileMetaWriteInFlight).toBe(true);
    expect(await listMetaKeys(fixture.store)).toHaveLength(1);
  }, 15000);

  it('aborts a hung begin on shutdown and closes the callback listener', async () => {
    const hanging = await startHangingServer();
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    const callbackServer: callbackServerModule.CallbackServer = {
      redirectUri: 'http://127.0.0.1:45679/callback',
      waitForCode: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const startSpy = vi
      .spyOn(callbackServerModule, 'startCallbackServer')
      .mockResolvedValue(callbackServer);
    cleanups.push(() => startSpy.mockRestore());

    const begin = fixture.service.beginAuthorization(SERVER_NAME, hanging.url);
    await vi.waitFor(() => {
      expect(hanging.counts.requests).toBeGreaterThan(0);
    });

    const beginRejected = expect(begin).rejects.toThrow(/failed to start OAuth flow/);
    await fixture.service.shutdown();

    await beginRejected;
    expect(callbackServer.close).toHaveBeenCalled();
  }, 15000);

  it('writes no tokens when shutdown aborts an in-flight code exchange', async () => {
    const gated = await startGatedExchangeAuthServer();
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    cleanups.push(() => gated.releaseExchange());
    const provider = fixture.service.getProvider(SERVER_NAME, gated.url);
    await provider.ready;
    const state = authServerState(gated.url);
    await provider.saveDiscoveryState(state.discovery);
    await provider.saveClientInformation(state.client);

    const flow = await fixture.service.beginAuthorization(SERVER_NAME, gated.url);
    const complete = flow.complete({ timeoutMs: 10_000 });
    await deliverCallback(flow);
    await gated.exchangeStarted;

    const shutdown = fixture.service.shutdown();
    await expect(complete).rejects.toThrow(/OAuth flow for "notion" failed/);
    await shutdown;

    expect((await fixture.service.tokenState(SERVER_NAME, gated.url)).hasTokens).toBe(false);
    expect(fixture.events.filter((event) => event.type === 'tokens-saved')).toHaveLength(0);
  }, 15000);

  it('does not log a drain timeout after a clean shutdown settles', async () => {
    const warnings: string[] = [];
    const log: Logger = {
      error: () => {},
      warn: (message) => {
        warnings.push(message);
      },
      info: () => {},
      debug: () => {},
      child: () => log,
    };
    const fixture = makeFixture(createMemoryMcpOAuthStore(), {
      shutdownDrainTimeoutMs: 50,
      log,
    });
    cleanups.push(() => fixture.service.dispose());

    await fixture.service.shutdown();
    await fixture.scheduler.advanceBy(1_000);

    expect(warnings).toHaveLength(0);
  });
});
