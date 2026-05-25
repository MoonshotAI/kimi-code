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
} from '../types';

export class SessionApprovalHistoryPermissionPolicy implements PermissionPolicy {
  readonly name = 'session-approval-history';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const match = matchSessionApprovalRule(this.agent, context);
    if (match === undefined) return undefined;
    return {
      kind: 'approve',
      reason: {
        has_rule_args: match.hasRuleArgs,
        match_strategy: match.strategy,
      },
    };
  }
}

function matchSessionApprovalRule(
  agent: Agent,
  context: PermissionPolicyContext,
): PermissionRuleMatch | undefined {
  for (const pattern of agent.permission.sessionApprovalRulePatterns()) {
    const match = matchPermissionRule({
      rule: sessionApprovalRule(pattern),
      toolName: context.toolCall.name,
      args: context.args,
      execution: context.execution,
    });
    if (match !== undefined) return match;
  }
  return undefined;
}

function sessionApprovalRule(pattern: string): PermissionRule {
  return {
    decision: 'allow',
    scope: 'session-runtime',
    pattern,
    reason: 'approve for session',
  };
}
