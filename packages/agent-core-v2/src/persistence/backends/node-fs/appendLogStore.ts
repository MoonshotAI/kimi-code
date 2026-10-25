import { createHash, type Hash } from 'node:crypto';

import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { ISessionLockService } from '#/persistence/interface/sessionLock';

import {
  IFileSystemStorageService,
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

const RECOVERY_BASE_DELAY_MS = 1_000;
const RECOVERY_MAX_DELAY_MS = 30_000;
const NEWLINE = 0x0a;

interface RecoveryState {
  readonly failure:
    | { readonly kind: 'beforeAppend'; readonly failedAtSize: number | undefined }
    | {
        readonly kind: 'append';
        readonly encoded: Uint8Array;
        readonly recordCount: number;
        readonly failedAtSize: number;
        readonly knownAtSize: number | undefined;
      };
  attempts: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function isRecoverableStorageError(error: unknown): boolean {
  return (
    error instanceof StorageError &&
    (error.code === StorageErrors.codes.STORAGE_DISK_FULL ||
      (StorageErrors.retryable as readonly string[]).includes(error.code))
  );
}

const pendingRetirements = new Set<Promise<void>>();

export async function drainAppendLogRetirements(): Promise<void> {
  while (pendingRetirements.size > 0) {
    await Promise.all(pendingRetirements);
  }
}

interface LogState {
  pending: unknown[];
  pendingVersion: number;
  flushPromise: Promise<void> | undefined;
  flushScheduled: boolean;
  storageFailure: { readonly error: unknown } | undefined;
  recovery: RecoveryState | undefined;
  recoveryPrefix: { readonly length: number; readonly hash: Hash; readonly observedLength: number } | undefined;
  recoveryPromise: Promise<void> | undefined;
  failureWarned: boolean;
  stuckWatch: NodeJS.Timeout | undefined;
  cutoverEpoch: number;
  refCount: number;
  retired: boolean;
  retirementGuard: (() => boolean | IDisposable) | undefined;
  writeLease: IDisposable | undefined;
  closeSettled: boolean;
  ready: Promise<void>;
  retirement: Promise<void> | undefined;
  settlementPromise: Promise<void> | undefined;
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
  private recoveryStopped = false;
  private disposed = false;
  private disposalPromise: Promise<void> | undefined;
  private closingPromise: Promise<void> | undefined;
  private readonly writeGuards = new Map<string, () => boolean | IDisposable>();
  private readonly writeEmitter = this._register(new Emitter<AppendLogWrite>());
  readonly onDidWrite: Event<AppendLogWrite> = this.writeEmitter.event;
  private readonly recoverEmitter = this._register(new Emitter<AppendLogWrite>());
  readonly onDidRecover: Event<AppendLogWrite> = this.recoverEmitter.event;

  constructor(
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @ILogService private readonly logger: ILogService,
    @ISessionLockService _sessionLockLifetime: ISessionLockService,
  ) {
    super();
  }

  // oxlint-disable-next-line typescript-eslint/no-misused-promises
  override dispose(): Promise<void> {
    if (this.disposed) return this.disposalPromise ?? Promise.resolve();
    this.disposed = true;
    this.recoveryStopped = true;
    super.dispose();
    for (const [id, state] of this.logs) {
      const { scope, key } = fromLogId(id);
      this.retire(scope, key, state);
    }
    this.disposalPromise = this.drainRetirements();
    return this.disposalPromise;
  }

  append<R>(scope: string, key: string, record: R, options?: AppendLogOptions): void {
    const state = this.state(scope, key);
    state.closeSettled = false;
    state.pending.push(record);
    state.pendingVersion++;
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
    state.closeSettled = false;
    state.pendingVersion++;
    state.cutoverEpoch++;
    this.cancelRecovery(state);
    const prior = state.flushPromise ?? state.ready;
    const priorSettled = prior.then(
      () => undefined,
      () => undefined,
    );
    let handledWriteFailure = false;
    const rewrite = priorSettled.then(async () => {
      try {
        if (!this.writeAllowed(scope, key, state)) {
          throw new StorageError(
            StorageErrors.codes.STORAGE_LOCKED,
            'append-log rewrite deferred: write guard declined',
            { details: { scope, key } },
          );
        }
        state.inFlightBytes = 0;
        state.rewriteInFlight = encoded.length;
        await this.storage.write(scope, key, encoded, { atomic: true });
        state.rewriteInFlight = undefined;
        state.storageFailure = undefined;
        state.knownLength = encoded.length;
        return true;
      } catch (error) {
        state.storageFailure = { error };
        state.rewriteInFlight = undefined;
        if (options?.onError !== undefined) {
          options.onError(error);
          handledWriteFailure = true;
        }
        throw error;
      }
    });
    try {
      await this.ownFlush(scope, key, state, rewrite, { value: false });
    } catch (error) {
      if (!handledWriteFailure) throw error;
    }
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

  close(): Promise<void> {
    this.recoveryStopped = true;
    if (this.closingPromise !== undefined) return this.closingPromise;
    const closing = this.settleLogs().finally(() => {
      if (this.closingPromise === closing) this.closingPromise = undefined;
    });
    this.closingPromise = closing;
    return closing;
  }

  private async settleLogs(): Promise<void> {
    const seen = new Map<LogState, number>();
    const failures = new Map<LogState, unknown>();
    while (true) {
      const work = [...this.logs].filter(([, state]) =>
        seen.get(state) !== state.pendingVersion ||
        state.flushPromise !== undefined ||
        state.recoveryPromise !== undefined,
      );
      if (work.length === 0) break;
      await Promise.all(work.map(async ([id, state]) => {
        seen.set(state, state.pendingVersion);
        const { scope, key } = fromLogId(id);
        try {
          await this.settleLog(scope, key, state);
          failures.delete(state);
        } catch (error) {
          failures.set(state, error);
        }
      }));
    }
    for (const state of this.logs.values()) state.closeSettled = true;
    for (const error of failures.values()) {
      throw error;
    }
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
    const known = state?.knownLength;
    if (known === undefined) return false;
    const disk = this.diskLength(scope, key);
    if (disk === undefined) return false;
    if (state?.rewriteInFlight !== undefined && disk === state.rewriteInFlight) return false;
    return disk < known || disk > known + (state?.inFlightBytes ?? 0);
  }

  bindWriteGuard(scope: string, key: string, guard: () => boolean | IDisposable): IDisposable {
    const id = logId(scope, key);
    this.writeGuards.set(id, guard);
    return toDisposable(() => {
      if (this.writeGuards.get(id) === guard) this.writeGuards.delete(id);
    });
  }

  private writeAllowed(scope: string, key: string, state: LogState): boolean {
    if (state.writeLease !== undefined) return true;
    const guard = state.retired ? state.retirementGuard : this.writeGuards.get(logId(scope, key));
    const allowed = guard?.() ?? true;
    if (allowed !== false) {
      if (allowed !== true) state.writeLease = allowed;
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
    if (this.disposed) throw new Error('Append log store is disposed');
    const id = logId(scope, key);
    let state = this.logs.get(id);
    if (state === undefined || state.retired) {
      const ready = state?.retirement ?? Promise.resolve();
      state = {
        pending: [],
        pendingVersion: 0,
        flushPromise: undefined,
        flushScheduled: false,
        storageFailure: undefined,
        recovery: undefined,
        recoveryPrefix: undefined,
        recoveryPromise: undefined,
        failureWarned: false,
        stuckWatch: undefined,
        cutoverEpoch: 0,
        refCount: 0,
        retired: false,
        retirementGuard: undefined,
        writeLease: undefined,
        closeSettled: false,
        ready,
        retirement: undefined,
        settlementPromise: undefined,
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
    if (this.disposed || state.retired) return;
    if (state.flushScheduled || state.flushPromise !== undefined) return;
    if (state.storageFailure !== undefined) return;
    state.flushScheduled = true;
    queueMicrotask(() => {
      state.flushScheduled = false;
      if (this.disposed || state.retired) {
        void state.flushPromise?.catch((error) => state.onError?.(error));
        return;
      }
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
    this.retire(scope, key, state);
  }

  private retire(scope: string, key: string, state: LogState): void {
    if (state.retired) return;
    state.retirementGuard = this.writeGuards.get(logId(scope, key));
    state.retired = true;
    const retirement = this.settleRetiredState(scope, key, state).catch(() => undefined);
    state.retirement = retirement;
    pendingRetirements.add(retirement);
    void retirement.finally(() => pendingRetirements.delete(retirement));
  }

  private async settleRetiredState(scope: string, key: string, state: LogState): Promise<void> {
    try {
      if (
        !state.closeSettled ||
        state.flushPromise !== undefined ||
        state.recoveryPromise !== undefined ||
        state.settlementPromise !== undefined
      ) {
        await this.settleLog(scope, key, state);
      }
      if (state.pending.length > 0 && state.guardWarned) {
        console.warn(
          `[append-log] ${scope}/${key}: dropping ${state.pending.length} unflushed record(s) on close; write guard declined`,
        );
      }
    } finally {
      const id = logId(scope, key);
      if (this.logs.get(id) === state) this.logs.delete(id);
    }
  }

  private settleLog(scope: string, key: string, state: LogState): Promise<void> {
    if (state.settlementPromise !== undefined) return state.settlementPromise;
    const settlement = this.finishSettlement(scope, key, state).finally(() => {
      if (state.settlementPromise === settlement) state.settlementPromise = undefined;
    });
    state.settlementPromise = settlement;
    return settlement;
  }

  private async finishSettlement(scope: string, key: string, state: LogState): Promise<void> {
    if (state.recovery?.timer !== undefined) clearTimeout(state.recovery.timer);
    if (state.recovery !== undefined) state.recovery.timer = undefined;
    await this.flushState(scope, key, state).catch(() => undefined);
    while (state.flushPromise !== undefined || state.recoveryPromise !== undefined) {
      await (state.recoveryPromise ?? state.flushPromise)?.catch(() => undefined);
    }
    if (state.recovery !== undefined) {
      if (state.recovery.timer !== undefined) clearTimeout(state.recovery.timer);
      state.recovery.timer = undefined;
      await this.attemptRecovery(scope, key, state);
    }
    await this.flushState(scope, key, state);
  }

  private cancelRecovery(state: LogState): void {
    if (state.recovery?.timer !== undefined) clearTimeout(state.recovery.timer);
    state.recovery = undefined;
    state.recoveryPrefix = undefined;
  }

  private scheduleRecovery(scope: string, key: string, state: LogState): void {
    const recovery = state.recovery;
    if (this.recoveryStopped || recovery === undefined || state.retired || recovery.timer !== undefined) return;
    const delay = Math.min(RECOVERY_BASE_DELAY_MS * 2 ** recovery.attempts, RECOVERY_MAX_DELAY_MS);
    recovery.timer = setTimeout(() => {
      recovery.timer = undefined;
      if (this.recoveryStopped || state.retired) return;
      void this.attemptRecovery(scope, key, state);
    }, delay);
    recovery.timer.unref();
  }

  private attemptRecovery(scope: string, key: string, state: LogState): Promise<void> {
    if (state.recoveryPromise !== undefined) return state.recoveryPromise;
    const owned = this.recoverLog(scope, key, state).finally(() => {
      if (state.recoveryPromise === owned) state.recoveryPromise = undefined;
    });
    state.recoveryPromise = owned;
    return owned;
  }

  private async recoverLog(scope: string, key: string, state: LogState): Promise<void> {
    const recovery = state.recovery;
    if (recovery === undefined) return;
    const epoch = state.cutoverEpoch;
    state.recovery = undefined;
    let guardDeclined = false;
    try {
      if (state.flushPromise !== undefined) {
        await state.flushPromise.catch(() => undefined);
      }
      if (state.cutoverEpoch !== epoch) return;
      const storageFailure = state.storageFailure;
      if (storageFailure === undefined) return;
      if (state.recovery !== undefined) return;
      if (state.flushPromise !== undefined) {
        state.recovery = recovery;
        this.scheduleRecovery(scope, key, state);
        return;
      }
      await this.ownFlush(
        scope,
        key,
        state,
        Promise.resolve().then(() => {
          if (state.cutoverEpoch !== epoch) return false;
          const allowed = this.writeAllowed(scope, key, state);
          if (state.cutoverEpoch !== epoch) return false;
          if (!allowed) {
            guardDeclined = true;
            throw storageFailure.error;
          }
          return this.reconcileCommittedTail(scope, key, state, recovery);
        }),
        { value: false },
      );
      if (state.cutoverEpoch !== epoch) return;
      if (state.pending.length > 0) {
        state.recovery = {
          failure: { kind: 'beforeAppend', failedAtSize: state.recoveryPrefix?.length ?? state.knownLength },
          attempts: recovery.attempts,
          timer: undefined,
        };
        this.scheduleRecovery(scope, key, state);
        return;
      }
      state.storageFailure = undefined;
      state.recoveryPrefix = undefined;
      this.recoverEmitter.fire({ scope, key });
      if (state.pending.length > 0) this.scheduleFlush(scope, key, state);
    } catch (error) {
      if (state.cutoverEpoch !== epoch) return;
      if (guardDeclined) {
        state.recovery = recovery;
        this.scheduleRecovery(scope, key, state);
        return;
      }
      state.storageFailure = { error };
      if (state.recovery !== undefined) {
        state.recovery.attempts = recovery.attempts + 1;
        if (state.recovery.timer !== undefined) clearTimeout(state.recovery.timer);
        state.recovery.timer = undefined;
        this.scheduleRecovery(scope, key, state);
        return;
      }
      if (isRecoverableStorageError(error)) {
        state.recovery = recovery;
        recovery.attempts++;
        this.scheduleRecovery(scope, key, state);
      } else {
        this.logger.warn('automatic append-log recovery stopped; buffered records remain in memory', {
          scope,
          key,
          pending: state.pending.length,
          error,
        });
      }
    }
  }

  private async reconcileCommittedTail(
    scope: string,
    key: string,
    state: LogState,
    recovery: RecoveryState,
  ): Promise<boolean> {
    const failure = recovery.failure;
    const epoch = state.cutoverEpoch;
    const guard = state.retired ? state.retirementGuard : this.writeGuards.get(logId(scope, key));
    const prefix = state.recoveryPrefix;
    if (guard !== undefined) {
      if (prefix === undefined || prefix.length !== failure.failedAtSize) {
        throw new StorageError(
          StorageErrors.codes.STORAGE_CORRUPTED,
          'append-log recovery aborted: trusted failure-time prefix or end evidence is unavailable',
          { details: { scope, key } },
        );
      }
      const current = await this.hashPrefix(scope, key, prefix.length);
      if (state.cutoverEpoch !== epoch) return false;
      if (current.copy().digest('hex') !== prefix.hash.copy().digest('hex')) {
        throw new StorageError(
          StorageErrors.codes.STORAGE_CORRUPTED,
          'append-log recovery aborted: original prefix was modified',
          { details: { scope, key } },
        );
      }
    }
    if (failure.kind === 'beforeAppend') {
      if (guard === undefined) return false;
      const size = await this.storage.size(scope, key);
      if (state.cutoverEpoch !== epoch) return false;
      if (failure.failedAtSize === undefined || (size ?? 0) !== failure.failedAtSize) {
        throw new StorageError(
          StorageErrors.codes.STORAGE_CORRUPTED,
          'append-log recovery aborted: guarded log has no unchanged confirmed boundary',
          { details: { scope, key } },
        );
      }
      return false;
    }
    const encoded = failure.encoded;
    if (encoded.byteLength === 0) return false;
    const boundary = failure.failedAtSize;
    const size = await this.storage.size(scope, key);
    if (state.cutoverEpoch !== epoch) return false;
    if ((size ?? 0) < boundary) {
      throw new StorageError(
        StorageErrors.codes.STORAGE_CORRUPTED,
        'append-log recovery aborted: log shrank while reconciling',
        { details: { scope, key } },
      );
    }
    if (size === undefined || size === boundary) {
      if (size !== undefined && size > 0) {
        let lastByte = 0;
        for await (const chunk of this.storage.readStream(scope, key, {
          start: size - 1,
          end: size - 1,
        })) {
          lastByte = chunk[chunk.byteLength - 1] ?? 0;
        }
        if (lastByte !== NEWLINE) {
          throw new StorageError(
            StorageErrors.codes.STORAGE_CORRUPTED,
            'append-log tail does not match the failed batch; automatic recovery aborted',
            { details: { scope, key } },
          );
        }
      }
    }
    if (prefix !== undefined && (size ?? 0) !== prefix.observedLength) {
      throw new StorageError(
        StorageErrors.codes.STORAGE_CORRUPTED,
        'append-log recovery aborted: observed failed append length changed',
        { details: { scope, key } },
      );
    }
    const committed = (size ?? 0) - boundary;
    if (committed > encoded.byteLength) {
      throw new StorageError(
        StorageErrors.codes.STORAGE_CORRUPTED,
        'append-log recovery aborted: log grew past the failed batch',
        { details: { scope, key } },
      );
    }
    const tail = new Uint8Array(committed);
    let offset = 0;
    if (committed > 0) {
      for await (const chunk of this.storage.readStream(scope, key, {
        start: boundary,
        end: boundary + committed - 1,
      })) {
        tail.set(chunk.subarray(0, Math.min(chunk.byteLength, committed - offset)), offset);
        offset += chunk.byteLength;
      }
    }
    if (state.cutoverEpoch !== epoch) return false;
    if (offset !== committed || !bytesEqual(tail, encoded.subarray(0, committed))) {
      throw new StorageError(
        StorageErrors.codes.STORAGE_CORRUPTED,
        'append-log tail does not match the failed batch; automatic recovery aborted',
        { details: { scope, key } },
      );
    }
    const allowed = this.writeAllowed(scope, key, state);
    if (state.cutoverEpoch !== epoch) return false;
    if (!allowed) {
      throw new StorageError(
        StorageErrors.codes.STORAGE_LOCKED,
        'append-log recovery deferred: write guard declined',
        { details: { scope, key } },
      );
    }
    const remaining = encoded.subarray(committed);
    state.inFlightBytes = remaining.byteLength;
    try {
      await this.storage.append(scope, key, remaining, { durable: true });
    } catch (error) {
      let sizeAfter: number | undefined;
      if (state.cutoverEpoch === epoch && state.knownLength !== undefined) {
        sizeAfter = this.diskLength(scope, key);
        if (sizeAfter !== undefined) {
          state.knownLength += Math.min(remaining.byteLength, Math.max(0, sizeAfter - (size ?? 0)));
        }
      }
      if (state.cutoverEpoch === epoch && prefix !== undefined) {
        try {
          const observedLength = sizeAfter ?? (await this.storage.size(scope, key)) ?? 0;
          if (state.cutoverEpoch === epoch) {
            state.recoveryPrefix = observedLength >= (size ?? 0) && observedLength <= boundary + encoded.byteLength
              ? { ...prefix, observedLength }
              : undefined;
          }
        } catch {
          if (state.cutoverEpoch === epoch) state.recoveryPrefix = undefined;
        }
      }
      throw error;
    } finally {
      state.inFlightBytes = 0;
    }
    if (state.cutoverEpoch === epoch) {
      if (prefix !== undefined) {
        state.recoveryPrefix = {
          length: prefix.length + encoded.byteLength,
          hash: prefix.hash.copy().update(encoded),
          observedLength: boundary + encoded.byteLength,
        };
      }
      state.knownLength = failure.knownAtSize === undefined
        ? undefined
        : failure.knownAtSize + encoded.byteLength;
      state.pending.splice(0, failure.recordCount);
    }
    return true;
  }

  private async hashPrefix(scope: string, key: string, length: number): Promise<Hash> {
    const hash = createHash('sha256');
    let read = 0;
    if (length > 0) {
      for await (const chunk of this.storage.readStream(scope, key, { start: 0, end: length - 1 })) {
        read += chunk.byteLength;
        if (read > length) break;
        hash.update(chunk);
      }
    }
    if (read !== length) {
      throw new StorageError(
        StorageErrors.codes.STORAGE_CORRUPTED,
        'append-log recovery aborted: original prefix length could not be verified',
        { details: { scope, key } },
      );
    }
    return hash;
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
          if (state.flushPromise !== owned) break;
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
        const lease = state.writeLease;
        state.writeLease = undefined;
        lease?.dispose();
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
      const batch = state.pending.slice();
      const encoded = encodeBatch(batch);
      let failure: RecoveryState['failure'] = {
        kind: 'beforeAppend',
        failedAtSize: state.recoveryPrefix?.length ?? state.knownLength,
      };
      try {
        const sizeBefore = await this.storage.size(scope, key);
        if (state.cutoverEpoch !== cutoverEpoch) return wrote;
        if (!this.writeAllowed(scope, key, state)) return wrote;
        if (state.cutoverEpoch !== cutoverEpoch) return wrote;
        failure = {
          kind: 'append',
          encoded,
          recordCount: batch.length,
          failedAtSize: sizeBefore ?? 0,
          knownAtSize: state.knownLength,
        };
        state.inFlightBytes = encoded.length;
        await this.storage.append(scope, key, encoded, { durable: true });
        state.inFlightBytes = 0;
        wrote = true;
        if (state.cutoverEpoch === cutoverEpoch && state.knownLength !== undefined) {
          state.knownLength += encoded.length;
        }
        if (state.cutoverEpoch === cutoverEpoch && state.recoveryPrefix !== undefined) {
          state.recoveryPrefix = {
            length: state.recoveryPrefix.length + encoded.byteLength,
            hash: state.recoveryPrefix.hash.copy().update(encoded),
            observedLength: state.recoveryPrefix.length + encoded.byteLength,
          };
        }
        if (wroteBox !== undefined) wroteBox.value = true;
      } catch (error) {
        state.inFlightBytes = 0;
        let sizeAfter: number | undefined;
        if (failure.kind === 'append' && state.cutoverEpoch === cutoverEpoch && state.knownLength !== undefined) {
          sizeAfter = this.diskLength(scope, key);
          if (sizeAfter !== undefined) {
            state.knownLength += Math.min(encoded.length, Math.max(0, sizeAfter - failure.failedAtSize));
          }
        }
        if (state.storageFailure === undefined) state.failureWarned = false;
        state.storageFailure = { error };
        if (
          state.cutoverEpoch === cutoverEpoch &&
          state.recovery === undefined &&
          isRecoverableStorageError(error)
        ) {
          state.recoveryPrefix = undefined;
          const guard = state.retired ? state.retirementGuard : this.writeGuards.get(logId(scope, key));
          if (guard !== undefined && failure.failedAtSize !== undefined) {
            try {
              const observedLength = failure.kind === 'append'
                ? sizeAfter ?? (await this.storage.size(scope, key)) ?? 0
                : failure.failedAtSize;
              if (state.cutoverEpoch === cutoverEpoch) {
                const hash = await this.hashPrefix(scope, key, failure.failedAtSize);
                if (state.cutoverEpoch === cutoverEpoch) {
                  state.recoveryPrefix = { length: failure.failedAtSize, hash, observedLength };
                }
              }
            } catch {}
          }
          if (state.cutoverEpoch !== cutoverEpoch) throw error;
          state.recovery = {
            failure,
            attempts: 0,
            timer: undefined,
          };
          this.scheduleRecovery(scope, key, state);
        }
        throw error;
      }
      if (state.cutoverEpoch !== cutoverEpoch) return wrote;
      state.pending.splice(0, batch.length);
    }
    return wrote;
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

registerScopedService(
  LifecycleScope.App,
  IAppendLogStore,
  AppendLogStore,
  ScopeActivation.OnScopeCreated,
  'storage',
);
