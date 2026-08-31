/**
 * Keychain-backed OAuth token storage with plaintext-file fallback.
 *
 * Backend: the OS keychain (macOS Keychain, Windows Credential Manager,
 * Linux Secret Service). This package stays pure TypeScript — the host
 * process (apps/kimi-code) adapts the native `@napi-rs/keyring` binding to
 * the narrow `KeyringApi` surface below and injects it through
 * `registerKeyringBackend`. Tokens live under a keychain *service* derived
 * per credentials directory (`keyringServiceForCredentialsDir`) so distinct
 * profiles / SDK callers stay isolated exactly like the file backend isolates
 * them by directory; each token is one entry whose *account* is the token
 * `name` and whose *password* is the snake_case wire JSON — the exact same
 * payload `FileTokenStorage` writes to disk.
 *
 * Selection (`resolveTokenStorage`), in order:
 *   1. `KIMI_DISABLE_KEYRING=1` → file ('disabled').
 *   2. `KIMI_CODE_EXPERIMENTAL_KEYRING` not '1' → file ('not-opted-in'); a
 *      temporary opt-in gate, see the factory's JSDoc.
 *   3. No backend registered → file ('no-backend').
 *   4. Capability probe failed → file ('probe-failed'). A set/get/delete
 *      round-trip under a SEPARATE sentinel service catches a binding that
 *      loads but has no live OS backend at runtime (e.g. headless Linux with
 *      no Secret Service): entry operations only throw at CALL time.
 *   5. Otherwise the keychain is authoritative.
 *
 * Degradation: any keyring call that THROWS marks the backend degraded
 * process-wide (sticky until re-registration), reports
 * `onKeyringDegraded`, and the current operation uses the file store where a
 * copy exists — load reads it without migrating, save writes it, remove clears
 * it, and list reads it. A keychain-only token is reported as unavailable
 * instead of being mistaken for a logged-out account.
 *
 * Migration: when the keychain is selected but a token is still only on disk
 * (written by an older file-only build), `load` migrates it — copy into the
 * keychain, then compare-and-delete the plaintext file (only unlink a file
 * that still matches the value made keychain-authoritative) — so secrets stop
 * living in the clear without ever dropping a newer token a concurrent
 * file-backend writer may have just landed. Migration holds the same
 * per-token file lock as `FileTokenStorage`. `remove` and `list` also reconcile against the
 * legacy file store so pre-migration plaintext can never linger or go
 * missing. `save` prunes any legacy plaintext copy after the keychain write
 * so a later file-backend run can't resurrect a superseded token.
 *
 * Reconcile-on-hit (flip-flop repair): `resolveTokenStorage` can pick a
 * DIFFERENT backend per run for one credentialsDir (keychain locked,
 * headless/SSH, `KIMI_DISABLE_KEYRING=1`, no registered backend, probe
 * fails). A sequential flip-flop then splits state — the keychain may hold an
 * OLDER token while a fallback run wrote a NEWER one to the plaintext file.
 * So `load` reconciles against the legacy file even on a keychain HIT,
 * adopting the file token ONLY when BOTH sides are valid (neither a
 * tombstone) AND the file was issued strictly later (mint second
 * `expiresAt - expiresIn`, not the expiration time `expiresAt`). It NEVER
 * un-revokes a deliberate tombstone from stale plaintext, and only prunes a
 * plaintext copy it made authoritative or one equal to the keychain value
 * after canonical re-serialization. See `reconcileOnHit`.
 */

import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { assertValidTokenName, FileTokenStorage } from './storage';
import type { FileTokenAccess, TokenStorage } from './storage';
import { OAuthStorageUnavailableError } from './errors';
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
  /**
   * Returns true when a credential was deleted. The native binding NEVER
   * throws and maps EVERY failure (locked/no-access/ambiguous/platform error)
   * to the SAME `false` it returns for "no such entry", so `false` is
   * ambiguous — "did not exist" OR "delete failed". `getPassword()` cannot
   * disambiguate it (the binding likewise collapses every read error to
   * `null`); prove absence with the service-scoped `findAccounts()` listing
   * instead (see `remove`).
   */
  deleteCredential(): boolean;
}

