import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { IGitService } from '#/app/git/git';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ResolvedToolExecutionHookContext } from '#/actor/toolExecutor/toolHooks';
import type { PermissionPolicy, PermissionPolicyResult } from '#/actor/toolExecutor/permissionTypes';
import { AutoModeApprovePermissionPolicyService } from '#/actor/toolExecutor/internal/policies/auto-mode-approve';
import { AutoModeAskUserQuestionDenyPermissionPolicyService } from '#/actor/toolExecutor/internal/policies/auto-mode-ask-user-question-deny';
import { DefaultToolApprovePermissionPolicyService } from '#/actor/toolExecutor/internal/policies/default-tool-approve';
import { FallbackAskPermissionPolicyService } from '#/actor/toolExecutor/internal/policies/fallback-ask';
import { GitControlPathAccessAskPermissionPolicyService } from '#/actor/toolExecutor/internal/policies/git-control-path-access-ask';
import { GitCwdWriteApprovePermissionPolicyService } from '#/actor/toolExecutor/internal/policies/git-cwd-write-approve';
import { SensitiveFileAccessAskPermissionPolicyService } from '#/actor/toolExecutor/internal/policies/sensitive-file-access-ask';
import { SessionApprovalHistoryPermissionPolicyService } from '#/actor/toolExecutor/internal/policies/session-approval-history';
import { UserConfiguredAllowPermissionPolicyService } from '#/actor/toolExecutor/internal/policies/user-configured-allow';
import { UserConfiguredAskPermissionPolicyService } from '#/actor/toolExecutor/internal/policies/user-configured-ask';
import { UserConfiguredDenyPermissionPolicyService } from '#/actor/toolExecutor/internal/policies/user-configured-deny';
import { YoloModeApprovePermissionPolicyService } from '#/actor/toolExecutor/internal/policies/yolo-mode-approve';

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
