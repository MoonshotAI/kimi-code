import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { IGitService } from '#/app/git/git';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ResolvedToolExecutionHookContext } from '#/features/toolExecutor/toolHooks';
import type { PermissionPolicy, PermissionPolicyResult } from '#/features/toolExecutor/permissionTypes';
import { AutoModeApprovePermissionPolicyService } from '#/features/toolExecutor/internal/policies/auto-mode-approve';
import { AutoModeAskUserQuestionDenyPermissionPolicyService } from '#/features/toolExecutor/internal/policies/auto-mode-ask-user-question-deny';
import { DefaultToolApprovePermissionPolicyService } from '#/features/toolExecutor/internal/policies/default-tool-approve';
import { FallbackAskPermissionPolicyService } from '#/features/toolExecutor/internal/policies/fallback-ask';
import { GitControlPathAccessAskPermissionPolicyService } from '#/features/toolExecutor/internal/policies/git-control-path-access-ask';
import { GitCwdWriteApprovePermissionPolicyService } from '#/features/toolExecutor/internal/policies/git-cwd-write-approve';
import { SensitiveFileAccessAskPermissionPolicyService } from '#/features/toolExecutor/internal/policies/sensitive-file-access-ask';
import { SessionApprovalHistoryPermissionPolicyService } from '#/features/toolExecutor/internal/policies/session-approval-history';
import { UserConfiguredAllowPermissionPolicyService } from '#/features/toolExecutor/internal/policies/user-configured-allow';
import { UserConfiguredAskPermissionPolicyService } from '#/features/toolExecutor/internal/policies/user-configured-ask';
import { UserConfiguredDenyPermissionPolicyService } from '#/features/toolExecutor/internal/policies/user-configured-deny';
import { YoloModeApprovePermissionPolicyService } from '#/features/toolExecutor/internal/policies/yolo-mode-approve';

export interface PermissionPolicyEvaluation {
  readonly policyName: string;
  readonly result: PermissionPolicyResult;
}

export class ToolExecutionPermissionPolicyChain {
  private readonly policies: readonly PermissionPolicy[];

  constructor(
    agentLifecycle: IAgentLifecycleService,
    scopeContext: IAgentScopeContext,
    agentRuntime: IAgentRuntimeService,
    workspace: ISessionWorkspaceContext,
    git: IGitService,
  ) {
    this.policies = [
      new AutoModeAskUserQuestionDenyPermissionPolicyService(agentLifecycle, scopeContext),
      new UserConfiguredDenyPermissionPolicyService(agentLifecycle, scopeContext),
      new AutoModeApprovePermissionPolicyService(agentLifecycle, scopeContext),
      new SessionApprovalHistoryPermissionPolicyService(agentLifecycle, scopeContext),
      new UserConfiguredAskPermissionPolicyService(agentLifecycle, scopeContext),
      new UserConfiguredAllowPermissionPolicyService(agentLifecycle, scopeContext),
      new SensitiveFileAccessAskPermissionPolicyService(),
      new GitControlPathAccessAskPermissionPolicyService(agentRuntime, workspace, git),
      new YoloModeApprovePermissionPolicyService(agentLifecycle, scopeContext),
      new DefaultToolApprovePermissionPolicyService(),
      new GitCwdWriteApprovePermissionPolicyService(agentRuntime, workspace, git),
      new FallbackAskPermissionPolicyService(),
    ];
  }

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyEvaluation | undefined> {
    for (const policy of this.policies) {
      const result = await policy.evaluate(context);
      if (result !== undefined) return { policyName: policy.name, result };
    }
    return undefined;
  }
}
