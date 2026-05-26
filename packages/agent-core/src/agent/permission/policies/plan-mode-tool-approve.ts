import type { Agent } from '../..';
import type { ToolResourceAccess } from '../../../loop/tool-access';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class PlanModeToolApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'plan-mode-tool-approve';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const toolName = context.toolCall.name;
    if (toolName === 'EnterPlanMode') {
      return {
        kind: 'approve',
      };
    }

    if (
      this.agent.planMode.isActive &&
      (toolName === 'Write' || toolName === 'Edit') &&
      writesOnlyPlanFile(context, this.agent.planMode.planFilePath)
    ) {
      return {
        kind: 'approve',
      };
    }

    if (toolName !== 'ExitPlanMode') return;
    if (context.execution.display?.kind !== 'plan_review') {
      return {
        kind: 'approve',
      };
    }
    if (context.execution.display.plan.trim().length > 0) return;
    return {
      kind: 'approve',
    };
  }
}

type FileAccess = Extract<ToolResourceAccess, { kind: 'file' }>;

function writesOnlyPlanFile(
  context: PermissionPolicyContext,
  planFilePath: string | null,
): boolean {
  if (planFilePath === null) return false;
  const writeAccesses =
    context.execution.accesses?.filter(
      (access): access is FileAccess =>
        access.kind === 'file' &&
        (access.operation === 'write' || access.operation === 'readwrite'),
    ) ?? [];
  if (writeAccesses.length === 0) return false;
  return writeAccesses.every((access) => access.path === planFilePath);
}
