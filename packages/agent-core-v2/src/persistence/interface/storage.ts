/**
 * `storage` domain — the filesystem persistence backend.
 *
 * `IFileSystemStorageService` is the filesystem-specific byte store that the
 * `node-fs` Store implementations are built on. It exposes two irreducible
 * durable primitives side by side:
 *
 *   - `write`  — atomic whole-value replacement (the `Config` access pattern).
 *   - `append` — ordered, durable byte extension   (the `Record` access pattern).
 *
 * They are not interchangeable: building `append` on top of `write` is O(n)
 * per append, and building `write` on top of `append` yields awkward "read
 * the last value" semantics. Keeping both as first-class primitives lets each
 * implementation implement them optimally (file: `open('a')` vs tmp+rename).
 *
 * The service is byte-oriented and scope/key-addressed: `scope` maps to a
 * directory, `key` maps to a filename. It knows nothing about JSON, records,
 * configs, versions or framing. Those concerns live in the typed Store facades
 * above it (`IAppendLogStore`, `IAtomicDocumentStore`, `IBlobStore`).
 *
 * Non-filesystem backends (Postgres, S3, Redis) do not implement this
 * interface — they implement the Store interfaces directly via their own
 * native clients.
 *
 * `scope`/`key` are trusted internal path segments for the file implementation
 * (e.g. scope `"agents/main"`, key `"wire.jsonl"`); they are not user input.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export interface StorageWriteOptions {
  readonly atomic?: boolean;
}

export interface StorageAppendOptions {
  readonly durable?: boolean;
}

export interface IFileSystemStorageService {
  readonly _serviceBrand: undefined;

  read(scope: string, key: string): Promise<Uint8Array | undefined>;
  readStream(scope: string, key: string): AsyncIterable<Uint8Array>;
  write(scope: string, key: string, data: Uint8Array, options?: StorageWriteOptions): Promise<void>;
  append(scope: string, key: string, data: Uint8Array, options?: StorageAppendOptions): Promise<void>;
  list(scope: string, prefix?: string): Promise<readonly string[]>;
  delete(scope: string, key: string): Promise<void>;
  watch?(scope: string, key: string): Event<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export const IFileSystemStorageService: ServiceIdentifier<IFileSystemStorageService> =
  createDecorator<IFileSystemStorageService>('fileSystemStorageService');
