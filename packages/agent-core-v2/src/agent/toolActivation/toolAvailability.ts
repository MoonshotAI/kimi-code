import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import type { AgentToolContributionOptions } from '#/agent/toolRegistry/toolContribution';

export function isToolAvailable(
  options: AgentToolContributionOptions,
  accessor: ServicesAccessor,
  environment: Pick<IAgentEnvironmentService, 'isAvailable' | 'inspect'>,
): boolean {
  const required = options.requiredEnvironmentCapabilities;
  if (required !== undefined && !environment.isAvailable(required)) {
    try {
      if (typeof environment.inspect().connect !== 'function') return false;
    } catch {
      return false;
    }
  }
  return options.when?.(accessor) ?? true;
}
