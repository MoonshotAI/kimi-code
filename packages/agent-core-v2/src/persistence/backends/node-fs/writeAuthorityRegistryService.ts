/**
 * `storage` domain (L1) — `IWriteAuthorityRegistry` implementation.
 *
 * A plain `sessionId → ISessionWriteAuthority` map with no storage or
 * filesystem dependencies: the session lifecycle registers an authority when
 * the session's lease is acquired and disposes the registration when the
 * lease is released, and the `AppendLogStore` resolves authorities at drain /
 * rewrite time. Double registration for the same session is a bug (two live
 * writers for one session must never coexist), so it throws a
 * `BugIndicatingError` instead of replacing. Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { BugIndicatingError } from '#/_base/errors/errors';
import {
  type ISessionWriteAuthority,
  IWriteAuthorityRegistry,
} from '#/persistence/interface/writeAuthority';

export class WriteAuthorityRegistryService implements IWriteAuthorityRegistry {
  declare readonly _serviceBrand: undefined;

  private readonly authorities = new Map<string, ISessionWriteAuthority>();

  register(authority: ISessionWriteAuthority): IDisposable {
    if (this.authorities.get(authority.sessionId) !== undefined) {
      throw new BugIndicatingError(
        `write authority already registered for session ${authority.sessionId}`,
      );
    }
    this.authorities.set(authority.sessionId, authority);
    return toDisposable(() => {
      if (this.authorities.get(authority.sessionId) === authority) {
        this.authorities.delete(authority.sessionId);
      }
    });
  }

  resolve(sessionId: string): ISessionWriteAuthority | undefined {
    return this.authorities.get(sessionId);
  }
}

registerScopedService(
  LifecycleScope.App,
  IWriteAuthorityRegistry,
  WriteAuthorityRegistryService,
  InstantiationType.Eager,
  'storage',
);
