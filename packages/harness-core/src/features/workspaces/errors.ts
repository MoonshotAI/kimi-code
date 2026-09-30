import { HostFsError } from '#/features/os/host/types';

export type WorkspaceFsErrorCode =
  | 'fs.not_absolute'
  | 'fs.path_not_found'
  | 'fs.path_escapes'
  | 'fs.is_directory'
  | 'fs.is_binary'
  | 'fs.too_large'
  | 'fs.too_many_results'
  | 'fs.already_exists'
  | 'fs.permission_denied'
  | 'fs.grep_timeout'
  | 'fs.config_invalid';

export class WorkspaceFsError extends Error {
  readonly code: WorkspaceFsErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: WorkspaceFsErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'WorkspaceFsError';
    this.code = code;
    this.details = details;
  }
}

export function missingPathError(inputPath: string): WorkspaceFsError {
  return new WorkspaceFsError('fs.path_not_found', `path not found: ${inputPath}`, { path: inputPath });
}

export function mapHostFsError(error: unknown, inputPath: string): Error {
  if (error instanceof WorkspaceFsError) return error;
  if (error instanceof HostFsError) {
    switch (error.code) {
      case 'os.fs.not_found':
      case 'os.fs.not_directory':
        return missingPathError(inputPath);
      case 'os.fs.is_directory':
        return new WorkspaceFsError('fs.is_directory', `path is a directory: ${inputPath}`, { path: inputPath });
      case 'os.fs.already_exists':
        return new WorkspaceFsError('fs.already_exists', `path already exists: ${inputPath}`, { path: inputPath });
      case 'os.fs.permission_denied':
        return new WorkspaceFsError('fs.permission_denied', `permission denied: ${inputPath}`, { path: inputPath });
      default:
        return error;
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}
