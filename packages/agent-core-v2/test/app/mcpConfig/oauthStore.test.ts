import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerKeyringBackend,
  unregisterKeyringBackend,
  type KeyringApi,
  type KeyringEntry,
} from '@moonshot-ai/kimi-code-oauth';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { ILogService, type ILogger } from '#/_base/log/log';
import {
  createKeyringMcpOAuthStore,
  KEYRING_MCP_OAUTH_SERVICE,
} from '#/app/mcpConfig/keyringMcpOAuthStore';
import { createMcpOAuthStore, McpOAuthStoreAdapter } from '#/app/mcpConfig/oauthStore';
import type { McpOAuthStore } from '#/mcpCore/oauth/store';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

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

class FakeKeyring implements KeyringApi {
  readonly store = new Map<string, string>();
  throwOnGet = false;
  throwOnSet = false;
  throwOnDelete = false;

  private key(service: string, account: string): string {
    return `${service} ${account}`;
  }

  createEntry(service: string, account: string): KeyringEntry {
    const key = this.key(service, account);
    const store = this.store;
    return {
      getPassword: (): string | null => {
        if (this.throwOnGet) throw new Error('keychain read failed');
        return store.get(key) ?? null;
      },
      setPassword: (password: string): void => {
        if (this.throwOnSet) throw new Error('keychain write failed');
        store.set(key, password);
      },
      deleteCredential: (): boolean => {
        if (this.throwOnDelete) throw new Error('keychain delete failed');
        return store.delete(key);
      },
    };
  }

  findAccounts(service: string): string[] {
    const prefix = `${service} `;
    const accounts: string[] = [];
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) accounts.push(k.slice(prefix.length));
    }
    return accounts;
  }
}

function keyringValue(keyring: FakeKeyring, key: string): string | undefined {
  return keyring.store.get(`${KEYRING_MCP_OAUTH_SERVICE} ${key}`);
}

function createFallback(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const calls: Array<{ op: string; key: string; value?: unknown }> = [];
  const store: McpOAuthStore = {
    async read<T>(key: string): Promise<T | undefined> {
      calls.push({ op: 'read', key });
      return data.get(key) as T | undefined;
    },
    async write(key, value) {
      calls.push({ op: 'write', key, value });
      data.set(key, value);
    },
    async remove(key) {
      calls.push({ op: 'remove', key });
      data.delete(key);
    },
    async list(prefix?: string) {
      calls.push({ op: 'list', key: prefix ?? '' });
      const keys = [...data.keys()];
      return prefix === undefined ? keys : keys.filter((key) => key.startsWith(prefix));
    },
  };
  return { store, calls, data };
}

function fakeLog(): { log: ILogger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { log: { warn } as unknown as ILogger, warn };
}

