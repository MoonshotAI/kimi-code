/**
 * `session-context` domain (L6) — seeded per-session context token.
 *
 * Defines the `ISessionContext` contract carrying the session id and the session
 * `meta` store, and the `sessionContextSeed` helper that seeds it into a Session
 * scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { ISessionMetaStore } from '#/records/records';

export interface ISessionContext {
  readonly sessionId: string;
  readonly meta: ISessionMetaStore;
}

export const ISessionContext: ServiceIdentifier<ISessionContext> =
  createDecorator<ISessionContext>('sessionContext');

export function sessionContextSeed(
  sessionId: string,
  meta: ISessionMetaStore,
): ScopeSeed {
  return [
    [
      ISessionContext as ServiceIdentifier<unknown>,
      { sessionId, meta } satisfies ISessionContext,
    ],
  ];
}
