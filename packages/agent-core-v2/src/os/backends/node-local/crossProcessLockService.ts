/**
 * `crossProcessLock` domain (L1) — `ICrossProcessLockService` implementation.
 *
 * Uses `kernel-file-lock` to hold an operating-system advisory lock on a
 * permanent sentinel file. Owner metadata is stored in a sibling JSON document
 * for diagnostics and routing only; it is not part of the exclusion protocol.
 * Bound at App scope.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import {
  type KernelFileLockHandle,
  tryAcquireKernelFileLock,
} from '@moonshot-ai/kernel-file-lock';
import { ulid } from 'ulid';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  CrossProcessLockError,
  CrossProcessLockErrorCode,
  type CrossProcessLockAcquireOptions,
  type CrossProcessLockInspection,
  type CrossProcessLockPayload,
  type CrossProcessLockServiceDeps,
  type CrossProcessLockWaitOptions,
  type ICrossProcessLockHandle,
  ICrossProcessLockService,
} from '#/os/interface/crossProcessLock';

const DEFAULT_WAIT_RETRY_INTERVAL_MS = 50;

interface DiskLockPayload {
  lock_id?: string;
  instance_id?: string;
  pid?: number;
  address?: string;
}

function readErrno(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ownerPath(lockPath: string): string {
  return `${lockPath}.owner.json`;
}

function toDiskPayload(payload: CrossProcessLockPayload): DiskLockPayload {
  return {
    lock_id: payload.lockId,
    instance_id: payload.instanceId,
    pid: payload.pid,
    address: payload.address,
  };
}

function fromDiskPayload(payload: DiskLockPayload): CrossProcessLockPayload | undefined {
  if (
    typeof payload.lock_id !== 'string' ||
    typeof payload.instance_id !== 'string' ||
    typeof payload.pid !== 'number'
  ) {
    return undefined;
  }
  return {
    lockId: payload.lock_id,
    instanceId: payload.instance_id,
    pid: payload.pid,
    address: typeof payload.address === 'string' ? payload.address : undefined,
  };
}

function readPayload(lockPath: string): CrossProcessLockPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ownerPath(lockPath), 'utf8'));
    return parsed !== null && typeof parsed === 'object'
      ? fromDiskPayload(parsed as DiskLockPayload)
      : undefined;
  } catch (error) {
    if (readErrno(error) === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function writePayload(lockPath: string, payload: CrossProcessLockPayload): void {
  const path = ownerPath(lockPath);
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(toDiskPayload(payload)), { mode: 0o600 });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function toLockIoError(error: unknown, path: string, op: string): CrossProcessLockError {
  if (error instanceof CrossProcessLockError) return error;
  return new CrossProcessLockError(
    CrossProcessLockErrorCode.Io,
    `${op} failed on lock ${path}: ${errorMessage(error)}`,
    { details: { path, op, errno: readErrno(error) }, cause: error },
  );
}

function heldError(
  lockPath: string,
  inspection: CrossProcessLockInspection,
): CrossProcessLockError {
  return new CrossProcessLockError(
    CrossProcessLockErrorCode.Held,
    `cross-process lock unavailable (${inspection.state})`,
    { details: { path: lockPath, reason: inspection.state, holder: inspection.payload } },
  );
}

function waitTimeoutError(
  lockPath: string,
  timeoutMs: number,
  cause: unknown,
): CrossProcessLockError {
  return new CrossProcessLockError(
    CrossProcessLockErrorCode.WaitTimeout,
    `timed out waiting for the cross-process lock (${timeoutMs}ms)`,
    { details: { path: lockPath, timeoutMs }, cause },
  );
}

class CrossProcessLockHandle implements ICrossProcessLockHandle {
  private released = false;

  constructor(
    readonly lockPath: string,
    readonly lockId: string,
    private readonly kernelHandle: KernelFileLockHandle,
  ) {}

  checkHeld(): boolean {
    return !this.released && this.kernelHandle.checkHeld();
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      if (this.kernelHandle.checkHeld()) {
        try {
          rmSync(ownerPath(this.lockPath), { force: true });
        } catch {}
      }
    } finally {
      this.kernelHandle.release();
    }
  }
}

export class CrossProcessLockService implements ICrossProcessLockService {
  declare readonly _serviceBrand: undefined;

  private readonly selfPid: number;
  private readonly now: () => number;
  private readonly newLockId: () => string;
  private readonly instanceId: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: CrossProcessLockServiceDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.selfPid = deps.selfPid ?? process.pid;
    this.newLockId = deps.newLockId ?? ulid;
    this.instanceId = deps.instanceId ?? ulid();
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async acquire(
    lockPath: string,
    options: CrossProcessLockAcquireOptions = {},
  ): Promise<ICrossProcessLockHandle> {
    let kernelHandle: KernelFileLockHandle | undefined;
    try {
      kernelHandle = tryAcquireKernelFileLock(lockPath);
    } catch (error) {
      throw toLockIoError(error, lockPath, 'acquire');
    }
    if (kernelHandle === undefined) throw heldError(lockPath, this.inspectHeld(lockPath));

    const lockId = this.newLockId();
    const payload: CrossProcessLockPayload = {
      lockId,
      instanceId: this.instanceId,
      pid: this.selfPid,
      address: options.address,
    };
    try {
      rmSync(ownerPath(lockPath), { force: true });
      writePayload(lockPath, payload);
      return new CrossProcessLockHandle(lockPath, lockId, kernelHandle);
    } catch (error) {
      kernelHandle.release();
      throw toLockIoError(error, lockPath, 'write-owner');
    }
  }

  async acquireWithWait(
    lockPath: string,
    options: CrossProcessLockAcquireOptions & { wait: CrossProcessLockWaitOptions },
  ): Promise<ICrossProcessLockHandle> {
    const deadline = this.now() + options.wait.timeoutMs;
    const retryIntervalMs = options.wait.retryIntervalMs ?? DEFAULT_WAIT_RETRY_INTERVAL_MS;
    let firstAttempt = true;
    let lastHeldError: CrossProcessLockError | undefined;
    for (;;) {
      const isFirstAttempt = firstAttempt;
      if (!isFirstAttempt && this.now() >= deadline) {
        throw waitTimeoutError(lockPath, options.wait.timeoutMs, lastHeldError);
      }
      firstAttempt = false;
      try {
        const handle = await this.acquire(lockPath, options);
        if (!isFirstAttempt && this.now() >= deadline) {
          handle.release();
          throw waitTimeoutError(lockPath, options.wait.timeoutMs, lastHeldError);
        }
        return handle;
      } catch (error) {
        if (
          !(error instanceof CrossProcessLockError) ||
          error.code !== CrossProcessLockErrorCode.Held
        ) {
          throw error;
        }
        lastHeldError = error;
        const remainingMs = deadline - this.now();
        if (remainingMs <= 0) {
          throw waitTimeoutError(lockPath, options.wait.timeoutMs, error);
        }
        await this.sleep(Math.min(retryIntervalMs, remainingMs));
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

  inspect(lockPath: string): CrossProcessLockInspection {
    let probe: KernelFileLockHandle | undefined;
    try {
      probe = tryAcquireKernelFileLock(lockPath);
    } catch (error) {
      throw toLockIoError(error, lockPath, 'inspect');
    }
    if (probe !== undefined) {
      probe.release();
      return { state: 'free' };
    }
    return this.inspectHeld(lockPath);
  }

  private inspectHeld(lockPath: string): CrossProcessLockInspection {
    try {
      const payload = readPayload(lockPath);
      return payload === undefined ? { state: 'creating' } : { state: 'held', payload };
    } catch (error) {
      throw toLockIoError(error, lockPath, 'read-owner');
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
