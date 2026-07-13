import { IAgentPlanService, type IAgentPlanService as AgentPlanService } from '#/agent/plan/plan';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { writesOnlyPlanFile } from './path-utils';

export class PlanModeToolApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'plan-mode-tool-approve';

  constructor(@IAgentPlanService private readonly plan: AgentPlanService) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    const toolName = context.toolCall.name;
    if (toolName === 'EnterPlanMode') return { kind: 'approve' };

    const plan = await this.plan.status();
    const planFilePath = plan?.path ?? null;
    if (
      (toolName === 'Write' || toolName === 'Edit') &&
      plan !== null &&
      planFilePath !== null &&
      writesOnlyPlanFile(context, planFilePath)
    ) {
      return { kind: 'approve' };
    }

    if (toolName === 'ExitPlanMode') {
      if (plan === null) return { kind: 'approve' };
      if (context.execution.display?.kind !== 'plan_review') return { kind: 'approve' };
      if (context.execution.display.plan.trim().length === 0) return { kind: 'approve' };
    }

    return undefined;
  }
}
