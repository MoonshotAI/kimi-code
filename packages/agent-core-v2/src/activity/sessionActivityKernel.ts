/**
 * `activity` domain (L4) — `ISessionActivityKernel` implementation.
 *
 * Owns the Session activity lane (`restoring → active ⇄ quiescing → closing →
 * disposed`) and the admission table that the Agent kernel consults on every
 * `begin` (child-injects-parent). `restoring` covers the materialize / replay
 * window (the half-initialized handle of矛盾 j): the lifecycle drives the
 * `restoring → active` transition via `markActive()` once the session is ready.
 * `quiesce()` atomically flips to `quiescing` (closing the door so subsequent
 * `admitTurn` calls reject with `activity.session_rejected`) and awaits every
 * in-flight lease to drain — this eliminates the fork check-then-act race
 * (矛盾 k). `beginClosing()` starts the close/archive cascade; `settled()`
 * resolves once every admitted lease has returned. The lane is mirrored to the
 * live-only `sessionActivityLane` wire Model for the derived `ISessionActivity`
 * read model. Bound at Session scope.
 */

import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ErrorCodes, Error2 } from '#/errors';

import type {
  ActivityLease,
  SessionCommand,
  SessionLane,
  SessionQuiesceLease,
} from './activity';
import { ISessionActivityKernel } from './activity';

export class SessionActivityKernel extends Disposable implements ISessionActivityKernel {
  declare readonly _serviceBrand: undefined;

  private _lane: SessionLane = 'restoring';
  private readonly leases = new Map<string, ActivityLease>();
  private readonly settleWaiters: Array<() => void> = [];

  constructor() {
    super();
  }

  lane(): SessionLane {
    return this._lane;
  }

  canAccept(command: SessionCommand): boolean {
    switch (this._lane) {
      case 'active':
        return true;
      case 'restoring':
        return command === 'agent.create';
      default:
        return false;
    }
  }

  admitTurn(agentId: string, lease: ActivityLease): IDisposable {
    if (this._lane !== 'active') {
      throw new Error2(
        ErrorCodes.ACTIVITY_SESSION_REJECTED,
        `Session is ${this._lane}; turn begin rejected`,
        { details: { lane: this._lane, agentId } },
      );
    }
    const key = `${agentId}:${lease.turnId}`;
    this.leases.set(key, lease);
    this.publishLane();
    return toDisposable(() => {
      this.leases.delete(key);
      this.publishLane();
      this.maybeSettle();
    });
  }

  quiesce(reason: string): Promise<SessionQuiesceLease> {
    if (this._lane !== 'active') {
      return Promise.reject(
        new Error2(
          ErrorCodes.ACTIVITY_SESSION_REJECTED,
          `Cannot quiesce while ${this._lane}`,
          { details: { lane: this._lane } },
        ),
      );
    }
    this._lane = 'quiescing';
    this.publishLane();
    return this.settled().then(() => {
      let released = false;
      return {
        reason,
        dispose: () => {
          if (released) return;
          released = true;
          if (this._lane === 'quiescing') {
            this._lane = 'active';
            this.publishLane();
          }
        },
      };
    });
  }

  beginClosing(): void {
    if (this._lane === 'closing' || this._lane === 'disposed') return;
    this._lane = 'closing';
    this.publishLane();
    this.maybeSettle();
  }

  markActive(): void {
    if (this._lane !== 'restoring') return;
    this._lane = 'active';
    this.publishLane();
  }

  settled(): Promise<void> {
    if (this.leases.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.settleWaiters.push(resolve);
    });
  }

  private maybeSettle(): void {
    if (this.leases.size > 0) return;
    if (this._lane === 'closing') {
      this._lane = 'disposed';
      this.publishLane();
    }
    if (this.settleWaiters.length === 0) return;
    const waiters = this.settleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private publishLane(): void {
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionActivityKernel,
  SessionActivityKernel,
  InstantiationType.Delayed,
  'activity',
);
