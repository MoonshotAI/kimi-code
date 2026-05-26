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

export class UserConfiguredDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'user-configured-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const match = firstMatchingRule(this.agent, context, 'deny');
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

export class UserConfiguredAllowPermissionPolicy implements PermissionPolicy {
  readonly name = 'user-configured-allow';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const match = firstMatchingRule(this.agent, context, 'allow');
    if (match === undefined) return;
    return {
      kind: 'approve',
      reason: userRuleReason('allow', match),
    };
  }
}

export class UserConfiguredAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'user-configured-ask';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const match = firstMatchingRule(this.agent, context, 'ask');
    if (match === undefined) return;
    return {
      kind: 'ask',
      reason: userRuleReason('ask', match),
    };
  }
}

function firstMatchingRule(
  agent: Agent,
  context: PermissionPolicyContext,
  decision: PermissionRuleDecision,
): PermissionRuleMatch | undefined {
  const rules = agent.permission.data().rules.filter((rule): rule is PermissionRule =>
    USER_CONFIGURED_SCOPES.has(rule.scope),
  );
  for (const rule of rules) {
    if (rule.decision !== decision) continue;
    const match = matchPermissionRule({
      rule,
      toolName: context.toolCall.name,
      args: context.args,
      execution: context.execution,
    });
    if (match !== undefined) return match;
  }
  return;
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
