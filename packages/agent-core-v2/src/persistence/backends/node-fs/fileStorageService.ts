import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'pathe';

import { atomicWrite, atomicWriteStream, syncDir } from '#/_base/utils/fs';

import type {
  IFileSystemStorageService,
  StorageAppendOptions,
  StorageReadRange,
  StorageWriteOptions,
} from '#/persistence/interface/storage';
import { toStorageIoError } from '#/persistence/interface/storage';

const TORN_READ_RETRIES = 3;
const TORN_READ_RETRY_DELAY_MS = 15;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export class FileStorageService implements IFileSystemStorageService {
  declare readonly _serviceBrand: undefined;

  private readonly syncedDirs = new Set<string>();

  constructor(
    private readonly baseDir: string,
    private readonly dirMode?: number,
    private readonly fileMode?: number,
  ) {}

  async read(scope: string, key: string): Promise<Uint8Array | undefined> {
    const filePath = this.pathFor(scope, key);
    for (let attempt = 0; ; attempt += 1) {
      let bytes: Uint8Array;
      try {
        bytes = await readFile(filePath);
      } catch (error) {
        if (isEnoent(error)) return undefined;
        throw toStorageIoError(error, { path: filePath, op: 'read' });
      }
      if (attempt >= TORN_READ_RETRIES) return bytes;
      let size: number | undefined;
      try {
        size = (await stat(filePath)).size;
      } catch {
        size = undefined;
      }
      if (size === undefined || size === bytes.length) return bytes;
      await new Promise((resolve) => setTimeout(resolve, TORN_READ_RETRY_DELAY_MS));
    }
  }

  async *readStream(
    scope: string,
    key: string,
    range?: StorageReadRange,
  ): AsyncIterable<Uint8Array> {
    const filePath = this.pathFor(scope, key);
    const stream = createReadStream(
      filePath,
      range === undefined ? undefined : { start: range.start, end: range.end },
    );
    try {
      for await (const chunk of stream) {
        yield chunk as Uint8Array;
      }
    } catch (error) {
      if (isEnoent(error)) return;
      throw toStorageIoError(error, { path: filePath, op: 'read' });
    }
  }

  async write(
    scope: string,
    key: string,
    data: Uint8Array,
    options: StorageWriteOptions = {},
  ): Promise<void> {
    const filePath = this.pathFor(scope, key);
    try {
      await mkdir(dirname(filePath), { recursive: true, mode: this.dirMode });
      await atomicWrite(filePath, data, undefined, this.fileMode, options.signal);
      await this.syncDirOnce(dirname(filePath));
    } catch (error) {
      options.signal?.throwIfAborted();
      throw toStorageIoError(error, { path: filePath, op: 'write' });
    }
  }

  async writeStream(
    scope: string,
    key: string,
    source: AsyncIterable<Uint8Array>,
    options: StorageWriteOptions = {},
  ): Promise<void> {
    const filePath = this.pathFor(scope, key);
    try {
      await mkdir(dirname(filePath), { recursive: true, mode: this.dirMode });
      await atomicWriteStream(filePath, source, this.fileMode, options.signal);
      await this.syncDirOnce(dirname(filePath));
    } catch (error) {
      options.signal?.throwIfAborted();
      throw toStorageIoError(error, { path: filePath, op: 'write' });
    }
  }

  async append(
    scope: string,
    key: string,
    data: Uint8Array,
    options: StorageAppendOptions = {},
  ): Promise<void> {
    const filePath = this.pathFor(scope, key);
    const dir = dirname(filePath);
    try {
      await mkdir(dir, { recursive: true, mode: this.dirMode });

      const fh = await open(filePath, 'a', this.fileMode);
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
    } catch (error) {
      throw toStorageIoError(error, { path: filePath, op: 'append' });
    }
  }

  async list(scope: string, prefix?: string): Promise<readonly string[]> {
    let entries: readonly string[];
    try {
      entries = await readdir(this.scopePath(scope));
    } catch (error) {
      if (isEnoent(error)) return [];
      throw toStorageIoError(error, { path: this.scopePath(scope), op: 'list' });
    }
    return prefix === undefined ? entries : entries.filter((entry) => entry.startsWith(prefix));
  }

  async delete(scope: string, key: string): Promise<void> {
    const filePath = this.pathFor(scope, key);
    try {
      await unlink(filePath);
    } catch (error) {
      if (isEnoent(error)) return;
      throw toStorageIoError(error, { path: filePath, op: 'delete' });
    }
  }

  async size(scope: string, key: string): Promise<number | undefined> {
    const filePath = this.pathFor(scope, key);
    try {
      return (await stat(filePath)).size;
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw toStorageIoError(error, { path: filePath, op: 'stat' });
    }
  }

  async mtime(scope: string, key: string): Promise<number | undefined> {
    const filePath = this.pathFor(scope, key);
    try {
      return (await stat(filePath)).mtimeMs;
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw toStorageIoError(error, { path: filePath, op: 'stat' });
    }
  }

  async flush(): Promise<void> {
  }

  async close(): Promise<void> {}

  pathFor(scope: string, key: string): string {
    return join(this.baseDir, scope, key);
  }

  private scopePath(scope: string): string {
    return join(this.baseDir, scope);
  }

  private async syncDirOnce(dir: string): Promise<void> {
    if (this.syncedDirs.has(dir)) return;
    try {
      await syncDir(dir);
      this.syncedDirs.add(dir);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
}