describe('createKeyringMcpOAuthStore', () => {
  it('serves reads from the keyring on a hit without touching the fallback', async () => {
    const keyring = new FakeKeyring();
    keyring.store.set(
      `${KEYRING_MCP_OAUTH_SERVICE} srv-tokens.json`,
      JSON.stringify({ token: 'fresh' }),
    );
    const fallback = createFallback({ 'srv-tokens.json': { token: 'stale' } });
    const store = createKeyringMcpOAuthStore(keyring, fallback.store);

    await expect(store.read('srv-tokens.json')).resolves.toEqual({ token: 'fresh' });
    expect(fallback.calls).toEqual([]);
  });

  it('answers from the fallback on a keyring miss', async () => {
    const keyring = new FakeKeyring();
    const fallback = createFallback({ 'srv-client.json': { client_id: 'c1' } });
    const store = createKeyringMcpOAuthStore(keyring, fallback.store);

    await expect(store.read('srv-client.json')).resolves.toEqual({ client_id: 'c1' });
  });

  it('treats a corrupt keyring payload as a miss', async () => {
    const keyring = new FakeKeyring();
    keyring.store.set(`${KEYRING_MCP_OAUTH_SERVICE} srv-tokens.json`, '{not json');
    const fallback = createFallback({ 'srv-tokens.json': { token: 'from-file' } });
    const store = createKeyringMcpOAuthStore(keyring, fallback.store);

    await expect(store.read('srv-tokens.json')).resolves.toEqual({ token: 'from-file' });
  });

  it('writes to the keyring and lazily removes the fallback copy', async () => {
    const keyring = new FakeKeyring();
    const fallback = createFallback({ 'srv-tokens.json': { token: 'stale' } });
    const store = createKeyringMcpOAuthStore(keyring, fallback.store);

    await store.write('srv-tokens.json', { token: 'new' });

    expect(keyringValue(keyring, 'srv-tokens.json')).toBe(JSON.stringify({ token: 'new' }));
    expect(fallback.data.has('srv-tokens.json')).toBe(false);
    expect(fallback.calls).toEqual([{ op: 'remove', key: 'srv-tokens.json' }]);
  });

  it('removes from both stores', async () => {
    const keyring = new FakeKeyring();
    keyring.store.set(`${KEYRING_MCP_OAUTH_SERVICE} srv-tokens.json`, JSON.stringify({ token: 'x' }));
    const fallback = createFallback({ 'srv-tokens.json': { token: 'y' } });
    const store = createKeyringMcpOAuthStore(keyring, fallback.store);

    await store.remove('srv-tokens.json');

    expect(keyringValue(keyring, 'srv-tokens.json')).toBeUndefined();
    expect(fallback.data.has('srv-tokens.json')).toBe(false);
  });

  it('degrades to the fallback for the rest of the process after a keyring write failure', async () => {
    const keyring = new FakeKeyring();
    keyring.throwOnSet = true;
    const fallback = createFallback();
    const { log, warn } = fakeLog();
    const store = createKeyringMcpOAuthStore(keyring, fallback.store, log);

    await store.write('a.json', { v: 1 });
    expect(fallback.data.get('a.json')).toEqual({ v: 1 });
    expect(warn).toHaveBeenCalledTimes(1);

    keyring.throwOnSet = false;
    await store.write('b.json', { v: 2 });
    expect(fallback.data.get('b.json')).toEqual({ v: 2 });
    expect(keyringValue(keyring, 'b.json')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('degrades after a keyring read failure and answers from the fallback', async () => {
    const keyring = new FakeKeyring();
    keyring.throwOnGet = true;
    const fallback = createFallback({ 'a.json': { v: 1 } });
    const { log, warn } = fakeLog();
    const store = createKeyringMcpOAuthStore(keyring, fallback.store, log);

    await expect(store.read('a.json')).resolves.toEqual({ v: 1 });
    expect(warn).toHaveBeenCalledTimes(1);

    keyring.throwOnGet = false;
    keyring.store.set(`${KEYRING_MCP_OAUTH_SERVICE} b.json`, JSON.stringify({ v: 2 }));
    await store.write('b.json', { v: 3 });
    expect(fallback.data.get('b.json')).toEqual({ v: 3 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('still removes the fallback copy when the keyring delete fails', async () => {
    const keyring = new FakeKeyring();
    keyring.store.set(`${KEYRING_MCP_OAUTH_SERVICE} a.json`, JSON.stringify({ v: 1 }));
    keyring.throwOnDelete = true;
    const fallback = createFallback({ 'a.json': { v: 1 } });
    const { log, warn } = fakeLog();
    const store = createKeyringMcpOAuthStore(keyring, fallback.store, log);

    await store.remove('a.json');

    expect(fallback.data.has('a.json')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('merges keyring accounts with fallback keys on list and honors the prefix', async () => {
    const keyring = new FakeKeyring();
    keyring.store.set(`${KEYRING_MCP_OAUTH_SERVICE} srv-tokens.json`, JSON.stringify({ v: 1 }));
    keyring.store.set(`${KEYRING_MCP_OAUTH_SERVICE} other.json`, JSON.stringify({ v: 2 }));
    const fallback = createFallback({ 'srv-client.json': { v: 3 }, 'srv-tokens.json': { v: 4 } });
    const store = createKeyringMcpOAuthStore(keyring, fallback.store);

    await expect(store.list()).resolves.toEqual(['srv-tokens.json', 'other.json', 'srv-client.json']);
    await expect(store.list('srv-')).resolves.toEqual(['srv-tokens.json', 'srv-client.json']);
  });
});

describe('McpOAuthStoreAdapter', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables);
  });

  afterEach(() => {
    disposables.dispose();
    unregisterKeyringBackend();
    vi.unstubAllEnvs();
  });

  function createDocsStub() {
    const data = new Map<string, unknown>();
    const calls: Array<{ op: string; key: string; value?: unknown }> = [];
    const impl = {
      _serviceBrand: undefined,
      async get<T>(_scope: string, key: string): Promise<T | undefined> {
        calls.push({ op: 'get', key });
        return data.get(key) as T | undefined;
      },
      async set(_scope: string, key: string, value: unknown) {
        calls.push({ op: 'set', key, value });
        data.set(key, value);
      },
      async delete(_scope: string, key: string) {
        calls.push({ op: 'delete', key });
        data.delete(key);
      },
    } as unknown as IAtomicDocumentStore;
    return { impl, calls, data };
  }

  function createAdapter(docs: IAtomicDocumentStore): McpOAuthStoreAdapter {
    ix.stub(IAtomicDocumentStore, docs);
    ix.stub(ILogService, { warn: vi.fn() } as unknown as ILogService);
    return ix.createInstance(McpOAuthStoreAdapter);
  }

  it('uses the keyring when a backend is registered and the gate opts in', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_KEYRING', '1');
    vi.stubEnv('KIMI_DISABLE_KEYRING', '');
    const keyring = new FakeKeyring();
    registerKeyringBackend(keyring);
    const docs = createDocsStub();

    await createAdapter(docs.impl).write('srv-tokens.json', { token: 'abc' });

    expect(keyringValue(keyring, 'srv-tokens.json')).toBe(JSON.stringify({ token: 'abc' }));
    expect(docs.calls).toEqual([{ op: 'delete', key: 'srv-tokens.json' }]);
  });

  it('stays on the document store without the opt-in gate', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_KEYRING', '');
    vi.stubEnv('KIMI_DISABLE_KEYRING', '');
    const keyring = new FakeKeyring();
    registerKeyringBackend(keyring);
    const docs = createDocsStub();

    await createAdapter(docs.impl).write('srv-tokens.json', { token: 'abc' });

    expect(keyring.store.size).toBe(0);
    expect(docs.calls).toEqual([{ op: 'set', key: 'srv-tokens.json', value: { token: 'abc' } }]);
  });

  it('stays on the document store when no backend is registered', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_KEYRING', '1');
    vi.stubEnv('KIMI_DISABLE_KEYRING', '');
    const docs = createDocsStub();

    await createAdapter(docs.impl).write('srv-tokens.json', { token: 'abc' });

    expect(docs.calls).toEqual([{ op: 'set', key: 'srv-tokens.json', value: { token: 'abc' } }]);
  });
});
