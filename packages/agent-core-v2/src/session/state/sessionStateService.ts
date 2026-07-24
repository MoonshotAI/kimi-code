/**
 * `state` domain (L1) — `ISessionStateService` implementation.
 *
 * Thin per-scope binding over the `_base` `StateRegistry`; the container owns
 * construction and disposal, so registered state dies with the scope. Bound
 * at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { StateRegistry } from '#/_base/state/stateRegistry';

import { ISessionStateService } from './sessionState';

export class SessionStateService extends StateRegistry implements ISessionStateService {
  declare readonly _serviceBrand: undefined;
}

registerScopedService(
  LifecycleScope.Session,
  ISessionStateService,
  SessionStateService,
  InstantiationType.Eager,
  'state',
);
