import type { ResolvedToolExecutionHookContext } from '#/actor/toolExecutor/toolHooks';
import { AgentPermissionRules } from '#/actor/permissionRules/permissionRulesAgentRuntime';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/actor/toolExecutor/permissionTypes';

export class SessionApprovalHistoryPermissionPolicyService implements PermissionPolicy {
  readonly name = 'session-approval-history';

  constructor(
    private readonly agentLifecycle: IAgentLifecycleService,
    private readonly scopeContext: IAgentScopeContext,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    const match = this.agentLifecycle
      .resolve(this.scopeContext.agentContext, AgentPermissionRules)
      .evaluateApproval({
        toolName: context.toolCall.name,
        input: context.args,
        execution: context.execution,
      });
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
