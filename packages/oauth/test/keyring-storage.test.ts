/**
 * KeyringTokenStorage + resolveTokenStorage tests — fully hermetic.
 *
 * NEVER touches the real OS keychain: the keyring backend is an in-memory
 * fake `KeyringApi` (a Map keyed by `service\u0000account`). The file fallback
 * uses a real `FileTokenStorage` over a tmp dir so migration + union with the
 * plaintext store are exercised end-to-end. The registration slot and the
 * process-wide degradation flag are reset via `unregisterKeyringBackend()`
 * after every test.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getRegisteredKeyringBackend,
  isKeyringOptedIn,
  KEYRING_PROBE_SERVICE,
  KEYRING_SERVICE,
  KeyringTokenStorage,
  keyringServiceForCredentialsDir,
  registerKeyringBackend,
  resolveTokenStorage,
  unregisterKeyringBackend,
} from '../src/keyring-storage';
import type { KeyringApi, KeyringEntry, KeyringStorageObserver } from '../src/keyring-storage';
import { FileTokenStorage } from '../src/storage';
import { classifyToken, revokedTombstone } from '../src/token-state';
import type { TokenInfo } from '../src/types';
import { tokenToWire } from '../src/types';

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `kimi-keyring-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
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

/** A KeyringApi whose entry operations always throw (exercises probe fallback). */
class ThrowingKeyring implements KeyringApi {
  createEntry(): KeyringEntry {
    return {
      getPassword(): string | null {
        throw new Error('no keychain backend available');
      },
      setPassword(): void {
        throw new Error('no keychain backend available');
      },
      deleteCredential(): boolean {
        throw new Error('no keychain backend available');
      },
    };
  }

  findAccounts(): string[] {
    return [];
  }
}

/** A KeyringApi whose native entry constructor fails before any operation. */
class ConstructorThrowingKeyring implements KeyringApi {
  createEntry(): KeyringEntry {
    throw new Error('keychain entry initialization failed');
  }

  findAccounts(): string[] {
    return [];
  }
}

/**
 * Records every account `createEntry` is asked for, per service, so the probe's
 * account-uniqueness can be asserted. Functionally identical to FakeKeyring.
 */
class RecordingKeyring extends FakeKeyring {
  public readonly accountsByService = new Map<string, string[]>();

  override createEntry(service: string, account: string): KeyringEntry {
    const seen = this.accountsByService.get(service) ?? [];
    seen.push(account);
    this.accountsByService.set(service, seen);
    return super.createEntry(service, account);
  }
}

/** A FakeKeyring whose individual operations can be made to throw on demand. */
class FlakyKeyring extends FakeKeyring {
  public throwOnGet = false;
  public throwOnSet = false;
  public throwOnDelete = false;
  public throwOnFind = false;

  override createEntry(service: string, account: string): KeyringEntry {
    const base = super.createEntry(service, account);
    return {
      getPassword: (): string | null => {
        if (this.throwOnGet) throw new Error('keychain read failed');
        return base.getPassword();
      },
      setPassword: (p: string): void => {
        if (this.throwOnSet) throw new Error('keychain write failed');
        base.setPassword(p);
      },
      deleteCredential: (): boolean => {
        if (this.throwOnDelete) throw new Error('keychain delete failed');
        return base.deleteCredential();
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

  it('round-trips a token via save/load/list/remove', async () => {
    const token = sampleToken();
    expect(await storage.load('kimi-code')).toBeUndefined();

    await storage.save('kimi-code', token);
    expect(await storage.load('kimi-code')).toEqual(token);
    expect(await storage.list()).toEqual(['kimi-code']);

    await storage.remove('kimi-code');
    expect(await storage.load('kimi-code')).toBeUndefined();
    expect(await storage.list()).toEqual([]);
  });

  it('stores the password as the snake_case wire JSON under KEYRING_SERVICE', async () => {
    const token = sampleToken();
    await storage.save('kimi-code', token);
    const raw = keyring.store.get(`${KEYRING_SERVICE}\u0000kimi-code`);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string)).toEqual(tokenToWire(token));
  });

  it('save() prunes a lingering plaintext copy after writing the keychain', async () => {
    // A stale plaintext file lingers from a prior file-backend run (or a
    // keychain-wins reconcile that left an older file). A later save() must make
    // the keychain authoritative AND drop the cleartext, so a subsequent
    // KIMI_DISABLE_KEYRING / probe-failure run (keychain-unaware FileTokenStorage)
    // can no longer resurrect the obsolete token, and no secret lingers on disk.
    const fileTok = sampleToken({ accessToken: 'at-stale-file', refreshToken: 'rt-stale-file' });
    const newTok = sampleToken({ accessToken: 'at-new', refreshToken: 'rt-new' });
    await legacy.save('kimi-code', fileTok);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);

    await storage.save('kimi-code', newTok);

    const raw = keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
    expect(raw).toBe(JSON.stringify(tokenToWire(newTok)));
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
  });

