import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentLoopService } from '#/agent/loop/loop';
import { isMissingConfiguredModelError } from '#/agent/profile/errors';
import { IProviderDiscoveryService } from '#/app/kosongConfig/discovery';

export function missingConfiguredModelAlias(agent: IAgentScopeHandle): string | undefined {
  const profile = agent.accessor.get(IAgentLoopService);
  const previous = profile.getModel();
  if (previous === '' || typeof profile.resolveModelContext !== 'function') return undefined;
  try {
    profile.resolveModelContext();
    return undefined;
  } catch (error) {
    if (!isMissingConfiguredModelError(error, previous)) throw error;
    return agent.accessor.get(IProviderDiscoveryService).retiredModelReplacement(previous) === undefined
      ? previous
      : undefined;
  }
}
