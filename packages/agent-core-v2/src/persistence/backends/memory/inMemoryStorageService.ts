import {
  IFileSystemStorageService,
  type StorageAppendOptions,
  type StorageReadRange,
  type StorageWriteOptions,
} from '#/persistence/interface/storage';

export class InMemoryStorageService implements IFileSystemStorageService {
  declare readonly _serviceBrand: undefined;

  private readonly scopes = new Map<string, Map<string, Uint8Array>>();
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
    this.mtimes.set(this.keyFor(scope, key), Date.now());
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
    this.mtimes.set(this.keyFor(scope, key), Date.now());
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
      this.mtimes.set(this.keyFor(scope, key), Date.now());
      return;
    }
    const merged = new Uint8Array(existing.byteLength + data.byteLength);
    merged.set(existing, 0);
    merged.set(data, existing.byteLength);
    bucket.set(key, merged);
    this.mtimes.set(this.keyFor(scope, key), Date.now());
  }

  async list(scope: string, prefix?: string): Promise<readonly string[]> {
    const bucket = this.scopes.get(scope);
    if (bucket === undefined) return [];
    const keys = [...bucket.keys()];
    return prefix === undefined ? keys : keys.filter((key) => key.startsWith(prefix));
  }

  async delete(scope: string, key: string): Promise<void> {
    this.scopes.get(scope)?.delete(key);
    this.mtimes.delete(this.keyFor(scope, key));
  }

  async size(scope: string, key: string): Promise<number | undefined> {
    return this.scopes.get(scope)?.get(key)?.byteLength;
  }

  async mtime(scope: string, key: string): Promise<number | undefined> {
    return this.mtimes.get(this.keyFor(scope, key));
  }

  pathFor(_scope: string, _key: string): undefined {
    return undefined;
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}

  private keyFor(scope: string, key: string): string {
    return `${scope}\0${key}`;
  }

  private bucket(scope: string): Map<string, Uint8Array> {
    let bucket = this.scopes.get(scope);
    if (bucket === undefined) {
      bucket = new Map();
      this.scopes.set(scope, bucket);
    }
    return bucket;
  }
}
