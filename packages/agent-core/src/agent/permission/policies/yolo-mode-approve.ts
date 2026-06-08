import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyResult } from '../types';

export class YoloModeApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'yolo-mode-approve';

  constructor(private readonly agent: Agent) {}

  evaluate(): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'yolo') return;
    return {
      kind: 'approve',
    };
  }
}
