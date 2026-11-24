import type {
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';

export class YoloModeApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'yolo-mode-approve';

  evaluate(_context: PermissionPolicyContext, mode: PermissionMode): PermissionPolicyResult | undefined {
    return mode === 'yolo' ? { kind: 'approve' } : undefined;
  }
}
