/**
 * `persistence/interface` — `IAppendLogStore` contract.
 *
 * The append-log access-pattern store: turns a byte stream into an ordered
 * sequence of typed JSON records on top of `IFileSystemStorageService`. Owns the
 * concerns the storage service deliberately ignores: line framing, batching,
 * and crash-tolerant decoding. Acquired handles share a keyed buffer; its final
 * owner release starts a flush and retires that buffer once the flush settles,
 * before a replacement buffer starts storage I/O for the same key. `rewrite`
 * takes ownership at its call boundary: `records` replaces the history already
 * durable before that cutover, while appends still queued or in flight remain
 * a live tail that is drained after the atomic replacement. Callers must not
 * also include those outstanding appends in `records`. An ambiguous append or
 * rewrite failure remains sticky for that acquired buffer generation so a
 * later flush cannot duplicate data by guessing whether storage committed it.
 * A valid explicit `rewrite` is the recovery boundary: a successful atomic
 * replacement clears that failure before the preserved live tail drains.
 * `flush` and `close` wait for every keyed buffer to settle before reporting
 * the first failure in stable key insertion order.
 *
 * This file ships the interface, error class, and DI token only.
 * The concrete `AppendLogStore` implementation lives in
 * `persistence/backends/node-fs/appendLogStore.ts`.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';

import { StorageError, StorageErrors } from '#/persistence/interface/storage';

/**
 * A non-final line of an append log failed to parse — real corruption (a torn
 * final line is dropped silently instead). Carries `storage.corrupted`; the
 * scope/key/lineNumber coordinates live in `details` and the underlying parse
 * error is preserved as `cause`.
 */
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
}

export const IAppendLogStore: ServiceIdentifier<IAppendLogStore> =
  createDecorator<IAppendLogStore>('appendLogStore');
