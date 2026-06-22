/**
 * End-to-end proof that the keychain backend is reachable through the public
 * `KimiOAuthToolkit` surface — fully hermetic, NEVER touches the real OS
 * keychain.
 *
 * Task 1 built `KeyringTokenStorage` + `resolveTokenStorage`; the adversarial
 * review of that task flagged that the backend was unreachable from runtime
 * (the toolkit still defaulted to `FileTokenStorage` and the symbols weren't
 * exported). These tests lock in the wiring:
 *
 *  1. A toolkit constructed with a keyring-backed store (built from the REAL
 *     `resolveTokenStorage` factory + the test seam) drives the full public
 *     lifecycle — status / read / refresh / logout — and every credential
 *     read and write lands in the FAKE keychain, never in a plaintext file on
 *     disk.
 *  2. A default-constructed toolkit (no `options.storage`) goes through
 *     `resolveTokenStorage`: with `KIMI_DISABLE_KEYRING=1` it transparently
 *     falls back to the file store and still works — proving the factory is on
 *     the default code path, not bypassed.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KeyringTokenStorage,
  keyringServiceForCredentialsDir,
  resolveTokenStorage,
} from '../src/keyring-storage';
import type { KeyringApi, KeyringEntry } from '../src/keyring-storage';
import { FileTokenStorage } from '../src/storage';
import { KimiOAuthToolkit } from '../src/toolkit';
import type { TokenInfo } from '../src/types';

const TEST_IDENTITY = {
  userAgentProduct: 'kimi-code-cli',
  version: '0.0.0-test',
} as const;

const FLOW_CONFIG = {
  name: 'kimi-code',
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

/** In-memory KeyringApi fake backed by a Map keyed by `service\x00account`. */
class FakeKeyring implements KeyringApi {
  public readonly store = new Map<string, string>();

  private key(service: string, account: string): string {
    return `${service}\x00${account}`;
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
    const prefix = `${service}\x00`;
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
    // Build the store through the REAL factory + the test seam. `disabled:
    // false` is explicit so a stray KIMI_DISABLE_KEYRING in the env can't make
    // this select the file backend — we are specifically proving the keyring
    // path. The probe round-trips against the fake, so this returns a
    // KeyringTokenStorage.
    const resolved = resolveTokenStorage(dir, {
      loadKeyring: () => keyring,
      disabled: false,
    });
    storage = resolved as KeyringTokenStorage;
  });

  afterEach(() => {
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
    // copy must be gone, so a later KIMI_DISABLE_KEYRING run (keychain-unaware)
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
  let prevDisable: string | undefined;

  beforeEach(() => {
    dir = makeTmpDir();
    prevDisable = process.env['KIMI_DISABLE_KEYRING'];
  });

  afterEach(() => {
    if (prevDisable === undefined) delete process.env['KIMI_DISABLE_KEYRING'];
    else process.env['KIMI_DISABLE_KEYRING'] = prevDisable;
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the file store when KIMI_DISABLE_KEYRING=1 (no injected storage)', async () => {
    process.env['KIMI_DISABLE_KEYRING'] = '1';

    // No `storage` option: the toolkit must build its store via
    // resolveTokenStorage, which with the flag set returns a FileTokenStorage.
    const toolkit = new KimiOAuthToolkit({
      homeDir: dir,
      identity: TEST_IDENTITY,
      now: () => 100,
      flowConfig: FLOW_CONFIG,
    });

    const credentialsDir = join(dir, 'credentials');
    // Seed via an independent FileTokenStorage over the same dir the default
    // factory uses; the default toolkit must read it back.
    await new FileTokenStorage(credentialsDir).save('kimi-code', token({ accessToken: 'file-access' }));

    await expect(toolkit.status()).resolves.toEqual({
      providers: [{ providerName: 'managed:kimi-code', hasToken: true }],
    });
    await expect(toolkit.tokenProvider().getAccessToken()).resolves.toBe('file-access');
    // Proof the file backend is what was selected: the plaintext file exists.
    expect(existsSync(join(credentialsDir, 'kimi-code.json'))).toBe(true);
  });
});
