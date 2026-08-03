import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';

export class YoloModeApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'yolo-mode-approve';

  constructor(
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
  ) {}

  evaluate(): PermissionPolicyResult | undefined {
    return this.modeService.mode === 'yolo' ? { kind: 'approve' } : undefined;
  }
}
