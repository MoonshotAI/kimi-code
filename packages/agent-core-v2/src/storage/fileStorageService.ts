/**
 * `FileStorageService` — `IStorageService` backed by the local filesystem.
 *
 * Layout: a value addressed by `(scope, key)` lives at
 * `<baseDir>/<scope>/<key>`. `scope` may contain slashes to form nested
 * directories (e.g. `"agents/main"`).
 *
 * Primitives:
 *   - `write`  → `atomicWrite` (tmp + fsync + rename) followed by a directory
 *                fsync, so the replacement is both atomic and durable.
 *   - `append` → `open('a')` + write + `fh.sync()` (when `durable`), plus a
 *                one-time directory fsync per scope.
 *
 * It uses raw `node:fs` (like `wireRecord/persistence.ts` and
 * `blobStoreService.ts`) rather than `kaos`: the storage kernel needs direct
 * control over append offsets, fsync, atomic rename and (future) streaming,
 * which the agent-execution-environment abstraction does not expose.
 */

import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'pathe';

import { atomicWrite, syncDir } from '#/_base/utils/fs';

import type {
  IStorageService,
  StorageAppendOptions,
  StorageWriteOptions,
} from './storageService';

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export class FileStorageService implements IStorageService {
  declare readonly _serviceBrand: undefined;

  private readonly syncedDirs = new Set<string>();

  constructor(private readonly baseDir: string) {}

  async read(scope: string, key: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(this.path(scope, key));
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
  }

  async write(
    scope: string,
    key: string,
    data: Uint8Array,
    _options: StorageWriteOptions = {},
  ): Promise<void> {
    const filePath = this.path(scope, key);
    await mkdir(dirname(filePath), { recursive: true });
    await atomicWrite(filePath, data);
    await this.syncDirOnce(dirname(filePath));
  }

  async append(
    scope: string,
    key: string,
    data: Uint8Array,
    options: StorageAppendOptions = {},
  ): Promise<void> {
    const filePath = this.path(scope, key);
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });

    const fh = await open(filePath, 'a');
    try {
      if (data.byteLength > 0) {
        await fh.writeFile(data);
      }
      if (options.durable !== false) {
        await fh.sync();
      }
    } finally {
      await fh.close();
    }
    await this.syncDirOnce(dir);
  }

  async list(scope: string, prefix?: string): Promise<readonly string[]> {
    let entries: readonly string[];
    try {
      entries = await readdir(this.scopePath(scope));
    } catch (error) {
      if (isEnoent(error)) return [];
      throw error;
    }
    return prefix === undefined ? entries : entries.filter((entry) => entry.startsWith(prefix));
  }

  async delete(scope: string, key: string): Promise<void> {
    try {
      await unlink(this.path(scope, key));
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }

  async flush(): Promise<void> {
    // Writes resolve only after the bytes are durable; nothing is buffered.
  }

  async close(): Promise<void> {}

  private path(scope: string, key: string): string {
    return join(this.baseDir, scope, key);
  }

  private scopePath(scope: string): string {
    return join(this.baseDir, scope);
  }

  private async syncDirOnce(dir: string): Promise<void> {
    if (this.syncedDirs.has(dir)) return;
    await syncDir(dir);
    this.syncedDirs.add(dir);
  }
}
