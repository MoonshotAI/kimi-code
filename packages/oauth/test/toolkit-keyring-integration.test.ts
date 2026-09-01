/**
 * End-to-end proof that the keychain backend is reachable through the public
 * `KimiOAuthToolkit` surface — fully hermetic, NEVER touches the real OS
 * keychain.
 *
 * These tests lock in the wiring:
 *
 *  1. A toolkit constructed with a keyring-backed store (built from the REAL
 *     `resolveTokenStorage` factory + the test seam) drives the full public
 *     lifecycle — status / read / refresh / logout — and every credential
 *     read and write lands in the FAKE keychain, never in a plaintext file on
 *     disk.
 *  2. A default-constructed toolkit (no `options.storage`) goes through
 *     `resolveTokenStorage`: with no backend registered it transparently
 *     falls back to the file store and still works — proving the factory is on
 *     the default code path, not bypassed. With a backend registered it
 *     transparently uses the keychain — the exact production wiring the host
 *     app sets up.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KeyringTokenStorage,
  keyringServiceForCredentialsDir,
  registerKeyringBackend,
  resolveTokenStorage,
  unregisterKeyringBackend,
} from '../src/keyring-storage';
import type { KeyringApi, KeyringEntry } from '../src/keyring-storage';
import { FileTokenStorage } from '../src/storage';
import { KimiOAuthToolkit } from '../src/toolkit';
import type { TokenInfo } from '../src/types';
import { tokenToWire } from '../src/types';

const TEST_IDENTITY = {
  productName: 'kimi-code-cli',
  version: '0.0.0-test',
  platform: 'kimi_code_cli',
} as const;

const FLOW_CONFIG = {
  name: 'kimi-code',
  // The DEFAULT_KIMI_CODE_OAUTH_HOST: the only host whose OAuth key resolves
  // to the default 'kimi-code' storage name these tests seed and assert on.
  oauthHost: 'https://auth.kimi.com',
  clientId: 'test-client-id',
} as const;

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `kimi-toolkit-keyring-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function token(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: 10_000,
    scope: '',
    tokenType: 'Bearer',
    expiresIn: 3600,
    ...overrides,
  };
}

/** In-memory KeyringApi fake backed by a Map keyed by `service\u0000account`. */
class FakeKeyring implements KeyringApi {
  public readonly store = new Map<string, string>();

  private key(service: string, account: string): string {
    return `${service}\u0000${account}`;
  }

  createEntry(service: string, account: string): KeyringEntry {
    const key = this.key(service, account);
    const store = this.store;
    return {
      getPassword(): string | null {
        return store.has(key) ? (store.get(key) as string) : null;
      },
      setPassword(password: string): void {
        store.set(key, password);
      },
      deleteCredential(): boolean {
        return store.delete(key);
      },
    };
  }

  findAccounts(service: string): string[] {
    const prefix = `${service}\u0000`;
    const accounts: string[] = [];
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) accounts.push(k.slice(prefix.length));
    }
    return accounts;
  }
}

/** Token entries currently in the fake keychain under the given service. */
function keychainTokenNames(keyring: FakeKeyring, service: string): string[] {
  return keyring.findAccounts(service);
}

/** Plaintext `<name>.json` token files on disk (excludes tmp write files). */
function plaintextTokenFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => e.endsWith('.json'));
  } catch {
    return [];
  }
}

function fetchInputUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  throw new TypeError('expected fetch input to be a string, URL, or Request');
}

