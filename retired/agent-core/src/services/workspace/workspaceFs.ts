

import { createDecorator, Disposable } from '../../di';

import type { FsBrowseResponse, FsHomeResponse } from '@moonshot-ai/protocol';

export class WorkspaceFsNotAbsoluteError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`path must be absolute: ${path}`);
    this.name = 'WorkspaceFsNotAbsoluteError';
    this.path = path;
  }
}

export class WorkspaceFsNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`path not found: ${path}`);
    this.name = 'WorkspaceFsNotFoundError';
    this.path = path;
  }
}

export class WorkspaceFsPermissionError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`permission denied: ${path}`);
    this.name = 'WorkspaceFsPermissionError';
    this.path = path;
  }
}

export interface IWorkspaceFsService {
  readonly _serviceBrand: undefined;

  browse(absPath?: string): Promise<FsBrowseResponse>;

  home(): Promise<FsHomeResponse>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IWorkspaceFsService = createDecorator<IWorkspaceFsService>(
  'workspaceFsService',
);

export abstract class WorkspaceFsBase
  extends Disposable
  implements IWorkspaceFsService
{
  readonly _serviceBrand: undefined;
  abstract browse(absPath?: string): Promise<FsBrowseResponse>;
  abstract home(): Promise<FsHomeResponse>;
}

export const RECENT_ROOTS_LIMIT = 8;
