import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/actor/toolExecutor/permissionTypes';

export class FallbackAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'fallback-ask';

  evaluate(): PermissionPolicyResult {
    return { kind: 'ask' };
  }
}
