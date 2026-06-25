import type { ResolvedToolExecutionHookContext } from '../../../../loop';
import { IPermissionRulesService } from '../../permissionRules/permissionRules';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../permissionPolicy';
import type { PermissionPolicyRuntime } from './runtime';
import { evaluateUserConfiguredRule } from './user-configured-rule';

export class UserConfiguredDenyPermissionPolicyService implements PermissionPolicy {
  readonly name = 'user-configured-deny';

  constructor(
    private readonly runtime: PermissionPolicyRuntime,
    @IPermissionRulesService private readonly rulesService: IPermissionRulesService,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    return evaluateUserConfiguredRule(context, 'deny', this.rulesService, this.runtime);
  }
}
