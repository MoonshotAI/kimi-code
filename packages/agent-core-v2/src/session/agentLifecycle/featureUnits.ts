import type { AgentMachineSelf } from '#human/agent/machine';
import type { AgentEventStore } from '#human/agent/slices';
import { featureSpecs, mountAgentFeatures } from '#human/feature/index';
import type { EffectScope, UnitHandle } from '#human/kernel/index';

export interface MountAgentFeatureUnitsOptions {
  readonly self: AgentMachineSelf;
  readonly store: AgentEventStore;
  readonly sessionId: string;
  readonly agentId: string;
  readonly scope: EffectScope;
}

export function mountAgentFeatureUnits(options: MountAgentFeatureUnitsOptions): UnitHandle {
  return mountAgentFeatures({
    self: options.self,
    store: options.store,
    sessionId: options.sessionId,
    agentId: options.agentId,
    features: featureSpecs,
    scope: options.scope,
  });
}
