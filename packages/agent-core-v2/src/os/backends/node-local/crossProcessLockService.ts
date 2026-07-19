/**
 * `crossProcessLock` domain (L1) — `ICrossProcessLockService` implementation.
 *
 * Node-local backend for the cross-process exclusive file-lock protocol
 * defined by `os/interface/crossProcessLock` (design:
 * `.tmp/refactor-watch-design-v2.md` §3.3). Uses the synchronous `node:fs`
 * API by design: every operation is a short burst (create / read / rename /
 * beat) on low-frequency coordination paths — server lock, session lease,
 * lock-in-RMW — and must never be called from turn/loop hot paths. Process
 * probing goes through `createNodeProcessProbe`; every clock, pid, probe and
 * token source is injectable for tests.
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
 * - Takeover is rename-isolated: the stale file is moved aside to
 *   `<lock>.stale.<lockId>` before re-creating, and the freshly created
 *   payload is read back and confirmed against the new `lockId` — a creator
 *   frozen inside its create window cannot silently stomp the new lock.
 * - Creation window: an empty/unparseable file younger than
 *   `creationWindowMs` (default 5s) is `creating` (treated as held); past the
 *   window it is stale.
 * - Heartbeat is `write(position 0) + ftruncate + fsync` on the fd kept open
 *   from acquire — never tmp+rename, which would let a frozen old holder's
 *   next beat overwrite the lock that took it over.
 *
 * Bound at App scope.
 */

import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

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

  sealPidOnly(): void {
    this.closeFd();
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
    const fd = openSync(this.lockPath, 'r+');
    try {
      writeSync(fd, data, 0, data.length, 0);
      ftruncateSync(fd, data.length);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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
  private readonly instanceId: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: CrossProcessLockServiceDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.selfPid = deps.selfPid ?? process.pid;
    this.probe = deps.probeProcess ?? createNodeProcessProbe();
    this.newLockId = deps.newLockId ?? ulid;
    this.instanceId = deps.instanceId ?? ulid();
    this.sleep =
      deps.sleep ??
      ((ms) =>
        new Promise<void>((resolvePromise) => {
          const timer = setTimeout(resolvePromise, ms);
          timer.unref();
        }));
  }

  acquire(
    lockPath: string,
    options: CrossProcessLockAcquireOptions = {},
  ): ICrossProcessLockHandle {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
    } catch (error) {
      throw toLockIoError(error, { path: lockPath, op: 'mkdir' });
    }
    const creationWindowMs = options.creationWindowMs ?? DEFAULT_CREATION_WINDOW_MS;
    const observedTtlMs = options.heartbeat?.ttlMs ?? creationWindowMs;
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
            throw heldError(lockPath, this.reasonForHeld(inspection.payload, observedTtlMs), inspection.payload);
          case 'stale':
            this.isolateStale(lockPath, inspection);
            continue;
        }
      }
      return this.completeAcquire(lockPath, fd, options);
    }
    throw heldError(lockPath, 'held', lastHolder);
  }

  async acquireWithWait(
    lockPath: string,
    options: CrossProcessLockAcquireOptions & { wait: CrossProcessLockWaitOptions },
  ): Promise<ICrossProcessLockHandle> {
    const start = this.now();
    let lastError: CrossProcessLockError | undefined;
    for (;;) {
      try {
        return this.acquire(lockPath, options);
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

  private isolateStale(lockPath: string, inspection: CrossProcessLockInspection): void {
    const rawLockId = inspection.payload?.lockId;
    const staleLockId = rawLockId !== undefined && rawLockId !== '' ? rawLockId : 'unknown';
    try {
      renameSync(lockPath, `${lockPath}.stale.${staleLockId}`);
    } catch (error) {
      if (readErrno(error) === 'ENOENT') return;
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
    if (options.heartbeat !== undefined) {
      handle.startHeartbeat();
    } else {
      handle.sealPidOnly();
    }
    return handle;
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
