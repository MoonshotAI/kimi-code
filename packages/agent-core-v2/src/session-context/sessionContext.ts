/**
 * `session-context` domain (L6) — seeded per-session context token.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { ISessionMetaStore } from '#/records/records';

/** Seeded into the Session scope (not a registered descriptor). */
export interface ISessionContext {
  readonly sessionId: string;
  readonly meta: ISessionMetaStore;
}

export const ISessionContext: ServiceIdentifier<ISessionContext> =
  createDecorator<ISessionContext>('sessionContext');

/** Build the Session-scope seed for `ISessionContext`. */
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
