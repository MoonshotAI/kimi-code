/**
 * KeyringTokenStorage + resolveTokenStorage tests — fully hermetic.
 *
 * NEVER touches the real OS keychain: the keyring backend is an in-memory
 * fake `KeyringApi` (a Map keyed by `service account`). The file fallback
 * uses a real `FileTokenStorage` over a tmp dir so migration + union with the
 * plaintext store are exercised end-to-end. The registration slot and the
 * process-wide degradation flag are reset via `unregisterKeyringBackend()`
 * after every test.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CREDENTIALS_STORE_CONFIG_KEY,
  getRegisteredKeyringBackend,
  KEYRING_PROBE_SERVICE,
  KEYRING_SERVICE,
  KeyringTokenStorage,
  keyringServiceForCredentialsDir,
  registerKeyringBackend,
  resolveCredentialsStoreMode,
  resolveTokenStorage,
  unregisterKeyringBackend,
} from '../src/keyring-storage';
import type { KeyringApi, KeyringEntry, KeyringStorageObserver } from '../src/keyring-storage';
import { FileTokenStorage } from '../src/storage';
import { revokedTombstone } from '../src/token-state';
import type { TokenInfo } from '../src/types';
import { tokenToWire } from '../src/types';

function makeTmpDir(): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dir = join(tmpdir(), `kimi-keyring-test-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sampleToken(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    accessToken: 'at-abc',
    refreshToken: 'rt-xyz',
    expiresAt: 1_700_000_000,
    scope: 'read write',
    tokenType: 'Bearer',
    expiresIn: 3600,
    ...overrides,
  };
}

/** Compact token factory for reconcile scenarios (issuedAt = expiresAt - expiresIn). */
function tok(accessToken: string, expiresAt: number, expiresIn = 3600): TokenInfo {
  return sampleToken({ accessToken, refreshToken: `rt-${accessToken}`, expiresAt, expiresIn });
}

/** In-memory KeyringApi fake backed by a Map keyed by `service account`. */
class FakeKeyring implements KeyringApi {
  public readonly store = new Map<string, string>();

  private key(service: string, account: string): string {
    return `${service} ${account}`;
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
    const prefix = `${service} `;
    return [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }
}

/** Records every account `createEntry` is asked for, per service. */
class RecordingKeyring extends FakeKeyring {
  public readonly accountsByService = new Map<string, string[]>();

  override createEntry(service: string, account: string): KeyringEntry {
    const seen = this.accountsByService.get(service) ?? [];
    seen.push(account);
    this.accountsByService.set(service, seen);
    return super.createEntry(service, account);
  }
}

/**
 * A FakeKeyring with configurable misbehavior: per-operation throws
 * (degradation tests) and constructor/delete/read/list denial or lying
 * (ambiguity + probe tests). All defaults are healthy.
 */
class ConfigurableKeyring extends FakeKeyring {
  public createThrows = false;
  public throwOnGet = false;
  public throwOnSet = false;
  public throwOnDelete = false;
  public throwOnFind = false;
  public deleteRemoves = true;
  public deleteReturns = true;
  /** Reads before getPassword() collapses to null (binding-style read denial). */
  public nullReadsAfter = Number.POSITIVE_INFINITY;

  override createEntry(service: string, account: string): KeyringEntry {
    if (this.createThrows) throw new Error('keychain entry initialization failed');
    const base = super.createEntry(service, account);
    let reads = 0;
    return {
      getPassword: (): string | null => {
        if (this.throwOnGet) throw new Error('keychain read failed');
        reads += 1;
        return reads > this.nullReadsAfter ? null : base.getPassword();
      },
      setPassword: (p: string): void => {
        if (this.throwOnSet) throw new Error('keychain write failed');
        base.setPassword(p);
      },
      deleteCredential: (): boolean => {
        if (this.throwOnDelete) throw new Error('keychain delete failed');
        if (this.deleteRemoves) return base.deleteCredential();
        return this.deleteReturns;
      },
    };
  }

  override findAccounts(service: string): string[] {
    if (this.throwOnFind) throw new Error('keychain store unreachable');
    return super.findAccounts(service);
  }
}

/** Recording KeyringStorageObserver. */
class FakeObserver implements KeyringStorageObserver {
  public readonly selected: Array<{ backend: 'keyring' | 'file'; reason?: string }> = [];
  public readonly degraded: Array<{ operation: string; message: string }> = [];
  public readonly migrated: string[] = [];

  onBackendSelected(backend: 'keyring' | 'file', reason?: string): void {
    this.selected.push({ backend, reason });
  }

  onKeyringDegraded(operation: 'load' | 'save' | 'remove' | 'list', message: string): void {
    this.degraded.push({ operation, message });
  }

