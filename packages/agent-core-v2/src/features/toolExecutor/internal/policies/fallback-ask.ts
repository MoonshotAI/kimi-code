import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/features/toolExecutor/permissionTypes';

export class FallbackAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'fallback-ask';

  evaluate(): PermissionPolicyResult {
    return { kind: 'ask' };
  }
}
