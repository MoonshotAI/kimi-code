import {
  IFileSystemStorageService,
  type StorageAppendOptions,
  type StorageReadRange,
  type StorageWriteOptions,
} from '#/persistence/interface/storage';

interface MemoryEntry {
  chunks: Uint8Array[];
  byteLength: number;
}

function materialize(entry: MemoryEntry): Uint8Array {
  if (entry.chunks.length === 0) return new Uint8Array(0);
  if (entry.chunks.length === 1) return entry.chunks[0]!;
  const merged = new Uint8Array(entry.byteLength);
  let offset = 0;
  for (const chunk of entry.chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  entry.chunks = [merged];
  return merged;
}

export class InMemoryStorageService implements IFileSystemStorageService {
  declare readonly _serviceBrand: undefined;

  private readonly scopes = new Map<string, Map<string, MemoryEntry>>();
  private readonly mtimes = new Map<string, number>();

  async read(scope: string, key: string): Promise<Uint8Array | undefined> {
    const entry = this.scopes.get(scope)?.get(key);
    return entry === undefined ? undefined : materialize(entry);
  }

  async *readStream(
    scope: string,
    key: string,
    range?: StorageReadRange,
  ): AsyncIterable<Uint8Array> {
    const entry = this.scopes.get(scope)?.get(key);
    if (entry === undefined) return;
    if (range === undefined) {
      for (const chunk of entry.chunks) {
        if (chunk.byteLength > 0) yield chunk;
      }
      return;
    }
    const start = Math.max(0, range.start);
    const end = Math.min(entry.byteLength, range.end + 1);
    if (start >= end) return;
    let offset = 0;
    for (const chunk of entry.chunks) {
      const chunkStart = offset;
      const chunkEnd = offset + chunk.byteLength;
      offset = chunkEnd;
      if (chunkEnd <= start) continue;
      if (chunkStart >= end) break;
      const sliceStart = Math.max(0, start - chunkStart);
      const sliceEnd = Math.min(chunk.byteLength, end - chunkStart);
      if (sliceStart < sliceEnd) yield chunk.subarray(sliceStart, sliceEnd);
    }
  }

  async write(
    scope: string,
    key: string,
    data: Uint8Array,
    options: StorageWriteOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    this.bucket(scope).set(key, {
      chunks: data.byteLength === 0 ? [] : [data.slice()],
      byteLength: data.byteLength,
    });
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
      if (chunk.byteLength > 0) {
        chunks.push(chunk.slice());
        total += chunk.byteLength;
      }
    }
    options.signal?.throwIfAborted();
    this.bucket(scope).set(key, { chunks, byteLength: total });
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
      bucket.set(key, {
        chunks: data.byteLength === 0 ? [] : [data.slice()],
        byteLength: data.byteLength,
      });
      this.mtimes.set(this.keyFor(scope, key), Date.now());
      return;
    }
    if (data.byteLength > 0) {
      existing.chunks.push(data.slice());
      existing.byteLength += data.byteLength;
    }
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

  sizeSync(scope: string, key: string): number | undefined {
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

  private bucket(scope: string): Map<string, MemoryEntry> {
    let bucket = this.scopes.get(scope);
    if (bucket === undefined) {
      bucket = new Map();
      this.scopes.set(scope, bucket);
    }
    return bucket;
  }
}
