import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { describe, expect, it } from 'vitest';

import { McpOAuthClientProvider } from '#/agent/mcp/oauth/provider';
import { McpOAuthService } from '#/agent/mcp/oauth/service';
import {
  createMcpOAuthStore,
  mcpOAuthStoreKey,
  sanitizeStoreKey,
} from '#/agent/mcp/oauth/store';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

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

describe('createMcpOAuthStore', () => {
  it('round-trips JSON data through the credentials/mcp scope', async () => {
    const calls: Array<{ op: string; scope: string; key: string; value?: unknown }> = [];
    const docs: Pick<IAtomicDocumentStore, 'get' | 'set' | 'delete'> = {
      async get<T>(scope: string, key: string): Promise<T | undefined> {
        calls.push({ op: 'get', scope, key });
        return { hello: 'world' } as T;
      },
      async set(scope, key, value) {
        calls.push({ op: 'set', scope, key, value });
      },
      async delete(scope, key) {
        calls.push({ op: 'delete', scope, key });
      },
    };
    const store = createMcpOAuthStore(docs as unknown as IAtomicDocumentStore);

    await expect(store.read('foo.json')).resolves.toEqual({ hello: 'world' });
    await store.write('foo.json', { token: 'abc' });
    await store.remove('foo.json');

    expect(calls).toEqual([
      { op: 'get', scope: 'credentials/mcp', key: 'foo.json' },
      { op: 'set', scope: 'credentials/mcp', key: 'foo.json', value: { token: 'abc' } },
      { op: 'delete', scope: 'credentials/mcp', key: 'foo.json' },
    ]);
  });

  it('returns undefined when the underlying document store read fails', async () => {
    const store = createMcpOAuthStore({
      get: async () => {
        throw new Error('corrupt json');
      },
      set: async () => {},
      delete: async () => {},
    } as unknown as IAtomicDocumentStore);

    await expect(store.read('bad.json')).resolves.toBeUndefined();
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
