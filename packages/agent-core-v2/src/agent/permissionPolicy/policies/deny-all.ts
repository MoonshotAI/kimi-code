import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';

const DEFAULT_MESSAGE = 'Tool calls are disabled for this agent.';

export class DenyAllPermissionPolicyService implements PermissionPolicy {
  readonly name = 'deny-all';

  constructor(private readonly message: string = DEFAULT_MESSAGE) {}

  evaluate(): PermissionPolicyResult {
    return { kind: 'deny', message: this.message };
  }
}