/** Injectable keychain API so the storage is unit-testable without the OS. */
export interface KeyringApi {
  createEntry(service: string, account: string): KeyringEntry;
  /** Accounts present under a service. */
  findAccounts(service: string): string[];
}

/** Storage operations that can degrade to the file backend. */
export type KeyringOperation = 'load' | 'save' | 'remove' | 'list';

/** Observability hooks for keyring selection, migration, and degradation. */
export interface KeyringStorageObserver {
  /**
   * Fired once per `resolveTokenStorage` call. `reason` for `'file'` is one of
   * `'disabled' | 'not-opted-in' | 'no-backend' | 'probe-failed'`; the
   * `'keyring'` selection carries no reason.
   */
  onBackendSelected?(backend: 'keyring' | 'file', reason?: string): void;
  /** Fired when a keyring call throws and the backend degrades to the file store. */
  onKeyringDegraded?(operation: KeyringOperation, message: string): void;
  /** Fired when a plaintext-file token is migrated into the keychain. */
  onMigrated?(name: string): void;
}

/** The registered keychain backend plus its observability hooks. */
export interface RegisteredKeyringBackend {
  readonly api: KeyringApi;
  readonly observer?: KeyringStorageObserver;
}

let registeredBackend: RegisteredKeyringBackend | undefined;

/**
 * Process-wide sticky degradation flag: once any keyring call throws, every
 * KeyringTokenStorage in this process completes against the file store.
 * Reset by (re-)registering or unregistering the backend.
 */
let keyringDegraded = false;
let keyringDegradationError: unknown;

/**
 * Register the host-provided keychain backend. Process-wide; calling again
 * replaces the previous registration (and clears the degradation flag), which
 * tests rely on. Without a registration `resolveTokenStorage` always selects
 * the file backend.
 */
export function registerKeyringBackend(api: KeyringApi, observer?: KeyringStorageObserver): void {
  registeredBackend = { api, observer };
  keyringDegraded = false;
  keyringDegradationError = undefined;
}

/** Clear the registered backend and the degradation flag. Intended for tests. */
export function unregisterKeyringBackend(): void {
  registeredBackend = undefined;
  keyringDegraded = false;
  keyringDegradationError = undefined;
}

/**
 * Read the process-wide registration slot. Returns undefined when no backend
 * has been registered; other keyring consumers (e.g. the v2 MCP OAuth grant
 * store) reuse it to make the same backend decision as `resolveTokenStorage`.
 */
export function getRegisteredKeyringBackend(): RegisteredKeyringBackend | undefined {
  return registeredBackend;
}

/**
 * Single source for the keyring opt-in gate: the keychain is considered only
 * when `KIMI_CODE_EXPERIMENTAL_KEYRING` is '1' AND `KIMI_DISABLE_KEYRING` is
 * not '1'. `resolveTokenStorage` still reports the two halves as distinct
 * fallback reasons ('disabled' / 'not-opted-in'); callers that only need the
 * combined decision use this.
 */
export function isKeyringOptedIn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['KIMI_DISABLE_KEYRING'] !== '1' && env['KIMI_CODE_EXPERIMENTAL_KEYRING'] === '1';
}

interface KeyringTokenStorageOptions {
  readonly keyring: KeyringApi;
  /** File store used as migration source, reconcile target, and degraded fallback. */
  readonly legacy: FileTokenStorage;
  readonly service?: string;
  readonly observer?: KeyringStorageObserver;
}

export class KeyringTokenStorage implements TokenStorage {
  private readonly keyring: KeyringApi;
  private readonly legacy: FileTokenStorage;
  private readonly service: string;
  private readonly observer: KeyringStorageObserver | undefined;

