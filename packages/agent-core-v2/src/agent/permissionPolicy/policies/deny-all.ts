import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';

const DEFAULT_MESSAGE = 'Tool calls are disabled for this agent.';

/**
 * Permission policy that denies every tool call with a fixed message.
 *
 * Used to construct "side question" agents (see `startBtw`) whose loop tools
 * are kept visible for prompt-cache parity but must never execute: the model
 * answers from projected history with text only.
 */
export class DenyAllPermissionPolicyService implements PermissionPolicy {
  readonly name = 'deny-all';

  constructor(private readonly message: string = DEFAULT_MESSAGE) {}

  evaluate(): PermissionPolicyResult {
    return { kind: 'deny', message: this.message };
  }
}
