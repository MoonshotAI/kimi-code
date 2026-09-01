import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

import {
  registerKeyringBackend,
  unregisterKeyringBackend,
  type KeyringApi,
  type KeyringEntry,
} from '@moonshot-ai/kimi-code-oauth';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { ILogService, type ILogger } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  createKeyringMcpOAuthStore,
  KEYRING_MCP_OAUTH_SERVICE,
  keyringMcpOAuthServiceForCredentialsDir,
} from '#/app/mcpConfig/keyringMcpOAuthStore';
import { createMcpOAuthStore, McpOAuthStoreAdapter } from '#/app/mcpConfig/oauthStore';
import type { McpOAuthStore } from '#/mcpCore/oauth/store';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

describe('createMcpOAuthStore', () => {
  it('round-trips JSON data through the credentials/mcp scope', async () => {
    const calls: Array<{ op: string; scope: string; key: string; value?: unknown }> = [];
    const docs = {
      async get<T>(scope: string, key: string): Promise<T | undefined> {
        calls.push({ op: 'get', scope, key });
        return { hello: 'world' } as T;
      },
      async set(scope: string, key: string, value: unknown) {
        calls.push({ op: 'set', scope, key, value });
      },
      async delete(scope: string, key: string) {
        calls.push({ op: 'delete', scope, key });
      },
    } as unknown as IAtomicDocumentStore;
    const store = createMcpOAuthStore(docs);

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
    const docs = {
      get: vi.fn().mockRejectedValue(new Error('x')),
    } as unknown as IAtomicDocumentStore;

    await expect(createMcpOAuthStore(docs).read('bad.json')).resolves.toBeUndefined();
  });
});

class FakeKeyring implements KeyringApi {
  readonly store = new Map<string, string>();
  throwOnGet = false;
  throwOnSet = false;
  throwOnDelete = false;

  createEntry(service: string, account: string): KeyringEntry {
    const key = `${service} ${account}`;
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
    return [...this.store.keys()]
      .filter((key) => key.startsWith(`${service} `))
      .map((key) => key.slice(service.length + 1));
  }
}

function keyringValue(keyring: FakeKeyring, key: string): string | undefined {
  return [...keyring.store].find(([entry]) => entry.endsWith(` ${key}`))?.[1];
}