  constructor(opts: KeyringTokenStorageOptions) {
    this.keyring = opts.keyring;
    this.legacy = opts.legacy;
    this.service = opts.service ?? KEYRING_SERVICE;
    this.observer = opts.observer;
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

  /**
   * Run a keyring call, converting a throw into degradation: mark the backend
   * degraded process-wide, notify the observer, and return `{ ok: false }` so
   * the caller completes the operation against the file store.
   */
  private tryKeyring<T>(
    operation: KeyringOperation,
    fn: () => T,
  ): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown } {
    try {
      return { ok: true, value: fn() };
    } catch (error) {
      keyringDegraded = true;
      keyringDegradationError = error;
      this.observer?.onKeyringDegraded?.(
        operation,
        error instanceof Error ? error.message : String(error),
      );
      return { ok: false, error };
    }
  }

  async load(name: string): Promise<TokenInfo | undefined> {
    assertValidTokenName(name);
    return this.legacy.withTokenLock(name, async (access) => {
      if (keyringDegraded) {
        const fallback = await access.load();
        if (fallback !== undefined) return fallback;
        throw new OAuthStorageUnavailableError(`keyring unavailable while loading credential "${name}"`, {
          cause: keyringDegradationError,
        });
      }
      if (access.isRemovalMarked()) {
        if (access.isFileChangedSinceRemoval()) {
          access.clearRemoval();
        } else {
          const survived = new Error(`failed to delete keyring credential "${name}"`);
          const removed = this.tryKeyring('remove', () => {
            const deleted = this.keyring.createEntry(this.service, name).deleteCredential();
            if (!deleted && this.keyring.findAccounts(this.service).includes(name)) {
              throw survived;
            }
          });
          if (!removed.ok) {
            throw new OAuthStorageUnavailableError(`keyring unavailable while loading credential "${name}"`, {
              cause: removed.error,
            });
          }
          return undefined;
        }
      }
      const read = this.tryKeyring('load', () =>
        this.keyring.createEntry(this.service, name).getPassword(),
      );
      if (!read.ok) {
        const fallback = await access.load();
        if (fallback !== undefined) return fallback;
        throw new OAuthStorageUnavailableError(`keyring unavailable while loading credential "${name}"`, {
          cause: read.error,
        });
      }
      const raw = read.value;
      if (raw !== null) return this.reconcileOnHitUnlocked(name, raw, access);

      const first = await access.load();
      if (first === undefined) return undefined;
      let serialized = this.serialize(first);
      let latest = first;
      if (
        !this.tryKeyring('save', () => {
          this.keyring.createEntry(this.service, name).setPassword(serialized);
        }).ok
      ) {
        return latest;
      }

      for (let i = 0; i < 3; i += 1) {
        const current = await access.load();
        if (current === undefined) {
          this.observer?.onMigrated?.(name);
          return latest;
        }
        const currentSerialized = this.serialize(current);
        if (currentSerialized === serialized) {
          if (await access.removeIfMatches(serialized)) {
            this.observer?.onMigrated?.(name);
            return latest;
          }
          continue;
        }
        const write = this.tryKeyring('load', () => {
          this.keyring.createEntry(this.service, name).setPassword(currentSerialized);
        });
        if (!write.ok) return current;
        serialized = currentSerialized;
        latest = current;
      }
      return latest;
    });
  }

