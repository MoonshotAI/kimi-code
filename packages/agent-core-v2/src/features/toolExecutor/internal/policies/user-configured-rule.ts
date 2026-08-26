import type { ResolvedToolExecutionHookContext } from '#/features/toolExecutor/toolHooks';
import type { PermissionRulesRuntime } from '#/features/permissionRules/permissionRulesAgentRuntime';
import type { PermissionRuleDecision } from '#/features/permissionRules/types';
import type { PermissionPolicyResult } from '#/features/toolExecutor/permissionTypes';

export function evaluateUserConfiguredRule(
  context: ResolvedToolExecutionHookContext,
  decision: PermissionRuleDecision,
  rules: PermissionRulesRuntime,
): PermissionPolicyResult | undefined {
  const match = rules.evaluateRule(
    {
      toolName: context.toolCall.name,
      input: context.args,
      execution: context.execution,
    },
    decision,
  );
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
