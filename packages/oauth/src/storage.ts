/**
 * File-based OAuth token storage.
 *
 * Tokens are persisted under a directory (default
 * `~/.kimi-code/credentials/`) as `<name>.json` with mode 0600 (parent
 * dir 0700). Wire format uses snake_case to match the server contract.
 *
 * Write semantics: write to `<name>.tmp.<pid>.<rand>` → fsync → rename.
 * Atomic on POSIX; Windows best-effort.
 *
 * Load semantics: missing file → undefined. Corrupt JSON / wrong shape →
 * undefined (never throws). Callers treat undefined as "no token stored".
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import lockfile from 'proper-lockfile';

import type { TokenInfo, TokenInfoWire } from './types';
import { tokenFromWire, tokenToWire } from './types';
import { isRecord } from './utils';

export interface TokenStorage {
  load(name: string): Promise<TokenInfo | undefined>;
  save(name: string, token: TokenInfo): Promise<void>;
  remove(name: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface FileTokenAccess {
  load(): Promise<TokenInfo | undefined>;
  save(token: TokenInfo): Promise<void>;
  remove(): Promise<void>;
  removeIfMatches(expected: string): Promise<boolean>;
}

export async function withFileLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const fd = openSync(target, 'a', 0o600);
  closeSync(fd);
  const release = await lockfile.lock(target, {
    retries: { retries: 120, factor: 1, minTimeout: 50, maxTimeout: 500 },
    stale: 5_000,
    realpath: false,
  });
  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch {
      // Best effort: a stale lock must not mask the completed operation.
    }
  }
}

/**
 * Guard against path traversal: caller-provided names (from config.toml
 * or slash commands) must not escape the credentials dir. `basename`
 * strips any `..` or `/` segments; if the sanitized value differs from
 * the input we refuse the request entirely rather than silently
 * writing to a different file than the caller asked for.
 */
export function assertValidTokenName(name: string): void {
  const safe = basename(name);
  if (safe.length === 0 || safe !== name || safe.startsWith('.')) {
    throw new Error(`Invalid token name: "${name}"`);
  }
}

export class FileTokenStorage implements TokenStorage {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // recursive=true with mode only applies on initial create; tighten after
    // the fact in case an existing dir had looser permissions.
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // best-effort; Windows / read-only FS may refuse
    }
  }

  private pathFor(name: string): string {
    assertValidTokenName(name);
    return join(this.dir, `${name}.json`);
  }

  private lockTargetFor(name: string): string {
    assertValidTokenName(name);
    return join(this.dir, `${name}.lock-target`);
  }

  protected loadUnlocked(name: string): TokenInfo | undefined {
    const file = this.pathFor(name);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf-8');
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isRecord(parsed)) return undefined;
    return tokenFromWire(parsed as Partial<TokenInfoWire>);
  }

  protected saveUnlocked(name: string, token: TokenInfo): void {
    this.ensureDir();
    const target = this.pathFor(name);
    const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    const data = Buffer.from(`${JSON.stringify(tokenToWire(token), null, 2)}\n`, 'utf-8');
    const fd = openSync(tmp, 'w', 0o600);
    try {
      let written = 0;
      while (written < data.length) {
        written += writeSync(fd, data, written, data.length - written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmp, 0o600);
      renameSync(tmp, target);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  protected removeUnlocked(name: string): void {
    try {
      unlinkSync(this.pathFor(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  protected removeIfMatchesUnlocked(name: string, expected: string): boolean {
    const target = this.pathFor(name);
    const quarantined = `${target}.remove.${process.pid}.${randomBytes(4).toString('hex')}`;
    try {
      renameSync(target, quarantined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }

    let matches = false;
    let readError: unknown;
    try {
      const raw = readFileSync(quarantined, 'utf-8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      matches =
        isRecord(parsed) &&
        JSON.stringify(tokenToWire(tokenFromWire(parsed as Partial<TokenInfoWire>))) === expected;
    } catch (error) {
      readError = error;
    }
    if (matches) {
      unlinkSync(quarantined);
    } else {
      try {
        renameSync(quarantined, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') unlinkSync(quarantined);
        else throw error;
      }
    }
    if (readError !== undefined) {
      throw readError instanceof Error ? readError : new Error('failed to inspect token file', { cause: readError });
    }
    return matches;
  }

  async withTokenLock<T>(name: string, fn: (access: FileTokenAccess) => Promise<T>): Promise<T> {
    assertValidTokenName(name);
    this.ensureDir();
    const lockTarget = this.lockTargetFor(name);
    return withFileLock(lockTarget, () =>
      fn({
        load: async () => this.loadUnlocked(name),
        save: async (token) => {
          this.saveUnlocked(name, token);
        },
        remove: async () => {
          this.removeUnlocked(name);
        },
        removeIfMatches: async (expected) => this.removeIfMatchesUnlocked(name, expected),
      }),
    );
  }

  async load(name: string): Promise<TokenInfo | undefined> {
    assertValidTokenName(name);
    return this.withTokenLock(name, async (access) => access.load());
  }

  async save(name: string, token: TokenInfo): Promise<void> {
    assertValidTokenName(name);
    await this.withTokenLock(name, async (access) => {
      await access.save(token);
    });
  }

  async remove(name: string): Promise<void> {
    assertValidTokenName(name);
    await this.withTokenLock(name, async (access) => {
      await access.remove();
    });
  }

  async list(): Promise<string[]> {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return [];
    }
    return entries.filter((e) => e.endsWith('.json')).map((e) => e.slice(0, -'.json'.length));
  }
}
