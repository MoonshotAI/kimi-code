import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/features/toolExecutor/permissionTypes';
import { AgentPermissionMode } from '#/features/permissionMode/permissionModeAgentRuntime';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

export class AutoModeApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'auto-mode-approve';

  constructor(
    private readonly agentLifecycle: IAgentLifecycleService,
    private readonly scopeContext: IAgentScopeContext,
  ) {}

  evaluate(): PermissionPolicyResult | undefined {
    return this.mode() === 'auto' ? { kind: 'approve' } : undefined;
  }

  private mode() {
    return this.agentLifecycle
      .resolve(this.scopeContext.agentContext, AgentPermissionMode)
      .mode();
  }
}
