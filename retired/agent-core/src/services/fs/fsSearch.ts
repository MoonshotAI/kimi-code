
import { createDecorator } from '../../di';
import type { IDisposable } from '../../di';
import type {
  FsGrepRequest,
  FsGrepResponse,
  FsSearchRequest,
  FsSearchResponse,
} from '@moonshot-ai/protocol';

export class FsGrepTimeoutError extends Error {
  readonly elapsedMs: number;
  constructor(elapsedMs: number) {
    super(`fs.grep_timeout after ${elapsedMs}ms`);
    this.name = 'FsGrepTimeoutError';
    this.elapsedMs = elapsedMs;
  }
}

export interface IFsSearchService extends IDisposable {
  readonly _serviceBrand: undefined;

  search(
    sessionId: string,
    req: FsSearchRequest,
  ): Promise<FsSearchResponse>;
  grep(sessionId: string, req: FsGrepRequest): Promise<FsGrepResponse>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IFsSearchService = createDecorator<IFsSearchService>(
  'fsSearchService',
);