  onMigrated(name: string): void {
    this.migrated.push(name);
  }
}

describe('KeyringTokenStorage', () => {
  let dir: string;
  let legacy: FileTokenStorage;
  let keyring: FakeKeyring;
  let observer: FakeObserver;
  let storage: KeyringTokenStorage;

  beforeEach(() => {
    dir = makeTmpDir();
    legacy = new FileTokenStorage(dir);
    keyring = new FakeKeyring();
    observer = new FakeObserver();
    storage = new KeyringTokenStorage({ keyring, legacy, observer });
  });

  afterEach(() => {
    unregisterKeyringBackend();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a token via save/load/list/remove, stored as snake_case wire JSON under KEYRING_SERVICE', async () => {
    const token = sampleToken();
    expect(await storage.load('kimi-code')).toBeUndefined();

    await storage.save('kimi-code', token);
    const raw = keyring.store.get(`${KEYRING_SERVICE} kimi-code`);
    expect(JSON.parse(raw as string)).toEqual(tokenToWire(token));
    expect(await storage.load('kimi-code')).toEqual(token);
    expect(await storage.list()).toEqual(['kimi-code']);

    // remove() clears BOTH stores: the keychain entry and a lingering plaintext copy.
    await legacy.save('kimi-code', token);
    await storage.remove('kimi-code');
    expect(keyring.store.size).toBe(0);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    expect(await storage.load('kimi-code')).toBeUndefined();
    expect(await storage.list()).toEqual([]);
  });

  it('migrates a plaintext token into the keychain, then compare-and-deletes the file', async () => {
    const token = sampleToken();
    await legacy.save('kimi-code', token);

    // First load migrates: returns the token, populates the keychain, deletes
    // the stable matching file, and reports it. The second load reads straight
    // from the keychain without re-migrating.
    expect(await storage.load('kimi-code')).toEqual(token);
    expect(keyring.store.get(`${KEYRING_SERVICE} kimi-code`)).toBeDefined();
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    expect(observer.migrated).toEqual(['kimi-code']);
    expect(await storage.load('kimi-code')).toEqual(token);
    expect(observer.migrated).toEqual(['kimi-code']);
  });

  it('compare-and-delete: a file under persistent churn is NEVER deleted', async () => {
    // A legacy store whose value differs on every read — a concurrent writer
    // landing a fresher token between every re-read, so the file never
    // stabilises to the migrated value. The bounded converge loop must
    // exhaust its budget WITHOUT unlinking; a later load reconciles.
    const tokens: TokenInfo[] = Array.from({ length: 5 }, (_, i) => tok(`at-${i + 1}`, 1000));
    const lastToken = tokens.at(-1) as TokenInfo;
    class RacyLegacy extends FileTokenStorage {
      public loadCalls = 0;
      public removeCalls = 0;
      override loadUnlocked(): TokenInfo | undefined {
        const value = tokens.at(this.loadCalls) ?? lastToken;
        this.loadCalls += 1;
        return value;
      }
      override removeIfMatchesUnlocked(name: string, expected: string): boolean {
        this.removeCalls += 1;
        return super.removeIfMatchesUnlocked(name, expected);
      }
    }
    const racy = new RacyLegacy(dir);
    await racy.save('kimi-code', tokens[0] as TokenInfo); // a real file so a wrongful remove is observable

    const loaded = await new KeyringTokenStorage({ keyring, legacy: racy, observer }).load('kimi-code');

    // The keychain ends authoritative with the newest value the loop observed;
    // the file is never deleted and no migration is reported.
    const latest = tokens.at(racy.loadCalls - 1) ?? lastToken;
    expect(loaded).toEqual(latest);
    expect(racy.removeCalls).toBe(0);
    const raw = keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
    expect(JSON.parse(raw as string)).toEqual(tokenToWire(latest));
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
    expect(observer.migrated).toEqual([]);
  });

  // Reconcile-on-HIT: the backend can differ per run for one credentialsDir,
  // so a sequential flip-flop can split state — the keychain may hold an OLDER
  // token while a fallback run wrote a NEWER one to the plaintext file. load()
  // adopts the file token ONLY when both sides are valid and the file was
  // issued strictly later (issuedAt = expiresAt - expiresIn); it NEVER
  // un-revokes a tombstone from stale plaintext.
  it.each([
    {
      name: 'adopts a strictly-newer file token (sequential fallback flip-flop)',
      keyringTok: tok('at-A', 1000), fileTok: tok('at-B', 2000), adopted: true, fileKept: false,
    },
    {
      // expiresAt is an expiration time (mint + expiresIn), not a write-order
      // proxy: B was issued later (issuedAt 3900 > 1400) despite a SMALLER expiresAt.
      name: 'adopts a later-issued file token with a smaller expiresAt',
      keyringTok: tok('at-A', 5000, 3600), fileTok: tok('at-B', 4000, 100), adopted: true, fileKept: false,
    },
    {
      name: 'a stale plaintext token never resurrects a revoked tombstone',
      keyringTok: revokedTombstone(sampleToken()), fileTok: tok('at-B', 2000), adopted: false, fileKept: true,
    },
    {
      // The inverse: plaintext must NOT force-revoke a valid keychain token
      // (a tombstone is timestamp-less, so it cannot order against it).
      name: 'a file-side tombstone never force-revokes a valid keychain token',
      keyringTok: tok('at-valid', 2000), fileTok: revokedTombstone(sampleToken()), adopted: false, fileKept: true,
    },
    {
      name: 'an equal-expiresAt tie is not strictly newer',
      keyringTok: tok('at-keyring', 1500), fileTok: tok('at-file', 1500), adopted: false, fileKept: true,
    },
    {
      name: 'a strictly-older file token is not adopted',
      keyringTok: tok('at-B', 2000), fileTok: tok('at-A', 1000), adopted: false, fileKept: true,
    },
    {
      name: 'a byte-equal plaintext duplicate is pruned (no migration)',
      keyringTok: tok('at-X', 1500), fileTok: tok('at-X', 1500), adopted: false, fileKept: false,
    },
  ])(
    'keychain HIT reconcile: $name',
    async ({ keyringTok, fileTok, adopted, fileKept }) => {
      await storage.save('kimi-code', keyringTok);
      await legacy.save('kimi-code', fileTok);

      const expected = adopted ? fileTok : keyringTok;
      expect(await storage.load('kimi-code')).toEqual(expected);
      const raw = keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
      expect(JSON.parse(raw as string)).toEqual(tokenToWire(expected));
      // A differing file is left in place (we never delete a token we did not
      // make authoritative); an adopted or byte-equal file is pruned.
      expect(existsSync(join(dir, 'kimi-code.json'))).toBe(fileKept);
      expect(observer.migrated).toEqual(adopted ? ['kimi-code'] : []);
    },
  );

  it('load() tolerates corrupt keychain JSON: undefined without a file, migration over it with one', async () => {
    keyring.store.set(`${KEYRING_SERVICE} kimi-code`, '{ not json');
    expect(await storage.load('kimi-code')).toBeUndefined();

    // A valid plaintext token is adopted over the corrupt payload.
    const token = sampleToken({ accessToken: 'from-file', refreshToken: 'from-file' });
    await legacy.save('kimi-code', token);
    expect(await storage.load('kimi-code')).toEqual(token);
    expect(keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword()).toBe(
      JSON.stringify(tokenToWire(token)),
    );
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    expect(observer.migrated).toEqual(['kimi-code']);
  });

  it('removal marker: load() does not resurrect, save() re-publishes and clears the marker', async () => {
    const token = sampleToken();
    await storage.save('kimi-code', token);
    await new FileTokenStorage(dir).remove('kimi-code'); // another process logged out

    // load() honors the cross-process marker and re-deletes the keychain entry.
    expect(await storage.load('kimi-code')).toBeUndefined();
    expect(keyring.findAccounts(KEYRING_SERVICE)).not.toContain('kimi-code');

    // A file recreated by a file-only process is pruned by the next save(),
    // which also clears the marker.
    writeFileSync(join(dir, 'kimi-code.json'), JSON.stringify(tokenToWire(token)));
    const restored = sampleToken({ accessToken: 'restored-keyring' });
    await storage.save('kimi-code', restored);
    expect(await storage.load('kimi-code')).toEqual(restored);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    expect(existsSync(join(dir, 'kimi-code.removed'))).toBe(false);
  });

  it('remove() disambiguates a false deleteCredential() via the service listing', async () => {
    // The native binding maps EVERY delete failure to the same `false` as "no
    // such entry"; disambiguation must come from findAccounts().
    const denying = Object.assign(new ConfigurableKeyring(), {
      deleteRemoves: false,
      deleteReturns: false,
    });
    const denyingStorage = new KeyringTokenStorage({ keyring: denying, legacy, observer });

    // Entry genuinely missing (absent from the listing): a no-op success that
    // still clears any plaintext copy — mirrors the file backend's ENOENT path.
    await expect(denyingStorage.remove('never-existed')).resolves.toBeUndefined();
    await legacy.save('kimi-code', sampleToken());
    await expect(denyingStorage.remove('kimi-code')).resolves.toBeUndefined();
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);

    // Entry SURVIVES on a reachable store: an error, NOT a degradation — but
    // the plaintext cleanup still runs.
    await denyingStorage.save('kimi-code', sampleToken());
    await legacy.save('kimi-code', sampleToken());
    await expect(denyingStorage.remove('kimi-code')).rejects.toThrow(
      /failed to delete keyring credential/,
    );
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    expect(denying.findAccounts(KEYRING_SERVICE)).toContain('kimi-code');
    expect(observer.degraded).toEqual([]); // no keyring API throw → no degradation
  });

  it('list() unions keyring accounts and un-migrated legacy names, deduped', async () => {
    await storage.save('alpha', sampleToken());
    await legacy.save('beta', sampleToken());
    await legacy.save('alpha', sampleToken());
    expect((await storage.list()).toSorted()).toEqual(['alpha', 'beta']);
  });

  // getPassword() collapses read errors to null (locked/inaccessible store):
  // a null read is "no such entry" OR "read failed". load() disambiguates via
  // findAccounts() — a listed account means the read failed, so the token is
  // unavailable, never logged-out, and never migrated over.
  it('read-error ambiguity on a null getPassword: unavailable, file fallback, unreachable listing degrades', async () => {
    const deniedKeyring = Object.assign(new ConfigurableKeyring(), { nullReadsAfter: 0 });
    const raw = JSON.stringify(tokenToWire(sampleToken({ accessToken: 'at-keychain' })));
    deniedKeyring.store.set(`${KEYRING_SERVICE} kimi-code`, raw);
    const denied = new KeyringTokenStorage({ keyring: deniedKeyring, legacy, observer });

    // No file: reported unavailable; the surviving entry is never overwritten.
    await expect(denied.load('kimi-code')).rejects.toThrow(
      /keyring unavailable while loading credential/,
    );
    expect(deniedKeyring.store.get(`${KEYRING_SERVICE} kimi-code`)).toBe(raw);

    // With a plaintext copy: falls back to it WITHOUT migrating.
    const fileToken = sampleToken({ accessToken: 'at-file' });
    await legacy.save('kimi-code', fileToken);
    expect(await denied.load('kimi-code')).toEqual(fileToken);
    expect(deniedKeyring.store.get(`${KEYRING_SERVICE} kimi-code`)).toBe(raw);
    expect(observer.migrated).toEqual([]);

    // An unreachable listing (findAccounts throws) degrades and falls back.
    const unreachableKeyring = Object.assign(new ConfigurableKeyring(), {
      nullReadsAfter: 0,
      throwOnFind: true,
    });
    const unreachable = new KeyringTokenStorage({ keyring: unreachableKeyring, legacy, observer });
    expect(await unreachable.load('kimi-code')).toEqual(fileToken);
    expect(observer.degraded).toEqual([{ operation: 'load', message: 'keychain store unreachable' }]);
  });

  // Strict drop-in parity with FileTokenStorage: same rule, same
  // /Invalid token name/ error, and the guard runs BEFORE any keychain op.
  it.each(['../../etc/passwd', '../etc/passwd', '.hidden', ''])(
    'save/load/remove reject invalid name %j without touching the keychain (no orphan)',
    async (bad) => {
      await expect(storage.save(bad, sampleToken())).rejects.toThrow(/Invalid token name/);
      await expect(storage.load(bad)).rejects.toThrow(/Invalid token name/);
      await expect(storage.remove(bad)).rejects.toThrow(/Invalid token name/);
      expect(keyring.store.size).toBe(0);
    },
  );

  // Any keyring call that THROWS reports onKeyringDegraded, flips the
  // process-wide sticky flag, and completes the operation against the file
  // store; every later operation goes straight to the file store.
  describe('per-operation degradation to the file store', () => {
    let flaky: ConfigurableKeyring;
    let degradedStorage: KeyringTokenStorage;

    beforeEach(() => {
      flaky = new ConfigurableKeyring();
      degradedStorage = new KeyringTokenStorage({ keyring: flaky, legacy, observer });
    });

    it('load() degrades on a keyring throw, never reports a keychain-only token as logged out, and stays degraded', async () => {
      // A keychain-only token during an outage: reported unavailable, NEVER logged out.
      await degradedStorage.save('kimi-code', sampleToken());
      flaky.throwOnGet = true;
      await expect(degradedStorage.load('kimi-code')).rejects.toThrow(
        /keyring unavailable while loading credential/,
      );
      expect(observer.degraded).toEqual([{ operation: 'load', message: 'keychain read failed' }]);

      // With a plaintext copy the degraded load reads the file WITHOUT migrating.
      const token = sampleToken();
      await legacy.save('kimi-code', token);
      expect(await degradedStorage.load('kimi-code')).toEqual(token);
      expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
      expect(flaky.store.size).toBe(1); // only the first healthy save
      expect(observer.degraded).toHaveLength(1); // sticky: no new keyring call, no new event

      // Sticky: the keyring is "healthy" again, yet every later op goes to file.
      flaky.throwOnGet = false;
      const newer = sampleToken({ accessToken: 'at-newer', refreshToken: 'rt-newer' });
      await degradedStorage.save('kimi-code', newer);
      expect(flaky.store.size).toBe(1);
      expect(await degradedStorage.load('kimi-code')).toEqual(newer);
      expect(await degradedStorage.list()).toEqual(['kimi-code']);
    });

    it('after an outage a revoked tombstone is refused and remove() still retries the keychain', async () => {
      const token = sampleToken();
      await degradedStorage.save('kimi-code', token);
      flaky.throwOnGet = true;
      await expect(degradedStorage.load('kimi-code')).rejects.toThrow(/keyring unavailable/);

      // A revoked tombstone persisted only to the plaintext fallback would
      // resurrect a revoked account on file-only peers — refuse it.
      await expect(degradedStorage.save('kimi-code', revokedTombstone(token))).rejects.toThrow(
        /keyring unavailable while saving revoked credential/,
      );
      expect(await legacy.load('kimi-code')).toBeUndefined();

      // remove() is the exception: logout must still retry the keychain so the
      // credential cannot survive a past outage.
      flaky.throwOnGet = false;
      await expect(degradedStorage.remove('kimi-code')).resolves.toBeUndefined();
      expect(flaky.findAccounts(KEYRING_SERVICE)).not.toContain('kimi-code');
    });

    it('save() writes the file when the keyring write throws', async () => {
      const token = sampleToken();
      flaky.throwOnSet = true;

      await expect(degradedStorage.save('kimi-code', token)).resolves.toBeUndefined();
      expect(await legacy.load('kimi-code')).toEqual(token);
      expect(flaky.store.size).toBe(0);
      expect(observer.degraded).toEqual([{ operation: 'save', message: 'keychain write failed' }]);
    });

    it.each([
      { name: 'deleteCredential throws', arm: (f: ConfigurableKeyring): void => { f.throwOnDelete = true; }, message: 'keychain delete failed' },
      { name: 'findAccounts throws', arm: (f: ConfigurableKeyring): void => { f.throwOnFind = true; }, message: 'keychain store unreachable' },
    ])(
      'remove() clears the plaintext file but surfaces the failure when $name',
      async ({ arm, message }) => {
        await legacy.save('kimi-code', sampleToken());
        arm(flaky);

        await expect(degradedStorage.remove('kimi-code')).rejects.toThrow(
          /failed to delete keyring credential/,
        );
        expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false); // legacy cleanup still ran
        expect(observer.degraded).toEqual([{ operation: 'remove', message }]);
      },
    );

    it('list() falls back to the file store when findAccounts throws', async () => {
      await legacy.save('beta', sampleToken());
      flaky.store.set(`${KEYRING_SERVICE} alpha`, JSON.stringify(tokenToWire(sampleToken())));
      flaky.throwOnFind = true;

      expect(await degradedStorage.list()).toEqual(['beta']);
      expect(observer.degraded).toEqual([{ operation: 'list', message: 'keychain store unreachable' }]);
    });

    it('a keyring throw mid-reconcile degrades and the file token wins', async () => {
      // The adoption write to the keychain throws → degrade → this load
      // returns the FILE token and the plaintext copy is kept.
      const tokenA = tok('at-A', 1000);
      const tokenB = tok('at-B', 2000);
      await degradedStorage.save('kimi-code', tokenA);
      await legacy.save('kimi-code', tokenB);
      flaky.throwOnSet = true;

      expect(await degradedStorage.load('kimi-code')).toEqual(tokenB);
      expect(observer.degraded).toEqual([{ operation: 'load', message: 'keychain write failed' }]);
      expect(observer.migrated).toEqual([]);
      expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
      const raw = flaky.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
      expect(JSON.parse(raw as string)).toEqual(tokenToWire(tokenA)); // keychain still holds A
    });

    it('migration degrades mid-loop: a newer file token that cannot be copied in wins', async () => {
      // Copy-in of A succeeds, but the pre-delete re-read finds a NEWER B on
      // disk and the B write throws → degrade → the file stays authoritative.
      const tokenA = sampleToken({ accessToken: 'at-A', refreshToken: 'rt-A' });
      const tokenB = sampleToken({ accessToken: 'at-B', refreshToken: 'rt-B' });
      class FlipLegacy extends FileTokenStorage {
        private calls = 0;
        override loadUnlocked(): TokenInfo | undefined {
          this.calls += 1;
          if (this.calls === 2) flaky.throwOnSet = true; // the B write fails
          return this.calls === 1 ? tokenA : tokenB;
        }
      }
      const flip = new FlipLegacy(dir);
      await flip.save('kimi-code', tokenA); // a real file that must survive
      const midLoopStorage = new KeyringTokenStorage({ keyring: flaky, legacy: flip, observer });

      expect(await midLoopStorage.load('kimi-code')).toEqual(tokenB);
      expect(observer.degraded).toEqual([{ operation: 'load', message: 'keychain write failed' }]);
      expect(observer.migrated).toEqual([]);
      expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
    });

    it('degradation is process-wide and reset by unregisterKeyringBackend()', async () => {
      const token = sampleToken();
      await legacy.save('kimi-code', token);
      flaky.throwOnGet = true;
      await degradedStorage.load('kimi-code'); // degrades the process-wide flag

      // A brand-new KeyringTokenStorage over a HEALTHY keyring still falls
      // back immediately — the sticky flag is not per-instance.
      const healthy = new FakeKeyring();
      const second = new KeyringTokenStorage({ keyring: healthy, legacy });
      expect(await second.load('kimi-code')).toEqual(token);
      expect(healthy.store.size).toBe(0); // no migration attempt
      await second.save('kimi-code', sampleToken({ accessToken: 'at-second' }));
      expect(healthy.store.size).toBe(0); // save went to the file

      unregisterKeyringBackend();
      const recovered = new KeyringTokenStorage({ keyring: healthy, legacy });
      await recovered.save('kimi-code', sampleToken());
      expect(healthy.store.size).toBe(1); // keyring writes work again
    });
  });
});

