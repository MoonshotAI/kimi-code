/**
 * `hostFs` domain (L1) — error codes, `HostFsError`, and the `toHostFsError`
 * boundary translator.
 *
 * Every `IHostFileSystem` backend translates raw OS failures (Node
 * `ErrnoException`, and whatever a future non-Node backend throws) into a
 * `HostFsError` at its boundary, so consumers branch on a stable `code`
 * (`os.fs.*`) instead of platform errnos. `toHostFsError` is a pure function
 * shared by all backends; it is idempotent — an error that is already a
 * `HostFsError` passes through untouched.
 *
 * `os.fs.unavailable` covers non-errno resource failures (fs.watch unsupported,
 * fd exhaustion, …); `os.fs.unknown` is the fallback for unrecognized errnos.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';

export const OsFsErrors = {
  codes: {
    OS_FS_NOT_FOUND: 'os.fs.not_found',
    OS_FS_IS_DIRECTORY: 'os.fs.is_directory',
    OS_FS_NOT_DIRECTORY: 'os.fs.not_directory',
    OS_FS_ALREADY_EXISTS: 'os.fs.already_exists',
    OS_FS_PERMISSION_DENIED: 'os.fs.permission_denied',
    OS_FS_NOT_EMPTY: 'os.fs.not_empty',
    OS_FS_UNAVAILABLE: 'os.fs.unavailable',
    OS_FS_UNKNOWN: 'os.fs.unknown',
  },
  retryable: ['os.fs.unavailable', 'os.fs.unknown'],
  info: {
    'os.fs.not_found': {
      title: 'Path not found',
      retryable: false,
      public: true,
    },
    'os.fs.is_directory': {
      title: 'Path is a directory',
      retryable: false,
      public: true,
    },
    'os.fs.not_directory': {
      title: 'Path is not a directory',
      retryable: false,
      public: true,
    },
    'os.fs.already_exists': {
      title: 'Path already exists',
      retryable: false,
      public: true,
    },
    'os.fs.permission_denied': {
      title: 'Permission denied',
      retryable: false,
      public: true,
      action: 'Check the file permissions of the target path.',
    },
    'os.fs.not_empty': {
      title: 'Directory not empty',
      retryable: false,
      public: true,
    },
    'os.fs.unavailable': {
      title: 'Filesystem unavailable',
      retryable: true,
      public: true,
    },
    'os.fs.unknown': {
      title: 'Filesystem error',
      retryable: true,
      public: true,
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(OsFsErrors);

export type HostFsErrorCode = (typeof OsFsErrors.codes)[keyof typeof OsFsErrors.codes];

export class HostFsError extends Error2 {
  constructor(code: HostFsErrorCode, message: string, options?: Error2Options) {
    super(code, message, options);
    this.name = 'HostFsError';
  }
}

const REASONS: Record<HostFsErrorCode, string> = {
  'os.fs.not_found': 'path does not exist',
  'os.fs.is_directory': 'path is a directory',
  'os.fs.not_directory': 'a path component is not a directory',
  'os.fs.already_exists': 'path already exists',
  'os.fs.permission_denied': 'permission denied',
  'os.fs.not_empty': 'directory is not empty',
  'os.fs.unavailable': 'filesystem resource unavailable',
  'os.fs.unknown': 'unrecognized filesystem error',
};

function readErrno(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function readSyscall(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('syscall' in error)) return undefined;
  const syscall = (error as { syscall: unknown }).syscall;
  return typeof syscall === 'string' ? syscall : undefined;
}

function mapErrno(errno: string | undefined): HostFsErrorCode {
  if (errno === undefined) return OsFsErrors.codes.OS_FS_UNKNOWN;
  switch (errno) {
    case 'ENOENT':
      return OsFsErrors.codes.OS_FS_NOT_FOUND;
    case 'EISDIR':
      return OsFsErrors.codes.OS_FS_IS_DIRECTORY;
    case 'ENOTDIR':
      return OsFsErrors.codes.OS_FS_NOT_DIRECTORY;
    case 'EEXIST':
      return OsFsErrors.codes.OS_FS_ALREADY_EXISTS;
    case 'EACCES':
    case 'EPERM':
      return OsFsErrors.codes.OS_FS_PERMISSION_DENIED;
    case 'ENOTEMPTY':
      return OsFsErrors.codes.OS_FS_NOT_EMPTY;
    default:
      return OsFsErrors.codes.OS_FS_UNKNOWN;
  }
}

export function toHostFsError(error: unknown, ctx: { path: string; op: string }): HostFsError {
  if (error instanceof HostFsError) return error;
  const errno = readErrno(error);
  const code = mapErrno(errno);
  return new HostFsError(code, `${ctx.op} failed: ${REASONS[code]}`, {
    details: { path: ctx.path, op: ctx.op, errno, syscall: readSyscall(error) },
    cause: error,
  });
}
