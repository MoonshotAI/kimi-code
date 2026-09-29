import { permissionRuleMatcher } from '../language/tool-matchers';
import { matchPermissionRule, type PermissionRuleMatch } from '../language/pattern';
import type {
  PermissionRule,
  PermissionRuleDecision,
  PermissionRuleScope,
} from '../types';

import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from './chain';

const USER_CONFIGURED_SCOPES: ReadonlySet<PermissionRuleScope> = new Set([
  'turn-override',
  'project',
  'user',
]);

export const userConfiguredDeny: PermissionPolicy = {
  name: 'user-configured-deny',
  evaluate(context) {
    return evaluateUserConfiguredRule(context, 'deny');
  },
};

export const sessionApprovalHistory: PermissionPolicy = {
  name: 'session-approval-history',
  evaluate(context) {
    for (const pattern of context.sessionApprovalRulePatterns) {
      const match = matchPermissionRule({
        rule: {
          decision: 'allow',
          scope: 'session-runtime',
          pattern,
          reason: 'approve for session',
        },
        toolName: context.toolCall.name,
        matchesRule: boundMatchesRule(context),
      });
      if (match !== undefined) {
        return { kind: 'approve' };
      }
    }
    return undefined;
  },
};

export const userConfiguredAsk: PermissionPolicy = {
  name: 'user-configured-ask',
  evaluate(context) {
    return evaluateUserConfiguredRule(context, 'ask');
  },
};

export const userConfiguredAllow: PermissionPolicy = {
  name: 'user-configured-allow',
  evaluate(context) {
    return evaluateUserConfiguredRule(context, 'allow');
  },
};

function evaluateUserConfiguredRule(
  context: PermissionPolicyContext,
  decision: PermissionRuleDecision,
): PermissionPolicyResult | undefined {
  const match = firstMatchingRule(context, decision);
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
  context: PermissionPolicyContext,
  decision: PermissionRuleDecision,
): PermissionRuleMatch | undefined {
  const rules = context.rules.filter((rule): rule is PermissionRule =>
    USER_CONFIGURED_SCOPES.has(rule.scope),
  );
  const matchesRule = boundMatchesRule(context);
  for (const rule of rules) {
    if (rule.decision !== decision) continue;
    const match = matchPermissionRule({
      rule,
      toolName: context.toolCall.name,
      matchesRule,
    });
    if (match !== undefined) return match;
  }
  return undefined;
}

function boundMatchesRule(
  context: PermissionPolicyContext,
): ((argPattern: string) => boolean) | undefined {
  const matcher = permissionRuleMatcher(context.toolCall.name);
  if (matcher?.matchesRule === undefined || context.args === undefined) return undefined;
  const matchesRule = matcher.matchesRule;
  const args = context.args;
  const options = {
    cwd: context.workDir,
    pathClass: context.pathClass,
    homeDir: context.homeDir,
  };
  return (argPattern) => matchesRule(argPattern, args, options);
}
