import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../policy';
import { firstMatchingRuleDecision } from './utils';

export class SessionApprovalHistoryPermissionPolicy implements PermissionPolicy {
  readonly name = 'session.approval-history';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (
      context.matchedRule?.scope === 'session-runtime' &&
      context.matchedRule.decision === 'allow'
    ) {
      trackSessionApproval(this.agent, context);
      return { kind: 'allow' };
    }

    const sessionRules = this.agent.permission.rules.filter(
      (rule) => rule.scope === 'session-runtime',
    );
    const match = firstMatchingRuleDecision(sessionRules, this.agent, context);
    if (match?.decision !== 'allow') return undefined;
    trackSessionApproval(this.agent, context);
    return { kind: 'allow' };
  }
}

function trackSessionApproval(agent: Agent, context: PermissionPolicyContext): void {
  agent.telemetry.track('tool_approved', {
    tool_name: context.toolCall.function.name,
    approval_mode: 'auto_session',
    scope: 'session',
  });
}
