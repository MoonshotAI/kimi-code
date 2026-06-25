import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../permissionPolicy';

export class FallbackAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'fallback-ask';

  evaluate(): PermissionPolicyResult {
    return { kind: 'ask' };
  }
}
