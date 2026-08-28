import type { ResolvedToolExecutionHookContext } from '#/features/toolExecutor/toolHooks';
import { AgentPermissionRules } from '#/features/permissionRules/permissionRulesAgentRuntime';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/features/toolExecutor/permissionTypes';
import { evaluateUserConfiguredRule } from './user-configured-rule';

export class UserConfiguredAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'user-configured-ask';

  constructor(
    private readonly agentLifecycle: IAgentLifecycleService,
    private readonly scopeContext: IAgentScopeContext,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    return evaluateUserConfiguredRule(
      context,
      'ask',
      this.agentLifecycle.resolve(this.scopeContext.agentContext, AgentPermissionRules),
    );
  }
}
