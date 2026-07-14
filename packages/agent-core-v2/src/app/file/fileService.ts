/**
 * `file` domain — `IFileService` contract and error helpers.
 *
 * Process-global upload store backing the `/files` REST endpoints: persists
 * uploaded bytes via `IBlobStore` and their `FileMeta` index in the same
 * store, then hands callers a stream back on download. Bound at App scope.
 */

import type { Readable } from 'node:stream';

import type { FileMeta } from '@moonshot-ai/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';

export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface SaveOptions {
  readonly name?: string;
  readonly mimeType?: string;
  readonly expiresInSec?: number;
}

export interface GetResult {
  readonly meta: FileMeta;
  readonly stream: (range?: FileReadRange) => Readable;
}

export interface FileReadRange {
  readonly start: number;
  readonly end: number;
}

export interface IFileService {
  readonly _serviceBrand: undefined;

  save(source: Readable, filename: string, options?: SaveOptions): Promise<FileMeta>;
  get(fileId: string): Promise<GetResult>;
  delete(fileId: string): Promise<void>;
}

export const IFileService: ServiceIdentifier<IFileService> = createDecorator<IFileService>('fileService');


export const FileErrors = {
  codes: {
    FILE_NOT_FOUND: 'file.not_found',
    FILE_TOO_LARGE: 'file.too_large',
  },
  info: {
    'file.not_found': {
      title: 'File not found',
      retryable: false,
      public: true,
      action: 'Check the file_id or upload the file again.',
    },
    'file.too_large': {
      title: 'Upload too large',
      retryable: false,
      public: true,
      action: 'Upload a smaller file (limit is 50 MiB).',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(FileErrors);

export class FileError extends Error2 {
  constructor(
    code: (typeof FileErrors.codes)[keyof typeof FileErrors.codes],
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, { details });
    this.name = 'FileError';
  }
}

export function fileNotFoundError(fileId: string): FileError {
  return new FileError(FileErrors.codes.FILE_NOT_FOUND, `file not found: ${fileId}`, { fileId });
}

export function fileTooLargeError(seen: number, limit: number): FileError {
  return new FileError(
    FileErrors.codes.FILE_TOO_LARGE,
    `upload size ${seen} bytes exceeds limit ${limit} bytes`,
    { seen, limit },
  );
}

export function isFileError(error: unknown, code: (typeof FileErrors.codes)[keyof typeof FileErrors.codes]): boolean {
  return error instanceof Error2 && error.code === code;
}
