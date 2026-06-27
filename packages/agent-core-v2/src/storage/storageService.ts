/**
 * `storage` domain — the bottom-most persistence substrate.
 *
 * `IStorageService` is the single, backend-pluggable byte store that every
 * other local-persistence abstraction is built on. It exposes the two
 * irreducible durable primitives side by side:
 *
 *   - `write`  — atomic whole-value replacement (the `Config` access pattern).
 *   - `append` — ordered, durable byte extension   (the `Record` access pattern).
 *
 * They are not interchangeable: building `append` on top of `write` is O(n)
 * per append, and building `write` on top of `append` yields awkward "read
 * the last value" semantics. Keeping both as first-class primitives lets each
 * implementation implement them optimally (file: `open('a')` vs tmp+rename;
 * db: `INSERT` vs `UPSERT`).
 *
 * The service is intentionally byte-oriented and scope/key-addressed: it knows
 * nothing about JSON, records, configs, versions or framing. Those concerns
 * live in the typed facades above it (`IRecordStore`, `IConfigStore`).
 *
 * `scope`/`key` are trusted internal path segments for the file implementation
 * (e.g. scope `"agents/main"`, key `"wire.jsonl"`); they are not user input.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface StorageWriteOptions {
  /**
   * Replace atomically so readers never observe a half-written value. The file
   * implementation always writes atomically; the option is reserved for
   * implementations where atomicity is opt-in. Defaults to `true`.
   */
  readonly atomic?: boolean;
}

export interface StorageAppendOptions {
  /**
   * When `true` (default) the append is fsync'd before the call resolves so
   * the bytes are durable across a crash. Set to `false` only for rebuildable
   * data (caches/indexes) where throughput matters more than durability.
   */
  readonly durable?: boolean;
}

export interface IStorageService {
  readonly _serviceBrand: undefined;

  /** Read the whole value, or `undefined` when the key does not exist. */
  read(scope: string, key: string): Promise<Uint8Array | undefined>;

  /** Atomically replace the whole value. */
  write(scope: string, key: string, data: Uint8Array, options?: StorageWriteOptions): Promise<void>;

  /** Durable byte extension (ordered). */
  append(scope: string, key: string, data: Uint8Array, options?: StorageAppendOptions): Promise<void>;

  /** List the keys under `scope`, optionally filtered by `prefix`. */
  list(scope: string, prefix?: string): Promise<readonly string[]>;

  /** Delete a key. Missing keys are not an error. */
  delete(scope: string, key: string): Promise<void>;

  /** Flush any buffered writes to the durable medium. */
  flush(): Promise<void>;

  /** Release implementation resources (file handles, timers, connections). */
  close(): Promise<void>;
}

export const IStorageService: ServiceIdentifier<IStorageService> =
  createDecorator<IStorageService>('storageService');
