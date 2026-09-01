/**
 * Hermetic end-to-end proof that the keychain backend is reachable through the
 * public `KimiOAuthToolkit` surface (never the real OS keychain). Stores come
 * from the REAL `resolveTokenStorage` factory; a default-constructed toolkit
 * (no `storage` option) proves the factory is on the default code path: file
 * fallback without a registered backend, the keychain with one.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import type { KimiOAuthToolkitOptions } from '../src/toolkit';
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

function makeToolkit(homeDir: string, options: KimiOAuthToolkitOptions = {}): KimiOAuthToolkit {
  return new KimiOAuthToolkit({
    homeDir,
    identity: TEST_IDENTITY,
    flowConfig: FLOW_CONFIG,
    now: () => 100,
    ...options,
  });
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

/** Plaintext `<name>.json` token files on disk (excludes tmp write files). */
function plaintextTokenFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => e.endsWith('.json'));
  } catch {
    return [];
  }
}

describe('KimiOAuthToolkit with a keyring-backed store (hermetic)', () => {
  let dir: string;
  let keyring: FakeKeyring;
  let storage: KeyringTokenStorage;
  // resolveTokenStorage namespaces the keychain service per credentialsDir.
  let service: string;

  beforeEach(() => {
    dir = makeTmpDir();
    service = keyringServiceForCredentialsDir(dir);
    keyring = new FakeKeyring();
    // Strict 'keyring' mode via the REAL factory + test seam: prunes plaintext.
    storage = resolveTokenStorage(dir, {
      loadKeyring: () => keyring,
      mode: 'keyring',
    }) as KeyringTokenStorage;
  });

  afterEach(() => {
    unregisterKeyringBackend();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('drives status / cached reads / logout against the keychain, never the disk', async () => {
    // The store is the real factory output for a usable keyring, not the file fallback.
    expect(storage).toBeInstanceOf(KeyringTokenStorage);
    const toolkit = makeToolkit(dir, { storage });
    expect((await toolkit.status()).providers[0]?.hasToken).toBe(false);

    await storage.save('kimi-code', token({ accessToken: 'cached-access' }));

    expect((await toolkit.status()).providers[0]?.hasToken).toBe(true);
    await expect(toolkit.tokenProvider().getAccessToken()).resolves.toBe('cached-access');
    // The token lives in the fake keychain, not on disk.
    expect(keyring.findAccounts(service)).toEqual(['kimi-code']);
    expect(plaintextTokenFiles(dir)).toEqual([]);

    await expect(toolkit.logout()).resolves.toMatchObject({
      providerName: 'managed:kimi-code',
      ok: true,
    });
    expect((await toolkit.status()).providers[0]?.hasToken).toBe(false);
    expect(keyring.findAccounts(service)).toEqual([]);
    expect(plaintextTokenFiles(dir)).toEqual([]);
  });

  it('a refresh persists the rotated token into the keychain, never to disk', async () => {
    // A stale plaintext copy from a prior file-backend run + an already-expired
    // keychain token (so ensureFresh refreshes): the strict save prunes the
    // plaintext copy, so a later file-backend run cannot resurrect it.
    await new FileTokenStorage(dir).save('kimi-code', token({ accessToken: 'stale-plaintext' }));
    expect(plaintextTokenFiles(dir)).toEqual(['kimi-code.json']);
    await storage.save('kimi-code', token({ accessToken: 'stale-access', expiresAt: 100 }));
    expect(plaintextTokenFiles(dir)).toEqual([]);

    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toBe(`${FLOW_CONFIG.oauthHost}/api/oauth/token`);
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

    const toolkit = makeToolkit(dir, { storage, now: () => 1_000 });

    const nowBeforeRefresh = Math.floor(Date.now() / 1000);
    await expect(toolkit.ensureFresh()).resolves.toBe('rotated-access');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The rotated token lands in the keychain as snake_case wire JSON.
    const raw = keyring.createEntry(service, 'kimi-code').getPassword() as string;
    const persisted = JSON.parse(raw) as Record<string, unknown>;
    expect(persisted['access_token']).toBe('rotated-access');
    expect(persisted['refresh_token']).toBe('rotated-refresh');
    // expiresAt is stamped from real wall-clock (Date.now), not the injected `now`.
    expect(persisted['expires_at']).toBeGreaterThanOrEqual(nowBeforeRefresh + 3600);
    expect(plaintextTokenFiles(dir)).toEqual([]);

    await expect(toolkit.getCachedAccessToken()).resolves.toBe('rotated-access');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  it('falls back to the file store when no backend is registered', async () => {
    // Seeded via an independent FileTokenStorage over the dir the default factory uses.
    await new FileTokenStorage(credentialsDir).save(
      'kimi-code',
      token({ accessToken: 'file-access' }),
    );

    const toolkit = makeToolkit(dir);
    await expect(toolkit.tokenProvider().getAccessToken()).resolves.toBe('file-access');
  });

  it('uses the registered keychain backend through the production wiring', async () => {
    const keyring = new FakeKeyring();
    registerKeyringBackend(keyring);
    const service = keyringServiceForCredentialsDir(credentialsDir);

    // No `storage` option or deps seam: production wiring alone must pick the backend up.
    const toolkit = makeToolkit(dir);
    keyring.store.set(
      `${service}\u0000kimi-code`,
      JSON.stringify(tokenToWire(token({ accessToken: 'keyring-access' }))),
    );

    await expect(toolkit.tokenProvider().getAccessToken()).resolves.toBe('keyring-access');
    // Default mode is 'auto': the plaintext bridge is repaired from the keychain on load.
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

    const toolkit = makeToolkit(dir, { configPath });
    await expect(toolkit.tokenProvider().getAccessToken()).resolves.toBe('file-only-access');
    // 'file' mode: nothing was migrated or written into the keychain.
    expect(keyring.store).toEqual(new Map());
  });
});
