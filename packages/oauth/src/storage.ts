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

import { createHash, randomBytes } from 'node:crypto';
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
  removeFile(): Promise<void>;
  removeIfMatches(expected: string): Promise<boolean>;
  isRemovalMarked(): boolean;
  isFileChangedSinceRemoval(): boolean;
  markRemoved(): void;
  clearRemoval(): void;
}

export async function withFileLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  let release: (() => Promise<void>) | undefined;
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const fd = openSync(target, 'a', 0o600);
    closeSync(fd);
    release = await lockfile.lock(target, {
      retries: { retries: 120, factor: 1, minTimeout: 50, maxTimeout: 500 },
      stale: 5_000,
      realpath: false,
    });
  } catch (error) {
    // A read-only / unwritable credentials dir (e.g. a mounted secrets volume)
    // must not break loading an otherwise usable credential: proceed without
    // the lock. Writes still fail at their own write step, as before.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EROFS' && code !== 'EACCES' && code !== 'EPERM') throw error;
    return fn();
  }
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

  private removalMarkerFor(name: string): string {
    assertValidTokenName(name);
    return join(this.dir, `${name}.removed`);
  }

  protected loadUnlocked(name: string): TokenInfo | undefined {
    const removalMarker = this.readRemovalMarkerUnlocked(name);
    if (removalMarker !== undefined) {
      if (!this.isFileChangedSinceRemovalUnlocked(name, removalMarker)) return undefined;
      this.clearRemovalUnlocked(name);
    }
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
    try {
      this.clearRemovalUnlocked(name);
    } catch (error) {
      try {
        unlinkSync(target);
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  protected removeUnlocked(name: string): void {
    this.markRemovedUnlocked(name);
    this.removeFileUnlocked(name);
  }

  protected removeFileUnlocked(name: string): void {
    try {
      unlinkSync(this.pathFor(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private isRemovalMarkedUnlocked(name: string): boolean {
    return this.readRemovalMarkerUnlocked(name) !== undefined;
  }

  private readRemovalMarkerUnlocked(name: string): { readonly fileDigest: string | null } | undefined {
    try {
      const raw = readFileSync(this.removalMarkerFor(name), 'utf-8');
      if (raw.length === 0) return { fileDigest: null };
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as { version?: unknown }).version !== 1 ||
        !('file_digest' in parsed) ||
        (parsed as { file_digest?: unknown }).file_digest !== null &&
          typeof (parsed as { file_digest?: unknown }).file_digest !== 'string'
      ) {
        throw new Error(`Invalid removal marker for token "${name}"`);
      }
      return { fileDigest: (parsed as { file_digest: string | null }).file_digest };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof SyntaxError) {
        throw new TypeError(`Invalid removal marker for token "${name}"`, { cause: error });
      }
      throw error;
    }
  }

  private isFileChangedSinceRemovalUnlocked(
    name: string,
    marker: { readonly fileDigest: string | null },
  ): boolean {
    let raw: string;
    try {
      raw = readFileSync(this.pathFor(name), 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (marker.fileDigest === null) return true;
    return createHash('sha256').update(raw).digest('hex') !== marker.fileDigest;
  }

  private markRemovedUnlocked(name: string): void {
    this.ensureDir();
    let fileDigest: string | null = null;
    try {
      fileDigest = createHash('sha256').update(readFileSync(this.pathFor(name))).digest('hex');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const marker = this.removalMarkerFor(name);
    const tmp = `${marker}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    try {
      const fd = openSync(tmp, 'w', 0o600);
      try {
        const data = Buffer.from(JSON.stringify({ version: 1, file_digest: fileDigest }) + '\n');
        writeSync(fd, data, 0, data.length);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, marker);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  private clearRemovalUnlocked(name: string): void {
    try {
      unlinkSync(this.removalMarkerFor(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
        removeFile: async () => {
          this.removeFileUnlocked(name);
        },
        removeIfMatches: async (expected) => this.removeIfMatchesUnlocked(name, expected),
        isRemovalMarked: () => this.isRemovalMarkedUnlocked(name),
        isFileChangedSinceRemoval: () => {
          const marker = this.readRemovalMarkerUnlocked(name);
          return marker !== undefined && this.isFileChangedSinceRemovalUnlocked(name, marker);
        },
        markRemoved: () => this.markRemovedUnlocked(name),
        clearRemoval: () => this.clearRemovalUnlocked(name),
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
    return entries
      .filter((e) => e.endsWith('.json'))
      .map((e) => e.slice(0, -'.json'.length))
      .filter((name) => {
        const marker = this.readRemovalMarkerUnlocked(name);
        return marker === undefined || this.isFileChangedSinceRemovalUnlocked(name, marker);
      });
  }
}
