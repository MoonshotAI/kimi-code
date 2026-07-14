/**
 * `FileStorageService` — `IFileSystemStorageService` backed by the local filesystem.
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
 *   - `watch`  → chokidar on the parent directory, filtered to the exact key and
 *                debounced, so it survives atomic-replace renames and observes a
 *                file that does not exist yet at subscription time.
 *
 * It uses raw `node:fs` rather than `kaos`: the storage kernel needs direct
 * control over append offsets, fsync, atomic rename and streaming, which the
 * agent-execution-environment abstraction does not expose. Higher-level code
 * (`wireRecord`, `blobStore`) goes through the Store / Storage interfaces above
 * this backend, never `node:fs` directly.
 */

import { createReadStream, mkdirSync } from 'node:fs';
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { FSWatcher } from 'chokidar';
import { dirname, join, normalize } from 'pathe';

import { DisposableStore, combinedDisposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { atomicWrite, syncDir } from '#/_base/utils/fs';

import type {
  IFileSystemStorageService,
  StorageAppendOptions,
  StorageReadRange,
  StorageWriteOptions,
} from '#/persistence/interface/storage';
import { toStorageIoError } from '#/persistence/interface/storage';

const WATCH_DEBOUNCE_MS = 150;

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
    const filePath = this.path(scope, key);
    try {
      return await readFile(filePath);
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw toStorageIoError(error, { path: filePath, op: 'read' });
    }
  }

  async *readStream(
    scope: string,
    key: string,
    range?: StorageReadRange,
  ): AsyncIterable<Uint8Array> {
    const filePath = this.path(scope, key);
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
    _options: StorageWriteOptions = {},
  ): Promise<void> {
    const filePath = this.path(scope, key);
    try {
      await mkdir(dirname(filePath), { recursive: true, mode: this.dirMode });
      await atomicWrite(filePath, data, undefined, this.fileMode);
      await this.syncDirOnce(dirname(filePath));
    } catch (error) {
      throw toStorageIoError(error, { path: filePath, op: 'write' });
    }
  }

  async append(
    scope: string,
    key: string,
    data: Uint8Array,
    options: StorageAppendOptions = {},
  ): Promise<void> {
    const filePath = this.path(scope, key);
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
    const filePath = this.path(scope, key);
    try {
      await unlink(filePath);
    } catch (error) {
      if (isEnoent(error)) return;
      throw toStorageIoError(error, { path: filePath, op: 'delete' });
    }
  }

  watch(scope: string, key: string): Event<void> {
    const target = this.path(scope, key);
    const dir = dirname(target);
    const normalizedTarget = normalize(target);
    const emitter = new Emitter<void>();

    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refCount = 0;

    const schedule = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => emitter.fire(), WATCH_DEBOUNCE_MS);
    };

    const arm = (): void => {
      try {
        mkdirSync(dir, { recursive: true, mode: this.dirMode });
        watcher = new FSWatcher({
          ignoreInitial: true,
          awaitWriteFinish: false,
          depth: 0,
        });
        watcher.on('all', (_event, changedPath) => {
          if (normalize(changedPath) === normalizedTarget) schedule();
        });
        watcher.on('error', (error: unknown) => onUnexpectedError(error));
        watcher.add(dir);
      } catch (error) {
        onUnexpectedError(error);
      }
    };

    const disarm = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      const closeResult = watcher?.close();
      if (closeResult !== undefined) void closeResult.catch(() => undefined);
      watcher = undefined;
    };

    return (listener, thisArg, disposables) => {
      if (refCount === 0) arm();
      refCount++;
      const subscription = emitter.event(listener, thisArg);
      let tornDown = false;
      const teardown = toDisposable(() => {
        if (tornDown) return;
        tornDown = true;
        refCount--;
        if (refCount === 0) disarm();
      });
      const combined = combinedDisposable(subscription, teardown);
      if (disposables instanceof DisposableStore) {
        disposables.add(combined);
      } else if (disposables !== undefined) {
        (disposables as IDisposable[]).push(combined);
      }
      return combined;
    };
  }

  async flush(): Promise<void> {
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
    try {
      await syncDir(dir);
      this.syncedDirs.add(dir);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
}
