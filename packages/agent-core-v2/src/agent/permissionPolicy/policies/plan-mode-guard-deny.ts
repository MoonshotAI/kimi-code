import { IAgentPlanService, type IAgentPlanService as AgentPlanService } from '#/agent/plan/plan';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import {
  writesOnlyPlanFile,
} from './path-utils';

export class PlanModeGuardDenyPermissionPolicyService implements PermissionPolicy {
  readonly name = 'plan-mode-guard-deny';

  constructor(@IAgentPlanService private readonly plan: AgentPlanService) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    const plan = await this.plan.status();
    if (plan === null) return undefined;

    const toolName = context.toolCall.name;
    if (toolName === 'Write' || toolName === 'Edit') {
      const planFilePath = plan.path;
      if (planFilePath !== null && writesOnlyPlanFile(context, planFilePath)) return undefined;
      return {
        kind: 'deny',
        message: planModeWriteDeniedMessage(planFilePath),
      };
    }

    if (toolName === 'TaskStop') {
      return {
        kind: 'deny',
        message:
          'TaskStop is not available in plan mode. Call ExitPlanMode to exit plan mode before stopping a background task.',
      };
    }

    if (toolName === 'CronCreate' || toolName === 'CronDelete') {
      return {
        kind: 'deny',
        message:
          `${toolName} is not available in plan mode because it would mutate scheduled work that runs after plan exit. Call ExitPlanMode first.`,
      };
    }

    return undefined;
  }
}

function planModeWriteDeniedMessage(planFilePath: string | null): string {
  return (
    `Plan mode is active. You may only write to the current plan file: ${planFilePath ?? '(no plan file selected yet)'}. ` +
    'Call ExitPlanMode to exit plan mode before editing other files.'
  );
}
