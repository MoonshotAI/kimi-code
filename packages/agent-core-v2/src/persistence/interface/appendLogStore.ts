import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type {
  AppendLogOptions,
  AppendLogReadOptions,
  AppendLogRewriteOptions,
  AppendLogWrite,
} from '@moonshot-ai/core/store/append-log';

import { StorageError, StorageErrors } from '#/persistence/interface/storage';

export type {
  AppendLogOptions,
  AppendLogReadOptions,
  AppendLogRewriteOptions,
  AppendLogTruncation,
  AppendLogWrite,
} from '@moonshot-ai/core/store/append-log';

export class AppendLogCorruptedError extends StorageError {
  constructor(scope: string, key: string, lineNumber: number, cause: unknown) {
    super(
      StorageErrors.codes.STORAGE_CORRUPTED,
      `append-log ${scope}/${key}: corrupted line ${lineNumber}`,
      {
        details: { scope, key, lineNumber },
        cause,
      },
    );
    this.name = 'AppendLogCorruptedError';
  }
}

export interface IAppendLogStore {
  readonly _serviceBrand: undefined;

  readonly onDidWrite: Event<AppendLogWrite>;

  append<R>(scope: string, key: string, record: R, options?: AppendLogOptions): void;
  read<R>(scope: string, key: string, options?: AppendLogReadOptions): AsyncIterable<R>;
  rewrite<R>(scope: string, key: string, records: readonly R[], options?: AppendLogRewriteOptions): Promise<void>;
  flush(): Promise<void>;
  flushLog(scope: string, key: string): Promise<void>;
  close(): Promise<void>;
  acquire(scope: string, key: string): IDisposable;
  drainRetirements(): Promise<void>;
  externallyModified(scope: string, key: string): boolean;
  bindWriteGuard(scope: string, key: string, guard: () => boolean): IDisposable;
}

export const IAppendLogStore: ServiceIdentifier<IAppendLogStore> =
  createDecorator<IAppendLogStore>('appendLogStore');
