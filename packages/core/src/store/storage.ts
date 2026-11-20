export const StorageErrors = {
  codes: {
    STORAGE_NOT_FOUND: 'storage.not_found',
    STORAGE_DECODE_FAILED: 'storage.decode_failed',
    STORAGE_CORRUPTED: 'storage.corrupted',
    STORAGE_IO_FAILED: 'storage.io_failed',
    STORAGE_LOCKED: 'storage.locked',
    STORAGE_PERMISSION_DENIED: 'storage.permission_denied',
    STORAGE_DISK_FULL: 'storage.disk_full',
  },
} as const;

export type StorageErrorCode = (typeof StorageErrors.codes)[keyof typeof StorageErrors.codes];

export interface StorageErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class StorageError extends Error {
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    readonly code: StorageErrorCode,
    message: string,
    options: StorageErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StorageError';
    this.details = options.details;
  }
}

export type StorageErrorFactory = (code: StorageErrorCode, message: string, options?: StorageErrorOptions) => StorageError;

export function isStorageError(error: unknown, code: StorageErrorCode): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function readErrno(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

type StorageIoErrorCode =
  | typeof StorageErrors.codes.STORAGE_NOT_FOUND
  | typeof StorageErrors.codes.STORAGE_IO_FAILED
  | typeof StorageErrors.codes.STORAGE_PERMISSION_DENIED
  | typeof StorageErrors.codes.STORAGE_DISK_FULL;

const REASONS: Record<StorageIoErrorCode, string> = {
  'storage.not_found': 'path does not exist',
  'storage.io_failed': 'unrecognized I/O error',
  'storage.permission_denied': 'permission denied',
  'storage.disk_full': 'no space left on device',
};

function mapErrno(errno: string | undefined): StorageIoErrorCode {
  switch (errno) {
    case 'ENOENT':
      return StorageErrors.codes.STORAGE_NOT_FOUND;
    case 'EACCES':
    case 'EPERM':
      return StorageErrors.codes.STORAGE_PERMISSION_DENIED;
    case 'ENOSPC':
      return StorageErrors.codes.STORAGE_DISK_FULL;
    default:
      return StorageErrors.codes.STORAGE_IO_FAILED;
  }
}

export function toStorageIoError(error: unknown, ctx: { path: string; op: string }): StorageError {
  if (error instanceof StorageError) return error;
  const errno = readErrno(error);
  const code = mapErrno(errno);
  return new StorageError(code, `storage ${ctx.op} failed: ${REASONS[code]}`, {
    details: { path: ctx.path, op: ctx.op, errno },
    cause: error,
  });
}

export type StorageIoErrorMapper = (error: unknown, ctx: { path: string; op: string }) => StorageError;

export interface StorageWriteOptions {
  readonly atomic?: boolean;
  readonly signal?: AbortSignal;
}

export interface StorageAppendOptions {
  readonly durable?: boolean;
}

export interface StorageReadRange {
  readonly start: number;
  readonly end: number;
}

export interface Storage {
  read(scope: string, key: string): Promise<Uint8Array | undefined>;
  readStream(scope: string, key: string, range?: StorageReadRange): AsyncIterable<Uint8Array>;
  write(scope: string, key: string, data: Uint8Array, options?: StorageWriteOptions): Promise<void>;
  writeStream(
    scope: string,
    key: string,
    source: AsyncIterable<Uint8Array>,
    options?: StorageWriteOptions,
  ): Promise<void>;
  append(scope: string, key: string, data: Uint8Array, options?: StorageAppendOptions): Promise<void>;
  list(scope: string, prefix?: string): Promise<readonly string[]>;
  delete(scope: string, key: string): Promise<void>;
  size(scope: string, key: string): Promise<number | undefined>;
  sizeSync(scope: string, key: string): number | undefined;
  mtime(scope: string, key: string): Promise<number | undefined>;
  pathFor(scope: string, key: string): string | undefined;
  flush(): Promise<void>;
  close(): Promise<void>;
}