  it('save() is a no-op on the file when none exists (ENOENT path)', async () => {
    const tok = sampleToken({ accessToken: 'at-fresh', refreshToken: 'rt-fresh' });
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);

    await expect(storage.save('kimi-code', tok)).resolves.toBeUndefined();

    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    const raw = keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
    expect(JSON.parse(raw as string)).toEqual(tokenToWire(tok));
  });

  it('migrates a plaintext token into the keychain, then deletes the file', async () => {
    const token = sampleToken();
    await legacy.save('kimi-code', token);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);

    // First load migrates: returns the token, populates keyring, removes file,
    // and reports the migration to the observer.
    const loaded = await storage.load('kimi-code');
    expect(loaded).toEqual(token);
    expect(keyring.store.get(`${KEYRING_SERVICE}\u0000kimi-code`)).toBeDefined();
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    expect(observer.migrated).toEqual(['kimi-code']);

    // Second load reads straight from the keychain (file already gone).
    expect(await storage.load('kimi-code')).toEqual(token);
    expect(observer.migrated).toEqual(['kimi-code']);
  });

  it('compare-and-delete: a file under persistent churn is NEVER deleted', async () => {
    // A legacy store whose value is DIFFERENT on every read — modelling a
    // concurrent file-backend writer that keeps landing a fresher token on disk
    // between every one of our re-reads, so the on-disk value never stabilises to
    // match the one we just made keychain-authoritative. Under this persistent
    // churn the bounded converge loop must exhaust its budget WITHOUT ever
    // unlinking the file (we must never delete a token whose on-disk bytes differ
    // from what we migrated). A later load will reconcile.
    // More distinct values than the loop's re-read budget, so the file never
    // stabilises within the budget. The fallback keeps `load` total even past
    // the array (it is never reached in practice).
    const seed = sampleToken({ accessToken: 'at-1', refreshToken: 'rt-1' });
    const tokens: TokenInfo[] = [
      seed,
      sampleToken({ accessToken: 'at-2', refreshToken: 'rt-2' }),
      sampleToken({ accessToken: 'at-3', refreshToken: 'rt-3' }),
      sampleToken({ accessToken: 'at-4', refreshToken: 'rt-4' }),
      sampleToken({ accessToken: 'at-5', refreshToken: 'rt-5' }),
    ];
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
    // Seed a real file so a (wrongful) remove would be observable on disk.
    await racy.save('kimi-code', seed);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);

    const racyStorage = new KeyringTokenStorage({ keyring, legacy: racy, observer });
    const loaded = await racyStorage.load('kimi-code');

    // The keychain ends authoritative with the newest value the loop observed
    // before its budget ran out, load returns that value, the file is NEVER
    // deleted (every re-read differed from the migrated value), and remove was
    // never even called.
    const latest = tokens.at(racy.loadCalls - 1) ?? lastToken;
    expect(loaded).toEqual(latest);
    expect(racy.removeCalls).toBe(0);
    const raw = keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
    expect(JSON.parse(raw as string)).toEqual(tokenToWire(latest));
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
    // No completed migration (the cleartext is still there) → no event.
    expect(observer.migrated).toEqual([]);
  });

  it('compare-and-delete: a stable file that matches the migrated value is deleted', async () => {
    // The file value never changes across re-reads, so after copying it into the
    // keychain the pre-delete re-read matches → safe to unlink the cleartext.
    const t1 = sampleToken({ accessToken: 'at-stable', refreshToken: 'rt-stable' });
    class StableLegacy extends FileTokenStorage {
      public removeCalls = 0;
      override removeIfMatchesUnlocked(name: string, expected: string): boolean {
        this.removeCalls += 1;
        return super.removeIfMatchesUnlocked(name, expected);
      }
    }
    const stable = new StableLegacy(dir);
    await stable.save('kimi-code', t1);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);

    const stableStorage = new KeyringTokenStorage({ keyring, legacy: stable, observer });
    const loaded = await stableStorage.load('kimi-code');

    expect(loaded).toEqual(t1);
    expect(stable.removeCalls).toBe(1);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    const raw = keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
    expect(JSON.parse(raw as string)).toEqual(tokenToWire(t1));
    expect(observer.migrated).toEqual(['kimi-code']);
  });

  it('keychain HIT reconcile: adopts a strictly-newer plaintext token (sequential fallback flip-flop)', async () => {
    // Models the flip-flop bug: keychain holds an OLDER valid token A; a later
    // run that fell back to the file backend wrote a NEWER valid token B to the
    // same dir+name. On the next keychain-usable run, load() must adopt B (the
    // user's real, newer token), make the keychain authoritative with B, and
    // drop the now-migrated plaintext copy.
    const tokenA = sampleToken({ accessToken: 'at-A', refreshToken: 'rt-A', expiresAt: 1000 });
    const tokenB = sampleToken({ accessToken: 'at-B', refreshToken: 'rt-B', expiresAt: 2000 });

    await storage.save('kimi-code', tokenA); // keychain holds older A
    await legacy.save('kimi-code', tokenB); // file holds newer B
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);

    const loaded = await storage.load('kimi-code');
    expect(loaded).toEqual(tokenB);

    // Keychain is now authoritative with B's exact wire bytes.
    const raw = keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
    expect(JSON.parse(raw as string)).toEqual(tokenToWire(tokenB));

    // The migrated plaintext copy is gone, and the adoption was reported.
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    expect(observer.migrated).toEqual(['kimi-code']);
  });

  it('keychain HIT reconcile: adopts a file token issued later despite a SMALLER expiresAt (shorter expiresIn)', async () => {
    // Regression for the variable-`expires_in` flip-flop. `expiresAt` is an
    // EXPIRATION time = mintSecond + expiresIn, so it is NOT a write-order proxy.
    // Keychain holds an OLDER token A minted with a LONGER lifetime; a later
    // file-backend fallback run wrote a genuinely NEWER rotated token B with a
    // SHORTER lifetime, so B.expiresAt < A.expiresAt even though B was issued
    // later. The adoption guard must compare issuance order (expiresAt - expiresIn)
    // and adopt B. The old expiresAt-only guard returned A (4000 > 5000 is false).
    const tokenA = sampleToken({
      accessToken: 'at-keyring',
      refreshToken: 'rt-A',
      expiresAt: 5000,
      expiresIn: 3600,
    }); // issuedAt 1400
    const tokenB = sampleToken({
      accessToken: 'at-file',
      refreshToken: 'rt-B',
      expiresAt: 4000,
      expiresIn: 100,
    }); // issuedAt 3900 — issued later, shorter life, LOWER expiresAt

    await storage.save('kimi-code', tokenA); // keychain holds older A
    await legacy.save('kimi-code', tokenB); // file holds newer B (lower expiresAt)
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);

    const loaded = await storage.load('kimi-code');
    expect(loaded).toEqual(tokenB);

    // Keychain is now authoritative with B's exact wire bytes.
    const raw = keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
    expect(JSON.parse(raw as string)).toEqual(tokenToWire(tokenB));

    // The migrated plaintext copy is gone.
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
  });

  it('keychain HIT reconcile: a stale plaintext token NEVER resurrects a revoked tombstone', async () => {
    // Keychain holds a deliberate revoked tombstone (refresh_token was rejected);
    // a stale valid token still sits in the plaintext file. load() must NOT
    // un-revoke from plaintext — the tombstone stays authoritative and B is not
    // promoted. The file is left in place (its bytes differ from the
    // authoritative tombstone, so the conservative cleanup does not delete it).
    const prior = sampleToken();
    const tombstone = revokedTombstone(prior);
    const validB = sampleToken({ accessToken: 'at-B', refreshToken: 'rt-B', expiresAt: 2000 });

    await storage.save('kimi-code', tombstone); // keychain holds the tombstone
    await legacy.save('kimi-code', validB); // stale valid plaintext

    const loaded = await storage.load('kimi-code');
    expect(loaded).toBeDefined();
    expect(classifyToken(loaded).kind).toBe('revoked');
    expect((loaded as TokenInfo).accessToken).toBe('');

    // The tombstone is still authoritative; B was NOT promoted.
    const raw = keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
    expect(JSON.parse(raw as string)).toEqual(tokenToWire(tombstone));

    // Conservative: a file whose bytes differ from the authoritative value is
    // left in place (we never delete a token we did not make authoritative).
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
  });

  // CHARACTERIZATION/guard test: pins the deliberate keychain-authoritative
  // tradeoff for the INVERSE of the no-un-revoke direction. It encodes CURRENT
  // behavior (expected to pass on current code) — not a fix verification.
  it('reconcileOnHit() keeps a valid keychain token authoritative over a file-side tombstone (no force-revoke from plaintext)', async () => {
    // Inverse of the no-un-revoke test: keychain holds a VALID token; a file-side
    // tombstone (a fallback run's token was 401-rejected) sits in the plaintext
    // file. A tombstone is timestamp-less (issuedAt === 0), so it cannot order
    // against the keychain token — and the less-trusted plaintext must NOT
    // force-revoke the keychain. load() must return the keychain's VALID token,
    // leave the keychain entry unchanged, and leave the file tombstone in place.
    const valid = sampleToken({ accessToken: 'at-valid', refreshToken: 'rt-valid', expiresAt: 2000 });
    const tombstone = revokedTombstone(valid);

    await storage.save('kimi-code', valid); // keychain holds the VALID token
    await legacy.save('kimi-code', tombstone); // file holds a revoked tombstone
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);

    const loaded = await storage.load('kimi-code');
    // The keychain's VALID token wins — NOT a revoked/undefined result.
    expect(loaded).toEqual(valid);
    expect(classifyToken(loaded).kind).toBe('valid');
    expect((loaded as TokenInfo).accessToken).toBe('at-valid');

    // The keychain entry is UNCHANGED — it was not tombstoned or deleted.
    const raw = keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
    expect(JSON.parse(raw as string)).toEqual(tokenToWire(valid));

    // The file tombstone is LEFT IN PLACE (conservative "leave differing file"):
    // its bytes differ from the authoritative keychain value, so it is not pruned,
    // and the plaintext is never allowed to force-revoke the keychain.
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
    const fileRaw = await legacy.load('kimi-code');
    expect(classifyToken(fileRaw).kind).toBe('revoked');
  });

  it('keychain HIT reconcile: prunes a plaintext duplicate equal after canonical re-serialization', async () => {
    // Keychain and file hold the SAME token (a just-migrated state observed by a
    // concurrent peer, or a redundant copy). load() returns the keychain value
    // and prunes the redundant cleartext, since it equals the authoritative
    // keychain value after canonical re-serialization. Nothing was migrated —
    // the keychain already held the token — so no onMigrated event fires.
    const x = sampleToken({ accessToken: 'at-X', refreshToken: 'rt-X', expiresAt: 1500 });
    await storage.save('kimi-code', x); // keychain holds X
    await legacy.save('kimi-code', x); // redundant duplicate plaintext X
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);

    const loaded = await storage.load('kimi-code');
    expect(loaded).toEqual(x);

    const raw = keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
    expect(JSON.parse(raw as string)).toEqual(tokenToWire(x));
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    expect(observer.migrated).toEqual([]);
  });

  it('keychain HIT reconcile: equal expiresAt is NOT strictly newer, keychain wins and file is left intact', async () => {
    // Pins the strict `>` (not `>=`) adoption decision: keychain holds valid X
    // and the file holds a DIFFERENT valid Y with the SAME expiresAt. Since the
    // file is not STRICTLY newer, the keychain stays authoritative, load returns
    // X, and the differing file is left in place (conservative — not a redundant
    // duplicate, not made authoritative).
    const x = sampleToken({ accessToken: 'at-keyring', refreshToken: 'rt-keyring', expiresAt: 1500 });
    const y = sampleToken({ accessToken: 'at-file', refreshToken: 'rt-file', expiresAt: 1500 });

    await storage.save('kimi-code', x); // keychain holds X
    await legacy.save('kimi-code', y); // file holds a DIFFERENT token, same expiresAt
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);

    const loaded = await storage.load('kimi-code');
    expect(loaded).toEqual(x);

    // Keychain bytes are still X (Y was NOT promoted on an equal-expiresAt tie).
    const raw = keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
    expect(JSON.parse(raw as string)).toEqual(tokenToWire(x));

    // The differing file is left intact (not a redundant duplicate).
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
  });

  it('keychain HIT reconcile: keyring-newer wins, the older file is left intact', async () => {
    // Keychain holds the NEWER valid token B; the file holds an OLDER A. The
    // keychain stays authoritative (file is not strictly newer) and load returns
    // B. The older file is left in place — conservative: we only delete a file
    // we made authoritative or one that is byte-identical to the authoritative
    // value, and this older A is neither.
    const tokenA = sampleToken({ accessToken: 'at-A', refreshToken: 'rt-A', expiresAt: 1000 });
    const tokenB = sampleToken({ accessToken: 'at-B', refreshToken: 'rt-B', expiresAt: 2000 });

    await storage.save('kimi-code', tokenB); // keychain holds newer B
    await legacy.save('kimi-code', tokenA); // file holds older A

    const loaded = await storage.load('kimi-code');
    expect(loaded).toEqual(tokenB);

    const raw = keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
    expect(JSON.parse(raw as string)).toEqual(tokenToWire(tokenB));

    // Older file left intact (not byte-identical to B, not made authoritative).
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
  });

  it('keychain HIT fast path: a keychain value with no file returns the keychain token unchanged', async () => {
    // Steady state: token only in the keychain, no plaintext file. load() must
    // return it via the cheap fast path without touching the keychain or any
    // file (just one ENOENT readFile under the hood).
    const x = sampleToken({ accessToken: 'at-only', refreshToken: 'rt-only', expiresAt: 1234 });
    await storage.save('kimi-code', x);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);

    const loaded = await storage.load('kimi-code');
    expect(loaded).toEqual(x);

    const raw = keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
    expect(JSON.parse(raw as string)).toEqual(tokenToWire(x));
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
  });

  it('remove() surfaces a failed keychain delete that returns false (real @napi-rs/keyring never throws)', async () => {
    // The REAL @napi-rs/keyring binding maps EVERY delete failure (locked
    // keychain, no-access, ambiguous, platform error) to a plain `false` and
    // NEVER throws — the SAME `false` returned for "no such entry". This fake
    // models a delete that FAILS while the entry SURVIVES on a REACHABLE store:
    // remove() must disambiguate via the service listing and surface the
    // failure — otherwise a logout would clear the plaintext but silently leave
    // the keychain token alive. A surviving entry on a reachable store is an
    // error, NOT a degradation (the keyring API itself did not throw).
    const token = sampleToken();

    class FailingDeleteKeyring extends FakeKeyring {
      override createEntry(service: string, account: string): KeyringEntry {
        const base = super.createEntry(service, account);
        return {
          getPassword: () => base.getPassword(),
          setPassword(p: string): void {
            base.setPassword(p);
          },
          // Genuine failure: returns false but the credential is NOT removed,
          // so findAccounts() still lists it.
          deleteCredential(): boolean {
            return false;
          },
        };
      }
    }

    const failingKeyring = new FailingDeleteKeyring();
    const failingStorage = new KeyringTokenStorage({ keyring: failingKeyring, legacy, observer });

    // Seed the keychain (the credential persists through the failed delete) and a
    // lingering plaintext copy that must still be cleared.
    await failingStorage.save('kimi-code', token);
    await legacy.save('kimi-code', token);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);

    // The genuine keyring failure must be surfaced...
    await expect(failingStorage.remove('kimi-code')).rejects.toThrow(
      /failed to delete keyring credential/,
    );
    // ...but the legacy plaintext cleanup must still have run.
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    // The keychain credential genuinely survived (the bug being guarded against).
    expect(failingKeyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword()).not.toBeNull();
    // No keyring API throw → no degradation.
    expect(observer.degraded).toEqual([]);
  });

  it('remove() treats deleteCredential()=false with the name absent from the service listing as a no-op success', async () => {
    // A bare `false` from deleteCredential() is overloaded: it means "delete
    // failed" OR "no such entry". getPassword() cannot disambiguate (the binding
    // collapses every read error to null), so absence is proven via the
    // service-scoped findAccounts() listing: when the reachable store does NOT
    // list `name`, the entry is genuinely gone, so logging out must RESOLVE
    // without throwing (mirrors FileTokenStorage's ENOENT no-op).
    class AbsentDeleteKeyring extends FakeKeyring {
      override createEntry(service: string, account: string): KeyringEntry {
        const base = super.createEntry(service, account);
        return {
          getPassword: () => base.getPassword(),
          setPassword(p: string): void {
            base.setPassword(p);
          },
          // Mirrors the native binding's "did not exist" → false; never touches
          // the backing store, so findAccounts() does NOT list the name.
          deleteCredential(): boolean {
            return false;
          },
        };
      }
    }

    const absentStorage = new KeyringTokenStorage({ keyring: new AbsentDeleteKeyring(), legacy });
    await expect(absentStorage.remove('never-existed')).resolves.toBeUndefined();
  });

  it('remove() surfaces a denied delete when the entry survives AND the read is denied (getPassword null)', async () => {
    // The binding collapses every read error to null, so a denied/locked read
    // returns null EVEN THOUGH the entry still exists. Here getPassword()
    // returns null (read denied) while the entry STILL lives in the backing
    // store (so findAccounts lists it) and deleteCredential() returns false
    // without removing it. Keying off `getPassword() !== null` would silently
    // no-op and the keychain credential would SURVIVE while the plaintext is
    // wiped. Proving absence via the service listing surfaces the failure —
    // after still clearing the plaintext copy.
    const token = sampleToken();

    class DeniedReadSurvivingKeyring extends FakeKeyring {
      override createEntry(service: string, account: string): KeyringEntry {
        const base = super.createEntry(service, account);
        return {
          // Read is DENIED: collapses to null even though the entry exists.
          getPassword: () => null,
          setPassword(p: string): void {
            base.setPassword(p);
          },
          // Denied delete: returns false and the entry SURVIVES in the store.
          deleteCredential(): boolean {
            return false;
          },
        };
      }
    }

    const deniedKeyring = new DeniedReadSurvivingKeyring();
    const deniedStorage = new KeyringTokenStorage({ keyring: deniedKeyring, legacy });

    // Seed the keychain (entry persists through the denied delete) and a lingering
    // plaintext copy that must still be cleared.
    deniedKeyring.store.set(`${KEYRING_SERVICE}\u0000kimi-code`, JSON.stringify(tokenToWire(token)));
    await legacy.save('kimi-code', token);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);

    // The surviving entry must be surfaced as a failure...
    await expect(deniedStorage.remove('kimi-code')).rejects.toThrow(
      /failed to delete keyring credential/,
    );
    // ...but the legacy plaintext cleanup must still have run.
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    // The keychain credential genuinely survived (the bug being guarded against).
    expect(deniedKeyring.findAccounts(KEYRING_SERVICE)).toContain('kimi-code');
  });

  it('remove() resolves for a genuinely-missing entry (deleteCredential false, findAccounts lacks name)', async () => {
    // Pins missing⇒no-op parity with FileTokenStorage's ENOENT path and guards
    // against over-throwing. deleteCredential() returns false (no such entry),
    // and the reachable store's findAccounts() returns a list WITHOUT `name`,
    // so remove() must RESOLVE (no throw) while still clearing any plaintext
    // copy.
    const token = sampleToken();

    class MissingEntryKeyring extends FakeKeyring {
      override createEntry(service: string, account: string): KeyringEntry {
        const base = super.createEntry(service, account);
        return {
          getPassword: () => null,
          setPassword(p: string): void {
            base.setPassword(p);
          },
          deleteCredential: () => false,
        };
      }
      // Reachable store that lists OTHER accounts but not the one being removed.
      override findAccounts(): string[] {
        return ['some-other-account'];
      }
    }

    const missingStorage = new KeyringTokenStorage({ keyring: new MissingEntryKeyring(), legacy });
    await legacy.save('kimi-code', token); // a plaintext copy that must still clear
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);

    await expect(missingStorage.remove('kimi-code')).resolves.toBeUndefined();
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
  });

  it('list() unions keyring accounts and un-migrated legacy names, deduped', async () => {
    await storage.save('alpha', sampleToken()); // lands in keyring
    await legacy.save('beta', sampleToken()); // un-migrated plaintext
    await legacy.save('alpha', sampleToken()); // also a stray file for alpha

    const names = await storage.list();
    expect(names.toSorted()).toEqual(['alpha', 'beta']);
  });

  it('load() returns undefined on corrupt keychain JSON (does not throw)', async () => {
    keyring.store.set(`${KEYRING_SERVICE}\u0000kimi-code`, '{ not json');
    expect(await storage.load('kimi-code')).toBeUndefined();
  });

  it('load() migrates a valid plaintext token when the keychain payload is corrupt', async () => {
    const token = sampleToken({ accessToken: 'from-file', refreshToken: 'from-file' });
    keyring.store.set(`${KEYRING_SERVICE}\u0000kimi-code`, '{ not json');
    await legacy.save('kimi-code', token);

    await expect(storage.load('kimi-code')).resolves.toEqual(token);
    expect(keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword()).toBe(
      JSON.stringify(tokenToWire(token)),
    );
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    expect(observer.migrated).toEqual(['kimi-code']);
  });

  it('remove() clears both keyring and lingering plaintext file', async () => {
    await storage.save('kimi-code', sampleToken());
    await legacy.save('kimi-code', sampleToken()); // lingering plaintext
    await storage.remove('kimi-code');
    expect(keyring.store.size).toBe(0);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
  });

  it('does not resurrect a keyring credential after a file-side removal marker', async () => {
    const token = sampleToken();
    await storage.save('kimi-code', token);
    await new FileTokenStorage(dir).remove('kimi-code');

    await expect(storage.load('kimi-code')).resolves.toBeUndefined();
    expect(keyring.findAccounts(KEYRING_SERVICE)).not.toContain('kimi-code');
  });

  it('save() clears a removal marker and prunes a file recreated by a file-only process', async () => {
    const token = sampleToken({ accessToken: 'stale-file' });
    await storage.remove('kimi-code');
    writeFileSync(join(dir, 'kimi-code.json'), JSON.stringify(tokenToWire(token)));

    const restored = sampleToken({ accessToken: 'restored-keyring' });
    await storage.save('kimi-code', restored);

    expect(await storage.load('kimi-code')).toEqual(restored);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    expect(existsSync(join(dir, 'kimi-code.removed'))).toBe(false);
  });

  it('remove() does not throw when nothing exists', async () => {
    await expect(storage.remove('never-existed')).resolves.toBeUndefined();
  });

  // Invalid-name rejection — strict drop-in parity with FileTokenStorage:
  // same rule, same /Invalid token name/ error, and the guard must run BEFORE
  // any keychain op so save() can't orphan a credential under an invalid
  // account (file backend's fail-before-write).
  describe('rejects invalid token names (file-backend parity)', () => {
    const badNames = ['../../etc/passwd', '../etc/passwd', '.hidden', ''];

    it.each(badNames)('save() rejects %j', async (bad) => {
      await expect(storage.save(bad, sampleToken())).rejects.toThrow(/Invalid token name/);
    });

    it.each(badNames)('load() rejects %j', async (bad) => {
      await expect(storage.load(bad)).rejects.toThrow(/Invalid token name/);
    });

    it.each(badNames)('remove() rejects %j', async (bad) => {
      await expect(storage.remove(bad)).rejects.toThrow(/Invalid token name/);
    });

    it('save() with an invalid name writes NOTHING to the keychain (no orphan)', async () => {
      // The assertion that proves the orphan bug stays fixed: setPassword must
      // not run before the name check, so the FakeKeyring backing store stays
      // empty after the rejection.
      await expect(storage.save('../../etc/passwd', sampleToken())).rejects.toThrow(
        /Invalid token name/,
      );
      expect(keyring.store.size).toBe(0);
      expect(keyring.findAccounts(KEYRING_SERVICE)).toEqual([]);
      expect(keyring.createEntry(KEYRING_SERVICE, '../../etc/passwd').getPassword()).toBeNull();
    });
  });

  // Per-operation degradation: any keyring call that THROWS reports
  // onKeyringDegraded, flips the process-wide sticky flag, and completes the
  // current operation against the file store; every later operation goes
  // straight to the file store.
  describe('per-operation degradation to the file store', () => {
    let flaky: FlakyKeyring;
    let degradedStorage: KeyringTokenStorage;

    beforeEach(() => {
      flaky = new FlakyKeyring();
      degradedStorage = new KeyringTokenStorage({ keyring: flaky, legacy, observer });
    });

    it('load() reads the file WITHOUT migrating when the keyring read throws, then stays degraded', async () => {
      const token = sampleToken();
      await legacy.save('kimi-code', token);
      flaky.throwOnGet = true;

      const loaded = await degradedStorage.load('kimi-code');
      // The file token is returned as-is...
      expect(loaded).toEqual(token);
      // ...and NOT migrated: the file survives and nothing entered the keychain.
      expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
      expect(flaky.store.size).toBe(0);
      expect(observer.degraded).toEqual([{ operation: 'load', message: 'keychain read failed' }]);

      // Sticky: the keyring is "healthy" again, yet every later op goes to file.
      flaky.throwOnGet = false;
      const newer = sampleToken({ accessToken: 'at-newer', refreshToken: 'rt-newer' });
      await degradedStorage.save('kimi-code', newer);
      expect(flaky.store.size).toBe(0);
      expect(await degradedStorage.load('kimi-code')).toEqual(newer);
      expect(await degradedStorage.list()).toEqual(['kimi-code']);
    });

    it('load() does not report a keychain-only token as logged out during an outage', async () => {
      const token = sampleToken();
      await degradedStorage.save('kimi-code', token);
      expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);

      flaky.throwOnGet = true;
      await expect(degradedStorage.load('kimi-code')).rejects.toThrow(
        /keyring unavailable while loading credential/,
      );
      expect(observer.degraded).toEqual([{ operation: 'load', message: 'keychain read failed' }]);
    });

    it('remove() retries keychain deletion after an earlier outage', async () => {
      const token = sampleToken();
      await degradedStorage.save('kimi-code', token);
      flaky.throwOnGet = true;
      await expect(degradedStorage.load('kimi-code')).rejects.toThrow(
        /keyring unavailable while loading credential/,
      );

      flaky.throwOnGet = false;
      await expect(degradedStorage.remove('kimi-code')).resolves.toBeUndefined();
      expect(flaky.findAccounts(KEYRING_SERVICE)).not.toContain('kimi-code');
    });

    it('does not persist a revoked tombstone after a keyring outage', async () => {
      const token = sampleToken();
      await degradedStorage.save('kimi-code', token);
      flaky.throwOnGet = true;
      await expect(degradedStorage.load('kimi-code')).rejects.toThrow();

      await expect(degradedStorage.save('kimi-code', revokedTombstone(token))).rejects.toThrow(
        /keyring unavailable while saving revoked credential/,
      );
      expect(await legacy.load('kimi-code')).toBeUndefined();
    });

    it('save() writes the file when the keyring write throws', async () => {
      const token = sampleToken();
      flaky.throwOnSet = true;

      await expect(degradedStorage.save('kimi-code', token)).resolves.toBeUndefined();

      // The token landed in the file store, not the keychain.
      expect(await legacy.load('kimi-code')).toEqual(token);
      expect(flaky.store.size).toBe(0);
      expect(observer.degraded).toEqual([{ operation: 'save', message: 'keychain write failed' }]);

      // Sticky: a later save with a "healthy" keyring still writes the file.
      flaky.throwOnSet = false;
      const newer = sampleToken({ accessToken: 'at-newer' });
      await degradedStorage.save('kimi-code', newer);
      expect(await legacy.load('kimi-code')).toEqual(newer);
      expect(flaky.store.size).toBe(0);
    });

    it('remove() clears the plaintext file and surfaces a keyring delete failure', async () => {
      const token = sampleToken();
      await legacy.save('kimi-code', token); // lingering plaintext to clear
      expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
      flaky.throwOnDelete = true;

      await expect(degradedStorage.remove('kimi-code')).rejects.toThrow(
        /failed to delete keyring credential/,
      );
      // ...and the legacy cleanup still ran.
      expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
      expect(observer.degraded).toEqual([{ operation: 'remove', message: 'keychain delete failed' }]);
    });

    it('remove() clears the file but surfaces an unreachable keyring', async () => {
      // A locked / no-access store: deleteCredential returns false (nothing to
      // delete in the empty fake) and the service-scoped enumeration THROWS.
      const token = sampleToken();
      await legacy.save('kimi-code', token);
      expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
      flaky.throwOnFind = true;

      await expect(degradedStorage.remove('kimi-code')).rejects.toThrow(
        /failed to delete keyring credential/,
      );
      expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
      expect(observer.degraded).toEqual([
        { operation: 'remove', message: 'keychain store unreachable' },
      ]);
    });

    it('list() falls back to the file store when findAccounts throws', async () => {
      await legacy.save('beta', sampleToken());
      flaky.throwOnFind = true;

      expect(await degradedStorage.list()).toEqual(['beta']);
      expect(observer.degraded).toEqual([
        { operation: 'list', message: 'keychain store unreachable' },
      ]);

      // Sticky: entries that exist only in the keychain stay invisible.
      flaky.throwOnFind = false;
      flaky.store.set(`${KEYRING_SERVICE}\u0000alpha`, JSON.stringify(tokenToWire(sampleToken())));
      expect(await degradedStorage.list()).toEqual(['beta']);
    });

    it('a keyring throw mid-reconcile degrades and the file token wins', async () => {
      // Keychain holds older valid A; the file holds strictly-newer valid B.
      // The adoption write to the keychain throws → degrade → this load returns
      // the FILE token and the plaintext copy (now the working store's) is kept.
      const tokenA = sampleToken({ accessToken: 'at-A', refreshToken: 'rt-A', expiresAt: 1000 });
      const tokenB = sampleToken({ accessToken: 'at-B', refreshToken: 'rt-B', expiresAt: 2000 });
      await degradedStorage.save('kimi-code', tokenA); // keychain holds A (healthy write)
      await legacy.save('kimi-code', tokenB); // file holds newer B
      flaky.throwOnSet = true;

      const loaded = await degradedStorage.load('kimi-code');
      expect(loaded).toEqual(tokenB);
      expect(observer.degraded).toEqual([{ operation: 'load', message: 'keychain write failed' }]);
      expect(observer.migrated).toEqual([]);
      // The file was NOT pruned and the keychain still holds A's bytes.
      expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
      const raw = flaky.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
      expect(JSON.parse(raw as string)).toEqual(tokenToWire(tokenA));
    });

    it('migration degrades mid-loop: a newer file token that cannot be copied in wins', async () => {
      // Migration copy-in of A succeeds, but the pre-delete re-read finds a
      // NEWER token B on disk and the B write throws. The backend degrades and
      // the file stays authoritative — so this load must return B (the file's
      // current value), NOT the older A the keychain accepted earlier.
      const tokenA = sampleToken({ accessToken: 'at-A', refreshToken: 'rt-A' });
      const tokenB = sampleToken({ accessToken: 'at-B', refreshToken: 'rt-B' });
      class FlipLegacy extends FileTokenStorage {
        private calls = 0;
        override loadUnlocked(): TokenInfo | undefined {
          this.calls += 1;
          return this.calls === 1 ? tokenA : tokenB;
        }
      }
      class SecondWriteThrowKeyring extends FakeKeyring {
        private writes = 0;
        override createEntry(service: string, account: string): KeyringEntry {
          const base = super.createEntry(service, account);
          return {
            getPassword: () => base.getPassword(),
            setPassword: (p: string): void => {
              this.writes += 1;
              if (this.writes === 2) throw new Error('keychain write failed');
              base.setPassword(p);
            },
            deleteCredential: () => base.deleteCredential(),
          };
        }
      }
      const flip = new FlipLegacy(dir);
      await flip.save('kimi-code', tokenA); // a real file that must survive
      const midLoopStorage = new KeyringTokenStorage({
        keyring: new SecondWriteThrowKeyring(),
        legacy: flip,
        observer,
      });

      const loaded = await midLoopStorage.load('kimi-code');
      expect(loaded).toEqual(tokenB);
      expect(observer.degraded).toEqual([{ operation: 'load', message: 'keychain write failed' }]);
      expect(observer.migrated).toEqual([]);
      expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
    });

    it('degradation is process-wide: a second storage instance goes straight to the file store', async () => {
      const token = sampleToken();
      await legacy.save('kimi-code', token);
      flaky.throwOnGet = true;
      await degradedStorage.load('kimi-code'); // degrades the process-wide flag

      // A brand-new KeyringTokenStorage over a HEALTHY keyring must still fall
      // back immediately — the sticky flag is not per-instance.
      const healthy = new FakeKeyring();
      const second = new KeyringTokenStorage({ keyring: healthy, legacy });
      expect(await second.load('kimi-code')).toEqual(token);
      expect(healthy.store.size).toBe(0); // no migration attempt
      await second.save('kimi-code', sampleToken({ accessToken: 'at-second' }));
      expect(healthy.store.size).toBe(0); // save went to the file
    });

    it('unregisterKeyringBackend() resets the degradation flag', async () => {
      flaky.throwOnGet = true;
      await expect(degradedStorage.load('kimi-code')).rejects.toThrow(
        /keyring unavailable while loading credential/,
      );
      expect(observer.degraded).toHaveLength(1);

      unregisterKeyringBackend();

      const healthy = new FakeKeyring();
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

  it('returns FileTokenStorage when KIMI_DISABLE_KEYRING=1', () => {
    vi.stubEnv('KIMI_DISABLE_KEYRING', '1');
    const observer = new FakeObserver();
    const storage = resolveTokenStorage(dir, { observer, optedIn: true });
    expect(storage).toBeInstanceOf(FileTokenStorage);
    expect(observer.selected).toEqual([{ backend: 'file', reason: 'disabled' }]);
  });

  it('KIMI_DISABLE_KEYRING=1 wins over the opt-in gate (and never probes)', () => {
    vi.stubEnv('KIMI_DISABLE_KEYRING', '1');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_KEYRING', '1');
    const keyring = new RecordingKeyring();
    const observer = new FakeObserver();
    registerKeyringBackend(keyring, observer);
    const storage = resolveTokenStorage(dir);
    expect(storage).toBeInstanceOf(FileTokenStorage);
    expect(storage).not.toBeInstanceOf(KeyringTokenStorage);
    expect(observer.selected).toEqual([{ backend: 'file', reason: 'disabled' }]);
    // The disabled branch short-circuits before any keyring call.
    expect(keyring.accountsByService.size).toBe(0);
  });

  it('defaults to FileTokenStorage until KIMI_CODE_EXPERIMENTAL_KEYRING=1 (temporary opt-in gate)', () => {
    // The gate is env-driven and default-OFF: a registered, healthy backend is
    // NOT used until the process opts in. Defensively clear any ambient value.
    const prev = process.env['KIMI_CODE_EXPERIMENTAL_KEYRING'];
    delete process.env['KIMI_CODE_EXPERIMENTAL_KEYRING'];
    try {
      const observer = new FakeObserver();
      registerKeyringBackend(new FakeKeyring(), observer);
      const storage = resolveTokenStorage(dir);
      expect(storage).toBeInstanceOf(FileTokenStorage);
      expect(storage).not.toBeInstanceOf(KeyringTokenStorage);
      expect(observer.selected).toEqual([{ backend: 'file', reason: 'not-opted-in' }]);
    } finally {
      if (prev !== undefined) process.env['KIMI_CODE_EXPERIMENTAL_KEYRING'] = prev;
    }
  });

  it('selects KeyringTokenStorage via the registered backend once KIMI_CODE_EXPERIMENTAL_KEYRING=1', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_KEYRING', '1');
    const keyring = new FakeKeyring();
    const observer = new FakeObserver();
    registerKeyringBackend(keyring, observer);

    // The full production path: no deps seam, everything comes from the
    // registration slot + env.
    const storage = resolveTokenStorage(dir);
    expect(storage).toBeInstanceOf(KeyringTokenStorage);
    expect(observer.selected).toEqual([{ backend: 'keyring', reason: undefined }]);

    await storage.save('kimi-code', sampleToken());
    expect(keyring.store.get(`${keyringServiceForCredentialsDir(dir)}\u0000kimi-code`)).toBeDefined();
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
  });

  it('re-registering replaces the backend (and the observer)', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_KEYRING', '1');
    const first = new FakeKeyring();
    const second = new FakeKeyring();
    const secondObserver = new FakeObserver();
    registerKeyringBackend(first);
    registerKeyringBackend(second, secondObserver);

    const storage = resolveTokenStorage(dir);
    expect(storage).toBeInstanceOf(KeyringTokenStorage);
    expect(secondObserver.selected).toEqual([{ backend: 'keyring', reason: undefined }]);

    await storage.save('kimi-code', sampleToken());
    expect(second.store.size).toBe(1);
    expect(first.store.size).toBe(0);
  });

  it('falls back to FileTokenStorage when no backend is registered', () => {
    const observer = new FakeObserver();
    const storage = resolveTokenStorage(dir, {
      loadKeyring: () => undefined,
      observer,
      optedIn: true,
    });
    expect(storage).toBeInstanceOf(FileTokenStorage);
    expect(observer.selected).toEqual([{ backend: 'file', reason: 'no-backend' }]);
  });

  it('falls back to FileTokenStorage when the capability probe throws', () => {
    const observer = new FakeObserver();
    const storage = resolveTokenStorage(dir, {
      loadKeyring: () => new ThrowingKeyring(),
      observer,
      optedIn: true,
    });
    expect(storage).toBeInstanceOf(FileTokenStorage);
    expect(observer.selected).toEqual([{ backend: 'file', reason: 'probe-failed' }]);
  });

  it('falls back to FileTokenStorage when creating a keyring entry throws', () => {
    const observer = new FakeObserver();
    const storage = resolveTokenStorage(dir, {
      loadKeyring: () => new ConstructorThrowingKeyring(),
      observer,
      optedIn: true,
    });
    expect(storage).toBeInstanceOf(FileTokenStorage);
    expect(storage).not.toBeInstanceOf(KeyringTokenStorage);
    expect(observer.selected).toEqual([{ backend: 'file', reason: 'probe-failed' }]);
  });

  it('selects KeyringTokenStorage when the keyring probe succeeds', async () => {
    const keyring = new FakeKeyring();
    const storage = resolveTokenStorage(dir, { loadKeyring: () => keyring, optedIn: true });
    expect(storage).toBeInstanceOf(KeyringTokenStorage);

    // A save lands in the fake keyring, not on disk.
    await storage.save('kimi-code', sampleToken());
    expect(keyring.store.get(`${keyringServiceForCredentialsDir(dir)}\u0000kimi-code`)).toBeDefined();
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
  });

  it('the probe sentinel never leaks into the real service list', async () => {
    const keyring = new FakeKeyring();
    const storage = resolveTokenStorage(dir, { loadKeyring: () => keyring, optedIn: true });
    // Probe ran against a separate service; nothing under KEYRING_SERVICE yet.
    expect(await storage.list()).toEqual([]);
  });

  it('falls back to FileTokenStorage when the keyring can set/read but cannot DELETE', () => {
    // The keychain is the AUTHORITATIVE store once selected — logout/revocation
    // and load()'s migrate-then-delete depend on delete working. A backend that
    // stores+reads fine but whose deleteCredential() fails (returns false AND
    // leaves the entry present) would trap migrated tokens it can never remove
    // and make logout throw. The probe must treat that as unusable and fall back
    // to the plaintext file store, NOT migrate into a one-way keychain.
    class NoDeleteKeyring extends FakeKeyring {
      override createEntry(service: string, account: string): KeyringEntry {
        const base = super.createEntry(service, account);
        return {
          getPassword: () => base.getPassword(),
          setPassword(p: string): void {
            base.setPassword(p);
          },
          // Genuine delete failure: returns false and the entry SURVIVES, so a
          // follow-up getPassword() still sees the sentinel.
          deleteCredential: () => false,
        };
      }
    }
    const storage = resolveTokenStorage(dir, {
      loadKeyring: () => new NoDeleteKeyring(),
      optedIn: true,
    });
    expect(storage).toBeInstanceOf(FileTokenStorage);
    expect(storage).not.toBeInstanceOf(KeyringTokenStorage);
  });

  it('rejects a keyring whose delete returns true but the entry SURVIVES (lying boolean)', () => {
    // The native binding maps a failed delete to `false`, but the probe does NOT
    // trust the boolean — it confirms removal via the service-scoped findAccounts()
    // listing (our unique probe account must be ABSENT), mirroring remove()'s own
    // disambiguation. A backend that LIES (delete reports true while the entry
    // persists) must still be rejected, proving the probe relies on the
    // authoritative service listing, not the return value.
    class LyingDeleteKeyring extends FakeKeyring {
      override createEntry(service: string, account: string): KeyringEntry {
        const base = super.createEntry(service, account);
        return {
          getPassword: () => base.getPassword(),
          setPassword(p: string): void {
            base.setPassword(p);
          },
          // Lies: claims success while the entry remains present.
          deleteCredential: () => true,
        };
      }
    }
    const storage = resolveTokenStorage(dir, {
      loadKeyring: () => new LyingDeleteKeyring(),
      optedIn: true,
    });
    expect(storage).toBeInstanceOf(FileTokenStorage);
    expect(storage).not.toBeInstanceOf(KeyringTokenStorage);
  });

  it('rejects a keyring whose post-delete read is DENIED (null) while the sentinel SURVIVES (read-error ambiguity)', () => {
    // The binding collapses every read error to null, so a denied/locked
    // post-delete read returns null EVEN THOUGH the sentinel still exists. Here
    // the probe's set + FIRST getPassword round-trip succeed, deleteCredential()
    // returns false (denied — sentinel NOT removed), and the post-delete
    // getPassword() collapses to null (read denied) — BUT
    // findAccounts(KEYRING_PROBE_SERVICE) STILL lists the probe account because
    // the entry physically persists. Keying off `getPassword() === null` would
    // wrongly select a one-way keychain that traps migrated tokens. The probe
    // proves absence via the service listing instead → FileTokenStorage.
    class DeniedReadSurvivingProbeKeyring extends FakeKeyring {
      override createEntry(service: string, account: string): KeyringEntry {
        const base = super.createEntry(service, account);
        let reads = 0;
        return {
          // First read (the round-trip check) returns the stored sentinel; every
          // later read collapses to null (denied), as the binding does on error.
          getPassword(): string | null {
            reads += 1;
            return reads === 1 ? base.getPassword() : null;
          },
          setPassword(p: string): void {
            base.setPassword(p);
          },
          // Denied delete: returns false and the sentinel SURVIVES in the store,
          // so the faithful findAccounts() still lists this probe account.
          deleteCredential: () => false,
        };
      }
    }
    const storage = resolveTokenStorage(dir, {
      loadKeyring: () => new DeniedReadSurvivingProbeKeyring(),
      optedIn: true,
    });
    expect(storage).toBeInstanceOf(FileTokenStorage);
    expect(storage).not.toBeInstanceOf(KeyringTokenStorage);
  });

  it('rejects a keyring whose post-delete findAccounts THROWS (unreachable store mid-probe)', () => {
    // A locked / no-access store discovered only at the post-delete confirmation:
    // set + the first read succeed, deleteCredential() returns false, but the
    // service-scoped findAccounts() THROWS (findCredentials throws on an
    // unreachable store). The probe's findAccounts throw is caught → probe returns
    // false → FileTokenStorage, never migrating plaintext into an unusable keychain.
    class UnreachableProbeKeyring extends FakeKeyring {
      override createEntry(service: string, account: string): KeyringEntry {
        const base = super.createEntry(service, account);
        return {
          getPassword: () => base.getPassword(),
          setPassword(p: string): void {
            base.setPassword(p);
          },
          deleteCredential: () => false,
        };
      }
      override findAccounts(): string[] {
        throw new Error('keychain store unreachable (locked / no-access)');
      }
    }
    const storage = resolveTokenStorage(dir, {
      loadKeyring: () => new UnreachableProbeKeyring(),
      optedIn: true,
    });
    expect(storage).toBeInstanceOf(FileTokenStorage);
    expect(storage).not.toBeInstanceOf(KeyringTokenStorage);
  });

  it('selects KeyringTokenStorage and leaves NO probe sentinel behind on the healthy path', () => {
    // The healthy fake deletes properly (Map.delete mutates the backing store),
    // so the probe's delete-and-re-list confirms removal → keyring is selected.
    // Assert via instanceof AND that the isolated probe service has zero accounts
    // afterward, proving the probe's own cleanup ran (no leaked sentinel).
    const keyring = new FakeKeyring();
    const storage = resolveTokenStorage(dir, { loadKeyring: () => keyring, optedIn: true });
    expect(storage).toBeInstanceOf(KeyringTokenStorage);
    expect(keyring.findAccounts(KEYRING_PROBE_SERVICE)).toEqual([]);
  });

  it('the probe uses a unique, non-constant account per attempt', () => {
    const a = new RecordingKeyring();
    const b = new RecordingKeyring();
    resolveTokenStorage(dir, { loadKeyring: () => a, optedIn: true });
    resolveTokenStorage(dir, { loadKeyring: () => b, optedIn: true });

    const aAccounts = a.accountsByService.get(KEYRING_PROBE_SERVICE) ?? [];
    const bAccounts = b.accountsByService.get(KEYRING_PROBE_SERVICE) ?? [];
    expect(aAccounts.length).toBeGreaterThan(0);
    expect(bAccounts.length).toBeGreaterThan(0);

    // Never the old fixed sentinel account.
    for (const acct of [...aAccounts, ...bAccounts]) {
      expect(acct).not.toBe('probe');
    }
    // Distinct accounts across independent probe attempts.
    expect(new Set(aAccounts).size).toBe(1); // one account used consistently within an attempt
    expect(aAccounts[0]).not.toBe(bAccounts[0]);
  });

  it('a second probe sharing the backend does not clobber the first probe', () => {
    // Models two concurrent CLI probes against one live keychain. While probe A
    // is mid-round-trip (after set, before read), probe B runs a full
    // set/get/delete cycle. With a shared fixed account B's delete would wipe
    // A's sentinel → A reads null → false mismatch → file fallback. Per-attempt
    // unique accounts keep A's read intact.
    const shared = new FakeKeyring();
    let aAccount: string | undefined;
    let injected = false;

    const interleavingKeyring: KeyringApi = {
      createEntry(service, account) {
        const base = shared.createEntry(service, account);
        if (service !== KEYRING_PROBE_SERVICE) return base;
        aAccount ??= account;
        return {
          getPassword: () => base.getPassword(),
          setPassword(p: string): void {
            base.setPassword(p);
            // After A's set, interleave a second probe (process B) using the
            // SAME account A used — exactly what a shared fixed sentinel does.
            if (!injected) {
              injected = true;
              const bEntry = shared.createEntry(service, aAccount as string);
              bEntry.setPassword('b-sentinel');
              bEntry.deleteCredential();
            }
          },
          deleteCredential: () => base.deleteCredential(),
        };
      },
      findAccounts: (service) => shared.findAccounts(service),
    };

    // Sanity: this interleave on a SHARED account breaks the probe (read null).
    const storage = resolveTokenStorage(dir, {
      loadKeyring: () => interleavingKeyring,
      optedIn: true,
    });
    expect(storage).toBeInstanceOf(FileTokenStorage);

    // ...whereas the production probe derives a UNIQUE account per attempt, so a
    // concurrent probe on its own account cannot clobber it. Two real attempts
    // therefore use different accounts (asserted in the test above), which is
    // what prevents the collision modeled here on a healthy keychain.
  });
});

