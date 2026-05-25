import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../policy';
import type { PermissionRule, PermissionRuleScope } from '../types';
import {
  firstMatchingRuleDecision,
  formatPermissionRuleDenyMessage,
  genericInputDisplay,
} from './utils';

const USER_CONFIGURED_SCOPES = new Set<PermissionRuleScope>([
  'turn-override',
  'project',
  'user',
]);

export class UserConfiguredPermissionRulesPolicy implements PermissionPolicy {
  readonly name = 'user.configured-rules';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (
      context.matchedRule !== undefined &&
      USER_CONFIGURED_SCOPES.has(context.matchedRule.scope)
    ) {
      return permissionRuleResult(context, context.matchedRule.decision, context.matchedRule);
    }

    const rules = this.agent.permission.rules.filter((rule): rule is PermissionRule =>
      USER_CONFIGURED_SCOPES.has(rule.scope),
    );
    const match = firstMatchingRuleDecision(rules, this.agent, context);
    if (match === undefined) return undefined;

    return permissionRuleResult(context, match.decision, match.rule);
  }
}

function permissionRuleResult(
  context: PermissionPolicyContext,
  decision: PermissionRule['decision'],
  rule: PermissionRule,
): PermissionPolicyResult {
  const name = context.toolCall.function.name;
  switch (decision) {
    case 'deny':
      return {
        kind: 'result',
        block: true,
        reason: formatPermissionRuleDenyMessage(name, rule.reason),
      };
    case 'ask':
      return {
        kind: 'ask',
        action: `Approve ${name} due to permission rule`,
        display: genericInputDisplay(`Approve ${name}`, {
          rule: rule.pattern,
          reason: rule.reason,
          args: context.args,
        }),
      };
    case 'allow':
      return { kind: 'allow' };
  }
}
