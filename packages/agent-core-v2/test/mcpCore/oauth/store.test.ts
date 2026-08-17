import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { describe, expect, it } from 'vitest';

import { McpOAuthClientProvider, type StoredMcpOAuthTokens } from '#/mcpCore/oauth/provider';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { mcpOAuthStoreKey, sanitizeStoreKey } from '#/mcpCore/oauth/store';

import { createMemoryMcpOAuthStore } from '../stubs';

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

describe('MCP OAuth credential identity', () => {
  it('isolates tokens for the same server name on different URLs', async () => {
    const store = createMemoryMcpOAuthStore();
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
    await Promise.all([first.ready, second.ready]);

    await first.saveTokens(token('first-token'));
    await second.saveTokens(token('second-token'));

    expect(first.storeKey).not.toBe(second.storeKey);
    await expect(first.tokens()).resolves.toMatchObject({ access_token: 'first-token' });
    await expect(second.tokens()).resolves.toMatchObject({ access_token: 'second-token' });
  });

  it('isolates tokens when distinct server names sanitize to the same prefix', async () => {
    const store = createMemoryMcpOAuthStore();
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
    await Promise.all([first.ready, second.ready]);

    await first.saveTokens(token('space-token'));
    await second.saveTokens(token('bang-token'));

    expect(first.storeKey).not.toBe(second.storeKey);
    await expect(first.tokens()).resolves.toMatchObject({ access_token: 'space-token' });
    await expect(second.tokens()).resolves.toMatchObject({ access_token: 'bang-token' });
  });

  it('scopes hasTokens to the server URL, not just the configured name', async () => {
    const service = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const provider = service.getProvider('linear', 'https://first.example.com/mcp');
    await provider.ready;
    await provider.saveTokens(token('first-token'));

    await expect(service.hasTokens('linear', 'https://first.example.com/mcp')).resolves.toBe(true);
    await expect(service.hasTokens('linear', 'https://second.example.com/mcp')).resolves.toBe(false);
  });

  it('stamps saved tokens with obtained_at, in cache and on disk', async () => {
    const store = createMemoryMcpOAuthStore();
    const provider = new McpOAuthClientProvider({
      serverName: 'linear',
      serverUrl: 'https://first.example.com/mcp',
      store,
    });
    await provider.ready;

    const before = Date.now();
    await provider.saveTokens(token('stamped-token'));
    const after = Date.now();

    const stamped = (await provider.tokens()) as StoredMcpOAuthTokens | undefined;
    expect(stamped?.obtained_at).toBeGreaterThanOrEqual(before);
    expect(stamped?.obtained_at).toBeLessThanOrEqual(after);

    // A fresh provider over the same store reads the stamp back from disk.
    const reloaded = new McpOAuthClientProvider({
      serverName: 'linear',
      serverUrl: 'https://first.example.com/mcp',
      store,
    });
    await reloaded.ready;
    await expect(reloaded.tokens()).resolves.toMatchObject({ obtained_at: stamped?.obtained_at });
  });

  it('uses stored client redirect URI when no active OAuth callback is running', async () => {
    const provider = new McpOAuthClientProvider({
      serverName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      store: createMemoryMcpOAuthStore(),
    });
    await provider.ready;
    await provider.saveClientInformation({
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull);

    expect(provider.redirectUrl).toBe('http://127.0.0.1:45678/callback');
    expect(provider.clientMetadata.redirect_uris).toEqual(['http://127.0.0.1:45678/callback']);
  });

  it('canonicalizes URL fragments out of store keys', () => {
    expect(mcpOAuthStoreKey('s', 'https://example.com/mcp#frag')).toBe(
      mcpOAuthStoreKey('s', 'https://example.com/mcp'),
    );
  });
});

function token(accessToken: string): OAuthTokens {
  return {
    access_token: accessToken,
    token_type: 'Bearer',
  };
}

describe('McpOAuthClientProvider.invalidateStaleRegistration', () => {
  function makeProvider() {
    return new McpOAuthClientProvider({
      serverName: 'srv',
      serverUrl: 'https://mcp.example.com/mcp',
      store: createMemoryMcpOAuthStore(),
    });
  }

  const registration: OAuthClientInformationFull = {
    client_id: 'c1',
    redirect_uris: ['http://127.0.0.1:11111/callback'],
  };

  it('drops a registration whose redirect_uris miss the current callback', async () => {
    const provider = makeProvider();
    await provider.ready;
    await provider.saveClientInformation(registration);
    await expect(
      provider.invalidateStaleRegistration('http://127.0.0.1:22222/callback'),
    ).resolves.toBe(true);
    await expect(provider.clientInformation()).resolves.toBeUndefined();
  });

  it('keeps a registration that still covers the callback URI', async () => {
    const provider = makeProvider();
    await provider.ready;
    await provider.saveClientInformation(registration);
    await expect(
      provider.invalidateStaleRegistration('http://127.0.0.1:11111/callback'),
    ).resolves.toBe(false);
    await expect(provider.clientInformation()).resolves.toMatchObject({ client_id: 'c1' });
  });

  it('is a no-op without a stored registration', async () => {
    const provider = makeProvider();
    await provider.ready;
    await expect(
      provider.invalidateStaleRegistration('http://127.0.0.1:11111/callback'),
    ).resolves.toBe(false);
  });
});
