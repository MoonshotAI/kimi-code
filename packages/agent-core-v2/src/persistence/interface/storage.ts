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
import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';

export const StorageErrors = {
  codes: {
    STORAGE_NOT_FOUND: 'storage.not_found',
    STORAGE_DECODE_FAILED: 'storage.decode_failed',
    STORAGE_CORRUPTED: 'storage.corrupted',
    STORAGE_IO_FAILED: 'storage.io_failed',
    STORAGE_LOCKED: 'storage.locked',
  },
  retryable: ['storage.io_failed', 'storage.locked'],
  info: {
    'storage.not_found': {
      title: 'Stored value not found',
      retryable: false,
      public: true,
    },
    'storage.decode_failed': {
      title: 'Stored value could not be decoded',
      retryable: false,
      public: true,
      action: 'Inspect the stored document; it is not valid for its declared format.',
    },
    'storage.corrupted': {
      title: 'Stored data is corrupted',
      retryable: false,
      public: true,
      action: 'Inspect the backing store; the corrupted entry must be repaired or dropped.',
    },
    'storage.io_failed': {
      title: 'Storage I/O failed',
      retryable: true,
      public: true,
    },
    'storage.locked': {
      title: 'Storage is locked',
      retryable: true,
      public: true,
      action: 'Another process holds the store; close it or retry later.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(StorageErrors);

export type StorageErrorCode = (typeof StorageErrors.codes)[keyof typeof StorageErrors.codes];

export class StorageError extends Error2 {
  constructor(code: StorageErrorCode, message: string, options?: Error2Options) {
    super(code, message, options);
    this.name = 'StorageError';
  }
}

export function isStorageError(error: unknown, code: StorageErrorCode): boolean {
  return error instanceof StorageError && error.code === code;
}

function readErrno(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function toStorageIoError(error: unknown, ctx: { path: string; op: string }): StorageError {
  if (error instanceof StorageError) return error;
  return new StorageError(
    StorageErrors.codes.STORAGE_IO_FAILED,
    `storage ${ctx.op} failed`,
    {
      details: { path: ctx.path, op: ctx.op, errno: readErrno(error) },
      cause: error,
    },
  );
}

export interface StorageWriteOptions {
  readonly atomic?: boolean;
}

export interface StorageAppendOptions {
  readonly durable?: boolean;
}

export interface StorageReadRange {
  readonly start: number;
  readonly end: number;
}

export interface IFileSystemStorageService {
  readonly _serviceBrand: undefined;

  read(scope: string, key: string): Promise<Uint8Array | undefined>;
  readStream(scope: string, key: string, range?: StorageReadRange): AsyncIterable<Uint8Array>;
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
