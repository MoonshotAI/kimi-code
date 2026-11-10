import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';

import {
  IFileSystemStorageService,
  isStorageError,
  StorageError,
  StorageErrors,
} from '#/persistence/interface/storage';
import {
  AppendLogCorruptedError,
  IAppendLogStore,
  type AppendLogOptions,
  type AppendLogReadOptions,
  type AppendLogRewriteOptions,
  type AppendLogWrite,
} from '#/persistence/interface/appendLogStore';

const textEncoder = new TextEncoder();

const pendingRetirements = new Set<Promise<void>>();

export async function drainAppendLogRetirements(): Promise<void> {
  while (pendingRetirements.size > 0) {
    await Promise.all(pendingRetirements);
  }
}

interface AppendRecovery {
  readonly batch: unknown[];
  readonly encoded: Uint8Array;
  readonly baseLength: number;
  readonly externallyModifiedAtStart: boolean;
}

interface LogState {
  pending: unknown[];
  flushPromise: Promise<void> | undefined;
  flushScheduled: boolean;
  storageFailure: { readonly error: unknown } | undefined;
  recovery: AppendRecovery | undefined;
  failureWarned: boolean;
  stuckWatch: NodeJS.Timeout | undefined;
  cutoverEpoch: number;
  refCount: number;
  retired: boolean;
  ready: Promise<void>;
  retirement: Promise<void> | undefined;
  knownLength: number | undefined;
  inFlightBytes: number;
  rewriteInFlight: number | undefined;
  guardWarned: boolean;
  onError?: (error: unknown) => void;
}

const STUCK_FLUSH_CHECK_MS = 5_000;
const STUCK_FLUSH_WARN_MS = 30_000;
const STUCK_FLUSH_REPEAT_MS = 10 * 60_000;

export class AppendLogStore extends Disposable implements IAppendLogStore {
  declare readonly _serviceBrand: undefined;

  private readonly logs = new Map<string, LogState>();
  private readonly writeGuards = new Map<string, () => boolean>();
  private readonly writeEmitter = this._register(new Emitter<AppendLogWrite>());
  readonly onDidWrite: Event<AppendLogWrite> = this.writeEmitter.event;

  constructor(
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @ILogService private readonly logger: ILogService,
  ) {
    super();
  }

  append<R>(scope: string, key: string, record: R, options?: AppendLogOptions): void {
    const state = this.state(scope, key);
    state.pending.push(record);
    if (state.storageFailure !== undefined && !state.failureWarned) {
      state.failureWarned = true;
      this.logger.warn('append accepted while a storage failure is latched; the record may never reach disk', {
        scope,
        key,
        pending: state.pending.length,
      });
    }
    if (options?.onError !== undefined && state.onError === undefined) {
      state.onError = options.onError;
    }
    this.scheduleFlush(scope, key, state);
  }

