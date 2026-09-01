import {
  DisposableStore,
  combinedDisposable,
  toDisposable,
  type IDisposable,
} from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';

import {
  IFileSystemStorageService,
  type StorageAppendOptions,
  type StorageReadRange,
  type StorageWriteOptions,
} from '#/persistence/interface/storage';

interface WatchEntry {
  readonly emitter: Emitter<void>;
  count: number;
}

export class InMemoryStorageService implements IFileSystemStorageService {
  declare readonly _serviceBrand: undefined;

  private readonly scopes = new Map<string, Map<string, Uint8Array>>();
  private readonly watchers = new Map<string, WatchEntry>();
  private readonly mtimes = new Map<string, number>();

  async read(scope: string, key: string): Promise<Uint8Array | undefined> {
    return this.scopes.get(scope)?.get(key);
  }

  async *readStream(
    scope: string,
    key: string,
    range?: StorageReadRange,
  ): AsyncIterable<Uint8Array> {
    const data = this.scopes.get(scope)?.get(key);
    if (data === undefined) return;
    if (range === undefined) {
      yield data;
      return;
    }
    const start = Math.max(0, range.start);
    const end = Math.min(data.byteLength, range.end + 1);
    if (start < end) yield data.subarray(start, end);
  }

  async write(
    scope: string,
    key: string,
    data: Uint8Array,
    options: StorageWriteOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    this.bucket(scope).set(key, data);
    this.mtimes.set(this.watchKey(scope, key), Date.now());
    this.notifyWatchers(scope, key);
  }

  async writeStream(
    scope: string,
    key: string,
    source: AsyncIterable<Uint8Array>,
    options: StorageWriteOptions = {},
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of source) {
      options.signal?.throwIfAborted();
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    options.signal?.throwIfAborted();
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.bucket(scope).set(key, merged);
    this.mtimes.set(this.watchKey(scope, key), Date.now());
    this.notifyWatchers(scope, key);
  }

  async append(
    scope: string,
    key: string,
    data: Uint8Array,
    _options: StorageAppendOptions = {},
  ): Promise<void> {
    const bucket = this.bucket(scope);
    const existing = bucket.get(key);
    if (existing === undefined) {
      bucket.set(key, data);
      this.mtimes.set(this.watchKey(scope, key), Date.now());
      this.notifyWatchers(scope, key);
      return;
    }
    const merged = new Uint8Array(existing.byteLength + data.byteLength);
    merged.set(existing, 0);
    merged.set(data, existing.byteLength);
    bucket.set(key, merged);
    this.mtimes.set(this.watchKey(scope, key), Date.now());
    this.notifyWatchers(scope, key);
  }

  async list(scope: string, prefix?: string): Promise<readonly string[]> {
    const bucket = this.scopes.get(scope);
    if (bucket === undefined) return [];
    const keys = [...bucket.keys()];
    return prefix === undefined ? keys : keys.filter((key) => key.startsWith(prefix));
  }

  async delete(scope: string, key: string): Promise<void> {
    this.scopes.get(scope)?.delete(key);
    this.mtimes.delete(this.watchKey(scope, key));
    this.notifyWatchers(scope, key);
  }

  async size(scope: string, key: string): Promise<number | undefined> {
    return this.scopes.get(scope)?.get(key)?.byteLength;
  }

  async mtime(scope: string, key: string): Promise<number | undefined> {
    return this.mtimes.get(this.watchKey(scope, key));
  }

  pathFor(_scope: string, _key: string): undefined {
    return undefined;
  }

  watch(scope: string, key: string): Event<void> {
    const id = this.watchKey(scope, key);
    return (listener, thisArg, disposables) => {
      let entry = this.watchers.get(id);
      if (entry === undefined) {
        entry = { emitter: new Emitter<void>(), count: 0 };
        this.watchers.set(id, entry);
      }
      entry.count++;
      const subscription = entry.emitter.event(listener, thisArg);
      let tornDown = false;
      const teardown = toDisposable(() => {
        if (tornDown) return;
        tornDown = true;
        entry!.count--;
        if (entry!.count === 0) {
          entry!.emitter.dispose();
          this.watchers.delete(id);
        }
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

  private notifyWatchers(scope: string, key: string): void {
    this.watchers.get(this.watchKey(scope, key))?.emitter.fire();
  }

  private watchKey(scope: string, key: string): string {
    return `${scope}\0${key}`;
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}

  private bucket(scope: string): Map<string, Uint8Array> {
    let bucket = this.scopes.get(scope);
    if (bucket === undefined) {
      bucket = new Map();
      this.scopes.set(scope, bucket);
    }
    return bucket;
  }
}
