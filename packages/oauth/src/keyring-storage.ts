/**
 * Keychain-backed OAuth token storage with plaintext-file fallback.
 *
 * Backend: the OS keychain (macOS Keychain, Windows Credential Manager,
 * Linux Secret Service) via `@napi-rs/keyring`. Tokens live under a keychain
 * *service* derived per credentials directory (`keyringServiceForCredentialsDir`)
 * so distinct profiles / SDK callers stay isolated exactly like the file backend
 * isolates them by directory; each token is one entry whose *account* is the
 * token `name` and whose *password* is the snake_case wire JSON — the exact same
 * payload `FileTokenStorage` writes to disk.
 *
 * Selection (`resolveTokenStorage`): the keychain is used only when it is
 * actually usable. Two guards are required because the failure modes differ:
 *   1. The native binary may fail to load (unsupported platform / missing
 *      optional binary) — `require` THROWS at import time. Caught → file.
 *   2. The binary may load but have no live OS backend at runtime (e.g.
 *      headless Linux with no Secret Service) — `require` succeeds but entry
 *      operations throw at CALL time. A set/get/delete capability probe under
 *      a SEPARATE sentinel service catches this. Failed/​mismatched → file.
 * `KIMI_DISABLE_KEYRING=1` forces the file backend outright.
 *
 * Migration: when the keychain is selected but a token is still only on disk
 * (written by an older file-only build), `load` migrates it — copy into the
 * keychain, then compare-and-delete the plaintext file (only unlink a file that
 * still matches the value we made keychain-authoritative) — so secrets stop
 * living in the clear without ever dropping a newer token a concurrent
 * file-backend writer may have just landed. Migration is LOCK-FREE, exactly like
 * `FileTokenStorage`. `remove` and `list` also reconcile against the legacy file
 * store so pre-migration plaintext can never linger or go missing.
 *
 * Reconcile-on-hit (flip-flop repair): `resolveTokenStorage` can pick a
 * DIFFERENT backend per run for one credentialsDir (keychain locked,
 * headless/SSH, `KIMI_DISABLE_KEYRING=1`, native binary missing, probe fails).
 * A sequential flip-flop then splits state — the keychain may hold an OLDER
 * token while a fallback run wrote a NEWER one to the plaintext file. So `load`
 * reconciles against the legacy file even on a keychain HIT, adopting the file
 * token ONLY when BOTH sides are valid (neither a tombstone) AND the file was
 * issued strictly later (mint second `expiresAt - expiresIn`, not the expiration
 * time `expiresAt`). It NEVER un-revokes a deliberate tombstone from
 * stale plaintext, and only prunes a plaintext copy it made authoritative or one
 * equal to the keychain value after canonical re-serialization. See
 * `reconcileOnHit`.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { FileTokenStorage } from './storage';
import type { TokenStorage } from './storage';
import { classifyToken } from './token-state';
import type { TokenInfo, TokenInfoWire } from './types';
import { tokenFromWire, tokenToWire } from './types';
import { isRecord } from './utils';

/** Keychain service that holds every kimi-code token entry. */
export const KEYRING_SERVICE = 'kimi-code';
/** Isolated service for the capability probe; never collides with real data. */
export const KEYRING_PROBE_SERVICE = 'kimi-code-keyring-probe';

/** Minimal keychain entry surface (structurally satisfied by `Entry`). */
export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  /** Returns true if a credential existed. */
  deleteCredential(): boolean;
}

/** Injectable keychain API so the storage is unit-testable without the OS. */
export interface KeyringApi {
  createEntry(service: string, account: string): KeyringEntry;
  /** Accounts present under a service. */
  findAccounts(service: string): string[];
}

interface KeyringTokenStorageOptions {
  readonly keyring: KeyringApi;
  /** File store used both as migration source and reconciliation target. */
  readonly legacy: FileTokenStorage;
  readonly service?: string;
}

export class KeyringTokenStorage implements TokenStorage {
  private readonly keyring: KeyringApi;
  private readonly legacy: FileTokenStorage;
  private readonly service: string;

  constructor(opts: KeyringTokenStorageOptions) {
    this.keyring = opts.keyring;
    this.legacy = opts.legacy;
    this.service = opts.service ?? KEYRING_SERVICE;
  }

  private serialize(token: TokenInfo): string {
    return JSON.stringify(tokenToWire(token));
  }