describe('KimiOAuthToolkit with a keyring-backed store (hermetic)', () => {
  let dir: string;
  let keyring: FakeKeyring;
  let storage: KeyringTokenStorage;
  // resolveTokenStorage namespaces the keychain service per credentialsDir
  // (parity with the file backend), so the service is derived from `dir`, not
  // the bare KEYRING_SERVICE constant.
  let service: string;

  beforeEach(() => {
    dir = makeTmpDir();
    service = keyringServiceForCredentialsDir(dir);
    keyring = new FakeKeyring();
    // Build the store through the REAL factory + the test seam, in strict
    // 'keyring' mode: the probe round-trips against the fake, so this returns
    // a KeyringTokenStorage that prunes plaintext copies.
    const resolved = resolveTokenStorage(dir, {
      loadKeyring: () => keyring,
      mode: 'keyring',
    });
    storage = resolved as KeyringTokenStorage;
  });

  afterEach(() => {
    unregisterKeyringBackend();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolveTokenStorage selects KeyringTokenStorage on the public path', () => {
    // The store every test in this block drives is the real factory output for
    // a usable keyring — i.e. a KeyringTokenStorage, not the file fallback.
    expect(storage).toBeInstanceOf(KeyringTokenStorage);
  });

  it('status() reflects a token saved into the keychain (nothing on disk)', async () => {
    const toolkit = new KimiOAuthToolkit({
      homeDir: dir,
      identity: TEST_IDENTITY,
      storage,
      now: () => 100,
      flowConfig: FLOW_CONFIG,
    });

    await expect(toolkit.status()).resolves.toEqual({
      providers: [{ providerName: 'managed:kimi-code', hasToken: false }],
    });

    // Seed through the public store the toolkit was constructed with.
    await storage.save('kimi-code', token());

    await expect(toolkit.status()).resolves.toEqual({
      providers: [{ providerName: 'managed:kimi-code', hasToken: true }],
    });
    // The token lives in the fake keychain, not on disk.
    expect(keychainTokenNames(keyring, service)).toEqual(['kimi-code']);
    expect(plaintextTokenFiles(dir)).toEqual([]);
  });

  it('getAccessToken() returns the cached token straight from the keychain', async () => {
    await storage.save('kimi-code', token({ accessToken: 'cached-access' }));
    const toolkit = new KimiOAuthToolkit({
      homeDir: dir,
      identity: TEST_IDENTITY,
      storage,
      now: () => 100,
      flowConfig: FLOW_CONFIG,
    });

    await expect(toolkit.tokenProvider().getAccessToken()).resolves.toBe('cached-access');
    expect(plaintextTokenFiles(dir)).toEqual([]);
  });

  it('a refresh persists the rotated token into the keychain, never to disk', async () => {
    // Stored token is already expired so ensureFresh must refresh it.
    await storage.save('kimi-code', token({ accessToken: 'stale-access', expiresAt: 100 }));

    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(fetchInputUrl(input)).toBe(`${FLOW_CONFIG.oauthHost}/api/oauth/token`);
      if (typeof init?.body !== 'string') throw new TypeError('expected form body');
      expect(new URLSearchParams(init.body).get('grant_type')).toBe('refresh_token');
      return new Response(
        JSON.stringify({
          access_token: 'rotated-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
          scope: '',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchImpl);

    const toolkit = new KimiOAuthToolkit({
      homeDir: dir,
      identity: TEST_IDENTITY,
      storage,
      now: () => 1_000,
      flowConfig: FLOW_CONFIG,
    });

    const nowBeforeRefresh = Math.floor(Date.now() / 1000);
    await expect(toolkit.ensureFresh()).resolves.toBe('rotated-access');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The rotated token is persisted into the FAKE keychain as snake_case wire
    // JSON — the same payload the file store would have written, but to the
    // keychain instead.
    const raw = keyring.createEntry(service, 'kimi-code').getPassword();
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw as string) as Record<string, unknown>;
    expect(persisted['access_token']).toBe('rotated-access');
    expect(persisted['refresh_token']).toBe('rotated-refresh');
    expect(persisted['expires_in']).toBe(3600);
    expect(persisted['token_type']).toBe('Bearer');
    // OAuthManager stamps expiresAt from real wall-clock (Date.now), not the
    // injected `now`, so assert it is a fresh ~+3600s value rather than an
    // exact match against the stub.
    expect(persisted['expires_at']).toBeGreaterThanOrEqual(nowBeforeRefresh + 3600);
    // ...and absolutely nothing landed in plaintext on disk.
    expect(plaintextTokenFiles(dir)).toEqual([]);

    // A second read returns the rotated token without another network call.
    await expect(toolkit.getCachedAccessToken()).resolves.toBe('rotated-access');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a refresh prunes a pre-seeded stale plaintext file so a later file run cannot resurrect it', async () => {
    // Pre-seed a stale plaintext token at <credentialsDir>/kimi-code.json via a
    // real FileTokenStorage — exactly what a prior file-backend fallback run (or
    // a keychain-wins reconcile) leaves behind. The keychain holds an expired
    // token so ensureFresh refreshes and calls save(). After save() the cleartext
    // copy must be gone, so a later file-backend run (keychain-unaware)
    // can no longer read it back and resurrect the obsolete credential.
    await new FileTokenStorage(dir).save(
      'kimi-code',
      token({ accessToken: 'stale-plaintext', refreshToken: 'stale-plaintext-refresh' }),
    );
    expect(plaintextTokenFiles(dir)).toEqual(['kimi-code.json']);

    // Keychain token is already expired so ensureFresh must refresh it.
    await storage.save('kimi-code', token({ accessToken: 'stale-access', expiresAt: 100 }));

    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(fetchInputUrl(input)).toBe(`${FLOW_CONFIG.oauthHost}/api/oauth/token`);
      if (typeof init?.body !== 'string') throw new TypeError('expected form body');
      expect(new URLSearchParams(init.body).get('grant_type')).toBe('refresh_token');
      return new Response(
        JSON.stringify({
          access_token: 'rotated-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
          scope: '',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchImpl);

    const toolkit = new KimiOAuthToolkit({
      homeDir: dir,
      identity: TEST_IDENTITY,
      storage,
      now: () => 1_000,
      flowConfig: FLOW_CONFIG,
    });

    await expect(toolkit.ensureFresh()).resolves.toBe('rotated-access');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The rotated token is authoritative in the keychain...
    const raw = keyring.createEntry(service, 'kimi-code').getPassword();
    expect(raw).not.toBeNull();
    expect((JSON.parse(raw as string) as Record<string, unknown>)['access_token']).toBe(
      'rotated-access',
    );
    // ...and the pre-seeded stale plaintext copy is gone (no resurrection path).
    expect(plaintextTokenFiles(dir)).toEqual([]);
  });

  it('logout() removes the token from the keychain', async () => {
    await storage.save('kimi-code', token());
    const toolkit = new KimiOAuthToolkit({
      homeDir: dir,
      identity: TEST_IDENTITY,
      storage,
      now: () => 100,
      flowConfig: FLOW_CONFIG,
    });
    expect((await toolkit.status()).providers[0]?.hasToken).toBe(true);

    await expect(toolkit.logout()).resolves.toMatchObject({
      providerName: 'managed:kimi-code',
      ok: true,
    });

    expect((await toolkit.status()).providers[0]?.hasToken).toBe(false);
    expect(keychainTokenNames(keyring, service)).toEqual([]);
    expect(plaintextTokenFiles(dir)).toEqual([]);
  });
});

describe('KimiOAuthToolkit default storage goes through resolveTokenStorage', () => {
  let dir: string;
  let credentialsDir: string;

  beforeEach(() => {
    dir = makeTmpDir();
    credentialsDir = join(dir, 'credentials');
  });

  afterEach(() => {
    unregisterKeyringBackend();
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the file store when no backend is registered (no injected storage)', async () => {
    // No `storage` option: the toolkit must build its store via
    // resolveTokenStorage, which without a registered backend returns a
    // FileTokenStorage.
    const toolkit = new KimiOAuthToolkit({
      homeDir: dir,
      identity: TEST_IDENTITY,
      now: () => 100,
      flowConfig: FLOW_CONFIG,
    });

    // Seed via an independent FileTokenStorage over the same dir the default
    // factory uses; the default toolkit must read it back.
    await new FileTokenStorage(credentialsDir).save(
      'kimi-code',
      token({ accessToken: 'file-access' }),
    );

    await expect(toolkit.status()).resolves.toEqual({
      providers: [{ providerName: 'managed:kimi-code', hasToken: true }],
    });
    await expect(toolkit.tokenProvider().getAccessToken()).resolves.toBe('file-access');
    // Proof the file backend is what was selected: the plaintext file exists.
    expect(existsSync(join(credentialsDir, 'kimi-code.json'))).toBe(true);
  });

  it('uses the registered keychain backend (no injected storage)', async () => {
    const keyring = new FakeKeyring();
    registerKeyringBackend(keyring);
    const service = keyringServiceForCredentialsDir(credentialsDir);

    // No `storage` option and no deps seam: the toolkit must pick the
    // registered backend up through the production wiring alone.
    const toolkit = new KimiOAuthToolkit({
      homeDir: dir,
      identity: TEST_IDENTITY,
      now: () => 100,
      flowConfig: FLOW_CONFIG,
    });

    // Seed the keychain entry directly; the default toolkit must read it back.
    keyring.store.set(
      `${service}\u0000kimi-code`,
      JSON.stringify(tokenToWire(token({ accessToken: 'keyring-access' }))),
    );

    await expect(toolkit.status()).resolves.toEqual({
      providers: [{ providerName: 'managed:kimi-code', hasToken: true }],
    });
    await expect(toolkit.tokenProvider().getAccessToken()).resolves.toBe('keyring-access');
    // The default mode is 'auto' (coexistence): the keychain is read first,
    // and the plaintext bridge is repaired from it on load.
    expect(plaintextTokenFiles(credentialsDir)).toEqual(['kimi-code.json']);
  });

  it('uses the explicit configPath when selecting default storage', async () => {
    const configPath = join(dir, 'custom-config.toml');
    writeFileSync(configPath, 'credentials_store = "file"\n');
    const keyring = new FakeKeyring();
    registerKeyringBackend(keyring);
    await new FileTokenStorage(credentialsDir).save(
      'kimi-code',
      token({ accessToken: 'file-only-access' }),
    );

    const toolkit = new KimiOAuthToolkit({
      homeDir: dir,
      configPath,
      identity: TEST_IDENTITY,
      now: () => 100,
      flowConfig: FLOW_CONFIG,
    });

    await expect(toolkit.tokenProvider().getAccessToken()).resolves.toBe('file-only-access');
    expect(keyring.store).toEqual(new Map());
    expect(plaintextTokenFiles(credentialsDir)).toEqual(['kimi-code.json']);
  });
});
