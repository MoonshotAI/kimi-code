/**
 * `crossProcessLock` domain (L1) — cross-process exclusive file-lock contract.
 *
 * Defines `ICrossProcessLockService`, the single lock protocol that replaces the
 * repo's ad-hoc lockfiles (design: `.tmp/refactor-watch-design-v2.md` §3.3).
 * One JSON lock file per resource, created with `O_EXCL`. Protocol invariants:
 *
 * - Token-guarded: every acquire generates a fresh `lockId` (ulid); release,
 *   heartbeat and payload rewrites re-read the file and compare `lockId` before
 *   touching it, so a late operation never clobbers a newer holder's lock.
 * - Live PID is never taken over: a lock whose owner pid is alive and whose
 *   `processStartedAt` identity matches is held, even when its heartbeat has
 *   gone silent (`alive-unresponsive` — alert, never seize). Pid death, or a
 *   pid whose identity no longer matches (pid reused by a new process), makes
 *   the lock stale.
 * - Takeover is rename-isolated: the stale file is renamed aside to
 *   `<lock>.stale.<lockId>` before re-creating, then the new payload is read
 *   back and confirmed — a creator frozen inside its create window (SIGSTOP)
 *   cannot silently stomp the new lock when it resumes.
 * - Creation window: an empty or unparseable file younger than the creation
 *   window is "creating" (treated as held, no address yet); only past the
 *   window may it be treated as stale.
 * - Heartbeat, for modes that use it, is `pwrite + ftruncate + fsync` on the
 *   fd kept open from acquire — never tmp+rename, which would let a frozen old
 *   holder's next beat overwrite the lock that took it over.
 *
 * The on-disk JSON is flat and snake_case, matching operator-facing lock
 * conventions; the six known protocol keys map to the camelCase fields of
 * `CrossProcessLockPayload`, and any additional adapter-owned keys pass
 * through untouched. Bound at App scope; the Node implementation lives in
 * `os/backends/node-local/crossProcessLockService.ts`.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface CrossProcessLockPayload {
  /** Unique token of this acquire; every mutation must be guarded by it. */
  lockId: string;
  /** Identity of the acquiring instance (per-service ulid by default). */
  instanceId: string;
  pid: number;
  /** Opaque platform identity token for pid-reuse detection (macOS `sysctl
      kern.proc.starttime`, Linux `/proc/<pid>/stat` field 22); compared by
      equality only, never parsed. Absent when the platform cannot provide it. */
  processStartedAt?: string;
  /** Contact address for instances that run a network service. */
  address?: string;
  /** Last heartbeat wall-clock ms; present only in heartbeat modes. */
  heartbeatAt?: number;
  /** Adapter-owned extra fields, kept flat on disk (e.g. server lock `port`). */
  [extra: string]: unknown;
}

export interface CrossProcessLockHeartbeatOptions {
  /** Milliseconds between heartbeat writes. */
  readonly intervalMs: number;
  /** Milliseconds of heartbeat silence after which a *dead-identity* holder is
      observable as unresponsive; a live, identity-matching pid is still never
      taken over — the ttl only feeds the `alive-unresponsive` verdict. */
  readonly ttlMs: number;
}

export interface CrossProcessLockWaitOptions {
  /** Give up and throw `OS_LOCK_WAIT_TIMEOUT` after this many ms. */
  readonly timeoutMs: number;
  /** Delay between acquisition attempts; small default when omitted. */
  readonly retryIntervalMs?: number;
}

export interface CrossProcessLockAcquireOptions {
  /** Heartbeat mode. Omit for pid-only locks (no fd kept, no beats). */
  readonly heartbeat?: CrossProcessLockHeartbeatOptions;
  /** Milliseconds an empty/unparseable lock file counts as "creating" rather
      than stale. Default 5000 for heartbeat-less modes. */
  readonly creationWindowMs?: number;
  /** Contact address recorded in the payload. */
  readonly address?: string;
  /** Extra flat fields written into the lock JSON (adapter-owned, snake_case). */
  readonly extraPayload?: Record<string, unknown>;
  /** Called once when a heartbeat-mode lock detects it has lost ownership
      (payload token no longer matches). Not called for pid-only locks. */
  readonly onLost?: () => void;
}

