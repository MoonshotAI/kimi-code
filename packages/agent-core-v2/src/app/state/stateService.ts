/**
 * `state` domain (L1) — `IStateService` implementation.
 *
 * Thin per-scope binding over the `_base` `StateRegistry`; the container owns
 * construction and disposal, so registered state dies with the scope. Bound
 * at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { StateRegistry } from '#/_base/state/stateRegistry';

import { IStateService } from './state';

export class StateService extends StateRegistry implements IStateService {
  declare readonly _serviceBrand: undefined;
}

registerScopedService(LifecycleScope.App, IStateService, StateService, InstantiationType.Eager, 'state');