  private deserialize(raw: string): TokenInfo | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isRecord(parsed)) return undefined;
    return tokenFromWire(parsed as Partial<TokenInfoWire>);
  }

  async load(name: string): Promise<TokenInfo | undefined> {
    const raw = this.keyring.createEntry(this.service, name).getPassword();
    if (raw !== null) {
      return this.reconcileOnHit(name, raw);
    }
    // Not in the keychain — migrate any plaintext token written by an older
    // file-only build, then drop the cleartext copy (LOCK-FREE, exactly like
    // FileTokenStorage — no proper-lockfile, because reusing the oauth-manager
    // refresh lock here would deadlock the manager's in-lock re-read, and a
    // separate lock wouldn't coordinate with an old file-backend process).
    //
    // Compare-and-delete guards against a concurrent file-backend writer (an old
    // build, a KIMI_DISABLE_KEYRING process, or a fallback instance) saving a
    // NEWER token between our copy-in and our remove. We never unlink a file
    // whose serialized value differs from the one we just made authoritative in
    // the keychain — only a token we actually migrated is deleted.
    const first = await this.legacy.load(name);
    if (first === undefined) return undefined;
    let serialized = this.serialize(first);
    let latest = first;
    this.keyring.createEntry(this.service, name).setPassword(serialized);

    // Bounded converge loop: ensure the keychain holds the latest observed
    // serialized value `S`, then re-read the file ONE more time right before
    // deleting and only unlink when it still equals `S`. A newer value found on
    // the pre-delete re-read is written to keychain and we retry; persistent
    // churn after a few iterations leaves the file in place (a later load
    // reconciles) rather than risk deleting a token we didn't migrate.
    //
    // NOTE: the residual sub-microsecond TOCTOU under concurrently-MIXED
    // file+keyring backends is a documented best-effort limitation; running the
    // file and keyring backends simultaneously against one credentialsDir is
    // unsupported.
    for (let i = 0; i < 3; i += 1) {
      const current = await this.legacy.load(name);
      if (current === undefined) {
        // A peer already removed/migrated the file — nothing to delete, the
        // keychain already holds the latest value we observed.
        return latest;
      }
      const currentSerialized = this.serialize(current);
      if (currentSerialized === serialized) {
        // The file still matches what we migrated → safe to drop the cleartext.
        await this.legacy.remove(name);
        return latest;
      }
      // A newer token landed; make the keychain authoritative with it and retry
      // the compare-and-delete against this newer value.
      this.keyring.createEntry(this.service, name).setPassword(currentSerialized);
      serialized = currentSerialized;
      latest = current;
    }

    // Converge budget exhausted under persistent churn: leave the file in place
    // (never delete a token we may not have migrated) and return the latest
    // value we wrote to the keychain; a subsequent load will reconcile.
    return latest;
  }

  /**
   * Reconcile a keychain HIT against the legacy plaintext file.
   *
   * The keychain backend must be a faithful drop-in for the single-store file
   * backend, but `resolveTokenStorage` can pick a DIFFERENT backend per run for
   * one credentialsDir (keychain locked, headless/SSH, KIMI_DISABLE_KEYRING=1,
   * native binary missing, probe fails). A flip-flop then splits state: the
   * keychain may hold an OLDER token while a fallback run wrote a NEWER one to
   * the plaintext file. Returning the keychain value blindly would silently
   * ignore the user's real, newer token — and if the older token's refresh_token
   * is now rejected, the manager would re-read it and overwrite the keychain
   * with a revoked tombstone while the valid file token sits ignored → forced
   * re-login despite a valid token. So we reconcile on the HIT path too.
   *
   * Invariant — NEVER un-revoke from plaintext: a deliberately-written revoked
   * tombstone (refresh_token rejected) must outrank any stale plaintext token.
   * We therefore adopt the file token ONLY when BOTH sides are VALID (neither is
   * a tombstone) AND the file was ISSUED strictly later. `expiresAt` is an
   * EXPIRATION time (mint second + `expiresIn`), NOT a write-order proxy, so we
   * recover the mint second via `issuedAt = expiresAt - expiresIn` — the
   * `expiresIn` cancels out, making the comparison robust to the server returning
   * a different `expires_in` across refreshes (an older, longer-lived token can
   * otherwise have a LARGER `expiresAt` than a newer, shorter-lived one). In
   * every other case the keychain stays authoritative.
   *
   * Residual limitation: issuance time has 1-second granularity, so two tokens
   * minted in the SAME wall-clock second tie and the keychain stays authoritative
   * (strict `>`). That edge is practically unreachable, and we deliberately avoid
   * a new wire field / monotonic generation counter to keep ZERO breaking change
   * to the on-disk + keychain format.
   */
  private async reconcileOnHit(name: string, raw: string): Promise<TokenInfo | undefined> {
    const keyringToken = this.deserialize(raw);
    const fileToken = await this.legacy.load(name);

    // FAST PATH: steady state has no plaintext file (one cheap readFile that
    // ENOENTs), or the keychain bytes were corrupt JSON (must still return
    // undefined per the existing contract). Either way, nothing to reconcile.
    if (fileToken === undefined || keyringToken === undefined) {
      return keyringToken;
    }

    // Adopt the file token ONLY when both are valid (not tombstones) and the file
    // was ISSUED strictly later. This is the flip-flop repair: a fallback run
    // landed a newer token on disk; make it keychain-authoritative now. We compare
    // mint time (`expiresAt - expiresIn`), NOT `expiresAt` (an expiration time),
    // so a variable server `expires_in` can't make an older long-lived token look
    // newer than a freshly-rotated short-lived one.
    if (
      classifyToken(keyringToken).kind === 'valid' &&
      classifyToken(fileToken).kind === 'valid' &&
      issuedAt(fileToken) > issuedAt(keyringToken)
    ) {
      const fileSerialized = this.serialize(fileToken);
      this.keyring.createEntry(this.service, name).setPassword(fileSerialized);
      // Compare-and-delete: re-read and unlink ONLY if the on-disk bytes still
      // equal what we just made authoritative — never delete a token whose bytes
      // changed under a concurrent writer.
      await this.removeIfBytesMatch(name, fileSerialized);
      return fileToken;
    }

    // Keychain stays authoritative (keyring newer/equal, or EITHER side is a
    // tombstone — the no-un-revoke invariant). As cleanup, prune the plaintext
    // ONLY when it is equal to the authoritative keychain value after canonical
    // re-serialization (a redundant duplicate); a file whose serialized form
    // differs — reordered keys, extra fields, or a genuinely different token — is
    // left in place (conservative — we never delete a token we did not make
    // authoritative).
    //
    // A file left here is intentional and persists: no future `load` cleans it
    // up (this branch only prunes the redundant-duplicate case), so it lingers
    // until the next explicit `remove()` / logout. Deliberate — we never delete a
    // token we did not make authoritative.
    if (this.serialize(fileToken) === raw) {
      await this.removeIfBytesMatch(name, raw);
    }
    return keyringToken;
  }

  /**
   * Compare-and-delete the plaintext copy: re-read the file and unlink it ONLY
   * when its serialized bytes still equal `expected` (the value we made
   * keychain-authoritative). A concurrent file-backend writer that landed a
   * different token between our decision and this delete is left untouched.
   */
  private async removeIfBytesMatch(name: string, expected: string): Promise<void> {
    // The re-read is the compare-and-delete guard, not redundant I/O: it catches
    // a concurrent file-backend writer that landed a newer token between our
    // decision and this delete, so we only unlink bytes that still match.
    const current = await this.legacy.load(name);
    if (current !== undefined && this.serialize(current) === expected) {
      await this.legacy.remove(name);
    }
  }

  async save(name: string, token: TokenInfo): Promise<void> {
    this.keyring.createEntry(this.service, name).setPassword(this.serialize(token));
  }

  async remove(name: string): Promise<void> {
    // Clear both stores so a pre-migration plaintext copy can never linger
    // (e.g. logout before the token was ever migrated). Missing credentials
    // are a no-op, not an error.
    //
    // The legacy cleanup must ALWAYS run so a failing native keyring delete
    // (permissions, lock state, ambiguous entries) can never leave the
    // plaintext file behind — the "both stores cleared" guarantee must hold.
    // A genuine keyring error is surfaced after the file is cleared, never
    // swallowed. (`deleteCredential() === false` for a missing entry is normal,
    // not an error.)
    try {
      this.keyring.createEntry(this.service, name).deleteCredential();
    } catch (error) {
      // Keyring delete failed — still clear the plaintext copy, then re-throw.
      await this.legacy.remove(name);
      throw error;
    }
    await this.legacy.remove(name);
  }

  async list(): Promise<string[]> {
    const fromKeyring = this.keyring.findAccounts(this.service);
    const fromLegacy = await this.legacy.list();
    return [...new Set([...fromKeyring, ...fromLegacy])];
  }
}

