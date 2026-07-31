/**
 * `toolActivation` domain (L4) — `IAgentToolActivationService` contract.
 *
 * Owns the activation pass that turns the module-level `registerAgentToolService`
 * contributions (`toolRegistry`, L3) into entries of the per-agent runtime
 * registry: a contribution activates only when its `when` predicate holds,
 * the workspace os-level veto (`sessionToolPolicyGate`) does not disable it,
 * and its declared `name` is allowed by the bound Profile's tool policy
 * (`profile`, L4). `AgentLifecycleService.create` awaits one activation pass
 * after restore and profile binding, so an Agent's tools reflect the Profile
 * before the first turn. Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentToolActivationService {
  readonly _serviceBrand: undefined;

  /**
   * Idempotent: instantiates and registers every contribution that is allowed
   * by the current Profile and not yet registered. Never unregisters —
   * restriction stays the request-time tool policy's job.
   */
  activate(): Promise<void>;
}

export const IAgentToolActivationService =
  createDecorator<IAgentToolActivationService>('agentToolActivationService');
