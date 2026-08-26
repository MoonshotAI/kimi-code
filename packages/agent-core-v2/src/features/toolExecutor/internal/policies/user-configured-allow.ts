import type { ResolvedToolExecutionHookContext } from '#/features/toolExecutor/toolHooks';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { AgentPermissionRules } from '#/features/permissionRules/permissionRulesAgentRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/features/toolExecutor/permissionTypes';
import { evaluateUserConfiguredRule } from './user-configured-rule';

export class UserConfiguredAllowPermissionPolicyService implements PermissionPolicy {
  readonly name = 'user-configured-allow';

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    return evaluateUserConfiguredRule(
      context,
      'allow',
      this.agentLifecycle.resolve(this.scopeContext.agentContext, AgentPermissionRules),
    );
  }
}