  /**
   * Reconcile a keychain HIT against the legacy plaintext file.
   *
   * `resolveTokenStorage` can pick a DIFFERENT backend per run for one
   * credentialsDir, so a flip-flop can split state: the keychain may hold an
   * OLDER token while a fallback run wrote a NEWER one to the plaintext file.
   * Returning the keychain value blindly would silently ignore the user's
   * real, newer token — and if the older token's refresh_token is now
   * rejected, the manager would overwrite the keychain with a revoked
   * tombstone while the valid file token sits ignored → forced re-login
   * despite a valid token. So we reconcile on the HIT path too.
   *
   * Invariant — NEVER un-revoke from plaintext: a deliberately-written
   * revoked tombstone (refresh_token rejected) must outrank any stale
   * plaintext token. We adopt the file token ONLY when BOTH sides are VALID
   * AND the file was ISSUED strictly later. `expiresAt` is an EXPIRATION time
   * (mint second + `expiresIn`), NOT a write-order proxy, so we recover the
   * mint second via `issuedAt = expiresAt - expiresIn` — robust to the server
   * returning a different `expires_in` across refreshes. In every other case
   * the keychain stays authoritative.
   *
   * Residual limitation: issuance time has 1-second granularity, so two
   * tokens minted in the SAME wall-clock second tie and the keychain stays
   * authoritative (strict `>`). Deliberate — it avoids any breaking change to
   * the on-disk + keychain wire format.
   */
  private async reconcileOnHitUnlocked(
    name: string,
    raw: string,
    access: FileTokenAccess,
  ): Promise<TokenInfo | undefined> {
    const keyringToken = this.deserialize(raw);
    const fileToken = await access.load();

    if (fileToken === undefined) {
      return keyringToken;
    }

    if (keyringToken === undefined) {
      const fileSerialized = this.serialize(fileToken);
      const write = this.tryKeyring('load', () => {
        this.keyring.createEntry(this.service, name).setPassword(fileSerialized);
      });
      if (!write.ok) return fileToken;
      if (await access.removeIfMatches(fileSerialized)) this.observer?.onMigrated?.(name);
      return fileToken;
    }

    if (
      classifyToken(keyringToken).kind === 'valid' &&
      classifyToken(fileToken).kind === 'valid' &&
      issuedAt(fileToken) > issuedAt(keyringToken)
    ) {
      const fileSerialized = this.serialize(fileToken);
      const write = this.tryKeyring('load', () => {
        this.keyring.createEntry(this.service, name).setPassword(fileSerialized);
      });
      if (!write.ok) {
        return fileToken;
      }
      if (await access.removeIfMatches(fileSerialized)) {
        this.observer?.onMigrated?.(name);
      }
      return fileToken;
    }

    if (this.serialize(fileToken) === raw) {
      await access.removeIfMatches(raw);
    }
    return keyringToken;
  }

  async save(name: string, token: TokenInfo): Promise<void> {
    // Reject invalid names BEFORE the keychain write to preserve the file
    // backend's fail-before-write contract — otherwise setPassword would
    // orphan a credential under an invalid account before the legacy name
    // check threw.
    assertValidTokenName(name);
    await this.legacy.withTokenLock(name, async (access) => {
      if (keyringDegraded) {
        if (classifyToken(token).kind === 'revoked') {
          throw new OAuthStorageUnavailableError(`keyring unavailable while saving revoked credential "${name}"`, {
            cause: keyringDegradationError,
          });
        }
        await access.save(token);
        return;
      }
      const write = this.tryKeyring('save', () => {
        this.keyring.createEntry(this.service, name).setPassword(this.serialize(token));
      });
      if (!write.ok) {
        if (classifyToken(token).kind === 'revoked') {
          throw new OAuthStorageUnavailableError(`keyring unavailable while saving revoked credential "${name}"`, {
            cause: write.error,
          });
        }
        await access.save(token);
        return;
      }
      try {
        await access.removeFile();
        access.clearRemoval();
      } catch (error) {
        const rollback = this.tryKeyring('remove', () => {
          const deleted = this.keyring.createEntry(this.service, name).deleteCredential();
          if (!deleted && this.keyring.findAccounts(this.service).includes(name)) {
            throw new Error(`failed to roll back keyring credential "${name}"`, { cause: error });
          }
        });
        if (!rollback.ok) {
          const rollbackMessage =
            rollback.error instanceof Error ? rollback.error.message : String(rollback.error);
          throw new Error(
            `failed to finalize keyring credential "${name}": ${rollbackMessage}`,
            { cause: error },
          );
        }
        throw new Error(`failed to finalize credential "${name}"`, { cause: error });
      }
    });
  }

