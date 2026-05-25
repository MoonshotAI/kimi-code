import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class FallbackAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'fallback-ask';

  evaluate(_context: PermissionPolicyContext): PermissionPolicyResult {
    return {
      kind: 'ask',
    };
  }
}
