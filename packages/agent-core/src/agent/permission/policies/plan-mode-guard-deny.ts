import type { Agent } from '../..';
import type { ToolResourceAccess } from '../../../loop/tool-access';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class PlanModeGuardDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'plan-mode-guard-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (!this.agent.planMode.isActive) return;

    const toolName = context.toolCall.name;
    if (toolName === 'Write' || toolName === 'Edit') {
      const planFilePath = this.agent.planMode.planFilePath;
      if (planFilePath === null) {
        return {
          kind: 'deny',
          message: planModeWriteDeniedMessage(planFilePath),
        };
      }
      if (writesOnlyPlanFile(context, planFilePath)) {
        return;
      }
      return {
        kind: 'deny',
        message: planModeWriteDeniedMessage(planFilePath),
      };
    }

    if (toolName !== 'TaskStop') return;
    return {
      kind: 'deny',
      message:
        'TaskStop is not available in plan mode. Call ExitPlanMode to exit plan mode before stopping a background task.',
    };
  }
}

function writesOnlyPlanFile(
  context: PermissionPolicyContext,
  planFilePath: string,
): boolean {
  const writeAccesses =
    context.execution.accesses?.filter(
      (access): access is FileAccess =>
        access.kind === 'file' &&
        (access.operation === 'write' || access.operation === 'readwrite'),
    ) ?? [];
  if (writeAccesses.length === 0) return false;
  return writeAccesses.every((access) => access.path === planFilePath);
}

type FileAccess = Extract<ToolResourceAccess, { kind: 'file' }>;

function planModeWriteDeniedMessage(planFilePath: string | null): string {
  return (
    `Plan mode is active. You may only write to the current plan file: ${planFilePath ?? '(no plan file selected yet)'}. ` +
    'Call ExitPlanMode to exit plan mode before editing other files.'
  );
}
