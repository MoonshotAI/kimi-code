import type { ResolvedToolExecutionHookContext } from '#/features/toolExecutor/toolHooks';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/features/toolExecutor/permissionTypes';
import { AgentPermissionMode } from '#/features/permissionMode/permissionModeAgentRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

export class AutoModeAskUserQuestionDenyPermissionPolicyService implements PermissionPolicy {
  readonly name = 'auto-mode-ask-user-question-deny';

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    if (this.mode() !== 'auto') return undefined;
    if (context.toolCall.name !== 'AskUserQuestion') return undefined;
    return {
      kind: 'deny',
      message:
        'AskUserQuestion is disabled while auto permission mode is active. Make a reasonable decision and continue without asking the user.',
    };
  }

  private mode() {
    return this.agentLifecycle
      .resolve(this.scopeContext.agentContext, AgentPermissionMode)
      .mode();
  }
}
