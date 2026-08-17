import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { McpOAuthClientProvider, McpOAuthService } from '../../src/mcp/oauth';
import { JsonFileStore, sanitizeStoreKey } from '../../src/mcp/oauth/store';

describe('sanitizeStoreKey', () => {
  it('strips path traversal segments', () => {
    expect(sanitizeStoreKey('../../etc/passwd')).toBe('passwd');
    expect(sanitizeStoreKey('a/b/c')).toBe('c');
  });

  it('replaces unsafe characters with underscores and collapses runs', () => {
    expect(sanitizeStoreKey('My Server!Name')).toBe('My_Server_Name');
  });

  it('rejects names that collapse to empty', () => {
    expect(() => sanitizeStoreKey('')).toThrow(/Invalid/);
  });

  it('rewrites a leading dot into a safe underscore-prefixed name', () => {
    expect(sanitizeStoreKey('.dot')).toBe('_dot');
  });
});

describe('JsonFileStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-mcp-oauth-store-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips JSON data via the named file', () => {
    const store = new JsonFileStore(dir);
    store.write('foo.json', { hello: 'world' });
    expect(store.read('foo.json')).toEqual({ hello: 'world' });
  });

  it('returns undefined when a file is missing or unreadable JSON', () => {
    const store = new JsonFileStore(dir);
    expect(store.read('missing.json')).toBeUndefined();
  });

  it('writes files with 0600 permissions on POSIX', async () => {
    if (process.platform === 'win32') return; // file modes unreliable on Windows
    const store = new JsonFileStore(dir);
    store.write('secret.json', { token: 'abc' });
    const info = await stat(join(dir, 'secret.json'));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('removes existing files without throwing on already-missing files', () => {
    const store = new JsonFileStore(dir);
    store.write('keep.json', { a: 1 });
    expect(store.read('keep.json')).toEqual({ a: 1 });
    store.remove('keep.json');
    expect(store.read('keep.json')).toBeUndefined();
    store.remove('keep.json'); // no throw
  });
});

describe('MCP OAuth credential identity', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-mcp-oauth-identity-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('isolates tokens for the same server name on different URLs', async () => {
    const store = new JsonFileStore(dir);
    const first = new McpOAuthClientProvider({
      serverName: 'linear',
      serverUrl: 'https://first.example.com/mcp',
      store,
    });
    const second = new McpOAuthClientProvider({
      serverName: 'linear',
      serverUrl: 'https://second.example.com/mcp',
      store,
    });

    await first.saveTokens(token('first-token'));
    await second.saveTokens(token('second-token'));

    expect(first.storeKey).not.toBe(second.storeKey);
    expect(first.tokens()?.access_token).toBe('first-token');
    expect(second.tokens()?.access_token).toBe('second-token');
  });

  it('isolates tokens when distinct server names sanitize to the same prefix', async () => {
    const store = new JsonFileStore(dir);
    const first = new McpOAuthClientProvider({
      serverName: 'team mcp',
      serverUrl: 'https://same.example.com/mcp',
      store,
    });
    const second = new McpOAuthClientProvider({
      serverName: 'team!mcp',
      serverUrl: 'https://same.example.com/mcp',
      store,
    });

    await first.saveTokens(token('space-token'));
    await second.saveTokens(token('bang-token'));

    expect(first.storeKey).not.toBe(second.storeKey);
    expect(first.tokens()?.access_token).toBe('space-token');
    expect(second.tokens()?.access_token).toBe('bang-token');
  });

  it('scopes hasTokens to the server URL, not just the configured name', async () => {
    const service = new McpOAuthService({ store: new JsonFileStore(dir) });
    await service
      .getProvider('linear', 'https://first.example.com/mcp')
      .saveTokens(token('first-token'));

    expect(service.hasTokens('linear', 'https://first.example.com/mcp')).toBe(true);
    expect(service.hasTokens('linear', 'https://second.example.com/mcp')).toBe(false);
  });

  it('removes stored credentials when a server authorization is reset', async () => {
    const service = new McpOAuthService({ store: new JsonFileStore(dir) });
    await service
      .getProvider('linear', 'https://mcp.example.com/mcp')
      .saveTokens(token('access-token'));

    await service.invalidate('linear', 'https://mcp.example.com/mcp');

    expect(service.hasTokens('linear', 'https://mcp.example.com/mcp')).toBe(false);
  });

  it('uses stored client redirect URI when no active OAuth callback is running', () => {
    const provider = new McpOAuthClientProvider({
      serverName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      store: new JsonFileStore(dir),
    });
    provider.saveClientInformation({
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });

    expect(provider.redirectUrl).toBe('http://127.0.0.1:45678/callback');
    expect(provider.clientMetadata.redirect_uris).toEqual(['http://127.0.0.1:45678/callback']);
  });
});


function token(accessToken: string): OAuthTokens {
  return {
    access_token: accessToken,
    token_type: 'Bearer',
  };
}

describe('McpOAuthClientProvider.invalidateStaleRegistration', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-mcp-oauth-stale-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeProvider() {
    return new McpOAuthClientProvider({
      serverName: 'srv',
      serverUrl: 'https://mcp.example.com/mcp',
      store: new JsonFileStore(dir),
    });
  }

  it('drops a registration whose redirect_uris miss the current callback', async () => {
    const provider = makeProvider();
    provider.saveClientInformation({
      client_id: 'c1',
      redirect_uris: ['http://127.0.0.1:11111/callback'],
    });
    await expect(
      provider.invalidateStaleRegistration('http://127.0.0.1:22222/callback'),
    ).resolves.toBe(true);
    expect(provider.clientInformation()).toBeUndefined();
  });

  it('keeps a registration that still covers the callback URI', async () => {
    const provider = makeProvider();
    provider.saveClientInformation({
      client_id: 'c1',
      redirect_uris: ['http://127.0.0.1:11111/callback'],
    });
    await expect(
      provider.invalidateStaleRegistration('http://127.0.0.1:11111/callback'),
    ).resolves.toBe(false);
    expect(provider.clientInformation()).toMatchObject({ client_id: 'c1' });
  });

  it('is a no-op without a stored registration', async () => {
    const provider = makeProvider();
    await expect(
      provider.invalidateStaleRegistration('http://127.0.0.1:11111/callback'),
    ).resolves.toBe(false);
  });
});