function seedKeyring(keyring: FakeKeyring, key: string, value: unknown): void {
  keyring.store.set(`${KEYRING_MCP_OAUTH_SERVICE} ${key}`, JSON.stringify(value));
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

function setup(
  keyring: FakeKeyring,
  initial: Record<string, unknown> = {},
  opts: { coexist?: boolean; log?: ILogger; service?: string; legacyService?: string } = {},
) {
  const fallback = createFallback(initial);
  const store = createKeyringMcpOAuthStore(
    keyring,
    fallback.store,
    opts.log,
    opts.service,
    undefined,
    opts.legacyService,
    opts.coexist ?? false,
  );
  return { store, fallback };
}

describe('createKeyringMcpOAuthStore', () => {
  it('namespaces keychain grants by credentials directory', () => {
    expect(keyringMcpOAuthServiceForCredentialsDir('/tmp/kimi-profile-a/credentials')).not.toBe(
      keyringMcpOAuthServiceForCredentialsDir('/tmp/kimi-profile-b/credentials'),
    );
    expect(
      keyringMcpOAuthServiceForCredentialsDir(join(homedir(), '.kimi-code', 'credentials')),
    ).toBe(KEYRING_MCP_OAUTH_SERVICE);
  });

  it('migrates grants from an explicitly supplied legacy service only', async () => {
    const legacy = 'kimi-code-mcp-legacy-v1';
    const grant = { client_id: 'legacy' };
    const keyring = new FakeKeyring();
    const service = keyringMcpOAuthServiceForCredentialsDir('/tmp/kimi-profile-a/credentials');
    keyring.store.set(`${legacy} srv-client.json`, JSON.stringify(grant));
    seedKeyring(keyring, 'srv-other.json', { client_id: 'default-profile' });

    const { store: migrated } = setup(keyring, {}, { service, legacyService: legacy });
    await expect(migrated.read('srv-client.json')).resolves.toEqual(grant);
    expect(keyring.store.get(`${service} srv-client.json`)).toBe(JSON.stringify(grant));
    expect(keyring.store.has(`${legacy} srv-client.json`)).toBe(false);

    const { store: isolated } = setup(keyring, {}, { service });
    await expect(isolated.read('srv-other.json')).resolves.toBeUndefined();
    expect(keyring.store.has(`${service} srv-other.json`)).toBe(false);
    expect(keyring.store.has(`${KEYRING_MCP_OAUTH_SERVICE} srv-other.json`)).toBe(true);
  });

  it.each([
    ['strict', false],
    ['coexist', true],
  ] as const)('reconciles reads between the keyring and the fallback (%s)', async (_m, coexist) => {
    const newer = { access_token: 'new', obtained_at: 20 };
    const fromFile = { token: 'from-file' };
    const keyring = new FakeKeyring();
    seedKeyring(keyring, 'hit.json', { token: 'fresh' });
    seedKeyring(keyring, 'stale-tokens.json', { access_token: 'old', obtained_at: 10 });
    keyring.store.set(`${KEYRING_MCP_OAUTH_SERVICE} corrupt-tokens.json`, '{not json');
    const { store, fallback } = setup(
      keyring,
      {
        'hit.json': { token: 'stale' },
        'stale-tokens.json': newer,
        'miss.json': { client_id: 'c1' },
        'corrupt-tokens.json': fromFile,
      },
      { coexist },
    );

    await expect(store.read('hit.json')).resolves.toEqual({ token: 'fresh' });
    if (coexist) expect(fallback.data.get('hit.json')).toEqual({ token: 'fresh' });
    else expect(fallback.calls).toEqual([]);

    await expect(store.read('stale-tokens.json')).resolves.toEqual(newer);
    expect(keyringValue(keyring, 'stale-tokens.json')).toBe(JSON.stringify(newer));
    expect(fallback.data.has('stale-tokens.json')).toBe(coexist);

    await expect(store.read('miss.json')).resolves.toEqual({ client_id: 'c1' });
    expect(keyringValue(keyring, 'miss.json')).toBe(JSON.stringify({ client_id: 'c1' }));
    expect(fallback.data.has('miss.json')).toBe(coexist);

    await expect(store.read('corrupt-tokens.json')).resolves.toEqual(fromFile);
    expect(keyringValue(keyring, 'corrupt-tokens.json')).toBe(JSON.stringify(fromFile));
  });

  it('coexist read restores a missing fallback copy and never revives tombstones', async () => {
    const tombstone = { access_token: '', refresh_token: '', expires_in: 0 };
    const valid = { access_token: 'valid', refresh_token: 'refresh', expires_in: 3600 };
    const keyring = new FakeKeyring();
    seedKeyring(keyring, 'absent.json', { client_id: 'restored' });
    seedKeyring(keyring, 'revoked-tokens.json', tombstone);
    seedKeyring(keyring, 'valid-tokens.json', valid);
    const { store, fallback } = setup(
      keyring,
      { 'revoked-tokens.json': valid, 'valid-tokens.json': tombstone },
      { coexist: true },
    );

    await expect(store.read('absent.json')).resolves.toEqual({ client_id: 'restored' });
    expect(fallback.data.get('absent.json')).toEqual({ client_id: 'restored' });

    await expect(store.read('revoked-tokens.json')).resolves.toEqual(tombstone);
    expect(fallback.data.get('revoked-tokens.json')).toEqual(valid);

    await expect(store.read('valid-tokens.json')).resolves.toEqual(valid);
    expect(fallback.data.get('valid-tokens.json')).toEqual(tombstone);
  });

  it('writes to the keyring and lazily removes the fallback copy', async () => {
    const keyring = new FakeKeyring();
    const { store, fallback } = setup(keyring, { 'srv-tokens.json': { token: 'stale' } });

    await store.write('srv-tokens.json', { token: 'new' });

    expect(keyringValue(keyring, 'srv-tokens.json')).toBe(JSON.stringify({ token: 'new' }));
    expect(fallback.data.has('srv-tokens.json')).toBe(false);
    expect(fallback.calls).toEqual([
      { op: 'remove', key: 'srv-tokens.json.removed' },
      { op: 'remove', key: 'srv-tokens.json' },
    ]);
  });

  it('removes from both stores, and still removes the fallback when the keyring delete fails', async () => {
    const keyring = new FakeKeyring();
    seedKeyring(keyring, 'srv-tokens.json', { token: 'x' });
    const { store, fallback } = setup(keyring, { 'srv-tokens.json': { token: 'y' } });

    await store.remove('srv-tokens.json');

    expect(keyringValue(keyring, 'srv-tokens.json')).toBeUndefined();
    expect(fallback.data.has('srv-tokens.json')).toBe(false);

    seedKeyring(keyring, 'a.json', { v: 1 });
    keyring.throwOnDelete = true;
    const { log, warn } = fakeLog();
    const { store: store2, fallback: fb2 } = setup(keyring, { 'a.json': { v: 1 } }, { log });

    await expect(store2.remove('a.json')).rejects.toThrow(/failed to remove MCP OAuth credential/);
    expect(fb2.data.has('a.json')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a fallback rewrite of the same bytes after remove() is not resurrected into the keyring', async () => {
    const keyring = new FakeKeyring();
    const grant = { token: 'x' };
    const { store, fallback } = setup(keyring, { 'srv-tokens.json': grant });

    await store.remove('srv-tokens.json');
    await fallback.store.write('srv-tokens.json', grant);

    expect(await store.read('srv-tokens.json')).toBeUndefined();
    expect(keyringValue(keyring, 'srv-tokens.json')).toBeUndefined();
  });

  it('a different fallback write after remove() counts as a fresh login and migrates', async () => {
    const keyring = new FakeKeyring();
    const { store, fallback } = setup(keyring, { 'srv-tokens.json': { token: 'x' } });

    await store.remove('srv-tokens.json');
    await fallback.store.write('srv-tokens.json', { token: 'rotated' });

    expect(await store.read('srv-tokens.json')).toEqual({ token: 'rotated' });
    expect(keyringValue(keyring, 'srv-tokens.json')).toBe(JSON.stringify({ token: 'rotated' }));
    expect(fallback.data.has('srv-tokens.json.removed')).toBe(false);
  });

  it('remove() writes a tombstone that list() hides and write() clears', async () => {
    const keyring = new FakeKeyring();
    const { store, fallback } = setup(keyring, { 'srv-tokens.json': { token: 'x' } });

    await store.remove('srv-tokens.json');
    expect(fallback.data.has('srv-tokens.json.removed')).toBe(true);
    expect(await store.list()).not.toContain('srv-tokens.json');
    expect(await store.list()).not.toContain('srv-tokens.json.removed');

    await store.write('srv-tokens.json', { token: 'new' });
    expect(fallback.data.has('srv-tokens.json.removed')).toBe(false);
    expect(await store.list()).toContain('srv-tokens.json');
  });

  it.each(['throwOnSet', 'throwOnGet'] as const)(
    'degrades to the fallback for the rest of the process after a keyring failure (%s)',
    async (flag) => {
      const keyring = new FakeKeyring();
      keyring[flag] = true;
      const { log, warn } = fakeLog();
      const initial = flag === 'throwOnGet' ? { 'a.json': { v: 1 } } : {};
      const { store, fallback } = setup(keyring, initial, { log });

      if (flag === 'throwOnSet') {
        await store.write('a.json', { v: 1 });
        expect(fallback.data.get('a.json')).toEqual({ v: 1 });
      } else {
        await expect(store.read('a.json')).resolves.toEqual({ v: 1 });
      }
      expect(warn).toHaveBeenCalledTimes(1);

      keyring[flag] = false;
      await store.write('b.json', { v: 2 });
      expect(fallback.data.get('b.json')).toEqual({ v: 2 });
      expect(keyringValue(keyring, 'b.json')).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it('does not report a keychain-only grant as missing during an outage', async () => {
    const keyring = new FakeKeyring();
    const { store } = setup(keyring);

    await store.write('a.json', { v: 1 });
    keyring.throwOnGet = true;

    await expect(store.read('a.json')).rejects.toThrow(/keyring unavailable while reading/);
  });

  it('merges keyring accounts with fallback keys on list and honors the prefix', async () => {
    const keyring = new FakeKeyring();
    seedKeyring(keyring, 'srv-t.json', { v: 1 });
    seedKeyring(keyring, 'other.json', { v: 2 });
    const { store } = setup(keyring, { 'srv-c.json': { v: 3 }, 'srv-t.json': { v: 4 } });

    await expect(store.list()).resolves.toEqual(['srv-t.json', 'other.json', 'srv-c.json']);
    await expect(store.list('srv-')).resolves.toEqual(['srv-t.json', 'srv-c.json']);
  });

  it('coexist write dual-writes both stores and keeps the fallback when the keychain write fails', async () => {
    const keyring = new FakeKeyring();
    const { store, fallback } = setup(keyring, {}, { coexist: true });

    await store.write('srv-tokens.json', { token: 'abc' });

    expect(keyringValue(keyring, 'srv-tokens.json')).toBe(JSON.stringify({ token: 'abc' }));
    expect(fallback.data.get('srv-tokens.json')).toEqual({ token: 'abc' });

    const badKeyring = new FakeKeyring();
    badKeyring.throwOnSet = true;
    const { log, warn } = fakeLog();
    const { store: bad, fallback: badFb } = setup(badKeyring, {}, { coexist: true, log });

    await bad.write('srv-tokens.json', { token: 'abc' });

    expect(badFb.data.get('srv-tokens.json')).toEqual({ token: 'abc' });
    expect(badKeyring.store.size).toBe(0);
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
    homeDir = join(tmpdir(), `kimi-mcp-store-test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    disposables.dispose();
    unregisterKeyringBackend();
    vi.unstubAllEnvs();
    rmSync(homeDir, { recursive: true, force: true });
  });

  function createAdapter() {
    const calls: Array<{ op: string; key: string; value?: unknown }> = [];
    ix.stub(IAtomicDocumentStore, {
      _serviceBrand: undefined,
      async get<T>(_scope: string, key: string): Promise<T | undefined> {
        calls.push({ op: 'get', key });
        return undefined;
      },
      async set(_scope: string, key: string, value: unknown) {
        calls.push({ op: 'set', key, value });
      },
      async delete(_scope: string, key: string) {
        calls.push({ op: 'delete', key });
      },
    } as unknown as IAtomicDocumentStore);
    ix.stub(ILogService, { warn: vi.fn() } as unknown as ILogService);
    ix.stub(IBootstrapService, {
      homeDir,
      configPath: join(homeDir, 'config.toml'),
    } as unknown as IBootstrapService);
    return { adapter: ix.createInstance(McpOAuthStoreAdapter), calls };
  }

  async function expectFileWrite(): Promise<void> {
    const { adapter, calls } = createAdapter();
    await adapter.write('srv-tokens.json', { token: 'abc' });
    expect(calls).toEqual([{ op: 'set', key: 'srv-tokens.json', value: { token: 'abc' } }]);
  }

  it.each([
    [
      'auto',
      undefined,
      [
        { op: 'delete', key: 'srv-tokens.json.removed' },
        { op: 'set', key: 'srv-tokens.json', value: { token: 'abc' } },
      ],
    ],
    [
      'keyring',
      'credentials_store = "keyring"\n',
      [
        { op: 'delete', key: 'srv-tokens.json.removed' },
        { op: 'delete', key: 'srv-tokens.json' },
      ],
    ],
  ] as const)('uses the keyring in %s mode', async (_m, config, docsCalls) => {
    if (config !== undefined) writeFileSync(join(homeDir, 'config.toml'), config);
    const keyring = new FakeKeyring();
    registerKeyringBackend(keyring);
    const { adapter, calls } = createAdapter();

    await adapter.write('srv-tokens.json', { token: 'abc' });

    expect(keyringValue(keyring, 'srv-tokens.json')).toBe(JSON.stringify({ token: 'abc' }));
    expect(calls).toEqual(docsCalls);
  });

  it('stays on the document store when the keyring is disabled or unavailable', async () => {
    await expectFileWrite();

    writeFileSync(join(homeDir, 'config.toml'), 'credentials_store = "file"\n');
    const keyring = new FakeKeyring();
    registerKeyringBackend(keyring);
    await expectFileWrite();
    expect(keyring.store.size).toBe(0);

    rmSync(join(homeDir, 'config.toml'));
    vi.stubEnv('KIMI_DISABLE_KEYRING', '1');
    await expectFileWrite();
    expect(keyring.store.size).toBe(0);
  });

  it.each(['throwOnSet', 'throwOnGet', 'throwOnDelete'] as const)(
    'stays on the document store when the keyring probe fails (%s)',
    async (flag) => {
      const keyring = new FakeKeyring();
      keyring[flag] = true;
      registerKeyringBackend(keyring);

      await expectFileWrite();
      expect(keyringValue(keyring, 'srv-tokens.json')).toBeUndefined();
    },
  );
});
