/**
 * `sessionLease` domain (L6) — the per-session write lease.
 *
 * Defines `ISessionLeaseService`, the Session-scope seeded capability that
 * state writers use to re-verify they still own the session's durable state,
 * and the `SessionLease` object that satisfies it: an App-owned wrapper
 * (`SessionLifecycleService` builds it; it is deliberately not a DI service)
 * around the cross-process lock handle at
 * `<homeDir>/session-leases/<sessionId>.json`. `assertWritable` is the
 * Quint-verified hard gate (design: `.tmp/refactor-watch-design-v2.md`
 * §3.4.2/§3.4.5): it synchronously re-reads the on-disk lease payload and
 * compares the held `lockId` — a mismatch fails closed with
 * `session.lease_lost`, marks the lease lost, and fires the loss callback
 * exactly once so the owning session tears itself down. Release order is the
 * lifecycle's business; `release()` only forwards to the token-guarded lock
 * release (a foreign payload is never unlinked) and is idempotent.
 *
 * No default is registered for `ISessionLeaseService`: every production
 * session scope is seeded by `sessionLifecycle` via {@link sessionLeaseSeed};
 * resolving it unseeded (a session that bypassed materialization) is a bug
 * and must fail loudly rather than silently disable the fencing gate.
 */

import { join } from 'pathe';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import type { ICrossProcessLockHandle } from '#/os/interface/crossProcessLock';
import type { ISessionWriteAuthority } from '#/persistence/interface/writeAuthority';

export const SESSION_LEASE_HEARTBEAT_INTERVAL_MS = 2000;
export const SESSION_LEASE_TTL_MS = 6000;
export const LEASE_CREATING_RETRY_AFTER_MS = 1000;
export const HOLDER_UNRESPONSIVE_RETRY_AFTER_MS = 2000;
export const UNREGISTERED_WRITER_WINDOW_MS = 5000;
export const UNREGISTERED_WRITER_RECHECK_DELAY_MS = 1000;

/** `details` payload of `session.held_by_peer` errors; the zod twin lives in
    packages/protocol (`sessionOwnershipDetailsSchema`) and the shapes must
    stay byte-identical. Declared as `type` (not `interface`) so the payload
    stays assignable to `Error2Options.details`. */
export type SessionOwnershipPhase =
  | 'creating'
  | 'routable'
  | 'holder-unresponsive'
  | 'held-by-local-instance';

export type HeldByPeerDetails = {
  readonly kind: 'held-by-peer';
  readonly phase: SessionOwnershipPhase;
  readonly address?: string;
  readonly retry_after_ms?: number;
};

export type SessionOwnershipDetails = HeldByPeerDetails | { readonly kind: 'unregistered-writer' };

export interface ISessionLeaseInfo {
  readonly sessionId: string;
  readonly lockId: string;
}

export interface ISessionLeaseService {
  readonly _serviceBrand: undefined;

  /** The held lease identity; `undefined` once the lease is released. */
  readonly info: ISessionLeaseInfo | undefined;
  /** Hard gate, synchronously re-reads the lease payload (see the file
      header). Throws `Error2(session.lease_lost)` when this instance no
      longer holds the lease — including after `release()`. */
  assertWritable(): void;
}

export const ISessionLeaseService: ServiceIdentifier<ISessionLeaseService> =
  createDecorator<ISessionLeaseService>('sessionLeaseService');

export class SessionLease implements ISessionWriteAuthority, ISessionLeaseService {
  declare readonly _serviceBrand: undefined;

  readonly lockId: string;
  private _released = false;
  private _lost = false;
  private _lossFired = false;

  constructor(
    readonly sessionId: string,
    private readonly handle: ICrossProcessLockHandle,
    private readonly onLeaseLost: (sessionId: string) => void,
  ) {
    this.lockId = handle.lockId;
  }

  get released(): boolean {
    return this._released;
  }

  get info(): ISessionLeaseInfo | undefined {
    return this._released ? undefined : { sessionId: this.sessionId, lockId: this.lockId };
  }

  checkHeld(): boolean {
    return !this._released && this.handle.checkHeld();
  }

  assertWritable(): void {
    if (this._released) {
      throw new Error2(
        ErrorCodes.SESSION_LEASE_LOST,
        `session ${this.sessionId} write lease was released`,
        { details: { sessionId: this.sessionId } },
      );
    }
    if (this._lost || !this.handle.checkHeld()) {
      this.markLost();
      throw new Error2(
        ErrorCodes.SESSION_LEASE_LOST,
        `session ${this.sessionId} no longer holds its write lease`,
        { details: { sessionId: this.sessionId } },
      );
    }
  }

  /** Forwards the lock handle's heartbeat loss detection into the lease's
      own once-only loss path; also driven directly by `assertWritable`. */
  markLost(): void {
    this._lost = true;
    if (this._lossFired) return;
    this._lossFired = true;
    this.onLeaseLost(this.sessionId);
  }

  release(): void {
    if (this._released) return;
    this._released = true;
    this.handle.release();
  }
}

export function sessionLeasePath(homeDir: string, sessionId: string): string {
  return join(homeDir, 'session-leases', `${sessionId}.json`);
}

export function sessionLeaseSeed(lease: SessionLease): ScopeSeed {
  return [[ISessionLeaseService as ServiceIdentifier<unknown>, lease]];
}
