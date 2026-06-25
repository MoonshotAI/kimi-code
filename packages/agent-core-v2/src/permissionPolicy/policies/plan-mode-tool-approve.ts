import type { ResolvedToolExecutionHookContext } from '../../../../loop';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../permissionPolicy';
import { writesOnlyPlanFile } from './path-utils';
import type { PermissionPolicyRuntime } from './runtime';

export class PlanModeToolApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'plan-mode-tool-approve';

  constructor(private readonly runtime: PermissionPolicyRuntime) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    const toolName = context.toolCall.name;
    if (toolName === 'EnterPlanMode') return { kind: 'approve' };

    const planFilePath = this.runtime.planFilePath();
    if (
      (toolName === 'Write' || toolName === 'Edit') &&
      this.runtime.planModeActive() &&
      planFilePath !== null &&
      writesOnlyPlanFile(context, planFilePath)
    ) {
      return { kind: 'approve' };
    }

    if (toolName === 'ExitPlanMode') {
      if (!this.runtime.planModeActive()) return { kind: 'approve' };
      if (context.execution.display?.kind !== 'plan_review') return { kind: 'approve' };
      if (context.execution.display.plan.trim().length === 0) return { kind: 'approve' };
    }

    return undefined;
  }
}
