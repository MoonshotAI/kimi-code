/**
 * `storage` domain (L1) — `IWriteGateRegistry` implementation.
 *
 * Routes session-rooted storage scopes to the write gate registered by the
 * session lifecycle. Double registration is a bug, missing session gates fail
 * closed, and root or non-session storage scopes execute without a gate.
 * Bound at App scope.
 */

import { BugIndicatingError } from '#/_base/errors/errors';
import { InstantiationType } from '#/_base/di/extensions';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import {
  type ISessionWriteGate,
  IWriteGateRegistry,
} from '#/persistence/interface/writeGate';

export class WriteGateRegistryService implements IWriteGateRegistry {
  declare readonly _serviceBrand: undefined;

  private readonly gates = new Map<string, ISessionWriteGate>();

  register(sessionScope: string, gate: ISessionWriteGate): IDisposable {
    if (this.gates.has(sessionScope)) {
      throw new BugIndicatingError(`write gate already registered for ${sessionScope}`);
    }
    this.gates.set(sessionScope, gate);
    return toDisposable(() => {
      if (this.gates.get(sessionScope) === gate) this.gates.delete(sessionScope);
    });
  }

  async run<T>(scope: string, write: () => Promise<T>): Promise<T> {
    const sessionScope = sessionScopeFromStorageScope(scope);
    if (sessionScope === undefined) return write();
    const gate = this.gates.get(sessionScope);
    if (gate === undefined) {
      throw new Error2(ErrorCodes.SESSION_LEASE_LOST, 'session has no registered write gate', {
        details: { sessionId: sessionScope.slice(sessionScope.lastIndexOf('/') + 1) },
      });
    }
    return gate.run(write);
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
  IWriteGateRegistry,
  WriteGateRegistryService,
  InstantiationType.Eager,
  'storage',
);
