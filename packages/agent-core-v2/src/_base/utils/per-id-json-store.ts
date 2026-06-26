/**
 * Per-id JSON record store (`createPerIdJsonStore`) — atomically persists one
 * `<id>.json` file per record under a session-scoped directory.
 */

import { mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'pathe';

import { atomicWrite } from './fs';

export interface PerIdJsonStore<T> {
  write(id: string, value: T): Promise<void>;
  read(id: string): Promise<T | undefined>;
  list(): Promise<readonly T[]>;
  remove(id: string): Promise<void>;
}

export interface PerIdJsonStoreOptions<T> {
  readonly rootDir: string;
  readonly subdir: string;
  readonly idRegex: RegExp;
  readonly isValid?: (obj: unknown) => obj is T;
  readonly entityName?: string;
}

export function createPerIdJsonStore<T>(
  opts: PerIdJsonStoreOptions<T>,
): PerIdJsonStore<T> {
  const { rootDir, subdir, idRegex, isValid, entityName = 'id' } = opts;
  const dir = join(rootDir, subdir);

  function fileFor(id: string): string {
    if (!idRegex.test(id)) {
      throw new Error(`Invalid ${entityName}: "${id}"`);
    }
    return join(dir, `${id}.json`);
  }

  async function write(id: string, value: T): Promise<void> {
    const target = fileFor(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await atomicWrite(target, JSON.stringify(value, null, 2));
  }

  async function read(id: string): Promise<T | undefined> {
    const path = fileFor(id);
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (isValid !== undefined && !isValid(parsed)) return undefined;
    return parsed as T;
  }

  async function list(): Promise<readonly T[]> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -'.json'.length);
      if (!idRegex.test(id)) continue;
      const value = await read(id);
      if (value === undefined) continue;
      out.push(value);
    }
    return out;
  }

  async function remove(id: string): Promise<void> {
    const path = fileFor(id);
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  return { write, read, list, remove };
}
