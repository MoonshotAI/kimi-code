/**
 * `activity` domain (L4) — `ISessionActivityKernel` implementation (PR1 placeholder).
 *
 * PR1 only needs the Session kernel to exist so the Agent kernel can consult it
 * on `begin`; the real lifecycle lane machine (`restoring → active ⇄ quiescing
 * → closing → disposed`), the admission table and `quiesce` arrive in PR3. This
 * placeholder is always `active`: `canAccept` admits every command, `admitTurn`
 * registers the lease for settle tracking and never rejects, and `quiesce` /
 * `settled` resolve immediately. Lease registration is kept so the PR3 swap is
 * a behavior change rather than a structural one. Bound at Session scope.
 */

import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import type {
  ActivityLease,
  SessionCommand,
  SessionLane,
  SessionQuiesceLease,
} from './activity';
import { ISessionActivityKernel } from './activity';

export class SessionActivityKernel extends Disposable implements ISessionActivityKernel {
  declare readonly _serviceBrand: undefined;

  private readonly leases = new Set<ActivityLease>();

  lane(): SessionLane {
    return 'active';
  }

  markActive(): void {
    // Placeholder kernel is already active.
  }

  canAccept(_command: SessionCommand): boolean {
    return true;
  }

  admitTurn(_agentId: string, lease: ActivityLease): IDisposable {
    this.leases.add(lease);
    return toDisposable(() => {
      this.leases.delete(lease);
    });
  }

  quiesce(reason: string): Promise<SessionQuiesceLease> {
    return Promise.resolve({ reason, dispose: () => undefined });
  }

  beginClosing(): void {
    // PR3 drives the closing cascade.
  }

  settled(): Promise<void> {
    return Promise.resolve();
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionActivityKernel,
  SessionActivityKernel,
  InstantiationType.Delayed,
  'activity',
);
