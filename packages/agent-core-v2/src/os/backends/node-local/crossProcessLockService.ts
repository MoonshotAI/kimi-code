/**
 * `crossProcessLock` domain (L1) — `ICrossProcessLockService` implementation.
 *
 * Node-local backend for the cross-process exclusive file-lock protocol
 * defined by `os/interface/crossProcessLock`. Filesystem mutations are short
 * synchronous bursts; contender settlement is asynchronous so a delayed
 * process never forces the event loop to spin while another attempt exits.
 * Process probing goes through `createNodeProcessProbe`; every clock, pid,
 * probe and token source is injectable for tests.
 *
 * Protocol invariants implemented here:
 *
 * - Token-guarded: acquire stamps a fresh ulid `lockId`; release, heartbeat
 *   and payload rewrites re-read the file and compare it before touching the
 *   lock, so a late operation never clobbers a newer holder.
 * - Live PID is never taken over. Only pid death, or a live pid whose
 *   `processStartedAt` identity no longer matches (pid reused), makes a lock
 *   stale; a live identity-matching holder whose heartbeat is past ttl is
 *   `holder-unresponsive` — reported, never seized. An identity that either
 *   side cannot provide counts as matching (conservative).
 * - Each attempt publishes a unique sidecar intent before inspecting the lock.
 *   A creator confirms its token, snapshots the foreign intents already
 *   present, and waits for that finite set to settle before returning. A
 *   delayed stale observer therefore either sees the new live generation and
 *   backs off, or steals it before settlement and causes the creator to fail
 *   rather than double-return; contenders arriving after the snapshot cannot
 *   starve the creator because they can only observe the new generation.
 * - Creation window: an empty/unparseable file younger than
 *   `creationWindowMs` (default 5s) is `creating` (treated as held); past the
 *   window it is stale.
 * - The winning create fd stays open for every handle. Heartbeat and updates
 *   write only through that fd — never tmp+rename or path re-open — so a frozen
 *   old holder cannot overwrite a successor after losing the public path.
 *
 * Bound at App scope.
 */

import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { ulid } from 'ulid';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  CrossProcessLockError,
  CrossProcessLockErrorCode,
  type CrossProcessLockAcquireOptions,
  type CrossProcessLockHeartbeatOptions,
  type CrossProcessLockInspection,
  type CrossProcessLockPayload,
  type CrossProcessLockServiceDeps,
  type CrossProcessLockUnavailableReason,
  type CrossProcessLockWaitOptions,
  type ICrossProcessLockHandle,
  ICrossProcessLockService,
  type ProcessProbe,
} from '#/os/interface/crossProcessLock';

import { createNodeProcessProbe } from './processProbe';

const DEFAULT_CREATION_WINDOW_MS = 5_000;
const DEFAULT_WAIT_RETRY_INTERVAL_MS = 50;
const DEFAULT_SETTLE_RETRY_INTERVAL_MS = 10;
const MAX_ACQUIRE_ATTEMPTS = 3;