describe('getRegisteredKeyringBackend', () => {
  afterEach(() => {
    unregisterKeyringBackend();
  });

  it('returns undefined when nothing is registered', () => {
    expect(getRegisteredKeyringBackend()).toBeUndefined();
  });

  it('returns the registered api and observer', () => {
    const api = new FakeKeyring();
    const observer = new FakeObserver();
    registerKeyringBackend(api, observer);
    const registered = getRegisteredKeyringBackend();
    expect(registered?.api).toBe(api);
    expect(registered?.observer).toBe(observer);
  });

  it('reflects re-registration and unregistration', () => {
    const first = new FakeKeyring();
    const second = new FakeKeyring();
    registerKeyringBackend(first);
    expect(getRegisteredKeyringBackend()?.api).toBe(first);
    registerKeyringBackend(second);
    expect(getRegisteredKeyringBackend()?.api).toBe(second);
    expect(getRegisteredKeyringBackend()?.observer).toBeUndefined();
    unregisterKeyringBackend();
    expect(getRegisteredKeyringBackend()).toBeUndefined();
  });
});

describe('isKeyringOptedIn', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('requires KIMI_CODE_EXPERIMENTAL_KEYRING=1 and no KIMI_DISABLE_KEYRING=1', () => {
    expect(isKeyringOptedIn({})).toBe(false);
    expect(isKeyringOptedIn({ KIMI_CODE_EXPERIMENTAL_KEYRING: '1' })).toBe(true);
    expect(isKeyringOptedIn({ KIMI_CODE_EXPERIMENTAL_KEYRING: '0' })).toBe(false);
    expect(isKeyringOptedIn({ KIMI_DISABLE_KEYRING: '1' })).toBe(false);
    // Disable always wins over the opt-in.
    expect(
      isKeyringOptedIn({ KIMI_CODE_EXPERIMENTAL_KEYRING: '1', KIMI_DISABLE_KEYRING: '1' }),
    ).toBe(false);
  });

  it('reads process.env by default', () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_KEYRING', '1');
    vi.stubEnv('KIMI_DISABLE_KEYRING', '');
    expect(isKeyringOptedIn()).toBe(true);
    vi.stubEnv('KIMI_DISABLE_KEYRING', '1');
    expect(isKeyringOptedIn()).toBe(false);
  });

  it('gates resolveTokenStorage end-to-end (single decision source)', () => {
    const dir = makeTmpDir();
    try {
      vi.stubEnv('KIMI_CODE_EXPERIMENTAL_KEYRING', '1');
      vi.stubEnv('KIMI_DISABLE_KEYRING', '1');
      registerKeyringBackend(new FakeKeyring());
      // The combined gate rejects (disable wins) without consulting any deps seam.
      expect(resolveTokenStorage(dir)).toBeInstanceOf(FileTokenStorage);
    } finally {
      unregisterKeyringBackend();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