/**
 * Recover a token's mint second from persisted fields. `expiresAt` is stamped at
 * issuance as `floor(mintTime) + expiresIn`, so subtracting `expiresIn` cancels
 * the lifetime and yields the issuance instant — robust to a variable server
 * `expires_in` across refreshes (1-second granularity; same-second mints tie).
 */
function issuedAt(token: TokenInfo): number {
  return token.expiresAt - token.expiresIn;
}

/**
 * Adapter over the real `@napi-rs/keyring` module shape, kept narrow so the
 * production load path and the test fakes share one `KeyringApi` contract.
 */
interface NapiKeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry;
  findCredentials: (service: string) => Array<{ account: string; password: string }>;
}

function adaptNapiKeyring(mod: NapiKeyringModule): KeyringApi {
  return {
    createEntry(service, account) {
      return new mod.Entry(service, account);
    },
    findAccounts(service) {
      return mod.findCredentials(service).map((c) => c.account);
    },
  };
}

/** Real native load: throws (caught here) when the binary can't be required. */
function loadNativeKeyring(): KeyringApi | undefined {
  try {
    const require = createRequire(import.meta.url);
    const mod = require('@napi-rs/keyring') as NapiKeyringModule;
    return adaptNapiKeyring(mod);
  } catch {
    return undefined;
  }
}

