import type { ResolvedToolExecutionHookContext } from '../../../../loop';
import { matchPermissionRule } from '../../../../agent/permission/matches-rule';
import { IPermissionRulesService } from '../../permissionRules/permissionRules';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../permissionPolicy';

export class SessionApprovalHistoryPermissionPolicyService implements PermissionPolicy {
  readonly name = 'session-approval-history';

  constructor(
    @IPermissionRulesService private readonly rulesService: IPermissionRulesService,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    for (const pattern of this.rulesService.sessionApprovalRulePatterns) {
      const match = matchPermissionRule({
        rule: {
          decision: 'allow',
          scope: 'session-runtime',
          pattern,
          reason: 'approve for session',
        },
        toolName: context.toolCall.name,
        execution: context.execution,
      });
      if (match !== undefined) {
        return {
          kind: 'approve',
          reason: {
            has_rule_args: match.hasRuleArgs,
            match_strategy: match.strategy,
          },
        };
      }
    }
    return undefined;
  }
}
