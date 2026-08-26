import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/features/toolExecutor/permissionTypes';
import { AgentPermissionMode } from '#/features/permissionMode/permissionModeAgentRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

export class YoloModeApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'yolo-mode-approve';

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  evaluate(): PermissionPolicyResult | undefined {
    return this.mode() === 'dangerous' ? { kind: 'approve' } : undefined;
  }

  private mode() {
    return this.agentLifecycle
      .resolve(this.scopeContext.agentContext, AgentPermissionMode)
      .mode();
  }
}
