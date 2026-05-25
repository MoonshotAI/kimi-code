import type { PrepareToolExecutionResult, ToolExecutionHookContext } from '../../loop';
import type { ToolInputDisplay } from '../../tools/display';
import type { PermissionRule } from './types';

export interface PermissionPolicyContext extends ToolExecutionHookContext {
  /**
   * The rule matched by `checkPermission()`, if any.
   *
   * Policies that want to defer to user-defined rules (e.g. a default-allow
   * policy that should not override an explicit `ask`/`deny` rule) inspect
   * this to decide whether to fire. `undefined` means the decision came
   * from the built-in default permission table rather than a user rule.
  */
  readonly matchedRule: PermissionRule | undefined;
}

export type PermissionPolicyResult =
  | {
      readonly kind: 'allow';
      readonly executionMetadata?: unknown;
    }
  | ({ readonly kind: 'result' } & PrepareToolExecutionResult)
  | {
      readonly kind: 'ask';
      readonly action?: string | undefined;
      readonly display?: ToolInputDisplay | undefined;
    };

export interface PermissionPolicy {
  readonly name: string;
  evaluate(
    context: PermissionPolicyContext,
  ): PermissionPolicyResult | undefined | Promise<PermissionPolicyResult | undefined>;
}
