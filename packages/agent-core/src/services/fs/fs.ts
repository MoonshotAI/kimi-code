
import { createDecorator } from '../../di';
import type { IDisposable } from '../../di';
import type {
  FsEntry,
  FsListManyRequest,
  FsListManyResponse,
  FsListRequest,
  FsListResponse,
  FsMkdirRequest,
  FsReadRequest,
  FsReadResponse,
  FsStatManyRequest,
  FsStatManyResponse,
  FsStatRequest,
} from '@moonshot-ai/protocol';

export class FsPathNotFoundError extends Error {
  readonly inputPath: string;
  constructor(inputPath: string) {
    super(`fs.path_not_found: ${inputPath}`);
    this.name = 'FsPathNotFoundError';
    this.inputPath = inputPath;
  }
}

export class FsIsDirectoryError extends Error {
  readonly inputPath: string;
  constructor(inputPath: string) {
    super(`fs.is_directory: ${inputPath}`);
    this.name = 'FsIsDirectoryError';
    this.inputPath = inputPath;
  }
}

export class FsIsBinaryError extends Error {
  readonly inputPath: string;
  constructor(inputPath: string) {
    super(`fs.is_binary: ${inputPath}`);
    this.name = 'FsIsBinaryError';
    this.inputPath = inputPath;
  }
}

export class FsTooLargeError extends Error {
  readonly inputPath: string;
  readonly size: number;
  constructor(inputPath: string, size: number) {
    super(`fs.too_large: ${inputPath} (${size} bytes > 10 MB)`);
    this.name = 'FsTooLargeError';
    this.inputPath = inputPath;
    this.size = size;
  }
}

export class FsTooManyResultsError extends Error {
  readonly inputPath: string;
  readonly limit: number;
  constructor(inputPath: string, limit: number) {
    super(`fs.too_many_results: ${inputPath} (limit ${limit})`);
    this.name = 'FsTooManyResultsError';
    this.inputPath = inputPath;
    this.limit = limit;
  }
}

export class FsAlreadyExistsError extends Error {
  readonly inputPath: string;
  constructor(inputPath: string) {
    super(`fs.already_exists: ${inputPath}`);
    this.name = 'FsAlreadyExistsError';
    this.inputPath = inputPath;
  }
}

export interface IFsService extends IDisposable {
  readonly _serviceBrand: undefined;

  list(sessionId: string, req: FsListRequest): Promise<FsListResponse>;
  read(sessionId: string, req: FsReadRequest): Promise<FsReadResponse>;

  listMany(
    sessionId: string,
    req: FsListManyRequest,
  ): Promise<FsListManyResponse>;
  stat(sessionId: string, req: FsStatRequest): Promise<FsEntry>;
  statMany(
    sessionId: string,
    req: FsStatManyRequest,
  ): Promise<FsStatManyResponse>;

  mkdir(sessionId: string, req: FsMkdirRequest): Promise<FsEntry>;

  resolveDownload(
    sessionId: string,
    relPath: string,
  ): Promise<FsDownloadResolved>;

  resolvePath(
    sessionId: string,
    relPath: string,
  ): Promise<FsPathResolved>;
}

export interface FsDownloadResolved {

  readonly absolute: string;

  readonly relative: string;

  readonly size: number;

  readonly etag: string;

  readonly mime: string;

  readonly modifiedAt: Date;
}

export interface FsPathResolved {
  readonly absolute: string;
  readonly relative: string;
  readonly isDirectory: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IFsService = createDecorator<IFsService>('fsService');
