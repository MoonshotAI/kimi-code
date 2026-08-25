import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { AgentPermissionRules } from '#/features/permissionRules/permissionRulesAgentRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { evaluateUserConfiguredRule } from './user-configured-rule';

export class UserConfiguredDenyPermissionPolicyService implements PermissionPolicy {
  readonly name = 'user-configured-deny';

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    return evaluateUserConfiguredRule(
      context,
      'deny',
      this.agentLifecycle.resolve(this.scopeContext.agentContext, AgentPermissionRules),
    );
  }
}
