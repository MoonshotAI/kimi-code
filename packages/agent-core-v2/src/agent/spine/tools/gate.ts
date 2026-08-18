import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';

export const SPINE_BRANCH_LABEL = 'spineBranch';

export function isSpineControlHost(accessor: ServicesAccessor): boolean {
  const scope = accessor.get(IAgentScopeContext);
  return scope.agentId === 'main' || scope.labels[SPINE_BRANCH_LABEL] === 'true';
}
