import type { Agent } from '../..';
import {
  matchPermissionRule,
  type PermissionRuleMatch,
} from '../matches-rule';
import type {
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResult,
  PermissionRule,
  PermissionRuleDecision,
  PermissionRuleScope,
} from '../types';

const USER_CONFIGURED_SCOPES = new Set<PermissionRuleScope>([
  'turn-override',
  'project',
  'user',
]);

abstract class UserConfiguredPermissionPolicy {
  constructor(protected readonly agent: Agent) {}

  protected firstMatchingRule(
    context: PermissionPolicyContext,
    decision: PermissionRuleDecision,
  ): PermissionRuleMatch | undefined {
    const rules = this.agent.permission.data().rules.filter((rule): rule is PermissionRule =>
      USER_CONFIGURED_SCOPES.has(rule.scope),
    );
    for (const rule of rules) {
      if (rule.decision !== decision) continue;
      const match = matchPermissionRule({
        rule,
        toolName: context.toolCall.name,
        execution: context.execution,
      });
      if (match !== undefined) return match;
    }
    return;
  }
}

export class UserConfiguredDenyPermissionPolicy
  extends UserConfiguredPermissionPolicy
  implements PermissionPolicy
{
  readonly name = 'user-configured-deny';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const match = this.firstMatchingRule(context, 'deny');
    if (match === undefined) return;
    return {
      kind: 'deny',
      reason: userRuleReason('deny', match),
      message: formatPermissionRuleDenyMessage(
        context.toolCall.name,
        match.rule.reason,
        this.agent.type,
      ),
    };
  }
}

export class UserConfiguredAllowPermissionPolicy
  extends UserConfiguredPermissionPolicy
  implements PermissionPolicy
{
  readonly name = 'user-configured-allow';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const match = this.firstMatchingRule(context, 'allow');
    if (match === undefined) return;
    return {
      kind: 'approve',
      reason: userRuleReason('allow', match),
    };
  }
}

export class UserConfiguredAskPermissionPolicy
  extends UserConfiguredPermissionPolicy
  implements PermissionPolicy
{
  readonly name = 'user-configured-ask';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const match = this.firstMatchingRule(context, 'ask');
    if (match === undefined) return;
    return {
      kind: 'ask',
      reason: userRuleReason('ask', match),
    };
  }
}

function userRuleReason(decision: PermissionRuleDecision, match: PermissionRuleMatch) {
  return {
    rule_decision: decision,
    has_rule_args: match.hasRuleArgs,
    match_strategy: match.strategy,
  };
}

function formatPermissionRuleDenyMessage(
  tool: string,
  reason: string | undefined,
  agentType?: Agent['type'],
): string {
  const suffix = reason !== undefined && reason.length > 0 ? ` Reason: ${reason}` : '';
  if (agentType === 'sub') {
    return `Tool "${tool}" was denied.${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
  }
  return `Tool "${tool}" was denied by permission rule.${suffix}`;
}
