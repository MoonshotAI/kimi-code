import type { PermissionPolicy, PermissionPolicyResult } from '../types';

export class DenyAllPermissionPolicy implements PermissionPolicy {
  readonly name = 'deny-all';

  constructor(private readonly message: string) {}

  evaluate(): PermissionPolicyResult {
    return {
      kind: 'deny',
      message: this.message,
      reason: { source: 'side_question' },
    };
  }
}
