import { IInstantiationService } from "#/_base/di/instantiation";
import { Disposable, type IDisposable } from "#/_base/di/lifecycle";
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { AgentSwarmExclusiveDenyPermissionPolicyService } from '#/agent/permissionPolicy/policies/agent-swarm-exclusive-deny';
import { AutoModeApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/auto-mode-approve';
import { AutoModeAskUserQuestionDenyPermissionPolicyService } from '#/agent/permissionPolicy/policies/auto-mode-ask-user-question-deny';
import { DefaultToolApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/default-tool-approve';
import { ExitPlanModeReviewAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/exit-plan-mode-review-ask';
import { FallbackAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/fallback-ask';
import { GitControlPathAccessAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/git-control-path-access-ask';
import { GitCwdWriteApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/git-cwd-write-approve';
import { GoalStartReviewAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/goal-start-review-ask';
import { PlanModeGuardDenyPermissionPolicyService } from '#/agent/permissionPolicy/policies/plan-mode-guard-deny';
import { PlanModeToolApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/plan-mode-tool-approve';
import { SensitiveFileAccessAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/sensitive-file-access-ask';
import { SessionApprovalHistoryPermissionPolicyService } from '#/agent/permissionPolicy/policies/session-approval-history';
import { SwarmModeAgentSwarmApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/swarm-mode-agent-swarm-approve';
import { UserConfiguredAllowPermissionPolicyService } from '#/agent/permissionPolicy/policies/user-configured-allow';
import { UserConfiguredAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/user-configured-ask';
import { UserConfiguredDenyPermissionPolicyService } from '#/agent/permissionPolicy/policies/user-configured-deny';
import { YoloModeApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/yolo-mode-approve';
import {
  IAgentPermissionPolicyService,
  type PermissionPolicyEvaluation,
} from './permissionPolicy';
import type { PermissionPolicy } from "./types";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

export class AgentPermissionPolicyService
  extends Disposable
  implements IAgentPermissionPolicyService
{
  declare readonly _serviceBrand: undefined;

  private readonly policies: readonly PermissionPolicy[];
  private readonly dynamicPolicies: PermissionPolicy[] = [];

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {
    super();
    this.policies = [
      this.instantiation.createInstance(AgentSwarmExclusiveDenyPermissionPolicyService),
      this.instantiation.createInstance(AutoModeAskUserQuestionDenyPermissionPolicyService),
      this.instantiation.createInstance(PlanModeGuardDenyPermissionPolicyService),
      this.instantiation.createInstance(UserConfiguredDenyPermissionPolicyService),
      this.instantiation.createInstance(AutoModeApprovePermissionPolicyService),
      this.instantiation.createInstance(SessionApprovalHistoryPermissionPolicyService),
      this.instantiation.createInstance(UserConfiguredAskPermissionPolicyService),
      this.instantiation.createInstance(UserConfiguredAllowPermissionPolicyService),
      this.instantiation.createInstance(ExitPlanModeReviewAskPermissionPolicyService),
      this.instantiation.createInstance(GoalStartReviewAskPermissionPolicyService),
      this.instantiation.createInstance(PlanModeToolApprovePermissionPolicyService),
      this.instantiation.createInstance(SensitiveFileAccessAskPermissionPolicyService),
      this.instantiation.createInstance(GitControlPathAccessAskPermissionPolicyService),
      this.instantiation.createInstance(YoloModeApprovePermissionPolicyService),
      this.instantiation.createInstance(SwarmModeAgentSwarmApprovePermissionPolicyService),
      this.instantiation.createInstance(DefaultToolApprovePermissionPolicyService),
      this.instantiation.createInstance(GitCwdWriteApprovePermissionPolicyService),
      this.instantiation.createInstance(FallbackAskPermissionPolicyService),
    ];
  }

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyEvaluation | undefined> {
    for (const policy of this.dynamicPolicies) {
      const result = await policy.evaluate(context);
      if (result !== undefined) return { policyName: policy.name, result };
    }
    for (const policy of this.policies) {
      const result = await policy.evaluate(context);
      if (result !== undefined) return { policyName: policy.name, result };
    }
    return undefined;
  }

  registerPolicy(policy: PermissionPolicy): IDisposable {
    this.dynamicPolicies.unshift(policy);
    const disposable = {
      dispose: (): void => {
        const index = this.dynamicPolicies.indexOf(policy);
        if (index >= 0) this.dynamicPolicies.splice(index, 1);
      },
    };
    this._register(disposable);
    return disposable;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionPolicyService,
  AgentPermissionPolicyService,
  InstantiationType.Delayed,
  'permissionPolicy',
);
