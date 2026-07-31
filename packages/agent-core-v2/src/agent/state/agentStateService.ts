/**
 * `state` domain (L1) — `IAgentStateService` implementation.
 *
 * Thin per-scope binding over the `_base` `StateRegistry`; the container owns
 * construction and disposal, so registered state dies with the scope. Injects
 * the Session-tier state service as its `inspect()` cascade parent (the
 * parameter is optional so tests can construct a bare container; DI always
 * injects). Bound at Agent scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { StateRegistry } from '#/_base/state/stateRegistry';
import { ISessionStateService } from '#/session/state/sessionState';

import { IAgentStateService } from './agentState';

export class AgentStateService extends StateRegistry implements IAgentStateService {
  declare readonly _serviceBrand: undefined;
  protected override readonly inspectScope = 'agent';

  constructor(@ISessionStateService sessionState?: ISessionStateService) {
    super();
    this.inspectParent = sessionState;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentStateService,
  AgentStateService,
  ScopeActivation.OnScopeCreated,
  'state',
);
