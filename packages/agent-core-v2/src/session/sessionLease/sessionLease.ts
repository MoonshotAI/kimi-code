/**
 * `sessionLease` domain (L1) — the per-session write lease.
 *
 * Defines `ISessionLeaseService`, the Session-scope seeded ownership view,
 * and the `SessionLease` object that satisfies it together with the
 * `ISessionWriteAdmission` used by storage: an App-owned wrapper
 * (`SessionLifecycleService` builds it; it is deliberately not a DI service)
 * around the cross-process lock handle at
 * `<homeDir>/session-leases/<sessionId>.lock`. `assertWritable` is the hard
 * gate: it checks the live kernel-lock handle — a released or replaced
 * sentinel fails closed with
 * `session.lease_lost`, marks the lease lost, seals write admission, and fires
 * the loss callback exactly once so the owning session tears itself down.
 * The admission tracks physical writes so lifecycle release can await their
 * drain.
 *
 * No default is registered for either Session-scoped view: every production
 * session scope is seeded by `sessionLifecycle` via {@link sessionLeaseSeed};
 * resolving one unseeded (a session that bypassed materialization) is a bug
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
import { ISessionWriteAdmission } from '#/persistence/interface/sessionWriteAdmission';

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

export type SessionOwnershipDetails = HeldByPeerDetails;

/** `held-by-peer` details for the converging 'creating' phase. Shared by
    `heldByPeerDetailsFromInspection` and the lifecycle's failed-acquire probe:
    a holder that vanished mid-race converges by retrying, same as 'creating'. */
export const HELD_BY_PEER_CREATING_DETAILS: HeldByPeerDetails = {
  kind: 'held-by-peer',
  phase: 'creating',
  retry_after_ms: LEASE_CREATING_RETRY_AFTER_MS,
};

/**
 * Classify a lease inspection into `held-by-peer` details. Shared by every
 * surface that reports session ownership — the lifecycle's
 * post-acquire-failure probe and kap-server's read-only probes — so all of
 * them classify the same lease the same way. Returns `undefined` when the
 * lease is free; a caller on a failed-acquire path should map that to
 * {@link HELD_BY_PEER_CREATING_DETAILS}.
 */
export function heldByPeerDetailsFromInspection(
  inspection: CrossProcessLockInspection,
): HeldByPeerDetails | undefined {
  if (inspection.state === 'held' && inspection.ownerMetadata !== undefined) {
    const { address } = inspection.ownerMetadata;
    return address !== undefined
      ? { kind: 'held-by-peer', phase: 'routable', address }
      : { kind: 'held-by-peer', phase: 'held-by-local-instance' };
  }
  if (inspection.state === 'creating') {
    return HELD_BY_PEER_CREATING_DETAILS;
  }
  return undefined;
}

export interface SessionLeaseIdentity {
  readonly sessionId: string;
  readonly lockId: string;
}

export interface ISessionLeaseService {
  readonly _serviceBrand: undefined;

  /** The active lease identity; `undefined` once the lease is released. */
  readonly leaseIdentity: SessionLeaseIdentity | undefined;
  /** Hard gate. Throws `Error2(session.lease_lost)` when this instance no
      longer holds the kernel lease — including after `release()`. */
  assertWritable(): void;
}

export const ISessionLeaseService: ServiceIdentifier<ISessionLeaseService> =
  createDecorator<ISessionLeaseService>('sessionLeaseService');

export class SessionLease implements ISessionWriteAdmission, ISessionLeaseService {
  declare readonly _serviceBrand: undefined;

  readonly lockId: string;
  private _released = false;
  private _lost = false;
  private _lossFired = false;
  private _sealed = false;
  private inFlightWrites = 0;
  private readonly drainWaiters = new Set<() => void>();

  constructor(
    readonly sessionId: string,
    private readonly handle: ICrossProcessLockHandle,
    private readonly onLeaseLost: (sessionId: string) => void,
  ) {
    this.lockId = handle.lockId;
  }

  get leaseIdentity(): SessionLeaseIdentity | undefined {
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

  assertCanWriteNow(): void {
    if (this._sealed) throw this.writeAdmissionClosedError();
    this.assertWritable();
  }

  async withPhysicalWrite<T>(io: () => Promise<T>): Promise<T> {
    this.assertCanWriteNow();
    this.inFlightWrites++;
    try {
      return await io();
    } finally {
      this.inFlightWrites--;
      if (this.inFlightWrites === 0) {
        for (const resolve of this.drainWaiters) resolve();
        this.drainWaiters.clear();
      }
    }
  }

  sealAndDrain(): Promise<void> {
    this.sealWrites();
    return this.whenDrained();
  }

  private sealWrites(): void {
    this._sealed = true;
  }

  private whenDrained(): Promise<void> {
    if (this.inFlightWrites === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.add(resolve);
    });
  }

  private writeAdmissionClosedError(): Error2 {
    return new Error2(
      ErrorCodes.SESSION_LEASE_LOST,
      `session ${this.sessionId} write admission is sealed`,
      { details: { sessionId: this.sessionId } },
    );
  }

  private markLost(): void {
    this._lost = true;
    this.sealWrites();
    if (this._lossFired) return;
    this._lossFired = true;
    this.onLeaseLost(this.sessionId);
  }

  release(): void {
    if (this._released) return;
    this.sealWrites();
    this._released = true;
    this.handle.release();
  }
}

export function sessionLeasePath(homeDir: string, sessionId: string): string {
  return join(homeDir, 'session-leases', `${sessionId}.lock`);
}

export function sessionLeaseSeed(lease: SessionLease): ScopeSeed {
  return [
    [ISessionLeaseService as ServiceIdentifier<unknown>, lease],
    [ISessionWriteAdmission as ServiceIdentifier<unknown>, lease],
  ];
}
