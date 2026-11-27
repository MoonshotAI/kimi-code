import type { IDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes } from '#/errors';

import { ISessionAdmission } from './sessionAdmission';

interface Suspension {
  readonly reason: string;
}

export class SessionAdmissionService implements ISessionAdmission {
  declare readonly _serviceBrand: undefined;

  private readonly suspensions = new Map<string, Set<Suspension>>();

  suspend(sessionIds: readonly string[], reason: string): IDisposable {
    const suspension: Suspension = { reason };
    const ids = [...new Set(sessionIds)];
    for (const id of ids) {
      const held = this.suspensions.get(id) ?? new Set<Suspension>();
      held.add(suspension);
      this.suspensions.set(id, held);
    }
    return {
      dispose: () => {
        for (const id of ids) {
          const held = this.suspensions.get(id);
          if (held === undefined) continue;
          held.delete(suspension);
          if (held.size === 0) this.suspensions.delete(id);
        }
      },
    };
  }

  assertAdmits(sessionId: string): void {
    const held = this.suspensions.get(sessionId);
    if (held === undefined) return;
    const [first] = held;
    if (first === undefined) return;
    throw new Error2(ErrorCodes.SESSION_BUSY, first.reason, { details: { sessionId } });
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionAdmission,
  SessionAdmissionService,
  ScopeActivation.OnDemand,
  'sessionAdmission',
);
