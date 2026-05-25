import type { PermissionPolicy, PermissionPolicyResult } from '../policy';

export class FallbackAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'fallback.ask';

  evaluate(): PermissionPolicyResult {
    return { kind: 'ask' };
  }
}
