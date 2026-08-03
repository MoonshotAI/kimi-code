import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';

export class FallbackAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'fallback-ask';

  evaluate(): PermissionPolicyResult {
    return { kind: 'ask' };
  }
}
