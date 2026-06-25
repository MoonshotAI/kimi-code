import { IPermissionModeService } from '../../permissionMode/permissionMode';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../permissionPolicy';

export class AutoModeApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'auto-mode-approve';

  constructor(
    @IPermissionModeService private readonly modeService: IPermissionModeService,
  ) {}

  evaluate(): PermissionPolicyResult | undefined {
    return this.modeService.mode === 'auto' ? { kind: 'approve' } : undefined;
  }
}
