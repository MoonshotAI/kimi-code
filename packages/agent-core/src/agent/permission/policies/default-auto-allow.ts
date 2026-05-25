import { isDefaultAutoAllowTool } from '../../../tools/policies/default-permissions';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../policy';

export class DefaultAutoAllowPermissionPolicy implements PermissionPolicy {
  readonly name = 'system.approve.default-auto-allow';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (!isDefaultAutoAllowTool(context.toolCall.function.name)) return undefined;
    return { kind: 'allow' };
  }
}