  async *read<R>(scope: string, key: string, options?: AppendLogReadOptions): AsyncIterable<R> {
    await this.flushLog(scope, key);
    const state = this.state(scope, key);
    const lengthAtStart = this.diskLength(scope, key);
    try {
      const onTruncate = options?.onTruncate;
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
          let record: R | undefined;
          try {
            record = this.parseLine<R>(raw, scope, key, lineNumber, false);
          } catch (error) {
            if (onTruncate === undefined) throw error;
            onTruncate({ lineNumber, reason: 'corrupted', cause: error });
            return;
          }
          if (record !== undefined) yield record;
          newlineIndex = pending.indexOf('\n');
        }
      }
      pending += textDecoder.decode();
      if (pending.length > 0) {
        lineNumber++;
        const record = this.parseLine<R>(pending, scope, key, lineNumber, true);
        if (record !== undefined) {
          yield record;
        } else if (onTruncate !== undefined) {
          const line = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
          if (line.length > 0) onTruncate({ lineNumber, reason: 'truncated' });
        }
      }
    } finally {
      const disk = this.diskLength(scope, key);
      if (disk !== undefined) {
        state.knownLength = lengthAtStart === disk ? disk : (lengthAtStart ?? 0);
      }
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

  async rewrite<R>(
    scope: string,
    key: string,
    records: readonly R[],
    options?: AppendLogRewriteOptions,
  ): Promise<void> {
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
        state.rewriteInFlight = encoded.length;
        await this.storage.write(scope, key, encoded, { atomic: true });
        state.rewriteInFlight = undefined;
        state.storageFailure = undefined;
        state.recovery = undefined;
        state.knownLength = encoded.length;
        return true;
      } catch (error) {
        state.rewriteInFlight = undefined;
        if (options?.onError !== undefined) {
          options.onError(error);
          return false;
        }
        state.storageFailure = { error };
        throw error;
      }
    });
    await this.ownFlush(scope, key, state, rewrite, { value: false });
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

  drainRetirements(): Promise<void> {
    return drainAppendLogRetirements();
  }

  acquire(scope: string, key: string): IDisposable {
    const state = this.state(scope, key);
    state.refCount++;
    return toDisposable(() => {
      this.release(scope, key, state);
    });
  }

  externallyModified(scope: string, key: string): boolean {
    const state = this.logs.get(logId(scope, key));
    if (state?.recovery?.externallyModifiedAtStart === true) return true;
    const known = state?.knownLength;
    if (known === undefined) return false;
    const disk = this.diskLength(scope, key);
    if (disk === undefined) return false;
    if (state?.rewriteInFlight !== undefined && disk === state.rewriteInFlight) return false;
    const inFlight = state?.recovery?.encoded.length ?? state?.inFlightBytes ?? 0;
    return disk < known || disk > known + inFlight;
  }

  bindWriteGuard(scope: string, key: string, guard: () => boolean): IDisposable {
    const id = logId(scope, key);
    this.writeGuards.set(id, guard);
    return toDisposable(() => {
      if (this.writeGuards.get(id) === guard) this.writeGuards.delete(id);
    });
  }

  private writeAllowed(scope: string, key: string, state: LogState): boolean {
    const guard = this.writeGuards.get(logId(scope, key));
    if (guard === undefined || guard()) {
      state.guardWarned = false;
      return true;
    }
    if (!state.guardWarned) {
      state.guardWarned = true;
      console.warn(`[append-log] ${scope}/${key}: write guard declined; keeping writes in memory`);
    }
    return false;
  }

  private diskLength(scope: string, key: string): number | undefined {
    try {
      return this.storage.sizeSync(scope, key) ?? 0;
    } catch {
      return undefined;
    }
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
        recovery: undefined,
        failureWarned: false,
        stuckWatch: undefined,
        cutoverEpoch: 0,
        refCount: 0,
        retired: false,
        ready,
        retirement: undefined,
        knownLength: undefined,
        inFlightBytes: 0,
        rewriteInFlight: undefined,
        guardWarned: false,
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

  flushLog(scope: string, key: string): Promise<void> {
    const state = this.state(scope, key);
    return this.flushState(scope, key, state);
  }

  private flushState(scope: string, key: string, state: LogState): Promise<void> {
    if (state.flushPromise !== undefined) return state.flushPromise;
    if (state.storageFailure !== undefined) return Promise.reject(state.storageFailure.error);
    const wroteBox = { value: false };
    return this.ownFlush(scope, key, state, this.drain(scope, key, state, wroteBox), wroteBox);
  }

  private release(scope: string, key: string, state: LogState): void {
    state.refCount--;
    if (state.refCount > 0) return;
    state.retired = true;
    const retirement = this.settleRetiredState(scope, key, state).catch(() => undefined);
    state.retirement = retirement;
    pendingRetirements.add(retirement);
    void retirement.finally(() => pendingRetirements.delete(retirement));
  }

  private async settleRetiredState(scope: string, key: string, state: LogState): Promise<void> {
    try {
      await this.flushState(scope, key, state);
      if (state.pending.length > 0) {
        console.warn(
          `[append-log] ${scope}/${key}: dropping ${state.pending.length} unflushed record(s) on close; write guard declined`,
        );
      }
    } finally {
      const id = logId(scope, key);
      if (this.logs.get(id) === state) this.logs.delete(id);
    }
  }

  private ownFlush(
    scope: string,
    key: string,
    state: LogState,
    operation: Promise<boolean>,
    wroteBox: { value: boolean },
  ): Promise<void> {
    let owned!: Promise<void>;
    owned = this.finishOwnedFlush(scope, key, state, operation, wroteBox, () => owned);
    state.flushPromise = owned;
    this.watchStuckFlush(scope, key, state, owned);
    return owned;
  }

  private watchStuckFlush(scope: string, key: string, state: LogState, owned: Promise<void>): void {
    if (state.stuckWatch !== undefined) clearInterval(state.stuckWatch);
    const startedAt = Date.now();
    let lastWarnAt = 0;
    state.stuckWatch = setInterval(() => {
      if (state.flushPromise !== owned) {
        if (state.stuckWatch !== undefined) {
          clearInterval(state.stuckWatch);
          state.stuckWatch = undefined;
        }
        return;
      }
      const stuckMs = Date.now() - startedAt;
      if (stuckMs < STUCK_FLUSH_WARN_MS) return;
      if (Date.now() - lastWarnAt < STUCK_FLUSH_REPEAT_MS) return;
      lastWarnAt = Date.now();
      this.logger.warn('append log flush is stuck; records are accumulating in memory', {
        scope,
        key,
        pending: state.pending.length,
        stuckMs,
      });
    }, STUCK_FLUSH_CHECK_MS);
    state.stuckWatch.unref();
  }

  private async finishOwnedFlush(
    scope: string,
    key: string,
    state: LogState,
    operation: Promise<boolean>,
    wroteBox: { value: boolean },
    owner: () => Promise<void>,
  ): Promise<void> {
    let failure: { readonly error: unknown } | undefined;
    try {
      if (await operation) wroteBox.value = true;
      const owned = owner();
      if (state.flushPromise === owned) {
        while (state.flushPromise === owned && state.pending.length > 0) {
          if (!this.writeAllowed(scope, key, state)) break;
          await this.drain(scope, key, state, wroteBox);
        }
      }
    } catch (error) {
      failure ??= { error };
    } finally {
      const owned = owner();
      if (state.flushPromise === owned) {
        state.flushPromise = undefined;
        if (state.stuckWatch !== undefined) {
          clearInterval(state.stuckWatch);
          state.stuckWatch = undefined;
        }
      }
    }
    if (wroteBox.value) this.writeEmitter.fire({ scope, key });
    if (failure !== undefined) throw failure.error;
  }

  private async drain(
    scope: string,
    key: string,
    state: LogState,
    wroteBox?: { value: boolean },
  ): Promise<boolean> {
    const cutoverEpoch = state.cutoverEpoch;
    await state.ready;
    if (state.cutoverEpoch !== cutoverEpoch) return false;
    if (state.pending.length > 0 && !this.writeAllowed(scope, key, state)) return false;
    let wrote = false;
    while (state.pending.length > 0) {
      const recovery = state.recovery;
      const batch = recovery?.batch ?? state.pending.slice();
      const encoded = recovery?.encoded ?? encodeBatch(batch);
      const baseLength = recovery?.baseLength ?? this.diskLength(scope, key);
      let offset = 0;
      if (recovery !== undefined) {
        try {
          offset = await this.recoveryOffset(scope, key, recovery);
        } catch (error) {
          if (isStorageError(error, StorageErrors.codes.STORAGE_CORRUPTED)) {
            if (state.storageFailure === undefined) {
              state.storageFailure = { error };
              state.failureWarned = false;
            }
            throw state.storageFailure.error;
          }
          throw error;
        }
        if (state.cutoverEpoch !== cutoverEpoch) return wrote;
      }
      const externallyModifiedAtStart =
        recovery?.externallyModifiedAtStart ?? this.externallyModified(scope, key);
      try {
        state.inFlightBytes = encoded.length - offset;
        await this.storage.append(scope, key, encoded.subarray(offset), { durable: true });
        state.inFlightBytes = 0;
        state.recovery = undefined;
        wrote = true;
        if (state.knownLength !== undefined) state.knownLength += encoded.length;
        if (wroteBox !== undefined) wroteBox.value = true;
      } catch (error) {
        state.inFlightBytes = 0;
        if (baseLength === undefined) {
          if (state.storageFailure === undefined) {
            state.storageFailure = { error };
            state.failureWarned = false;
          }
          throw state.storageFailure.error;
        }
        state.recovery = { batch, encoded, baseLength, externallyModifiedAtStart };
        throw error;
      }
      if (state.cutoverEpoch !== cutoverEpoch) return wrote;
      state.pending.splice(0, batch.length);
    }
    return wrote;
  }

  private async recoveryOffset(scope: string, key: string, recovery: AppendRecovery): Promise<number> {
    const diskLength = (await this.storage.size(scope, key)) ?? 0;
    const suffixLength = diskLength - recovery.baseLength;
    if (suffixLength < 0 || suffixLength > recovery.encoded.length) {
      throw this.recoveryConflict(scope, key, recovery);
    }
    if (suffixLength === 0) return 0;
    let offset = 0;
    for await (const chunk of this.storage.readStream(scope, key, {
      start: recovery.baseLength,
      end: diskLength - 1,
    })) {
      for (const byte of chunk) {
        if (offset >= suffixLength || byte !== recovery.encoded[offset]) {
          throw this.recoveryConflict(scope, key, recovery);
        }
        offset++;
      }
    }
    if (offset !== suffixLength) throw this.recoveryConflict(scope, key, recovery);
    return suffixLength;
  }

  private recoveryConflict(scope: string, key: string, recovery: AppendRecovery): StorageError {
    return new StorageError(
      StorageErrors.codes.STORAGE_CORRUPTED,
      `append-log ${scope}/${key}: unexpected content during append recovery`,
      { details: { scope, key, baseLength: recovery.baseLength } },
    );
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
  ScopeActivation.OnScopeCreated,
  'storage',
);