  async remove(name: string): Promise<void> {
    assertValidTokenName(name);
    // Clear both stores so a pre-migration plaintext copy can never linger
    // (e.g. logout before the token was ever migrated). Missing credentials
    // are a no-op, not an error.
    const gone = await this.legacy.withTokenLock(name, async (access) => {
      access.markRemoved();
      const result = this.tryKeyring('remove', () => {
        const deleted = this.keyring.createEntry(this.service, name).deleteCredential();
        if (deleted) return true;
        return !this.keyring.findAccounts(this.service).includes(name);
      });
      await access.remove();
      return result;
    });
    if (!gone.ok) {
      throw new Error(`failed to delete keyring credential "${name}"`, {
        cause: gone.error,
      });
    }
    if (!gone.value) {
      throw new Error(`failed to delete keyring credential "${name}"`);
    }
  }

  async list(): Promise<string[]> {
    if (keyringDegraded) return this.legacy.list();
    const accounts = this.tryKeyring('list', () => this.keyring.findAccounts(this.service));
    if (!accounts.ok) return this.legacy.list();
    const fromLegacy = await this.legacy.list();
    return [...new Set([...accounts.value, ...fromLegacy])];
  }
}

/**
 * Recover a token's mint second from persisted fields. `expiresAt` is stamped
 * at issuance as `floor(mintTime) + expiresIn`, so subtracting `expiresIn`
 * cancels the lifetime and yields the issuance instant — robust to a variable
 * server `expires_in` across refreshes (1-second granularity; same-second
 * mints tie).
 *
 * Operates on any `TokenInfo`: both fields are always numeric
 * (`tokenFromWire` defaults them to 0), so even an externally-edited record
 * compares as a consistent integer order — never NaN/throw. Only the caller's
 * both-valid guard feeds it real minted tokens; tombstones (`expiresIn: 0`)
 * are excluded there.
 */
function issuedAt(token: TokenInfo): number {
  return token.expiresAt - token.expiresIn;
}

/**
 * Round-trip a sentinel under an isolated service to prove the keychain has a
 * live backend. Any throw, a read-back mismatch, or an inability to DELETE
 * the sentinel means the keychain is not usable on this host. Delete
 * capability is part of the usability contract: once selected the keychain is
 * the authoritative store, so logout/revocation (`remove`) and `load`'s
 * migrate-then-delete both depend on it being able to remove entries. A
 * backend that can set/read but not delete would trap migrated tokens it can
 * never remove and make logout throw — so we reject it here and fall back to
 * the file store instead of migrating plaintext into a one-way keychain.
 */
