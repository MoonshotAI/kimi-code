/**
 * `session-activity` domain (L6) — session-level idle predicate.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionActivity {
  readonly _serviceBrand: undefined;
  isIdle(): boolean;
}

export const ISessionActivity: ServiceIdentifier<ISessionActivity> =
  createDecorator<ISessionActivity>('sessionActivity');