function readErrno(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toLockIoError(error: unknown, ctx: { path: string; op: string }): CrossProcessLockError {
  if (error instanceof CrossProcessLockError) return error;
  return new CrossProcessLockError(
    CrossProcessLockErrorCode.Io,
    `${ctx.op} failed on lock file: ${errorMessage(error)}`,
    { details: { path: ctx.path, op: ctx.op, errno: readErrno(error) }, cause: error },
  );
}

function heldError(
  lockPath: string,
  reason: CrossProcessLockUnavailableReason,
  holder: CrossProcessLockPayload | undefined,
): CrossProcessLockError {
  const summary = holder
    ? `pid=${holder.pid} instanceId=${holder.instanceId} address=${holder.address ?? '-'} heartbeatAt=${holder.heartbeatAt ?? '-'}`
    : 'holder unknown';
  return new CrossProcessLockError(
    CrossProcessLockErrorCode.Held,
    `cross-process lock unavailable (${reason}): ${summary}`,
    { details: { path: lockPath, reason, holder } },
  );
}

function lostError(lockPath: string, what: string): CrossProcessLockError {
  return new CrossProcessLockError(
    CrossProcessLockErrorCode.Lost,
    `lock ownership lost while ${what}`,
    { details: { path: lockPath } },
  );
}

interface DiskLockPayload {
  lock_id?: string;
  instance_id?: string;
  pid?: number;
  process_started_at?: string;
  address?: string;
  heartbeat_at?: number;
  [extra: string]: unknown;
}

interface DiskIntentPayload {
  intent_id?: string;
  state?: 'active' | 'settled';
  pid?: number;
  process_started_at?: string;
}

interface RegisteredIntent {
  readonly path: string;
  readonly token: string;
  readonly fd: number;
}

function renderPayloadJson(payload: CrossProcessLockPayload): string {
  const { lockId, instanceId, pid, processStartedAt, address, heartbeatAt, ...extras } = payload;
  const disk: DiskLockPayload = {
    ...extras,
    lock_id: lockId,
    instance_id: instanceId,
    pid,
  };
  if (processStartedAt !== undefined) disk.process_started_at = processStartedAt;
  if (address !== undefined) disk.address = address;
  if (heartbeatAt !== undefined) disk.heartbeat_at = heartbeatAt;
  return JSON.stringify(disk);
}

function parseDiskPayload(raw: string): CrossProcessLockPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const disk = parsed as DiskLockPayload;
  const hasLockId = typeof disk.lock_id === 'string';
  const hasPid = typeof disk.pid === 'number';
  if (!hasLockId && !hasPid) return undefined;
  const { lock_id, instance_id, pid, process_started_at, address, heartbeat_at, ...extras } = disk;
  const payload: CrossProcessLockPayload = {
    ...extras,
    lockId: lock_id ?? '',
    instanceId: typeof instance_id === 'string' ? instance_id : '',
    pid: typeof pid === 'number' ? pid : -1,
  };
  if (typeof process_started_at === 'string') payload.processStartedAt = process_started_at;
  if (typeof address === 'string') payload.address = address;
  if (typeof heartbeat_at === 'number') payload.heartbeatAt = heartbeat_at;
  return payload;
}

function readPayloadFromPath(lockPath: string): CrossProcessLockPayload | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return undefined;
  }
  return parseDiskPayload(raw);
}

function extractExtras(payload: CrossProcessLockPayload): Record<string, unknown> {
  const {
    lockId: _lockId,
    instanceId: _instanceId,
    pid: _pid,
    processStartedAt: _processStartedAt,
    address,
    heartbeatAt: _heartbeatAt,
    ...rest
  } = payload;
  const extras: DiskLockPayload = rest;
  if (address !== undefined) extras.address = address;
  return extras;
}

function isProbingPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

class NodeCrossProcessLockHandle implements ICrossProcessLockHandle {
  private _released = false;
  private _lostNotified = false;
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _fd: number;
  private _extras: Record<string, unknown>;

  constructor(
    readonly lockPath: string,
    readonly lockId: string,
    private readonly now: () => number,
    private readonly selfPid: number,
    private readonly instanceId: string,
    private readonly selfProcessStartedAt: string | undefined,
    extras: Record<string, unknown>,
    private readonly heartbeat: CrossProcessLockHeartbeatOptions | undefined,
    private readonly onLost: (() => void) | undefined,
    fd: number,
  ) {
    this._extras = extras;
    this._fd = fd;
  }

  checkHeld(): boolean {
    return readPayloadFromPath(this.lockPath)?.lockId === this.lockId;
  }

  update(mutate: (payload: CrossProcessLockPayload) => Record<string, unknown>): void {
    const current = readPayloadFromPath(this.lockPath);
    if (current?.lockId !== this.lockId) {
      throw lostError(this.lockPath, 'updating the payload');
    }
    const merged: CrossProcessLockPayload = {
      ...current,
      ...mutate(current),
      lockId: this.lockId,
      instanceId: this.instanceId,
      pid: this.selfPid,
    };
    this._extras = extractExtras(merged);
    try {
      this.writePayload();
    } catch (error) {
      if (readErrno(error) === 'ENOENT') throw lostError(this.lockPath, 'updating the payload');
      throw toLockIoError(error, { path: this.lockPath, op: 'update' });
    }
    if (readPayloadFromPath(this.lockPath)?.lockId !== this.lockId) {
      throw lostError(this.lockPath, 'confirming the updated payload');
    }
  }

