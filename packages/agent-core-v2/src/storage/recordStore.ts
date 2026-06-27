/**
 * `IRecordStore` / `RecordStore` — the typed append-log service.
 *
 * Sits on top of `IStorageService` and turns a byte stream into an ordered
 * sequence of typed JSON records. Owns the concerns the storage service
 * deliberately ignores: line framing (one JSON value per line, a.k.a. JSONL),
 * batching of appends into a single durable `append`, and crash-tolerant
 * decoding (a torn final line is dropped; corruption anywhere else throws).
 *
 * It is a DI service: domains inject `IRecordStore` and call
 * `append/read/rewrite` with the `(scope, key)` of the log they own. Buffering
 * is kept per log inside the service, so many appends within a synchronous
 * block collapse into one durable write.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IStorageService } from './storageService';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class RecordCorruptedError extends Error {
  constructor(
    readonly scope: string,
    readonly key: string,
    readonly lineNumber: number,
    cause: unknown,
  ) {
    super(`record log ${scope}/${key}: corrupted line ${lineNumber}: ${String(cause)}`);
    this.name = 'RecordCorruptedError';
  }
}

export interface IRecordStore {
  readonly _serviceBrand: undefined;

  /** Buffer a record for the next durable append. Resolves immediately. */
  append<R>(scope: string, key: string, record: R): void;

  /**
   * Replay the log in order. Flushes pending appends first. A torn final line
   * (crash mid-flush) is dropped; any other corruption throws.
   */
  read<R>(scope: string, key: string): AsyncIterable<R>;

  /** Atomically replace the whole log with `records` (used after migration). */
  rewrite<R>(scope: string, key: string, records: readonly R[]): Promise<void>;

  /** Durable-write every buffered record across all logs. */
  flush(): Promise<void>;

  /** Flush and release resources. */
  close(): Promise<void>;
}

export const IRecordStore: ServiceIdentifier<IRecordStore> =
  createDecorator<IRecordStore>('recordStore');

interface LogState {
  pending: unknown[];
  flushPromise: Promise<void> | undefined;
  flushScheduled: boolean;
}

export class RecordStore implements IRecordStore {
  declare readonly _serviceBrand: undefined;

  private readonly logs = new Map<string, LogState>();

  constructor(@IStorageService private readonly storage: IStorageService) {}

  append<R>(scope: string, key: string, record: R): void {
    const state = this.state(scope, key);
    state.pending.push(record);
    this.scheduleFlush(scope, key, state);
  }

  async *read<R>(scope: string, key: string): AsyncIterable<R> {
    await this.flushLog(scope, key);
    const bytes = await this.storage.read(scope, key);
    if (bytes === undefined) return;

    const lines = textDecoder.decode(bytes).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.length === 0) continue;
      const isLast = i === lines.length - 1;
      try {
        yield JSON.parse(line) as R;
      } catch (error) {
        // A crash can leave a half-written last line; drop it. Corruption
        // anywhere before the end is real and must surface.
        if (isLast) return;
        throw new RecordCorruptedError(scope, key, i + 1, error);
      }
    }
  }

  async rewrite<R>(scope: string, key: string, records: readonly R[]): Promise<void> {
    // Persist anything already buffered, then atomically replace the log.
    await this.flushLog(scope, key);
    await this.storage.write(scope, key, encodeBatch(records), { atomic: true });
  }

  async flush(): Promise<void> {
    const inFlight = [...this.logs.keys()].map((id) => {
      const { scope, key } = fromLogId(id);
      return this.flushLog(scope, key);
    });
    await Promise.all(inFlight);
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private state(scope: string, key: string): LogState {
    const id = logId(scope, key);
    let state = this.logs.get(id);
    if (state === undefined) {
      state = { pending: [], flushPromise: undefined, flushScheduled: false };
      this.logs.set(id, state);
    }
    return state;
  }

  /**
   * Defer the drain to the next microtask so records appended within the same
   * synchronous block accumulate into a single durable `IStorageService.append`.
   */
  private scheduleFlush(scope: string, key: string, state: LogState): void {
    if (state.flushScheduled || state.flushPromise !== undefined) return;
    state.flushScheduled = true;
    queueMicrotask(() => {
      state.flushScheduled = false;
      void this.flushLog(scope, key);
    });
  }

  private flushLog(scope: string, key: string): Promise<void> {
    const state = this.state(scope, key);
    if (state.flushPromise !== undefined) return state.flushPromise;

    const promise = this.drain(scope, key, state).finally(() => {
      if (state.flushPromise === promise) {
        state.flushPromise = undefined;
      }
      // Records appended during the drain must be drained too.
      if (state.pending.length > 0) {
        void this.flushLog(scope, key);
      }
    });
    state.flushPromise = promise;
    return promise;
  }

  private async drain(scope: string, key: string, state: LogState): Promise<void> {
    while (state.pending.length > 0) {
      const batch = state.pending.splice(0);
      await this.storage.append(scope, key, encodeBatch(batch), { durable: true });
    }
  }
}

function logId(scope: string, key: string): string {
  return `${scope}\n${key}`;
}

function fromLogId(id: string): { scope: string; key: string } {
  const index = id.indexOf('\n');
  return { scope: id.slice(0, index), key: id.slice(index + 1) };
}

function encodeBatch(records: readonly unknown[]): Uint8Array {
  if (records.length === 0) return new Uint8Array(0);
  const content = records.map((record) => JSON.stringify(record) + '\n').join('');
  return textEncoder.encode(content);
}

registerScopedService(
  LifecycleScope.Session,
  IRecordStore,
  RecordStore,
  InstantiationType.Delayed,
  'storage',
);
