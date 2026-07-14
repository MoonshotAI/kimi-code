/**
 * `storage` domain (L1) — local-filesystem byte storage.
 *
 * Provides durable atomic replacement, ordered append, reads, listing,
 * deletion, and watching through the local filesystem. Bound at App scope.
 */

import {
  close as closeFd,
  closeSync,
  constants,
  createReadStream,
  fstat as fstatFd,
  mkdirSync,
  open as openFd,
} from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, stat, unlink } from 'node:fs/promises';
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
const MAX_DURABLE_ENTRIES = 64;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

function fileIdentity(stats: {
  readonly dev: bigint;
  readonly ino: bigint;
}): FileIdentity | undefined {
  return stats.ino === 0n ? undefined : { dev: stats.dev, ino: stats.ino };
}

function sameFile(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

interface DurableEntry extends FileIdentity {
  readonly fd: number;
}

const durableEntryFinalizer = new FinalizationRegistry<Map<string, DurableEntry>>((entries) => {
  for (const entry of entries.values()) {
    try {
      closeSync(entry.fd);
    } catch (error) {
      onUnexpectedError(error);
    }
  }
  entries.clear();
});

export class FileStorageService implements IFileSystemStorageService {
  declare readonly _serviceBrand: undefined;

  private readonly durableEntries = new Map<string, DurableEntry>();

  constructor(
    private readonly baseDir: string,
    private readonly dirMode?: number,
    private readonly fileMode?: number,
  ) {
    durableEntryFinalizer.register(this, this.durableEntries);
  }

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
      await this.removeDurableEntry(filePath);
      await atomicWrite(filePath, data, undefined, this.fileMode);
      const identity = fileIdentity(await stat(filePath, { bigint: true }));
      await syncDir(dirname(filePath));
      if (identity !== undefined) {
        const entry = await this.openDurableEntry(filePath, identity);
        if (entry !== undefined) await this.installDurableEntry(filePath, entry);
      }
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

      let fh: Awaited<ReturnType<typeof open>>;
      while (true) {
        try {
          fh = await open(filePath, 'ax', this.fileMode);
          break;
        } catch (error) {
          if (!isEexist(error)) throw error;
        }
        try {
          fh = await open(filePath, constants.O_WRONLY | constants.O_APPEND);
          break;
        } catch (error) {
          if (!isEnoent(error)) throw error;
          let entry: Awaited<ReturnType<typeof lstat>>;
          try {
            entry = await lstat(filePath);
          } catch (inspectError) {
            if (isEnoent(inspectError)) continue;
            throw inspectError;
          }
          if (entry.isSymbolicLink()) throw error;
        }
      }
      try {
        if (data.byteLength > 0) {
          await fh.writeFile(data);
        }
        if (options.durable !== false) {
          await fh.sync();
        }
        const identity = fileIdentity(await fh.stat({ bigint: true }));
        const durableEntry = this.durableEntries.get(filePath);
        if (
          durableEntry !== undefined &&
          sameFile(durableEntry, identity) &&
          this.touchDurableEntry(filePath, durableEntry)
        ) {
          return;
        }
        await syncDir(dir);
        if (identity === undefined) {
          await this.removeDurableEntry(filePath);
        } else {
          const entry = await this.openDurableEntry(filePath, identity);
          if (entry === undefined) {
            await this.removeDurableEntry(filePath);
          } else {
            await this.installDurableEntry(filePath, entry);
          }
        }
      } finally {
        await fh.close();
      }
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
      await this.removeDurableEntry(filePath);
    } catch (error) {
      throw toStorageIoError(error, { path: filePath, op: 'delete' });
    }
    try {
      await unlink(filePath);
    } catch (error) {
      if (!isEnoent(error)) {
        throw toStorageIoError(error, { path: filePath, op: 'delete' });
      }
    }
    try {
      await this.removeDurableEntry(filePath);
    } catch (error) {
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

  async flush(): Promise<void> {}

  dispose(): void {
    void this.close().catch(onUnexpectedError);
  }

  async close(): Promise<void> {
    const entries = [...this.durableEntries.entries()];
    this.durableEntries.clear();
    let firstError: Error | undefined;
    for (const [filePath, entry] of entries) {
      try {
        await closeAnchor(entry.fd);
      } catch (error) {
        firstError ??= toStorageIoError(error, { path: filePath, op: 'close' });
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  private path(scope: string, key: string): string {
    return join(this.baseDir, scope, key);
  }

  private scopePath(scope: string): string {
    return join(this.baseDir, scope);
  }

  private touchDurableEntry(filePath: string, entry: DurableEntry): boolean {
    if (this.durableEntries.get(filePath) !== entry) return false;
    this.durableEntries.delete(filePath);
    this.durableEntries.set(filePath, entry);
    return true;
  }

  private async installDurableEntry(filePath: string, entry: DurableEntry): Promise<void> {
    const entriesToClose: DurableEntry[] = [];
    const previous = this.durableEntries.get(filePath);
    if (previous !== undefined) {
      this.durableEntries.delete(filePath);
      if (previous.fd !== entry.fd) entriesToClose.push(previous);
    }
    if (this.durableEntries.size >= MAX_DURABLE_ENTRIES) {
      const oldestPath = this.durableEntries.keys().next().value;
      if (oldestPath !== undefined) {
        const oldest = this.durableEntries.get(oldestPath);
        this.durableEntries.delete(oldestPath);
        if (oldest !== undefined && oldest.fd !== entry.fd) entriesToClose.push(oldest);
      }
    }
    this.durableEntries.set(filePath, entry);
    for (const entryToClose of entriesToClose) {
      try {
        await closeAnchor(entryToClose.fd);
      } catch (error) {
        onUnexpectedError(error);
      }
    }
  }

  private async removeDurableEntry(filePath: string): Promise<void> {
    const entry = this.durableEntries.get(filePath);
    if (entry === undefined) return;
    this.durableEntries.delete(filePath);
    await closeAnchor(entry.fd);
  }

  private openDurableEntry(
    filePath: string,
    expectedIdentity: FileIdentity,
  ): Promise<DurableEntry | undefined> {
    return new Promise((resolve) => {
      openFd(filePath, constants.O_WRONLY, (openError, fd) => {
        if (openError !== null) {
          if (!isEnoent(openError)) onUnexpectedError(openError);
          resolve(undefined);
          return;
        }
        fstatFd(fd, { bigint: true }, (statError, stats) => {
          if (statError !== null) {
            void closeAnchor(fd).catch(onUnexpectedError);
            if (!isEnoent(statError)) onUnexpectedError(statError);
            resolve(undefined);
            return;
          }
          const identity = fileIdentity(stats);
          if (identity === undefined || !sameFile(identity, expectedIdentity)) {
            void closeAnchor(fd).catch(onUnexpectedError);
            resolve(undefined);
            return;
          }
          resolve({ fd, ...identity });
        });
      });
    });
  }
}

function closeAnchor(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    closeFd(fd, (error) => {
      if (error !== null) reject(error);
      else resolve();
    });
  });
}
