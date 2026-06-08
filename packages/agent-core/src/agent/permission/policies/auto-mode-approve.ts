import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyResult } from '../types';

export class AutoModeApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'auto-mode-approve';

  constructor(private readonly agent: Agent) {}

  evaluate(): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'auto') return;
    return {
      kind: 'approve',
    };
  }
}
