/**
 * `sessionLease` domain (L6) — the per-session write lease.
 *
 * Defines `ISessionLeaseService`, the Session-scope seeded capability that
 * state writers use to verify they still own the session's durable state,
 * and the `SessionLease` object that satisfies it: an App-owned wrapper
 * (`SessionLifecycleService` builds it; it is deliberately not a DI service)
 * around the cross-process lock handle at
 * `<homeDir>/session-leases/<sessionId>.lock`. `assertWritable` is the hard
 * gate: it checks the live kernel-lock handle — a released or replaced
 * sentinel fails closed with
 * `session.lease_lost`, marks the lease lost, and fires the loss callback
 * exactly once so the owning session tears itself down. Release order is the
 * lifecycle's business; `release()` only forwards to the idempotent kernel
 * lock release.
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
import type {
  CrossProcessLockInspection,
  ICrossProcessLockHandle,
} from '#/os/interface/crossProcessLock';
import type { ISessionWriteAuthority } from '#/persistence/interface/writeAuthority';

export const LEASE_CREATING_RETRY_AFTER_MS = 1000;

/** `details` payload of `session.held_by_peer` errors; the zod twin lives in
    packages/protocol (`sessionOwnershipDetailsSchema`) and the shapes must
    stay byte-identical. Declared as `type` (not `interface`) so the payload
    stays assignable to `Error2Options.details`. */
export type SessionOwnershipPhase =
  | 'creating'
  | 'routable'
  | 'held-by-local-instance';

export type HeldByPeerDetails = {
  readonly kind: 'held-by-peer';
  readonly phase: SessionOwnershipPhase;
  readonly address?: string;
  readonly retry_after_ms?: number;
};

export type SessionOwnershipDetails = HeldByPeerDetails | { readonly kind: 'unregistered-writer' };

/**
 * Classify a lease inspection into `held-by-peer` details. Shared by every
 * surface that reports session ownership — the lifecycle's
 * post-acquire-failure probe and kap-server's read-only probes — so all of
 * them classify the same lease the same way. Returns `undefined` when the
 * lease is free; a caller on a failed-acquire path should map that to
 * `'creating'`, since a holder that vanished mid-race converges by retrying.
 */
export function heldByPeerDetailsFromInspection(
  inspection: CrossProcessLockInspection,
): HeldByPeerDetails | undefined {
  if (inspection.state === 'held' && inspection.payload !== undefined) {
    const { address } = inspection.payload;
    return address !== undefined
      ? { kind: 'held-by-peer', phase: 'routable', address }
      : { kind: 'held-by-peer', phase: 'held-by-local-instance' };
  }
  if (inspection.state === 'creating') {
    return {
      kind: 'held-by-peer',
      phase: 'creating',
      retry_after_ms: LEASE_CREATING_RETRY_AFTER_MS,
    };
  }
  return undefined;
}

export interface ISessionLeaseInfo {
  readonly sessionId: string;
  readonly lockId: string;
}

export interface ISessionLeaseService {
  readonly _serviceBrand: undefined;

  /** The held lease identity; `undefined` once the lease is released. */
  readonly info: ISessionLeaseInfo | undefined;
  /** Hard gate. Throws `Error2(session.lease_lost)` when this instance no
      longer holds the kernel lease — including after `release()`. */
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

  get info(): ISessionLeaseInfo | undefined {
    return this._released ? undefined : { sessionId: this.sessionId, lockId: this.lockId };
  }

  private checkHeld(): boolean {
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
    if (this._lost || !this.checkHeld()) {
      this.markLost();
      throw new Error2(
        ErrorCodes.SESSION_LEASE_LOST,
        `session ${this.sessionId} no longer holds its write lease`,
        { details: { sessionId: this.sessionId } },
      );
    }
  }

  private markLost(): void {
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
  return join(homeDir, 'session-leases', `${sessionId}.lock`);
}

export function sessionLeaseSeed(lease: SessionLease): ScopeSeed {
  return [[ISessionLeaseService as ServiceIdentifier<unknown>, lease]];
}
