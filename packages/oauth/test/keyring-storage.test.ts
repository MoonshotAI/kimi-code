/**
 * KeyringTokenStorage + resolveTokenStorage tests — fully hermetic.
 *
 * NEVER touches the real OS keychain: the keyring backend is an in-memory
 * fake `KeyringApi` (a Map keyed by `service\x00account`). The file fallback
 * uses a real `FileTokenStorage` over a tmp dir so migration + union with the
 * plaintext store are exercised end-to-end.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  KEYRING_PROBE_SERVICE,
  KEYRING_SERVICE,
  KeyringTokenStorage,
  keyringServiceForCredentialsDir,
  resolveTokenStorage,
} from '../src/keyring-storage';
import type { KeyringApi, KeyringEntry } from '../src/keyring-storage';
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

describe('KeyringTokenStorage', () => {
  let dir: string;
  let legacy: FileTokenStorage;
  let keyring: FakeKeyring;
  let storage: KeyringTokenStorage;

  beforeEach(() => {
    dir = makeTmpDir();
    legacy = new FileTokenStorage(dir);
    keyring = new FakeKeyring();
    storage = new KeyringTokenStorage({ keyring, legacy });
  });

  afterEach(() => {
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
    const raw = keyring.store.get(`${KEYRING_SERVICE}\x00kimi-code`);
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

    // First load migrates: returns the token, populates keyring, removes file.
    const loaded = await storage.load('kimi-code');
    expect(loaded).toEqual(token);
    expect(keyring.store.get(`${KEYRING_SERVICE}\x00kimi-code`)).toBeDefined();
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);

    // Second load reads straight from the keychain (file already gone).
    expect(await storage.load('kimi-code')).toEqual(token);
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
      override async load(): Promise<TokenInfo | undefined> {
        const value = tokens.at(this.loadCalls) ?? lastToken;
        this.loadCalls += 1;
        return value;
      }
      override async remove(name: string): Promise<void> {
        this.removeCalls += 1;
        await super.remove(name);
      }
    }
    const racy = new RacyLegacy(dir);
    // Seed a real file so a (wrongful) remove would be observable on disk.
    await racy.save('kimi-code', seed);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);

    const racyStorage = new KeyringTokenStorage({ keyring, legacy: racy });
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
  });

  it('compare-and-delete: a stable file that matches the migrated value is deleted', async () => {
    // The file value never changes across re-reads, so after copying it into the
    // keychain the pre-delete re-read matches → safe to unlink the cleartext.
    const t1 = sampleToken({ accessToken: 'at-stable', refreshToken: 'rt-stable' });
    class StableLegacy extends FileTokenStorage {
      public removeCalls = 0;
      override async remove(name: string): Promise<void> {
        this.removeCalls += 1;
        await super.remove(name);
      }
    }
    const stable = new StableLegacy(dir);
    await stable.save('kimi-code', t1);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);

    const stableStorage = new KeyringTokenStorage({ keyring, legacy: stable });
    const loaded = await stableStorage.load('kimi-code');

    expect(loaded).toEqual(t1);
    expect(stable.removeCalls).toBe(1);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    const raw = keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
    expect(JSON.parse(raw as string)).toEqual(tokenToWire(t1));
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

    // The migrated plaintext copy is gone.
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
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

  it('keychain HIT reconcile: prunes a plaintext duplicate equal after canonical re-serialization', async () => {
    // Keychain and file hold the SAME token (a just-migrated state observed by a
    // concurrent peer, or a redundant copy). load() returns the keychain value
    // and prunes the redundant cleartext, since it equals the authoritative
    // keychain value after canonical re-serialization.
    const x = sampleToken({ accessToken: 'at-X', refreshToken: 'rt-X', expiresAt: 1500 });
    await storage.save('kimi-code', x); // keychain holds X
    await legacy.save('kimi-code', x); // redundant duplicate plaintext X
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);

    const loaded = await storage.load('kimi-code');
    expect(loaded).toEqual(x);

    const raw = keyring.createEntry(KEYRING_SERVICE, 'kimi-code').getPassword();
    expect(JSON.parse(raw as string)).toEqual(tokenToWire(x));
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
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

  it('remove() always clears the plaintext file even if keyring deletion throws', async () => {
    const token = sampleToken();
    await legacy.save('kimi-code', token); // lingering plaintext to clear
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);

    // Keyring whose deleteCredential throws (native ops can fail at runtime).
    class DeleteThrowingKeyring extends FakeKeyring {
      override createEntry(service: string, account: string): KeyringEntry {
        const base = super.createEntry(service, account);
        return {
          getPassword: () => base.getPassword(),
          setPassword(p: string): void {
            base.setPassword(p);
          },
          deleteCredential(): boolean {
            throw new Error('keychain delete failed');
          },
        };
      }
    }
    const throwingStorage = new KeyringTokenStorage({
      keyring: new DeleteThrowingKeyring(),
      legacy,
    });

    // The keyring error must propagate...
    await expect(throwingStorage.remove('kimi-code')).rejects.toThrow('keychain delete failed');
    // ...but the legacy cleanup must still have run.
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
  });

  it('remove() surfaces a failed keychain delete that returns false (real @napi-rs/keyring never throws)', async () => {
    // The REAL @napi-rs/keyring v1.3.0 binding maps EVERY delete failure (locked
    // keychain, no-access, ambiguous, platform error) to a plain `false` and
    // NEVER throws — the SAME `false` returned for "no such entry". getPassword()
    // likewise swallows errors to null. This fake models a delete that FAILS:
    // deleteCredential() returns false while getPassword() STILL returns the
    // stored value, so the credential definitively persists. remove() must
    // disambiguate via the re-read and surface the failure — otherwise a logout
    // would clear the plaintext but silently leave the keychain token alive.
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
          // so a follow-up getPassword() still sees it.
          deleteCredential(): boolean {
            return false;
          },
        };
      }
    }

    const failingKeyring = new FailingDeleteKeyring();
    const failingStorage = new KeyringTokenStorage({ keyring: failingKeyring, legacy });

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
  });

  it('remove() treats deleteCredential()=false with a null re-read as a no-op success (absent entry)', async () => {
    // A bare `false` from deleteCredential() is overloaded: it means "delete
    // failed" OR "no such entry". When the re-read getPassword() returns null the
    // entry is genuinely gone (deleted or never existed), so logging out an absent
    // entry must RESOLVE without throwing.
    class AbsentDeleteKeyring extends FakeKeyring {
      override createEntry(service: string, account: string): KeyringEntry {
        const base = super.createEntry(service, account);
        return {
          // Always reports the entry as absent.
          getPassword: () => null,
          setPassword(p: string): void {
            base.setPassword(p);
          },
          // Mirrors the native binding's "did not exist" → false.
          deleteCredential(): boolean {
            return false;
          },
        };
      }
    }

    const absentStorage = new KeyringTokenStorage({ keyring: new AbsentDeleteKeyring(), legacy });
    await expect(absentStorage.remove('never-existed')).resolves.toBeUndefined();
  });

  it('list() unions keyring accounts and un-migrated legacy names, deduped', async () => {
    await storage.save('alpha', sampleToken()); // lands in keyring
    await legacy.save('beta', sampleToken()); // un-migrated plaintext
    await legacy.save('alpha', sampleToken()); // also a stray file for alpha

    const names = await storage.list();
    expect(names.toSorted()).toEqual(['alpha', 'beta']);
  });

  it('load() returns undefined on corrupt keychain JSON (does not throw)', async () => {
    keyring.store.set(`${KEYRING_SERVICE}\x00kimi-code`, '{ not json');
    expect(await storage.load('kimi-code')).toBeUndefined();
  });

  it('remove() clears both keyring and lingering plaintext file', async () => {
    await storage.save('kimi-code', sampleToken());
    await legacy.save('kimi-code', sampleToken()); // lingering plaintext
    await storage.remove('kimi-code');
    expect(keyring.store.size).toBe(0);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
  });

  it('remove() does not throw when nothing exists', async () => {
    await expect(storage.remove('never-existed')).resolves.toBeUndefined();
  });
});

describe('resolveTokenStorage', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env['KIMI_DISABLE_KEYRING'];
  });

  it('returns FileTokenStorage when KIMI_DISABLE_KEYRING=1', () => {
    const prev = process.env['KIMI_DISABLE_KEYRING'];
    process.env['KIMI_DISABLE_KEYRING'] = '1';
    try {
      const storage = resolveTokenStorage(dir);
      expect(storage).toBeInstanceOf(FileTokenStorage);
    } finally {
      if (prev === undefined) delete process.env['KIMI_DISABLE_KEYRING'];
      else process.env['KIMI_DISABLE_KEYRING'] = prev;
    }
  });

  it('falls back to FileTokenStorage when the native module fails to load', () => {
    const storage = resolveTokenStorage(dir, { loadKeyring: () => undefined });
    expect(storage).toBeInstanceOf(FileTokenStorage);
  });

  it('falls back to FileTokenStorage when the capability probe throws', () => {
    const storage = resolveTokenStorage(dir, {
      loadKeyring: () => new ThrowingKeyring(),
    });
    expect(storage).toBeInstanceOf(FileTokenStorage);
  });

  it('selects KeyringTokenStorage when the keyring probe succeeds', async () => {
    const keyring = new FakeKeyring();
    const storage = resolveTokenStorage(dir, { loadKeyring: () => keyring });
    expect(storage).toBeInstanceOf(KeyringTokenStorage);

    // A save lands in the fake keyring, not on disk.
    await storage.save('kimi-code', sampleToken());
    expect(keyring.store.get(`${keyringServiceForCredentialsDir(dir)}\x00kimi-code`)).toBeDefined();
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
  });

  it('the probe sentinel never leaks into the real service list', async () => {
    const keyring = new FakeKeyring();
    const storage = resolveTokenStorage(dir, { loadKeyring: () => keyring });
    // Probe ran against a separate service; nothing under KEYRING_SERVICE yet.
    expect(await storage.list()).toEqual([]);
  });

  it('the probe uses a unique, non-constant account per attempt', () => {
    const a = new RecordingKeyring();
    const b = new RecordingKeyring();
    resolveTokenStorage(dir, { loadKeyring: () => a });
    resolveTokenStorage(dir, { loadKeyring: () => b });

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
    // set/get/delete cycle. With the OLD fixed `'probe'` account B's delete
    // would wipe A's sentinel → A reads null → false mismatch → file fallback.
    // Per-attempt unique accounts must keep A's read intact.
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
    const storage = resolveTokenStorage(dir, { loadKeyring: () => interleavingKeyring });
    expect(storage).toBeInstanceOf(FileTokenStorage);

    // ...whereas the production probe derives a UNIQUE account per attempt, so a
    // concurrent probe on its own account cannot clobber it. Two real attempts
    // therefore use different accounts (asserted in the test above), which is
    // what prevents the collision modeled here on a healthy keychain.
  });
});
