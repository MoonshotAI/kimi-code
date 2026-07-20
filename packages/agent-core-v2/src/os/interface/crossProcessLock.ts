/**
 * `crossProcessLock` domain (L1) — cross-process exclusive lock contract.
 *
 * Defines the App-scoped lock service used by durable read-modify-write
 * transactions and long-lived session leases. The lock path is a permanent
 * sentinel whose inode is never removed or replaced; ownership is enforced by
 * the operating system through an exclusive advisory lock held on an open file
 * descriptor. A separate owner document carries operator-facing metadata and
 * is never consulted for lock correctness.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';

export interface CrossProcessLockPayload {
  lockId: string;
  instanceId: string;
  pid: number;
  address?: string;
}

export interface CrossProcessLockWaitOptions {
  readonly timeoutMs: number;
  readonly retryIntervalMs?: number;
}

export interface CrossProcessLockAcquireOptions {
  readonly address?: string;
}

export interface CrossProcessLockInspection {
  readonly state: 'free' | 'creating' | 'held';
  readonly payload?: CrossProcessLockPayload;
}

export interface ICrossProcessLockHandle {
  readonly lockPath: string;
  readonly lockId: string;
  checkHeld(): boolean;
  release(): void;
}

export interface ICrossProcessLockService {
  readonly _serviceBrand: undefined;

  acquire(
    lockPath: string,
    options?: CrossProcessLockAcquireOptions,
  ): Promise<ICrossProcessLockHandle>;

  acquireWithWait(
    lockPath: string,
    options: CrossProcessLockAcquireOptions & { wait: CrossProcessLockWaitOptions },
  ): Promise<ICrossProcessLockHandle>;

  withLock<T>(
    lockPath: string,
    options: CrossProcessLockAcquireOptions & { wait: CrossProcessLockWaitOptions },
    fn: (handle: ICrossProcessLockHandle) => T | Promise<T>,
  ): Promise<T>;

  inspect(lockPath: string): CrossProcessLockInspection;
}

export const ICrossProcessLockService: ServiceIdentifier<ICrossProcessLockService> =
  createDecorator<ICrossProcessLockService>('crossProcessLockService');

export interface CrossProcessLockServiceDeps {
  readonly now?: () => number;
  readonly selfPid?: number;
  readonly newLockId?: () => string;
  readonly instanceId?: string;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const OsLockErrors = {
  codes: {
    OS_LOCK_HELD: 'os.lock.held',
    OS_LOCK_WAIT_TIMEOUT: 'os.lock.wait_timeout',
    OS_LOCK_LOST: 'os.lock.lost',
    OS_LOCK_IO: 'os.lock.io',
  },
  info: {
    'os.lock.held': {
      title: 'Lock is held by another process',
      retryable: false,
      public: true,
    },
    'os.lock.wait_timeout': {
      title: 'Timed out waiting for a cross-process lock',
      retryable: true,
      public: true,
    },
    'os.lock.lost': {
      title: 'Lock ownership was lost',
      retryable: false,
      public: true,
    },
    'os.lock.io': {
      title: 'Lock file I/O failed',
      retryable: true,
      public: false,
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(OsLockErrors);

export const CrossProcessLockErrorCode = {
  Held: OsLockErrors.codes.OS_LOCK_HELD,
  WaitTimeout: OsLockErrors.codes.OS_LOCK_WAIT_TIMEOUT,
  Lost: OsLockErrors.codes.OS_LOCK_LOST,
  Io: OsLockErrors.codes.OS_LOCK_IO,
} as const;

export type CrossProcessLockErrorCode =
  (typeof CrossProcessLockErrorCode)[keyof typeof CrossProcessLockErrorCode];

export class CrossProcessLockError extends Error2 {
  constructor(code: CrossProcessLockErrorCode, message: string, options?: Error2Options) {
    super(code, message, options);
    this.name = 'CrossProcessLockError';
  }
}
