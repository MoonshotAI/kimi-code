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
import { basename, join } from 'node:path';

import type { TokenInfo, TokenInfoWire } from './types';
import { tokenFromWire, tokenToWire } from './types';
import { isRecord } from './utils';

export interface TokenStorage {
  load(name: string): Promise<TokenInfo | undefined>;
  save(name: string, token: TokenInfo): Promise<void>;
  remove(name: string): Promise<void>;
  list(): Promise<string[]>;
}

/**
 * Guard against path traversal: caller-provided names (from config.toml or
 * slash commands) must not escape the credentials dir. `basename` strips any
 * `..` or `/` segments; if the sanitized value differs from the input we refuse
 * the request entirely rather than silently writing to a different file than the
 * caller asked for. Leading-dot names (hidden files) are also rejected.
 *
 * Shared so non-file backends (e.g. KeyringTokenStorage) enforce the identical
 * name-rejection rule, error text, and fail-before-write timing.
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

  async load(name: string): Promise<TokenInfo | undefined> {
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

  async save(name: string, token: TokenInfo): Promise<void> {
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
      // chmod again in case umask stripped bits during open
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

  async remove(name: string): Promise<void> {
    try {
      unlinkSync(this.pathFor(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
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
