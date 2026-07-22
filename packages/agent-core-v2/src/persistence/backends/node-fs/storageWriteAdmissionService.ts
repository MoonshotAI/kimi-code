/**
 * `storage` domain (L1) — `IStorageWriteAdmission` implementation.
 *
 * Routes session-rooted storage scopes to admissions registered by session
 * lifecycle. Double registration is a bug, missing session admissions fail
 * closed, and root or non-session storage scopes execute directly. Bound at
 * App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { BugIndicatingError } from '#/_base/errors/errors';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import type { ISessionWriteAdmission } from '#/persistence/interface/sessionWriteAdmission';
import { IStorageWriteAdmission } from '#/persistence/interface/storageWriteAdmission';

export class StorageWriteAdmissionService implements IStorageWriteAdmission {
  declare readonly _serviceBrand: undefined;

  private readonly admissions = new Map<string, ISessionWriteAdmission>();

  registerSession(sessionScope: string, admission: ISessionWriteAdmission): IDisposable {
    if (this.admissions.has(sessionScope)) {
      throw new BugIndicatingError(`write admission already registered for ${sessionScope}`);
    }
    this.admissions.set(sessionScope, admission);
    return toDisposable(() => {
      if (this.admissions.get(sessionScope) === admission) this.admissions.delete(sessionScope);
    });
  }

  assertCanWriteNow(scope: string): void {
    this.admissionFor(scope)?.assertCanWriteNow();
  }

  async withPhysicalWrite<T>(scope: string, io: () => Promise<T>): Promise<T> {
    const admission = this.admissionFor(scope);
    return admission === undefined ? io() : admission.withPhysicalWrite(io);
  }

  private admissionFor(scope: string): ISessionWriteAdmission | undefined {
    const sessionScope = sessionScopeFromStorageScope(scope);
    if (sessionScope === undefined) return undefined;
    const admission = this.admissions.get(sessionScope);
    if (admission === undefined) {
      throw new Error2(ErrorCodes.SESSION_LEASE_LOST, 'session has no registered write admission', {
        details: { sessionId: sessionScope.slice(sessionScope.lastIndexOf('/') + 1) },
      });
    }
    return admission;
  }
}

function sessionScopeFromStorageScope(scope: string): string | undefined {
  if (scope === '') return undefined;
  const parts = scope.split('/');
  if (
    parts.length < 3 ||
    parts[0] !== 'sessions' ||
    parts[1] === '' ||
    parts[2] === undefined ||
    parts[2] === ''
  ) {
    return undefined;
  }
  return parts.slice(0, 3).join('/');
}

registerScopedService(
  LifecycleScope.App,
  IStorageWriteAdmission,
  StorageWriteAdmissionService,
  InstantiationType.Eager,
  'storage',
);
