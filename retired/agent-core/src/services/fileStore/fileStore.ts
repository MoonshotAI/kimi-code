
import type { Readable } from 'node:stream';

import { createDecorator } from '../../di';

import type { FileMeta } from '@moonshot-ai/protocol';

export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export class FileNotFoundError extends Error {
  readonly fileId: string;
  constructor(fileId: string) {
    super(`file not found: ${fileId}`);
    this.name = 'FileNotFoundError';
    this.fileId = fileId;
  }
}

export class FileTooLargeError extends Error {
  readonly limit: number;
  readonly seen: number;
  constructor(seen: number, limit: number) {
    super(`upload size ${seen} bytes exceeds limit ${limit} bytes`);
    this.name = 'FileTooLargeError';
    this.seen = seen;
    this.limit = limit;
  }
}

export interface SaveOptions {

  name?: string;

  mimeType?: string;

  expiresInSec?: number;
}

export interface GetResult {
  meta: FileMeta;
  blobPath: string;
}

export interface IFileStore {
  readonly _serviceBrand: undefined;

  save(source: Readable, filename: string, options?: SaveOptions): Promise<FileMeta>;

  get(fileId: string): Promise<GetResult>;

  delete(fileId: string): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IFileStore = createDecorator<IFileStore>('fileStore');
