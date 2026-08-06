/**
 * `state` domain — `IAppStateService` implementation.
 *
 * Thin per-scope binding over the `_base` `StateRegistry`; the container owns
 * construction and disposal, so registered state dies with the scope. The
 * root of the four-tier `inspect()` cascade — the only tier without an
 * `inspectParent`. Bound at App scope.
 */

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { StateRegistry } from '#/_base/state/stateRegistry';

import { IAppStateService } from './appState';

export class AppStateService extends StateRegistry implements IAppStateService {
  declare readonly _serviceBrand: undefined;
  protected override readonly inspectScope = 'app';
}

registerScopedService(
  LifecycleScope.App,
  IAppStateService,
  AppStateService,
  ScopeActivation.OnScopeCreated,
  'state',
);
