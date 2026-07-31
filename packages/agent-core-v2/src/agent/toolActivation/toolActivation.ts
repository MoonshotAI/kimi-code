/**
 * `toolActivation` domain — `IAgentToolActivationService` contract.
 *
 * Owns the activation pass that turns the module-level `registerAgentToolService`
 * contributions (`toolRegistry`, L3) into entries of the per-agent runtime
 * registry: a contribution activates only when its `when` predicate holds,
 * the workspace os-level veto (`sessionToolPolicyGate`) does not disable it,
 * and its declared `name` is allowed by the bound Profile's tool policy
 * (`profile`, L4). One activation pass runs after restore and profile
 * binding, so an Agent's tools reflect the Profile before the first turn. Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentToolActivationService {
  readonly _serviceBrand: undefined;

  activate(): Promise<void>;
}

export const IAgentToolActivationService =
  createDecorator<IAgentToolActivationService>('agentToolActivationService');
