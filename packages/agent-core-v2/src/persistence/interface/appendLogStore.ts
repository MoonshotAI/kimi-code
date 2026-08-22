import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';

import { StorageError, StorageErrors } from '#/persistence/interface/storage';

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

export interface AppendLogOptions {
  readonly onError?: (error: unknown) => void;
}

export interface IAppendLogStore {
  readonly _serviceBrand: undefined;

  append<R>(scope: string, key: string, record: R, options?: AppendLogOptions): void;
  read<R>(scope: string, key: string): AsyncIterable<R>;
  rewrite<R>(scope: string, key: string, records: readonly R[]): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  acquire(scope: string, key: string): IDisposable;
  drainRetirements(): Promise<void>;
}

export const IAppendLogStore: ServiceIdentifier<IAppendLogStore> =
  createDecorator<IAppendLogStore>('appendLogStore');