export type CrossProcessLockUnavailableReason =
  /** Live, identity-matching owner (or, heartbeat mode, silently frozen). */
  | 'held'
  /** Empty/unparseable file still inside its creation window. */
  | 'creating'
  /** Heartbeat-mode lock whose heartbeatAt is past ttl while the owner pid is
      alive and identity-matching. Never taken over; surfaced for alerting. */
  | 'holder-unresponsive';

export type CrossProcessLockStaleReason =
  /** Owner pid no longer exists. */
  | 'holder-dead'
  /** Owner pid alive but `processStartedAt` differs — pid was reused. */
  | 'pid-reused'
  /** Empty/unparseable file older than the creation window. */
  | 'creation-window-expired';

export interface CrossProcessLockInspection {
  readonly state: 'free' | 'creating' | 'held' | 'stale';
  /** Present whenever the file existed and parsed. */
  readonly payload?: CrossProcessLockPayload;
  readonly unavailableReason?: CrossProcessLockUnavailableReason;
  readonly staleReason?: CrossProcessLockStaleReason;
}

export interface ICrossProcessLockHandle {
  readonly lockPath: string;
  readonly lockId: string;
  /** True while the on-disk payload still carries this handle's `lockId`. */
  checkHeld(): boolean;
  /** Token-guarded payload rewrite (`port` updates and the like). Re-reads
      and compares `lockId` first; protocol fields (`lockId`/`instanceId`/`pid`)
      are re-stamped, mutator output cannot change them. Throws
      `OS_LOCK_LOST` when the token no longer matches. */
  update(mutate: (payload: CrossProcessLockPayload) => Record<string, unknown>): void;
  /** Token-guarded unlink. Idempotent; a missing or foreign-owned file is
      left untouched. Stops the heartbeat when present. */
  release(): void;
}

export interface ICrossProcessLockService {
  readonly _serviceBrand: undefined;

  /** Fail-fast acquisition. Throws `OS_LOCK_HELD` carrying the
      `CrossProcessLockUnavailableReason` when a live owner stands in the way;
      takes over stale locks per protocol. */
  acquire(
    lockPath: string,
    options?: CrossProcessLockAcquireOptions,
  ): ICrossProcessLockHandle;

  /** Blocking acquisition for short critical sections (lock-in-RMW): retries
      while the lock is held/creating until `wait.timeoutMs` elapses. */
  acquireWithWait(
    lockPath: string,
    options: CrossProcessLockAcquireOptions & { wait: CrossProcessLockWaitOptions },
  ): Promise<ICrossProcessLockHandle>;

  /** `acquireWithWait` + `fn` + guaranteed release, for read-modify-write
      critical sections. */
  withLock<T>(
    lockPath: string,
    options: CrossProcessLockAcquireOptions & { wait: CrossProcessLockWaitOptions },
    fn: (handle: ICrossProcessLockHandle) => T | Promise<T>,
  ): Promise<T>;

  /** Read-only probe; never mutates the file. */
  inspect(lockPath: string, options?: Pick<CrossProcessLockAcquireOptions, 'creationWindowMs'>): CrossProcessLockInspection;
}

export const ICrossProcessLockService: ServiceIdentifier<ICrossProcessLockService> =
  createDecorator<ICrossProcessLockService>('crossProcessLockService');

/** Process probing seam, injectable for tests. `alive` follows `kill(pid,0)`
    semantics (EPERM counts as alive); `processStartedAt` is the opaque identity
    token. A probing failure must return the conservative `{alive: true}`. */
export type ProcessProbe = (pid: number) => {
  alive: boolean;
  processStartedAt?: string;
};

/** Test seam: every clock, pid, probe and token source is replaceable. */
export interface CrossProcessLockServiceDeps {
  readonly now?: () => number;
  readonly selfPid?: number;
  readonly probeProcess?: ProcessProbe;
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
      title: 'Lock ownership was lost to another process',
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
