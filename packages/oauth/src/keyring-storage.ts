/**
 * Keychain-backed OAuth token storage with plaintext-file fallback.
 *
 * Backend: the OS keychain (macOS Keychain, Windows Credential Manager,
 * Linux Secret Service) via `@napi-rs/keyring`. All tokens live under a single
 * keychain *service* (`KEYRING_SERVICE`); each token is one entry whose
 * *account* is the token `name` and whose *password* is the snake_case wire
 * JSON — the exact same payload `FileTokenStorage` writes to disk.
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
 * keychain, then delete the plaintext file — so secrets stop living in the
 * clear. `remove` and `list` also reconcile against the legacy file store so
 * pre-migration plaintext can never linger or go missing.
 */

import { createRequire } from 'node:module';

import { FileTokenStorage } from './storage';
import type { TokenStorage } from './storage';
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
      return this.deserialize(raw);
    }
    // Not in the keychain — migrate any plaintext token written by an older
    // file-only build, then drop the cleartext copy.
    const legacyToken = await this.legacy.load(name);
    if (legacyToken === undefined) return undefined;
    this.keyring.createEntry(this.service, name).setPassword(this.serialize(legacyToken));
    await this.legacy.remove(name);
    return legacyToken;
  }

  async save(name: string, token: TokenInfo): Promise<void> {
    this.keyring.createEntry(this.service, name).setPassword(this.serialize(token));
  }

  async remove(name: string): Promise<void> {
    // Clear both stores so a pre-migration plaintext copy can never linger
    // (e.g. logout before the token was ever migrated). Missing credentials
    // are a no-op, not an error.
    this.keyring.createEntry(this.service, name).deleteCredential();
    await this.legacy.remove(name);
  }

  async list(): Promise<string[]> {
    const fromKeyring = this.keyring.findAccounts(this.service);
    const fromLegacy = await this.legacy.list();
    return [...new Set([...fromKeyring, ...fromLegacy])];
  }
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
  const sentinel = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const entry = keyring.createEntry(KEYRING_PROBE_SERVICE, 'probe');
    entry.setPassword(sentinel);
    const readBack = entry.getPassword();
    entry.deleteCredential();
    return readBack === sentinel;
  } catch {
    return false;
  }
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

  return new KeyringTokenStorage({ keyring, legacy });
}
