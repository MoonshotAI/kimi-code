/**
 * `AppendLogStore` — node-fs backend for `IAppendLogStore`.
 *
 * Sits on top of `IFileSystemStorageService` and turns a byte stream into an ordered
 * sequence of typed JSON records. Owns the concerns the storage service
 * deliberately ignores: line framing (one JSON value per line, a.k.a. JSONL),
 * batching of appends into a single durable `append`, and crash-tolerant
 * decoding (a torn final line is dropped; corruption anywhere else throws).
 */

import { InstantiationType } from '#/_base/di/extensions';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IFileSystemStorageService } from '#/persistence/interface/storage';
import {
  AppendLogCorruptedError,
  IAppendLogStore,
  type AppendLogOptions,
} from '#/persistence/interface/appendLogStore';

const textEncoder = new TextEncoder();

interface LogState {
  pending: unknown[];
  flushPromise: Promise<void> | undefined;
  flushScheduled: boolean;
  onError?: (error: unknown) => void;
}

export class AppendLogStore implements IAppendLogStore {
  declare readonly _serviceBrand: undefined;

  private readonly logs = new Map<string, LogState>();

  constructor(@IFileSystemStorageService private readonly storage: IFileSystemStorageService) {}

  append<R>(scope: string, key: string, record: R, options?: AppendLogOptions): void {
    const state = this.state(scope, key);
    state.pending.push(record);
    if (options?.onError !== undefined && state.onError === undefined) {
      state.onError = options.onError;
    }
    this.scheduleFlush(scope, key, state);
  }

  async *read<R>(scope: string, key: string): AsyncIterable<R> {
    await this.flushLog(scope, key);
    const textDecoder = new TextDecoder();
    let pending = '';
    let lineNumber = 0;
    for await (const chunk of this.storage.readStream(scope, key)) {
      pending += textDecoder.decode(chunk, { stream: true });
      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex !== -1) {
        const raw = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        lineNumber++;
        const record = this.parseLine<R>(raw, scope, key, lineNumber, false);
        if (record !== undefined) yield record;
        newlineIndex = pending.indexOf('\n');
      }
    }
    pending += textDecoder.decode();
    if (pending.length > 0) {
      lineNumber++;
      const record = this.parseLine<R>(pending, scope, key, lineNumber, true);
      if (record !== undefined) yield record;
    }
  }

  private parseLine<R>(
    raw: string,
    scope: string,
    key: string,
    lineNumber: number,
    allowTruncated: boolean,
  ): R | undefined {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length === 0) return undefined;
    try {
      return JSON.parse(line) as R;
    } catch (error) {
      if (allowTruncated) return undefined;
      throw new AppendLogCorruptedError(scope, key, lineNumber, error);
    }
  }

  async rewrite<R>(scope: string, key: string, records: readonly R[]): Promise<void> {
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

  acquire(scope: string, key: string): IDisposable {
    return toDisposable(() => {
      void this.flushLog(scope, key);
    });
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

  private scheduleFlush(scope: string, key: string, state: LogState): void {
    if (state.flushScheduled || state.flushPromise !== undefined) return;
    state.flushScheduled = true;
    queueMicrotask(() => {
      state.flushScheduled = false;
      void this.flushLog(scope, key).catch((error) => state.onError?.(error));
    });
  }

  private flushLog(scope: string, key: string): Promise<void> {
    const state = this.state(scope, key);
    if (state.flushPromise !== undefined) return state.flushPromise;

    const promise = this.drain(scope, key, state).finally(() => {
      if (state.flushPromise === promise) {
        state.flushPromise = undefined;
      }
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
  LifecycleScope.App,
  IAppendLogStore,
  AppendLogStore,
  InstantiationType.Delayed,
  'storage',
);
