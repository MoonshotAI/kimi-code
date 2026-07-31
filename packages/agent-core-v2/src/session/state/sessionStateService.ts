/**
 * `state` domain — `ISessionStateService` implementation.
 *
 * Thin per-scope binding over the `_base` `StateRegistry`; the container owns
 * construction and disposal, so registered state dies with the scope. Injects
 * the Workspace-tier state service as its `inspect()` cascade parent (the
 * parameter is optional so tests can construct a bare container; DI always
 * injects). Bound at Session scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { StateRegistry } from '#/_base/state/stateRegistry';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';

import { ISessionStateService } from './sessionState';

export class SessionStateService extends StateRegistry implements ISessionStateService {
  declare readonly _serviceBrand: undefined;
  protected override readonly inspectScope = 'session';

  constructor(@IWorkspaceStateService workspaceState?: IWorkspaceStateService) {
    super();
    this.inspectParent = workspaceState;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionStateService,
  SessionStateService,
  ScopeActivation.OnScopeCreated,
  'state',
);
