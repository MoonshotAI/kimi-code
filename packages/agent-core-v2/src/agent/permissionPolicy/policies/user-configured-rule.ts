import type {
  PermissionRule,
  PermissionRuleDecision,
  PermissionRuleScope,
} from '#/agent/permissionRules/permissionRules';
import {
  matchPermissionRule,
  type PermissionRuleMatch,
} from '#/agent/permissionRules/matchesRule';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import type { PermissionPolicyResult } from '#/agent/permissionPolicy/types';

const USER_CONFIGURED_SCOPES = new Set<PermissionRuleScope>([
  'turn-override',
  'project',
  'user',
]);

export function evaluateUserConfiguredRule(
  context: ResolvedToolExecutionHookContext,
  decision: PermissionRuleDecision,
  rulesService: IAgentPermissionRulesService,
): PermissionPolicyResult | undefined {
  const match = firstMatchingRule(context, decision, rulesService, USER_CONFIGURED_SCOPES);
  if (match === undefined) return undefined;
  if (decision === 'deny') {
    return {
      kind: 'deny',
      message: defaultPermissionRuleDenyMessage(context.toolCall.name, match.rule.reason),
    };
  }
  if (decision === 'ask') return { kind: 'ask' };
  return { kind: 'approve' };
}

function defaultPermissionRuleDenyMessage(tool: string, reason: string | undefined): string {
  const suffix = reason !== undefined && reason.length > 0 ? ` Reason: ${reason}` : '';
  return `Tool "${tool}" was denied by permission rule.${suffix}`;
}

function firstMatchingRule(
  context: ResolvedToolExecutionHookContext,
  decision: PermissionRuleDecision,
  rulesService: IAgentPermissionRulesService,
  scopes: ReadonlySet<PermissionRuleScope>,
): PermissionRuleMatch | undefined {
  const rules = rulesService.rules.filter((rule): rule is PermissionRule =>
    scopes.has(rule.scope),
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
  return undefined;
}
