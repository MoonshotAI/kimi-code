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
 *   - `watch`  → `fs.watch` the parent directory (filtered by filename and
 *                debounced), so it survives atomic-replace renames and observes
 *                a file that does not exist yet.
 *
 * It uses raw `node:fs` rather than `kaos`: the storage kernel needs direct
 * control over append offsets, fsync, atomic rename and streaming, which the
 * agent-execution-environment abstraction does not expose. Higher-level code
 * (`wireRecord`, `blobStore`) goes through the Store / Storage interfaces above
 * this backend, never `node:fs` directly.
 */

import { createReadStream, mkdirSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'pathe';

import {
  DisposableStore,
  combinedDisposable,
  toDisposable,
  type IDisposable,
} from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { atomicWrite, syncDir } from '#/_base/utils/fs';

import type {
  IStorageService,
  StorageAppendOptions,
  StorageWriteOptions,
} from './storageService';

// `fs.watch` often emits a burst per save (plus the temp file of an atomic
// replace); collapse it into one reload signal.
const WATCH_DEBOUNCE_MS = 150;

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

  async *readStream(scope: string, key: string): AsyncIterable<Uint8Array> {
    const stream = createReadStream(this.path(scope, key));
    try {
      for await (const chunk of stream) {
        yield chunk as Uint8Array;
      }
    } catch (error) {
      if (isEnoent(error)) return;
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

  watch(scope: string, key: string): Event<void> {
    const target = this.path(scope, key);
    const dir = dirname(target);
    const name = basename(target);
    const emitter = new Emitter<void>();

    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refCount = 0;

    const schedule = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => emitter.fire(), WATCH_DEBOUNCE_MS);
    };

    // Watch the parent directory and filter by filename: the directory survives
    // atomic-replace renames (which would detach an inode watcher), and it lets
    // us observe a file that does not exist yet at subscription time.
    const arm = (): void => {
      try {
        mkdirSync(dir, { recursive: true });
        watcher = fsWatch(dir, (_event, filename) => {
          if (filename === null || filename === name) schedule();
        });
        watcher.on('error', () => undefined);
      } catch {
        // Best effort: callers can still reload explicitly when watching fails.
      }
    };

    const disarm = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      watcher?.close();
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
