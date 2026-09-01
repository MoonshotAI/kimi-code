import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'pathe';

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
  keyringMcpOAuthServiceForCredentialsDir,
} from '#/app/mcpConfig/keyringMcpOAuthStore';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
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
  for (const [entry, value] of keyring.store) {
    if (entry.endsWith(` ${key}`)) return value;
  }
  return undefined;
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
  it('namespaces keychain grants by credentials directory', () => {
    expect(
      keyringMcpOAuthServiceForCredentialsDir('/tmp/kimi-profile-a/credentials'),
    ).not.toBe(
      keyringMcpOAuthServiceForCredentialsDir('/tmp/kimi-profile-b/credentials'),
    );
    expect(
      keyringMcpOAuthServiceForCredentialsDir(join(homedir(), '.kimi-code', 'credentials')),
    ).toBe(KEYRING_MCP_OAUTH_SERVICE);
  });

  it('migrates grants from an explicitly supplied legacy service', async () => {
    const keyring = new FakeKeyring();
    const service = keyringMcpOAuthServiceForCredentialsDir('/tmp/kimi-profile-a/credentials');
    const legacyService = 'kimi-code-mcp-legacy-v1';
    keyring.store.set(
      `${legacyService} srv-client.json`,
      JSON.stringify({ client_id: 'legacy' }),
    );
    const fallback = createFallback();
    const store = createKeyringMcpOAuthStore(
      keyring,
      fallback.store,
      undefined,
      service,
      undefined,
      legacyService,
    );

    await expect(store.read('srv-client.json')).resolves.toEqual({ client_id: 'legacy' });
    expect(keyring.store.get(`${service} srv-client.json`)).toBe(
      JSON.stringify({ client_id: 'legacy' }),
    );
    expect(keyring.store.has(`${legacyService} srv-client.json`)).toBe(false);
  });

  it('does not treat the standard service as legacy for a custom profile', async () => {
    const keyring = new FakeKeyring();
    const service = keyringMcpOAuthServiceForCredentialsDir('/tmp/kimi-profile-a/credentials');
    keyring.store.set(
      `${KEYRING_MCP_OAUTH_SERVICE} srv-client.json`,
      JSON.stringify({ client_id: 'default-profile' }),
    );
    const fallback = createFallback();
    const store = createKeyringMcpOAuthStore(keyring, fallback.store, undefined, service);

    await expect(store.read('srv-client.json')).resolves.toBeUndefined();
    expect(keyring.store.has(`${service} srv-client.json`)).toBe(false);
    expect(keyring.store.has(`${KEYRING_MCP_OAUTH_SERVICE} srv-client.json`)).toBe(true);
  });

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

  it('adopts a newer fallback token when a keyring token is stale', async () => {
    const keyring = new FakeKeyring();
    keyring.store.set(
      `${KEYRING_MCP_OAUTH_SERVICE} srv-tokens.json`,
      JSON.stringify({ access_token: 'old', obtained_at: 10 }),
    );
    const fallback = createFallback({
      'srv-tokens.json': { access_token: 'new', obtained_at: 20 },
    });
    const store = createKeyringMcpOAuthStore(keyring, fallback.store);

    await expect(store.read('srv-tokens.json')).resolves.toEqual({
      access_token: 'new',
      obtained_at: 20,
    });
    expect(keyringValue(keyring, 'srv-tokens.json')).toBe(
      JSON.stringify({ access_token: 'new', obtained_at: 20 }),
    );
    expect(fallback.data.has('srv-tokens.json')).toBe(false);
  });

  it('answers from the fallback on a keyring miss', async () => {
    const keyring = new FakeKeyring();
    const fallback = createFallback({ 'srv-client.json': { client_id: 'c1' } });
    const store = createKeyringMcpOAuthStore(keyring, fallback.store);

    await expect(store.read('srv-client.json')).resolves.toEqual({ client_id: 'c1' });
    expect(keyringValue(keyring, 'srv-client.json')).toBe(
      JSON.stringify({ client_id: 'c1' }),
    );
    expect(fallback.data.has('srv-client.json')).toBe(false);
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

  it('does not delete a newly written credential when the service is the default service', async () => {
    const keyring = new FakeKeyring();
    const fallback = createFallback();
    const store = createKeyringMcpOAuthStore(
      keyring,
      fallback.store,
      undefined,
      KEYRING_MCP_OAUTH_SERVICE,
    );

    await store.write('srv-tokens.json', { token: 'new' });

    expect(keyringValue(keyring, 'srv-tokens.json')).toBe(JSON.stringify({ token: 'new' }));
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

  it('does not report a keychain-only grant as missing during an outage', async () => {
    const keyring = new FakeKeyring();
    const fallback = createFallback();
    const store = createKeyringMcpOAuthStore(keyring, fallback.store);

    await store.write('a.json', { v: 1 });
    keyring.throwOnGet = true;

    await expect(store.read('a.json')).rejects.toThrow(
      /keyring unavailable while reading MCP OAuth credential/,
    );
  });

  it('still removes the fallback copy when the keyring delete fails', async () => {
    const keyring = new FakeKeyring();
    keyring.store.set(`${KEYRING_MCP_OAUTH_SERVICE} a.json`, JSON.stringify({ v: 1 }));
    keyring.throwOnDelete = true;
    const fallback = createFallback({ 'a.json': { v: 1 } });
    const { log, warn } = fakeLog();
    const store = createKeyringMcpOAuthStore(keyring, fallback.store, log);

    await expect(store.remove('a.json')).rejects.toThrow(/failed to remove MCP OAuth credential/);

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

  it('coexist write dual-writes the keychain and the fallback', async () => {
    const keyring = new FakeKeyring();
    const fallback = createFallback();
    const store = createKeyringMcpOAuthStore(
      keyring,
      fallback.store,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    await store.write('srv-tokens.json', { token: 'abc' });

    expect(keyringValue(keyring, 'srv-tokens.json')).toBe(JSON.stringify({ token: 'abc' }));
    expect(fallback.data.get('srv-tokens.json')).toEqual({ token: 'abc' });
  });

  it('coexist read keeps the fallback copy after migrating it into the keychain', async () => {
    const keyring = new FakeKeyring();
    const fallback = createFallback({ 'srv-client.json': { client_id: 'c1' } });
    const store = createKeyringMcpOAuthStore(
      keyring,
      fallback.store,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    await expect(store.read('srv-client.json')).resolves.toEqual({ client_id: 'c1' });
    expect(keyringValue(keyring, 'srv-client.json')).toBe(JSON.stringify({ client_id: 'c1' }));
    expect(fallback.data.has('srv-client.json')).toBe(true);
  });

  it('coexist read repairs a stale fallback copy on a keyring hit', async () => {
    const keyring = new FakeKeyring();
    keyring.store.set(
      `${KEYRING_MCP_OAUTH_SERVICE} srv-client.json`,
      JSON.stringify({ client_id: 'fresh' }),
    );
    const fallback = createFallback({ 'srv-client.json': { client_id: 'stale' } });
    const store = createKeyringMcpOAuthStore(
      keyring,
      fallback.store,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    await expect(store.read('srv-client.json')).resolves.toEqual({ client_id: 'fresh' });
    expect(fallback.data.get('srv-client.json')).toEqual({ client_id: 'fresh' });
  });

  it('coexist read restores a missing fallback copy on a keyring hit', async () => {
    const keyring = new FakeKeyring();
    keyring.store.set(
      `${KEYRING_MCP_OAUTH_SERVICE} srv-client.json`,
      JSON.stringify({ client_id: 'fresh' }),
    );
    const fallback = createFallback();
    const store = createKeyringMcpOAuthStore(
      keyring,
      fallback.store,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    await expect(store.read('srv-client.json')).resolves.toEqual({ client_id: 'fresh' });
    expect(fallback.data.get('srv-client.json')).toEqual({ client_id: 'fresh' });
  });

  it('coexist read does not overwrite a valid fallback with a keyring tombstone', async () => {
    const keyring = new FakeKeyring();
    keyring.store.set(
      `${KEYRING_MCP_OAUTH_SERVICE} srv-tokens.json`,
      JSON.stringify({ access_token: '', refresh_token: '', expires_in: 0 }),
    );
    const fallback = createFallback({
      'srv-tokens.json': { access_token: 'valid', refresh_token: 'refresh', expires_in: 3600 },
    });
    const store = createKeyringMcpOAuthStore(
      keyring,
      fallback.store,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    await expect(store.read('srv-tokens.json')).resolves.toEqual({
      access_token: '',
      refresh_token: '',
      expires_in: 0,
    });
    expect(fallback.data.get('srv-tokens.json')).toEqual({
      access_token: 'valid',
      refresh_token: 'refresh',
      expires_in: 3600,
    });
  });

  it('coexist read does not overwrite a tombstone fallback with a valid keyring token', async () => {
    const keyring = new FakeKeyring();
    keyring.store.set(
      `${KEYRING_MCP_OAUTH_SERVICE} srv-tokens.json`,
      JSON.stringify({ access_token: 'valid', refresh_token: 'refresh', expires_in: 3600 }),
    );
    const fallback = createFallback({
      'srv-tokens.json': { access_token: '', refresh_token: '', expires_in: 0 },
    });
    const store = createKeyringMcpOAuthStore(
      keyring,
      fallback.store,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    await expect(store.read('srv-tokens.json')).resolves.toEqual({
      access_token: 'valid',
      refresh_token: 'refresh',
      expires_in: 3600,
    });
    expect(fallback.data.get('srv-tokens.json')).toEqual({
      access_token: '',
      refresh_token: '',
      expires_in: 0,
    });
  });

  it('coexist read adopts a newer fallback token without pruning it', async () => {
    const keyring = new FakeKeyring();
    keyring.store.set(
      `${KEYRING_MCP_OAUTH_SERVICE} srv-tokens.json`,
      JSON.stringify({ access_token: 'old', obtained_at: 10 }),
    );
    const fallback = createFallback({
      'srv-tokens.json': { access_token: 'new', obtained_at: 20 },
    });
    const store = createKeyringMcpOAuthStore(
      keyring,
      fallback.store,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    await expect(store.read('srv-tokens.json')).resolves.toEqual({
      access_token: 'new',
      obtained_at: 20,
    });
    expect(keyringValue(keyring, 'srv-tokens.json')).toBe(
      JSON.stringify({ access_token: 'new', obtained_at: 20 }),
    );
    expect(fallback.data.has('srv-tokens.json')).toBe(true);
  });

  it('coexist write degrades to the already-written fallback when the keychain write fails', async () => {
    const keyring = new FakeKeyring();
    keyring.throwOnSet = true;
    const fallback = createFallback();
    const { log, warn } = fakeLog();
    const store = createKeyringMcpOAuthStore(
      keyring,
      fallback.store,
      log,
      undefined,
      undefined,
      undefined,
      true,
    );

    await store.write('srv-tokens.json', { token: 'abc' });

    expect(fallback.data.get('srv-tokens.json')).toEqual({ token: 'abc' });
    expect(keyring.store.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('McpOAuthStoreAdapter', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let homeDir: string;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables);
    homeDir = join(tmpdir(), `kimi-mcp-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    disposables.dispose();
    unregisterKeyringBackend();
    rmSync(homeDir, { recursive: true, force: true });
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
    ix.stub(IBootstrapService, {
      homeDir,
      configPath: join(homeDir, 'config.toml'),
    } as unknown as IBootstrapService);
    return ix.createInstance(McpOAuthStoreAdapter);
  }

  it('uses the keyring when a backend is registered', async () => {
    const keyring = new FakeKeyring();
    registerKeyringBackend(keyring);
    const docs = createDocsStub();

    await createAdapter(docs.impl).write('srv-tokens.json', { token: 'abc' });

    expect(keyringValue(keyring, 'srv-tokens.json')).toBe(JSON.stringify({ token: 'abc' }));
    expect(docs.calls).toEqual([{ op: 'set', key: 'srv-tokens.json', value: { token: 'abc' } }]);
  });

  it("prunes the document store when credentials_store = 'keyring'", async () => {
    writeFileSync(join(homeDir, 'config.toml'), 'credentials_store = "keyring"\n');
    const keyring = new FakeKeyring();
    registerKeyringBackend(keyring);
    const docs = createDocsStub();

    await createAdapter(docs.impl).write('srv-tokens.json', { token: 'abc' });

    expect(keyringValue(keyring, 'srv-tokens.json')).toBe(JSON.stringify({ token: 'abc' }));
    expect(docs.calls).toEqual([{ op: 'delete', key: 'srv-tokens.json' }]);
  });

  it("stays on the document store when credentials_store = 'file'", async () => {
    writeFileSync(join(homeDir, 'config.toml'), 'credentials_store = "file"\n');
    const keyring = new FakeKeyring();
    registerKeyringBackend(keyring);
    const docs = createDocsStub();

    await createAdapter(docs.impl).write('srv-tokens.json', { token: 'abc' });

    expect(keyring.store.size).toBe(0);
    expect(docs.calls).toEqual([{ op: 'set', key: 'srv-tokens.json', value: { token: 'abc' } }]);
  });

  it('stays on the document store when no backend is registered', async () => {
    const docs = createDocsStub();

    await createAdapter(docs.impl).write('srv-tokens.json', { token: 'abc' });

    expect(docs.calls).toEqual([{ op: 'set', key: 'srv-tokens.json', value: { token: 'abc' } }]);
  });

  it('stays on the document store when the keyring probe fails', async () => {
    const keyring = new FakeKeyring();
    keyring.throwOnGet = true;
    registerKeyringBackend(keyring);
    const docs = createDocsStub();

    await createAdapter(docs.impl).write('srv-tokens.json', { token: 'abc' });

    expect(keyring.store.size).toBe(0);
    expect(docs.calls).toEqual([{ op: 'set', key: 'srv-tokens.json', value: { token: 'abc' } }]);
  });
});
