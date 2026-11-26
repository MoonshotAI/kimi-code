import type {
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';

export class AutoModeApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'auto-mode-approve';

  evaluate(_context: PermissionPolicyContext, mode: PermissionMode): PermissionPolicyResult | undefined {
    return mode === 'auto' ? { kind: 'approve' } : undefined;
  }
}