describe('resolveTokenStorage', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    unregisterKeyringBackend();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('KIMI_DISABLE_KEYRING=1 forces the file store; any other value leaves mode resolution alone', () => {
    const keyring = new FakeKeyring();
    const observer = new FakeObserver();
    registerKeyringBackend(keyring, observer);

    vi.stubEnv('KIMI_DISABLE_KEYRING', '0');
    expect(resolveTokenStorage(dir)).toBeInstanceOf(KeyringTokenStorage);

    // The kill switch beats a healthy backend AND credentials_store = keyring
    // in config.toml, and wins over the probe: no sentinel round-trip happens.
    vi.stubEnv('KIMI_DISABLE_KEYRING', '1');
    writeFileSync(join(dir, 'config.toml'), 'credentials_store = "keyring"\n');
    const storage = resolveTokenStorage(join(dir, 'credentials'));
    expect(storage).toBeInstanceOf(FileTokenStorage);
    expect(storage).not.toBeInstanceOf(KeyringTokenStorage);
    expect(keyring.store.size).toBe(0);
    expect(observer.selected).toEqual([
      { backend: 'keyring', reason: 'auto' },
      { backend: 'file', reason: 'disabled' },
    ]);
  });

  it('selects KeyringTokenStorage via the registered backend (production path, default auto coexistence)', async () => {
    const keyring = new FakeKeyring();
    const observer = new FakeObserver();
    registerKeyringBackend(keyring, observer);

    const storage = resolveTokenStorage(dir);
    expect(storage).toBeInstanceOf(KeyringTokenStorage);
    expect(observer.selected).toEqual([{ backend: 'keyring', reason: 'auto' }]);

    await storage.save('kimi-code', sampleToken());
    expect(keyring.store.get(`${keyringServiceForCredentialsDir(dir)} kimi-code`)).toBeDefined();
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true); // 'auto' dual-writes the bridge
  });

  it('getRegisteredKeyringBackend() reflects registration, re-registration, and unregistration', () => {
    expect(getRegisteredKeyringBackend()).toBeUndefined();

    const first = new FakeKeyring();
    const observer = new FakeObserver();
    registerKeyringBackend(first, observer);
    expect(getRegisteredKeyringBackend()?.api).toBe(first);
    expect(getRegisteredKeyringBackend()?.observer).toBe(observer);

    const second = new FakeKeyring();
    registerKeyringBackend(second);
    expect(getRegisteredKeyringBackend()?.api).toBe(second);
    expect(getRegisteredKeyringBackend()?.observer).toBeUndefined();

    unregisterKeyringBackend();
    expect(getRegisteredKeyringBackend()).toBeUndefined();
  });

  it('falls back to FileTokenStorage when no backend is registered', () => {
    const observer = new FakeObserver();
    const storage = resolveTokenStorage(dir, { loadKeyring: () => undefined, observer });
    expect(storage).toBeInstanceOf(FileTokenStorage);
    expect(observer.selected).toEqual([{ backend: 'file', reason: 'no-backend' }]);
  });

  // Once selected the keychain is the AUTHORITATIVE store, so logout and
  // migrate-then-delete depend on delete working. The probe round-trips a
  // sentinel under an isolated service and never trusts the
  // deleteCredential() boolean — removal is proven via findAccounts().
  it.each([
    { name: 'entry construction throws', configure: { createThrows: true } },
    { name: 'entry operations throw', configure: { throwOnGet: true, throwOnSet: true, throwOnDelete: true } },
    { name: 'delete is denied: returns false, sentinel survives', configure: { deleteRemoves: false, deleteReturns: false } },
    { name: 'delete lies: returns true, sentinel survives', configure: { deleteRemoves: false, deleteReturns: true } },
    { name: 'read is denied after delete: null while the sentinel survives', configure: { deleteRemoves: false, deleteReturns: false, nullReadsAfter: 1 } },
    { name: 'findAccounts throws mid-probe: unreachable store', configure: { throwOnFind: true } },
  ])('rejects a keyring whose $name', ({ configure }) => {
    const observer = new FakeObserver();
    const storage = resolveTokenStorage(dir, {
      loadKeyring: () => Object.assign(new ConfigurableKeyring(), configure),
      observer,
    });
    expect(storage).toBeInstanceOf(FileTokenStorage);
    expect(storage).not.toBeInstanceOf(KeyringTokenStorage);
    expect(observer.selected).toEqual([{ backend: 'file', reason: 'probe-failed' }]);
  });

  it('the probe uses a unique, non-constant account per attempt and leaves no sentinel behind', async () => {
    const a = new RecordingKeyring();
    const b = new RecordingKeyring();
    const storage = resolveTokenStorage(dir, { loadKeyring: () => a });
    resolveTokenStorage(dir, { loadKeyring: () => b });

    // One consistent account within an attempt, distinct across attempts, so
    // concurrent probes cannot clobber each other's sentinel round-trip.
    const aAccounts = a.accountsByService.get(KEYRING_PROBE_SERVICE) ?? [];
    const bAccounts = b.accountsByService.get(KEYRING_PROBE_SERVICE) ?? [];
    expect(aAccounts.length).toBeGreaterThan(0);
    expect(new Set(aAccounts).size).toBe(1);
    expect(aAccounts[0]).not.toBe(bAccounts[0]);

    // No sentinel leaks into the real service list or stays in the probe service.
    expect(await storage.list()).toEqual([]);
    expect(a.findAccounts(KEYRING_PROBE_SERVICE)).toEqual([]);
  });

  it("mode 'file' selects the file store via deps.mode or <home>/config.toml", () => {
    const observer = new FakeObserver();
    const viaDeps = resolveTokenStorage(dir, {
      loadKeyring: () => new FakeKeyring(),
      observer,
      mode: 'file',
    });
    expect(viaDeps).toBeInstanceOf(FileTokenStorage);
    expect(viaDeps).not.toBeInstanceOf(KeyringTokenStorage);

    writeFileSync(join(dir, 'config.toml'), 'credentials_store = "file"\n');
    const viaConfig = resolveTokenStorage(join(dir, 'credentials'), {
      loadKeyring: () => new FakeKeyring(),
      observer,
    });
    expect(viaConfig).toBeInstanceOf(FileTokenStorage);
    expect(observer.selected).toEqual([
      { backend: 'file', reason: 'mode-file' },
      { backend: 'file', reason: 'mode-file' },
    ]);
  });

  it("mode 'keyring' prunes the plaintext file on save; mode 'auto' keeps it as a dual-written bridge", async () => {
    const keyring = new FakeKeyring();
    const service = keyringServiceForCredentialsDir(dir);

    const strict = resolveTokenStorage(dir, { loadKeyring: () => keyring, mode: 'keyring' });
    expect(strict).toBeInstanceOf(KeyringTokenStorage);
    await new FileTokenStorage(dir).save('kimi-code', sampleToken({ accessToken: 'stale' }));
    await strict.save('kimi-code', sampleToken());
    expect(keyring.createEntry(service, 'kimi-code').getPassword()).not.toBeNull();
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);

    const coexist = resolveTokenStorage(dir, { loadKeyring: () => keyring, mode: 'auto' });
    expect(coexist).toBeInstanceOf(KeyringTokenStorage);
    await coexist.save('kimi-code', sampleToken());
    expect(keyring.createEntry(service, 'kimi-code').getPassword()).not.toBeNull();
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
  });
});

