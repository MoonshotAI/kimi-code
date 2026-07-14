/**
 * `storage` domain (L1) — node-fs backend for `IAppendLogStore`.
 *
 * Sits on top of `IFileSystemStorageService` and turns a byte stream into an ordered
 * sequence of typed JSON records. Owns the concerns the storage service
 * deliberately ignores: line framing (one JSON value per line, a.k.a. JSONL),
 * batching of appends into a single durable `append`, and crash-tolerant
 * decoding (a torn final line is dropped; corruption anywhere else throws).
 * Serializes whole-log rewrites with live appends, preserves queued or
 * in-flight records across the atomic replacement, keeps ambiguous append and
 * rewrite failures sticky, keeps the shared flush pending until the
 * post-rewrite drain is durable, waits every key before a global flush reports
 * an error, and preserves per-key storage ordering while acquired buffers
 * retire and hand off to replacement owners. Bound at App scope.
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
  storageFailure: { readonly error: unknown } | undefined;
  cutoverEpoch: number;
  refCount: number;
  retired: boolean;
  ready: Promise<void>;
  retirement: Promise<void> | undefined;
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
    const encoded = encodeBatch(records);
    const state = this.state(scope, key);
    state.cutoverEpoch++;
    const prior = state.flushPromise ?? state.ready;
    const priorSettled = prior.then(
      () => undefined,
      () => undefined,
    );
    const rewrite = priorSettled.then(async () => {
      try {
        await this.storage.write(scope, key, encoded, { atomic: true });
        state.storageFailure = undefined;
      } catch (error) {
        state.storageFailure = { error };
        throw error;
      }
    });
    await this.ownFlush(scope, key, state, rewrite);
  }

  async flush(): Promise<void> {
    const inFlight = [...this.logs.entries()].map(([id, state]) => {
      const { scope, key } = fromLogId(id);
      return this.flushState(scope, key, state);
    });
    const settled = await Promise.allSettled(inFlight);
    for (const result of settled) {
      if (result.status === 'rejected') throw result.reason;
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  acquire(scope: string, key: string): IDisposable {
    const state = this.state(scope, key);
    state.refCount++;
    return toDisposable(() => {
      this.release(scope, key, state);
    });
  }

  private state(scope: string, key: string): LogState {
    const id = logId(scope, key);
    let state = this.logs.get(id);
    if (state === undefined || state.retired) {
      const ready = state?.retirement ?? Promise.resolve();
      state = {
        pending: [],
        flushPromise: undefined,
        flushScheduled: false,
        storageFailure: undefined,
        cutoverEpoch: 0,
        refCount: 0,
        retired: false,
        ready,
        retirement: undefined,
      };
      this.logs.set(id, state);
    }
    return state;
  }

  private scheduleFlush(scope: string, key: string, state: LogState): void {
    if (state.flushScheduled || state.flushPromise !== undefined) return;
    state.flushScheduled = true;
    queueMicrotask(() => {
      state.flushScheduled = false;
      void this.flushState(scope, key, state).catch((error) => state.onError?.(error));
    });
  }

  private flushLog(scope: string, key: string): Promise<void> {
    const state = this.state(scope, key);
    return this.flushState(scope, key, state);
  }

  private flushState(scope: string, key: string, state: LogState): Promise<void> {
    if (state.flushPromise !== undefined) return state.flushPromise;
    if (state.storageFailure !== undefined) return Promise.reject(state.storageFailure.error);
    return this.ownFlush(scope, key, state, this.drain(scope, key, state));
  }

  private release(scope: string, key: string, state: LogState): void {
    state.refCount--;
    if (state.refCount > 0) return;
    state.retired = true;
    state.retirement = this.settleRetiredState(scope, key, state).catch(() => undefined);
  }

  private async settleRetiredState(scope: string, key: string, state: LogState): Promise<void> {
    try {
      await this.flushState(scope, key, state);
    } finally {
      const id = logId(scope, key);
      if (this.logs.get(id) === state) this.logs.delete(id);
    }
  }

  private ownFlush(
    scope: string,
    key: string,
    state: LogState,
    operation: Promise<void>,
  ): Promise<void> {
    let owned!: Promise<void>;
    owned = this.finishOwnedFlush(scope, key, state, operation, () => owned);
    state.flushPromise = owned;
    return owned;
  }

  private async finishOwnedFlush(
    scope: string,
    key: string,
    state: LogState,
    operation: Promise<void>,
    owner: () => Promise<void>,
  ): Promise<void> {
    let failure: { readonly error: unknown } | undefined;
    try {
      await operation;
    } catch (error) {
      failure = { error };
    }
    const owned = owner();
    if (state.flushPromise === owned) {
      try {
        if (failure === undefined) {
          while (state.flushPromise === owned && state.pending.length > 0) {
            await this.drain(scope, key, state);
          }
        }
      } finally {
        if (state.flushPromise === owned) {
          state.flushPromise = undefined;
        }
      }
    }
    if (failure !== undefined) throw failure.error;
  }

  private async drain(scope: string, key: string, state: LogState): Promise<void> {
    const cutoverEpoch = state.cutoverEpoch;
    await state.ready;
    if (state.cutoverEpoch !== cutoverEpoch) return;
    while (state.pending.length > 0) {
      const batch = state.pending.slice();
      try {
        await this.storage.append(scope, key, encodeBatch(batch), { durable: true });
      } catch (error) {
        const failure = (state.storageFailure ??= { error });
        throw failure.error;
      }
      if (state.cutoverEpoch !== cutoverEpoch) return;
      state.pending.splice(0, batch.length);
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