export function probeKeyringBackend(keyring: KeyringApi): boolean {
  // A UNIQUE account per attempt: two CLI processes probing concurrently must
  // not share one sentinel account, or one's delete clobbers the other's
  // round-trip → false mismatch → spurious file fallback on a healthy
  // keychain (which then splits file/keyring state — the very thing migration
  // avoids).
  const account = `probe-${process.pid}-${randomBytes(8).toString('hex')}`;
  const sentinel = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const entry = keyring.createEntry(KEYRING_PROBE_SERVICE, account);
  try {
    entry.setPassword(sentinel);
    if (entry.getPassword() !== sentinel) return false;
    entry.deleteCredential();
    // Confirm the delete the same non-error-ambiguous way remove() does: the
    // binding collapses a denied delete to `false` AND a denied read to
    // `null`, so `getPassword() === null` cannot prove the sentinel is gone.
    // findAccounts() THROWS on an unreachable store (→ caught below →
    // unusable) and lists accounts when reachable; our UNIQUE per-process
    // probe account being ABSENT from that listing proves the backend can
    // truly delete (and catches a deleteCredential() that lies about success).
    return !keyring.findAccounts(KEYRING_PROBE_SERVICE).includes(account);
  } catch {
    return false;
  } finally {
    // Safety-net cleanup for the early-return and throw paths, and a harmless
    // idempotent no-op on the success path: never leave a sentinel behind,
    // and never let cleanup mask the probe result.
    try {
      entry.deleteCredential();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Derive the keychain *service* name for a credentials directory so the
 * keyring backend isolates profiles by directory exactly like the file
 * backend isolates them by `credentialsDir`. Without this, every profile /
 * SDK caller would collide on one fixed `'kimi-code'` service — a data-loss
 * regression vs the file store.
 *
 * The "default" detection is deliberately keyed off the STANDARD path
 * (`~/.kimi-code/credentials`), NOT `defaultKimiHome()` / `KIMI_CODE_HOME`:
 * two different `KIMI_CODE_HOME` values would both look "default" and
 * re-collide on `'kimi-code'`. Hashing the actual resolved dir guarantees
 * isolation for every non-standard dir, while the one standard home per OS
 * user keeps a stable, human-readable `'kimi-code'` service.
 */
export function keyringServiceForCredentialsDir(credentialsDir: string): string {
  const resolved = resolve(credentialsDir);
  const standard = resolve(join(homedir(), '.kimi-code', 'credentials'));
  if (resolved === standard) return KEYRING_SERVICE;
  return `kimi-code-${createHash('sha256').update(resolved).digest('hex').slice(0, 16)}`;
}

/** Test seam for `resolveTokenStorage`; production passes nothing. */
export interface ResolveTokenStorageDeps {
  /** Overrides the registered-backend lookup; undefined return = no backend. */
  loadKeyring?: () => KeyringApi | undefined;
  /** Overrides the registered observer. */
  observer?: KeyringStorageObserver;
  /** Force the file backend (defaults to the KIMI_DISABLE_KEYRING env flag). */
  disabled?: boolean;
  /** Overrides the KIMI_CODE_EXPERIMENTAL_KEYRING opt-in gate. */
  optedIn?: boolean;
}

/**
 * Pick the token backend for `credentialsDir`: the keychain when usable,
 * otherwise the plaintext file store (which also seeds migration). The `deps`
 * seam is for tests only; production uses the registered backend + env flags.
 *
 * TEMPORARY OPT-IN GATE: the keychain is considered only when
 * `KIMI_CODE_EXPERIMENTAL_KEYRING=1` is set ('not-opted-in' otherwise). The
 * gate stays until the datasource-broker plugin rollout makes keyring
 * storage the right default everywhere; releasing is a one-line follow-up
 * that flips this check to default-on.
 */
export function resolveTokenStorage(
  credentialsDir: string,
  deps: ResolveTokenStorageDeps = {},
): TokenStorage {
  const legacy = new FileTokenStorage(credentialsDir);
  const observer = deps.observer ?? registeredBackend?.observer;

  const disabled = deps.disabled ?? process.env['KIMI_DISABLE_KEYRING'] === '1';
  if (disabled) {
    observer?.onBackendSelected?.('file', 'disabled');
    return legacy;
  }

  const optedIn = deps.optedIn ?? isKeyringOptedIn();
  if (!optedIn) {
    observer?.onBackendSelected?.('file', 'not-opted-in');
    return legacy;
  }

  const loadKeyring = deps.loadKeyring ?? (() => registeredBackend?.api);
  const keyring = loadKeyring();
  if (keyring === undefined) {
    observer?.onBackendSelected?.('file', 'no-backend');
    return legacy;
  }

  if (!probeKeyringBackend(keyring)) {
    observer?.onBackendSelected?.('file', 'probe-failed');
    return legacy;
  }

  // Namespace the keychain service by credentialsDir so distinct profiles /
  // SDK callers stay isolated, matching the file backend's per-directory
  // isolation. The legacy file store and the derived service both come from
  // the SAME credentialsDir, so a file at `<credentialsDir>/<name>.json`
  // migrates into the matching namespaced service.
  const service = keyringServiceForCredentialsDir(credentialsDir);
  observer?.onBackendSelected?.('keyring');
  return new KeyringTokenStorage({ keyring, legacy, service, observer });
}
