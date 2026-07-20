import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { evaluateUserConfiguredRule } from './user-configured-rule';

export class UserConfiguredAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'user-configured-ask';

  constructor(@IAgentPermissionRulesService private readonly rulesService: IAgentPermissionRulesService) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    return evaluateUserConfiguredRule(context, 'ask', this.rulesService);
  }
}