  release(): void {
    if (this._released) return;
    this._released = true;
    this.stopHeartbeat();
    this.closeFd();
    try {
      if (readPayloadFromPath(this.lockPath)?.lockId === this.lockId) {
        unlinkSync(this.lockPath);
      }
    } catch {
      // best-effort: a release failure must never delete a foreign lock.
    }
  }

  startHeartbeat(): void {
    if (this.heartbeat === undefined) return;
    this._timer = setInterval(() => {
      this.tick();
    }, this.heartbeat.intervalMs);
    this._timer.unref();
  }

  writeInitialPayload(): void {
    this.writePayload();
  }

  private tick(): void {
    if (this._released || this._fd < 0) return;
    try {
      this.writePayload();
    } catch {
      this.handleLost();
      return;
    }
    if (readPayloadFromPath(this.lockPath)?.lockId !== this.lockId) {
      this.handleLost();
    }
  }

  private handleLost(): void {
    this.stopHeartbeat();
    this.closeFd();
    if (this._lostNotified) return;
    this._lostNotified = true;
    this.onLost?.();
  }

  private writePayload(): void {
    const payload: CrossProcessLockPayload = {
      ...this._extras,
      lockId: this.lockId,
      instanceId: this.instanceId,
      pid: this.selfPid,
      processStartedAt: this.selfProcessStartedAt,
      heartbeatAt: this.heartbeat !== undefined ? this.now() : undefined,
    };
    const data = Buffer.from(renderPayloadJson(payload), 'utf8');
    if (this._fd >= 0) {
      writeSync(this._fd, data, 0, data.length, 0);
      ftruncateSync(this._fd, data.length);
      fsyncSync(this._fd);
      return;
    }
    throw lostError(this.lockPath, 'writing the payload');
  }

  private stopHeartbeat(): void {
    if (this._timer === undefined) return;
    clearInterval(this._timer);
    this._timer = undefined;
  }

  private closeFd(): void {
    if (this._fd < 0) return;
    try {
      closeSync(this._fd);
    } catch {
      // fd already closed elsewhere; nothing to do.
    }
    this._fd = -1;
  }
}

export class CrossProcessLockService implements ICrossProcessLockService {
  declare readonly _serviceBrand: undefined;

  private readonly now: () => number;
  private readonly selfPid: number;
  private readonly probe: ProcessProbe;
  private readonly newLockId: () => string;
  private readonly newAttemptId: () => string;
  private readonly instanceId: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly beforeStaleIsolation: (() => void | Promise<void>) | undefined;

  constructor(deps: CrossProcessLockServiceDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.selfPid = deps.selfPid ?? process.pid;
    this.probe = deps.probeProcess ?? createNodeProcessProbe();
    this.newLockId = deps.newLockId ?? ulid;
    this.newAttemptId = deps.newAttemptId ?? ulid;
    this.instanceId = deps.instanceId ?? ulid();
    this.beforeStaleIsolation = deps.beforeStaleIsolation;
    this.sleep =
      deps.sleep ??
      ((ms) =>
        new Promise<void>((resolvePromise) => {
          const timer = setTimeout(resolvePromise, ms);
          timer.unref();
        }));
  }

