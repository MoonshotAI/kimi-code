import type { TextDecodeErrors } from './execEnv/decodeText';
import type { OsKind, PathClass, ShellName } from './execEnv/environmentProbe';

export type { TextDecodeErrors } from './execEnv/decodeText';
export type { HostEnvironmentInfo, OsKind, PathClass, ShellName } from './execEnv/environmentProbe';

export interface OsHost {
  readonly process: OsProcessPort;
  readonly fs: OsFsPort;
  readonly environment: OsEnvironmentPort;
}

export interface OsSpawnOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly mergeStderr?: boolean;
  readonly windowsHide?: boolean;
}

export interface OsProcessStdin {
  write(data: string | Uint8Array): void;
  end(): void;
}

export interface OsProcess {
  readonly pid: number;
  readonly external?: { readonly kind: 'terminal'; readonly id: string };
  readonly exitCode: number | null;
  readonly stdin: OsProcessStdin;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  wait(): Promise<number>;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  dispose(): void;
}

export interface OsProcessPort {
  spawn(
    command: string,
    args?: readonly string[],
    options?: OsSpawnOptions,
  ): Promise<OsProcess>;
}

export type OsProcessErrorCode =
  | 'os.process.spawn_failed'
  | 'os.process.kill_failed'
  | 'shell.git_bash_not_found';

export interface OsProcessErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class OsProcessError extends Error {
  readonly code: OsProcessErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: OsProcessErrorCode, message: string, options?: OsProcessErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OsProcessError';
    this.code = code;
    this.details = options?.details;
  }
}

export interface HostFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink?: boolean;
  readonly size: number;
  readonly mtimeMs?: number;
  readonly ino?: number;
}

export interface HostDirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink?: boolean;
}

export interface OsFsPort {
  readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  appendText(path: string, data: string): Promise<void>;
  readBytes(path: string, n?: number, offset?: number): Promise<Uint8Array>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): AsyncGenerator<string>;
  createExclusive(path: string, data: Uint8Array): Promise<boolean>;
  stat(path: string): Promise<HostFileStat>;
  lstat(path: string): Promise<HostFileStat>;
  readdir(path: string): Promise<readonly HostDirEntry[]>;
  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  realpath(path: string): Promise<string>;
}

export type HostFsErrorCode =
  | 'os.fs.not_found'
  | 'os.fs.is_directory'
  | 'os.fs.not_directory'
  | 'os.fs.already_exists'
  | 'os.fs.permission_denied'
  | 'os.fs.not_empty'
  | 'os.fs.unavailable'
  | 'os.fs.unknown';

export const HOST_FS_RETRYABLE_CODES: readonly HostFsErrorCode[] = [
  'os.fs.unavailable',
  'os.fs.unknown',
];

export interface HostFsErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class HostFsError extends Error {
  readonly code: HostFsErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(code: HostFsErrorCode, message: string, options?: HostFsErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HostFsError';
    this.code = code;
    this.details = options?.details;
    this.retryable = HOST_FS_RETRYABLE_CODES.includes(code);
  }
}

const HOST_FS_REASONS: Record<HostFsErrorCode, string> = {
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
  switch (errno) {
    case 'ENOENT':
      return 'os.fs.not_found';
    case 'EISDIR':
      return 'os.fs.is_directory';
    case 'ENOTDIR':
      return 'os.fs.not_directory';
    case 'EEXIST':
      return 'os.fs.already_exists';
    case 'EACCES':
    case 'EPERM':
      return 'os.fs.permission_denied';
    case 'ENOTEMPTY':
      return 'os.fs.not_empty';
    default:
      return 'os.fs.unknown';
  }
}

export function toHostFsError(error: unknown, ctx: { path: string; op: string }): HostFsError {
  if (error instanceof HostFsError) return error;
  const errno = readErrno(error);
  const code = mapErrno(errno);
  return new HostFsError(code, `${ctx.op} failed: ${HOST_FS_REASONS[code]}`, {
    details: { path: ctx.path, op: ctx.op, errno, syscall: readSyscall(error) },
    cause: error,
  });
}

export function unwrapErrorCause(error: unknown): unknown {
  let current = error;
  while (
    (current instanceof HostFsError || current instanceof OsProcessError) &&
    current.cause !== undefined
  ) {
    current = current.cause;
  }
  return current;
}

export interface OsEnvironmentPort {
  readonly osKind: OsKind;
  readonly osArch: string;
  readonly osVersion: string;
  readonly shellName: ShellName;
  readonly shellPath: string;
  readonly pathClass: PathClass;
  readonly homeDir: string;
  readonly ready: Promise<void>;
}
