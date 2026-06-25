import { IPermissionModeService } from '../../permissionMode/permissionMode';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../permissionPolicy';

export class YoloModeApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'yolo-mode-approve';

  constructor(
    @IPermissionModeService private readonly modeService: IPermissionModeService,
  ) {}

  evaluate(): PermissionPolicyResult | undefined {
    return this.modeService.mode === 'yolo' ? { kind: 'approve' } : undefined;
  }
}