/**
 * Round-trip a sentinel under an isolated service to prove the keychain has a
 * live backend. Any throw, or a read-back mismatch, means the keychain is not
 * usable on this host.
 */
function probeKeyring(keyring: KeyringApi): boolean {
  // A UNIQUE account per attempt: two CLI processes probing concurrently must
  // not share one sentinel account, or one's delete clobbers the other's
  // round-trip → false mismatch → spurious file fallback on a healthy keychain
  // (which then splits file/keyring state — the very thing migration avoids).
  const account = `probe-${process.pid}-${randomBytes(8).toString('hex')}`;
  const sentinel = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const entry = keyring.createEntry(KEYRING_PROBE_SERVICE, account);
  try {
    entry.setPassword(sentinel);
    const readBack = entry.getPassword();
    return readBack === sentinel;
  } catch {
    return false;
  } finally {
    // Always remove our own sentinel, even if the round-trip threw mid-way.
    try {
      entry.deleteCredential();
    } catch {
      // best-effort cleanup; a failed delete must not mask the probe result
    }
  }
}

/**
 * Derive the keychain *service* name for a credentials directory so that the
 * keyring backend isolates profiles by directory exactly like the file backend
 * isolates them by `credentialsDir`. Without this, every profile / SDK caller
 * collides on one fixed `'kimi-code'` service — a data-loss regression vs the
 * file store.
 *
 * The "default" detection is deliberately keyed off the STANDARD path
 * (`~/.kimi-code/credentials`), NOT `defaultKimiHome()` / `KIMI_CODE_HOME`:
 * two different `KIMI_CODE_HOME` values would both look "default" and re-collide
 * on `'kimi-code'`. Hashing the actual resolved dir guarantees isolation for
 * every non-standard dir, while the one standard home per OS user keeps a
 * stable, human-readable `'kimi-code'` service for the common case.
 */
export function keyringServiceForCredentialsDir(credentialsDir: string): string {
  const resolved = resolve(credentialsDir);
  const standard = resolve(join(homedir(), '.kimi-code', 'credentials'));
  if (resolved === standard) return KEYRING_SERVICE;
  return `kimi-code-${createHash('sha256').update(resolved).digest('hex').slice(0, 16)}`;
}

interface ResolveTokenStorageDeps {
  /** Returns a usable KeyringApi, or undefined when the native load fails. */
  loadKeyring?: () => KeyringApi | undefined;
  /** Force the file backend (defaults to the KIMI_DISABLE_KEYRING env flag). */
  disabled?: boolean;
}

/**
 * Pick the token backend for `credentialsDir`: keychain when usable, otherwise
 * the plaintext file store (which also seeds migration). The `deps` seam is for
 * tests only; production uses the real native load + env flag.
 */
export function resolveTokenStorage(
  credentialsDir: string,
  deps: ResolveTokenStorageDeps = {},
): TokenStorage {
  const legacy = new FileTokenStorage(credentialsDir);

  const disabled = deps.disabled ?? process.env['KIMI_DISABLE_KEYRING'] === '1';
  if (disabled) return legacy;

  const loadKeyring = deps.loadKeyring ?? loadNativeKeyring;
  const keyring = loadKeyring();
  if (keyring === undefined) return legacy;

  if (!probeKeyring(keyring)) return legacy;

  // Namespace the keychain service by credentialsDir so distinct profiles /
  // SDK callers stay isolated, matching the file backend's per-directory
  // isolation. The legacy file store and the derived service both come from the
  // SAME credentialsDir, so a file at `<credentialsDir>/<name>.json` migrates
  // into the matching namespaced service.
  const service = keyringServiceForCredentialsDir(credentialsDir);
  return new KeyringTokenStorage({ keyring, legacy, service });
}
