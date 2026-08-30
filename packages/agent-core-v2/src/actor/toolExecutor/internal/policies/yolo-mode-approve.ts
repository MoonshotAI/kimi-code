import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/actor/toolExecutor/permissionTypes';
import { AgentPermissionMode } from '#/actor/permissionMode/permissionModeAgentRuntime';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

export class YoloModeApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'yolo-mode-approve';

  constructor(
    private readonly agentLifecycle: IAgentLifecycleService,
    private readonly scopeContext: IAgentScopeContext,
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
