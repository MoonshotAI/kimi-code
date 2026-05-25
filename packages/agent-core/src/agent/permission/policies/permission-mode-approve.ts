import type { Agent } from '../..';
import { isDefaultAutoAllowTool } from '../../../tools/policies/default-permissions';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../policy';

export class PermissionModeApprovePolicy implements PermissionPolicy {
  readonly name = 'system.approve.permission-mode';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const mode = this.agent.permission.mode;
    if (mode !== 'yolo' && mode !== 'auto') return undefined;
    const name = context.toolCall.function.name;
    if (isDefaultAutoAllowTool(name)) return undefined;
    this.agent.telemetry.track('tool_approved', {
      tool_name: name,
      approval_mode: mode === 'auto' ? 'afk' : 'yolo',
    });
    return { kind: 'allow' };
  }
}
