import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { AgentToolContributionOptions } from '#/agent/toolRegistry/toolContribution';

export function isToolAvailable(
  options: AgentToolContributionOptions,
  accessor: ServicesAccessor,
): boolean {
  return options.when?.(accessor) ?? true;
}
