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

export class FileTokenStorage implements TokenStorage {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {}
  }

  private pathFor(name: string): string {
    const safe = basename(name);
    if (safe.length === 0 || safe !== name || safe.startsWith('.')) {
      throw new Error(`Invalid token name: "${name}"`);
    }
    return join(this.dir, `${safe}.json`);
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
      chmodSync(tmp, 0o600);
      renameSync(tmp, target);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {}
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