describe('resolveCredentialsStoreMode', () => {
  let home: string;
  let credentialsDir: string;
  let configPath: string;

  beforeEach(() => {
    home = makeTmpDir();
    credentialsDir = join(home, 'credentials');
    configPath = join(home, 'config.toml');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it.each([
    { name: 'config.toml is missing', content: undefined },
    { name: 'the key is absent', content: 'default_model = "kimi-code"\n' },
    { name: 'the value is unrecognized', content: 'credentials_store = "vault"\n' },
    { name: 'the TOML is malformed', content: 'credentials_store = \n' },
  ])("falls back to 'auto' when $name", ({ content }) => {
    if (content !== undefined) writeFileSync(configPath, content);
    expect(resolveCredentialsStoreMode(credentialsDir)).toBe('auto');
  });

  it.each(['file', 'keyring', 'auto'] as const)('reads %s from config.toml', (mode) => {
    writeFileSync(configPath, `${CREDENTIALS_STORE_CONFIG_KEY} = "${mode}"\n`);
    expect(resolveCredentialsStoreMode(credentialsDir)).toBe(mode);
  });

  it('deps.mode and deps.configPath override config resolution', () => {
    writeFileSync(configPath, 'credentials_store = "file"\n');
    expect(resolveCredentialsStoreMode(credentialsDir, { mode: 'keyring' })).toBe('keyring');

    const elsewhere = join(home, 'elsewhere.toml');
    writeFileSync(elsewhere, 'credentials_store = "keyring"\n');
    expect(resolveCredentialsStoreMode(credentialsDir, { configPath: elsewhere })).toBe('keyring');
  });
});

describe('KeyringTokenStorage coexist (auto mode)', () => {
  let dir: string;
  let keyring: FakeKeyring;
  let service: string;
  let storage: KeyringTokenStorage;

  const seedKeychain = (name: string, token: TokenInfo): void => {
    keyring.createEntry(service, name).setPassword(JSON.stringify(tokenToWire(token)));
  };
  const keychainRaw = (name: string): string | null =>
    keyring.createEntry(service, name).getPassword();
  const fileWire = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf-8')) as Record<string, unknown>;

  function makeStorage(k: FakeKeyring, observer?: FakeObserver): KeyringTokenStorage {
    return new KeyringTokenStorage({
      keyring: k,
      legacy: new FileTokenStorage(dir),
      service,
      observer,
      coexist: true,
    });
  }

  beforeEach(() => {
    dir = makeTmpDir();
    keyring = new FakeKeyring();
    service = keyringServiceForCredentialsDir(dir);
    storage = makeStorage(keyring);
  });

  afterEach(() => {
    unregisterKeyringBackend();
    rmSync(dir, { recursive: true, force: true });
  });

  it('save() dual-writes both stores and still lands on disk when the keychain write throws', async () => {
    const token = sampleToken();
    await storage.save('kimi-code', token);
    expect(keychainRaw('kimi-code')).toBe(JSON.stringify(tokenToWire(token)));
    expect(fileWire('kimi-code')['access_token']).toBe(token.accessToken);

    // File FIRST: a keychain failure degrades to the already-written bridge.
    const flaky = new ConfigurableKeyring();
    const observer = new FakeObserver();
    const s = makeStorage(flaky, observer);
    flaky.throwOnSet = true;
    await s.save('kimi-code', sampleToken());
    expect(fileWire('kimi-code')['access_token']).toBe('at-abc');
    expect(observer.degraded.map((d) => d.operation)).toContain('save');
  });

  it('load() repairs a missing or stale plaintext bridge from an authoritative keychain', async () => {
    // Missing bridge: recreated from the keychain.
    seedKeychain('kimi-code', sampleToken());
    expect((await storage.load('kimi-code'))?.accessToken).toBe('at-abc');
    expect(fileWire('kimi-code')['access_token']).toBe('at-abc');

    // Stale bridge (older valid token): overwritten with the keychain's newer one.
    await new FileTokenStorage(dir).save(
      'kimi-code',
      sampleToken({ accessToken: 'stale', expiresAt: 1_000_000_000 }),
    );
    expect((await storage.load('kimi-code'))?.accessToken).toBe('at-abc');
    expect(fileWire('kimi-code')['access_token']).toBe('at-abc');
  });

  it('load() migrates a disk-only token and adopts a fresher plaintext token, keeping the bridge', async () => {
    const observer = new FakeObserver();
    const s = makeStorage(keyring, observer);

    // Disk-only: copied into the keychain, bridge kept, migration reported.
    await new FileTokenStorage(dir).save('kimi-code', sampleToken());
    expect((await s.load('kimi-code'))?.accessToken).toBe('at-abc');
    expect(JSON.parse(keychainRaw('kimi-code') as string)['access_token']).toBe('at-abc');
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
    expect(observer.migrated).toEqual(['kimi-code']);

    // Fresher plaintext (a file-only peer wrote a newer token): adopted into
    // the keychain, bridge kept.
    await new FileTokenStorage(dir).save(
      'kimi-code',
      sampleToken({ accessToken: 'at-fresh', expiresAt: 1_700_000_000 + 7200 }),
    );
    expect((await s.load('kimi-code'))?.accessToken).toBe('at-fresh');
    expect(JSON.parse(keychainRaw('kimi-code') as string)['access_token']).toBe('at-fresh');
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
  });

  it('a removed token is not resurrected by bridge repair', async () => {
    seedKeychain('kimi-code', sampleToken());
    await storage.remove('kimi-code');
    // A stale keychain entry survives (written by another process after the
    // removal): the removal marker must block bridge repair AND the load must
    // re-delete the keychain entry.
    seedKeychain('kimi-code', sampleToken());
    expect(await storage.load('kimi-code')).toBeUndefined();
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    expect(keychainRaw('kimi-code')).toBeNull();
  });

  it('a keychain tombstone outranks a valid plaintext token and leaves the bridge untouched', async () => {
    seedKeychain('kimi-code', revokedTombstone(sampleToken()));
    await new FileTokenStorage(dir).save('kimi-code', sampleToken());

    expect((await storage.load('kimi-code'))?.accessToken).toBe('');
    // The valid file login is NOT wiped: it may be genuinely newer, and the
    // next refresh's dual-write heals the asymmetry.
    expect(fileWire('kimi-code')['access_token']).toBe('at-abc');
  });
});
