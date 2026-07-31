/**
 * `state` domain (L1) — `IWorkspaceStateService` implementation.
 *
 * Thin per-scope binding over the `_base` `StateRegistry`; the container owns
 * construction and disposal, so registered state dies with the scope. Injects
 * the App-tier state service as its `inspect()` cascade parent (the parameter
 * is optional so tests can construct a bare container; DI always injects).
 * Bound at Workspace scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { StateRegistry } from '#/_base/state/stateRegistry';
import { IAppStateService } from '#/app/state/appState';

import { IWorkspaceStateService } from './workspaceState';

export class WorkspaceStateService extends StateRegistry implements IWorkspaceStateService {
  declare readonly _serviceBrand: undefined;
  protected override readonly inspectScope = 'workspace';

  constructor(@IAppStateService appState?: IAppStateService) {
    super();
    this.inspectParent = appState;
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceStateService,
  WorkspaceStateService,
  ScopeActivation.OnScopeCreated,
  'state',
);
