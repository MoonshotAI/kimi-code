import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { AgentToolContributionOptions } from '#/agent/toolRegistry/toolContribution';

export function isToolAvailable(
  options: AgentToolContributionOptions,
  accessor: ServicesAccessor,
  runtime: Pick<IAgentRuntimeService, 'isAvailable'>,
): boolean {
  const required = options.requiredRuntimeCapabilities;
  return (required === undefined || runtime.isAvailable(required)) &&
    (options.when?.(accessor) ?? true);
}
