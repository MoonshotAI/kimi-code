/**
 * `session-activity` domain (L6) — session-level idle predicate.
 *
 * Defines the public contract of session activity: the `ISessionActivity` used
 * to query whether the session is idle. Session-scoped — one instance per
 * session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionActivity {
  readonly _serviceBrand: undefined;
  isIdle(): boolean;
}

export const ISessionActivity: ServiceIdentifier<ISessionActivity> =
  createDecorator<ISessionActivity>('sessionActivity');
