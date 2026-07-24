/**
 * `state` domain (L1) — `IAgentStateService` implementation.
 *
 * Thin per-scope binding over the `_base` `StateRegistry`; the container owns
 * construction and disposal, so registered state dies with the scope. Bound
 * at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { StateRegistry } from '#/_base/state/stateRegistry';

import { IAgentStateService } from './agentState';

export class AgentStateService extends StateRegistry implements IAgentStateService {
  declare readonly _serviceBrand: undefined;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentStateService,
  AgentStateService,
  InstantiationType.Eager,
  'state',
);