  async acquire(
    lockPath: string,
    options: CrossProcessLockAcquireOptions = {},
  ): Promise<ICrossProcessLockHandle> {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
    } catch (error) {
      throw toLockIoError(error, { path: lockPath, op: 'mkdir' });
    }
    const creationWindowMs = options.creationWindowMs ?? DEFAULT_CREATION_WINDOW_MS;
    const observedTtlMs = options.heartbeat?.ttlMs ?? creationWindowMs;
    const intent = this.registerIntent(lockPath);
    let acquiredHandle: ICrossProcessLockHandle | undefined;
    let primaryError: unknown;
    let hasPrimaryError = false;
    try {
      let lastHolder: CrossProcessLockPayload | undefined;
      for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
        let fd: number;
        try {
          fd = openSync(lockPath, 'wx', 0o600);
        } catch (error) {
          if (readErrno(error) !== 'EEXIST') {
            throw toLockIoError(error, { path: lockPath, op: 'open' });
          }
          const inspection = this.classify(lockPath, creationWindowMs);
          lastHolder = inspection.payload;
          switch (inspection.state) {
            case 'free':
              continue;
            case 'creating':
              throw heldError(lockPath, 'creating', undefined);
            case 'held':
              throw heldError(
                lockPath,
                this.reasonForHeld(inspection.payload, observedTtlMs),
                inspection.payload,
              );
            case 'stale':
              if (!(await this.isolateStale(lockPath, inspection, creationWindowMs, intent.path))) {
                continue;
              }
              continue;
          }
        }
        const handle = this.completeAcquire(lockPath, fd, options);
        try {
          await this.settleAcquire(handle, intent.path, creationWindowMs);
          acquiredHandle = handle;
          break;
        } catch (error) {
          handle.release();
          throw error;
        }
      }
      if (acquiredHandle === undefined) throw heldError(lockPath, 'held', lastHolder);
    } catch (error) {
      hasPrimaryError = true;
      primaryError = error;
    }
    let cleanupError: unknown;
    let hasCleanupError = false;
    try {
      try {
        this.markIntentSettled(intent);
      } catch (error) {
        hasCleanupError = true;
        cleanupError = error;
      }
      try {
        this.removeIntent(intent);
      } catch (error) {
        if (!hasCleanupError) {
          hasCleanupError = true;
          cleanupError = error;
        }
      }
    } finally {
      this.closeIntent(intent);
    }
    if (hasCleanupError && acquiredHandle !== undefined) acquiredHandle.release();
    if (hasPrimaryError) throw primaryError;
    if (hasCleanupError) throw cleanupError;
    if (acquiredHandle === undefined) {
      throw new Error('cross-process lock acquisition finished without a result');
    }
    return acquiredHandle;
  }

  async acquireWithWait(
    lockPath: string,
    options: CrossProcessLockAcquireOptions & { wait: CrossProcessLockWaitOptions },
  ): Promise<ICrossProcessLockHandle> {
    const start = this.now();
    let lastError: CrossProcessLockError | undefined;
    for (;;) {
      try {
        return await this.acquire(lockPath, options);
      } catch (error) {
        if (!(error instanceof CrossProcessLockError) || error.code !== CrossProcessLockErrorCode.Held) {
          throw error;
        }
        lastError = error;
        if (this.now() - start >= options.wait.timeoutMs) {
          throw new CrossProcessLockError(
            CrossProcessLockErrorCode.WaitTimeout,
            `timed out waiting for the cross-process lock (${options.wait.timeoutMs}ms): ${lastError.message}`,
            { details: { path: lockPath, timeoutMs: options.wait.timeoutMs }, cause: lastError },
          );
        }
        await this.sleep(options.wait.retryIntervalMs ?? DEFAULT_WAIT_RETRY_INTERVAL_MS);
      }
    }
  }

  async withLock<T>(
    lockPath: string,
    options: CrossProcessLockAcquireOptions & { wait: CrossProcessLockWaitOptions },
    fn: (handle: ICrossProcessLockHandle) => T | Promise<T>,
  ): Promise<T> {
    const handle = await this.acquireWithWait(lockPath, options);
    try {
      return await fn(handle);
    } finally {
      handle.release();
    }
  }

  inspect(
    lockPath: string,
    options?: Pick<CrossProcessLockAcquireOptions, 'creationWindowMs'>,
  ): CrossProcessLockInspection {
    return this.classify(lockPath, options?.creationWindowMs ?? DEFAULT_CREATION_WINDOW_MS);
  }

  private classify(lockPath: string, creationWindowMs: number): CrossProcessLockInspection {
    let raw: string;
    try {
      raw = readFileSync(lockPath, 'utf8');
    } catch (error) {
      if (readErrno(error) === 'ENOENT') return { state: 'free' };
      throw toLockIoError(error, { path: lockPath, op: 'read' });
    }
    const payload = parseDiskPayload(raw);
    if (payload === undefined) {
      const mtimeMs = this.readMtimeMs(lockPath);
      if (mtimeMs === undefined) return { state: 'free' };
      return this.now() - mtimeMs < creationWindowMs
        ? { state: 'creating' }
        : { state: 'stale', staleReason: 'creation-window-expired' };
    }
    if (isProbingPid(payload.pid)) {
      const probed = this.safeProbe(payload.pid);
      if (!probed.alive) {
        return { state: 'stale', payload, staleReason: 'holder-dead' };
      }
      if (
        payload.processStartedAt !== undefined &&
        probed.processStartedAt !== undefined &&
        payload.processStartedAt !== probed.processStartedAt
      ) {
        return { state: 'stale', payload, staleReason: 'pid-reused' };
      }
    }
    return { state: 'held', payload, unavailableReason: 'held' };
  }

  private reasonForHeld(
    payload: CrossProcessLockPayload | undefined,
    observedTtlMs: number,
  ): CrossProcessLockUnavailableReason {
    const heartbeatAt = payload?.heartbeatAt;
    if (heartbeatAt !== undefined && this.now() - heartbeatAt > observedTtlMs) {
      return 'holder-unresponsive';
    }
    return 'held';
  }

  private async isolateStale(
    lockPath: string,
    inspection: CrossProcessLockInspection,
    creationWindowMs: number,
    intentPath: string,
  ): Promise<boolean> {
    const current = this.classify(lockPath, creationWindowMs);
    if (current.state !== 'stale') return false;
    if (inspection.payload?.lockId !== current.payload?.lockId) return false;
    await this.beforeStaleIsolation?.();
    const rawLockId = inspection.payload?.lockId;
    const staleLockId = rawLockId !== undefined && rawLockId !== '' ? rawLockId : 'unknown';
    try {
      renameSync(lockPath, `${lockPath}.stale.${staleLockId}.${basename(intentPath)}`);
      return true;
    } catch (error) {
      if (readErrno(error) === 'ENOENT') return false;
      throw toLockIoError(error, { path: lockPath, op: 'rename-stale' });
    }
  }

  private completeAcquire(
    lockPath: string,
    fd: number,
    options: CrossProcessLockAcquireOptions,
  ): ICrossProcessLockHandle {
    const lockId = this.newLockId();
    const extras: DiskLockPayload = { ...options.extraPayload };
    if (options.address !== undefined) extras.address = options.address;
    const handle = new NodeCrossProcessLockHandle(
      lockPath,
      lockId,
      this.now,
      this.selfPid,
      this.instanceId,
      this.safeProbe(this.selfPid).processStartedAt,
      extras,
      options.heartbeat,
      options.onLost,
      fd,
    );
    try {
      handle.writeInitialPayload();
    } catch (error) {
      // We exclusively created this file via O_EXCL and its (partial) content
      // is not a valid payload, so cleanup is safe and avoids creating-window
      // litter; release() closes the fd without touching foreign payloads.
      handle.release();
      try {
        unlinkSync(lockPath);
      } catch {
        // best effort
      }
      throw toLockIoError(error, { path: lockPath, op: 'write' });
    }
    // Read-back confirmation: a creator frozen inside its create window must
    // honestly fail instead of believing it still owns the lock.
    if (readPayloadFromPath(lockPath)?.lockId !== lockId) {
      handle.release();
      throw lostError(lockPath, 'confirming the newly created payload');
    }
    if (options.heartbeat !== undefined) handle.startHeartbeat();
    return handle;
  }

  private registerIntent(lockPath: string): RegisteredIntent {
    const token = this.newAttemptId();
    const intentPath = `${lockPath}.intent.${token}`;
    const startedAt = this.safeProbe(this.selfPid).processStartedAt;
    const payload: DiskIntentPayload = { intent_id: token, state: 'active', pid: this.selfPid };
    if (startedAt !== undefined) payload.process_started_at = startedAt;
    let fd: number | undefined;
    try {
      fd = openSync(intentPath, 'wx+', 0o600);
      this.writeIntent(fd, payload);
      return { path: intentPath, token, fd };
    } catch (error) {
      if (fd !== undefined) this.closeFd(fd);
      try {
        unlinkSync(intentPath);
      } catch {
        // best effort
      }
      throw toLockIoError(error, { path: intentPath, op: 'register-intent' });
    }
  }

  private markIntentSettled(intent: RegisteredIntent): void {
    const current = this.readIntent(intent.path);
    if (current?.intent_id !== intent.token) return;
    this.writeIntent(intent.fd, { ...current, intent_id: intent.token, state: 'settled' });
  }

  private removeIntent(intent: RegisteredIntent): void {
    try {
      const current = this.readIntent(intent.path);
      if (current?.intent_id !== intent.token) return;
      unlinkSync(intent.path);
    } catch (error) {
      if (readErrno(error) !== 'ENOENT') {
        throw toLockIoError(error, { path: intent.path, op: 'remove-intent' });
      }
    }
  }

  private readIntent(intentPath: string): DiskIntentPayload | undefined {
    let raw: string;
    try {
      raw = readFileSync(intentPath, 'utf8');
    } catch (error) {
      if (readErrno(error) === 'ENOENT') return undefined;
      throw toLockIoError(error, { path: intentPath, op: 'read-intent' });
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' ? (parsed as DiskIntentPayload) : undefined;
    } catch {
      return undefined;
    }
  }

  private writeIntent(fd: number, payload: DiskIntentPayload): void {
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    writeSync(fd, data, 0, data.length, 0);
    ftruncateSync(fd, data.length);
    fsyncSync(fd);
  }

  private closeIntent(intent: RegisteredIntent): void {
    this.closeFd(intent.fd);
  }

  private closeFd(fd: number): void {
    try {
      closeSync(fd);
    } catch {
      // best effort
    }
  }

  private async settleAcquire(
    handle: ICrossProcessLockHandle,
    ownIntentPath: string,
    timeoutMs: number,
  ): Promise<void> {
    const startedAt = this.now();
    const contenders = this.snapshotForeignIntents(handle.lockPath, ownIntentPath);
    for (;;) {
      if (!handle.checkHeld()) {
        throw lostError(handle.lockPath, 'settling concurrent contenders');
      }
      if (!this.hasLiveIntent(contenders, timeoutMs)) return;
      if (this.now() - startedAt >= timeoutMs) {
        throw heldError(handle.lockPath, 'creating', readPayloadFromPath(handle.lockPath));
      }
      await this.sleep(DEFAULT_SETTLE_RETRY_INTERVAL_MS);
    }
  }

  private snapshotForeignIntents(
    lockPath: string,
    ownIntentPath: string,
  ): Set<string> {
    const dir = dirname(lockPath);
    const prefix = `${basename(lockPath)}.intent.`;
    const ownName = basename(ownIntentPath);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      throw toLockIoError(error, { path: dir, op: 'list-intents' });
    }
    return new Set(
      names
        .filter((name) => name.startsWith(prefix) && name !== ownName)
        .map((name) => join(dir, name)),
    );
  }

  private hasLiveIntent(intentPaths: Set<string>, creationWindowMs: number): boolean {
    for (const path of intentPaths) {
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch (error) {
        if (readErrno(error) === 'ENOENT') {
          intentPaths.delete(path);
          continue;
        }
        throw toLockIoError(error, { path, op: 'read-intent' });
      }
      let payload: DiskIntentPayload | undefined;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object') payload = parsed as DiskIntentPayload;
      } catch {
        // handled as a creation-window intent below
      }
      if (payload?.state === 'settled') {
        this.removeIntent({ path, token: payload.intent_id ?? '', fd: -1 });
        intentPaths.delete(path);
        continue;
      }
      const intentPid = payload?.pid;
      if (!isProbingPid(intentPid ?? 0)) {
        const mtimeMs = this.readMtimeMs(path);
        if (mtimeMs !== undefined && this.now() - mtimeMs >= creationWindowMs) {
          this.removeIntent({ path, token: payload?.intent_id ?? '', fd: -1 });
          intentPaths.delete(path);
          continue;
        }
        return true;
      }
      const probed = this.safeProbe(intentPid as number);
      const reused =
        payload?.process_started_at !== undefined &&
        probed.processStartedAt !== undefined &&
        payload.process_started_at !== probed.processStartedAt;
      if (!probed.alive || reused) {
        this.removeIntent({ path, token: payload?.intent_id ?? '', fd: -1 });
        intentPaths.delete(path);
        continue;
      }
      return true;
    }
    return false;
  }

  private safeProbe(pid: number): { alive: boolean; processStartedAt?: string } {
    try {
      return this.probe(pid);
    } catch {
      return { alive: true };
    }
  }

  private readMtimeMs(lockPath: string): number | undefined {
    try {
      return statSync(lockPath).mtimeMs;
    } catch {
      return undefined;
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  ICrossProcessLockService,
  CrossProcessLockService,
  InstantiationType.Eager,
  'crossProcessLock',
);
