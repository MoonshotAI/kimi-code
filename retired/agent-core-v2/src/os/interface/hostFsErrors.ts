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
import { t } from '@moonshot-ai/kimi-i18n';

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
      title: t('v2Errors.pathNotFound'),
      retryable: false,
      public: true,
    },
    'os.fs.is_directory': {
      title: t('v2Errors.pathIsDirectory'),
      retryable: false,
      public: true,
    },
    'os.fs.not_directory': {
      title: t('v2Errors.pathNotDirectory'),
      retryable: false,
      public: true,
    },
    'os.fs.already_exists': {
      title: t('v2Errors.pathAlreadyExists'),
      retryable: false,
      public: true,
    },
    'os.fs.permission_denied': {
      title: t('v2Errors.permissionDenied'),
      retryable: false,
      public: true,
      action: t('v2Errors.permissionDeniedAction'),
    },
    'os.fs.not_empty': {
      title: t('v2Errors.directoryNotEmpty'),
      retryable: false,
      public: true,
    },
    'os.fs.unavailable': {
      title: t('v2Errors.fsUnavailable'),
      retryable: true,
      public: true,
    },
    'os.fs.unknown': {
      title: t('v2Errors.fsError'),
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
  'os.fs.not_found': t('v2Fs.pathNotFound'),
  'os.fs.is_directory': t('v2Fs.pathIsDirectory'),
  'os.fs.not_directory': t('v2Fs.pathNotDirectory'),
  'os.fs.already_exists': t('v2Fs.pathAlreadyExists'),
  'os.fs.permission_denied': t('v2Fs.permissionDenied'),
  'os.fs.not_empty': t('v2Fs.directoryNotEmpty'),
  'os.fs.unavailable': t('v2Fs.fsUnavailable'),
  'os.fs.unknown': t('v2Fs.fsError'),
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
  return new HostFsError(code, t('v2Fs.opFailed', { op: ctx.op, reason: REASONS[code] }), {
    details: { path: ctx.path, op: ctx.op, errno, syscall: readSyscall(error) },
    cause: error,
  });
}
