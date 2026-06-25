import type { ResolvedToolExecutionHookContext } from '../../../../loop';
import { IPermissionRulesService } from '../../permissionRules/permissionRules';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../permissionPolicy';
import type { PermissionPolicyRuntime } from './runtime';
import { evaluateUserConfiguredRule } from './user-configured-rule';

export class UserConfiguredAllowPermissionPolicyService implements PermissionPolicy {
  readonly name = 'user-configured-allow';

  constructor(
    private readonly runtime: PermissionPolicyRuntime,
    @IPermissionRulesService private readonly rulesService: IPermissionRulesService,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    return evaluateUserConfiguredRule(context, 'allow', this.rulesService, this.runtime);
  }
}
