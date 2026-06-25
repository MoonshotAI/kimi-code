import type { ResolvedToolExecutionHookContext } from '../../../../loop';
import { IPermissionRulesService } from '../../permissionRules/permissionRules';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../permissionPolicy';
import type { PermissionPolicyRuntime } from './runtime';
import { evaluateUserConfiguredRule } from './user-configured-rule';

export class UserConfiguredAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'user-configured-ask';

  constructor(
    private readonly runtime: PermissionPolicyRuntime,
    @IPermissionRulesService private readonly rulesService: IPermissionRulesService,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    return evaluateUserConfiguredRule(context, 'ask', this.rulesService, this.runtime);
  }
}
