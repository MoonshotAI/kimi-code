import type { ResolvedToolExecutionHookContext } from '#/features/toolExecutor/toolHooks';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { AgentPermissionRules } from '#/features/permissionRules/permissionRulesAgentRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/features/toolExecutor/permissionTypes';

export class SessionApprovalHistoryPermissionPolicyService implements PermissionPolicy {
  readonly name = 'session-approval-history';

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
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
