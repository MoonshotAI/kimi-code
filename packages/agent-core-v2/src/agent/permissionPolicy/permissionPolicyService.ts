import { IInstantiationService, ref, type LiveRef } from "#/_base/di/instantiation";
import { Service } from "#/_base/di/service";
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { AUTO_REVIEW_FLAG_ID } from '#/features/autoReview/flag';
import { AutoModeApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/auto-mode-approve';
import { AutoModeAskUserQuestionDenyPermissionPolicyService } from '#/agent/permissionPolicy/policies/auto-mode-ask-user-question-deny';
import { BashReadOnlyApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/bash-read-only';
import { DangerousCommandAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/dangerous-command-ask';
import { DefaultToolApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/default-tool-approve';
import { FallbackAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/fallback-ask';
import { GitControlPathAccessAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/git-control-path-access-ask';
import { GitCwdWriteApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/git-cwd-write-approve';
import { SensitiveFileAccessAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/sensitive-file-access-ask';
import { SessionApprovalHistoryPermissionPolicyService } from '#/agent/permissionPolicy/policies/session-approval-history';
import { UserConfiguredAllowPermissionPolicyService } from '#/agent/permissionPolicy/policies/user-configured-allow';
import { UserConfiguredAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/user-configured-ask';
import { UserConfiguredDenyPermissionPolicyService } from '#/agent/permissionPolicy/policies/user-configured-deny';
import { YoloModeApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/yolo-mode-approve';
import {
  IAgentPermissionPolicyService,
  type PermissionPolicyEvaluateOptions,
  type PermissionPolicyEvaluation,
} from './permissionPolicy';
import type { PermissionPolicy } from "./types";
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

export class AgentPermissionPolicyService
  extends Service
  implements IAgentPermissionPolicyService
{
  declare readonly _serviceBrand: undefined;

  private readonly policies: readonly PermissionPolicy[];

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @ref(IBootstrapService) private readonly bootstrap: LiveRef<IBootstrapService>,
    @ref(IFlagService) private readonly flags: LiveRef<IFlagService>,
  ) {
    super();
    this.policies = [
      this.instantiation.createInstance(AutoModeAskUserQuestionDenyPermissionPolicyService),
      this.instantiation.createInstance(UserConfiguredDenyPermissionPolicyService),
      this.instantiation.createInstance(DangerousCommandAskPermissionPolicyService),
      this.instantiation.createInstance(AutoModeApprovePermissionPolicyService),
      this.instantiation.createInstance(SessionApprovalHistoryPermissionPolicyService),
      this.instantiation.createInstance(UserConfiguredAskPermissionPolicyService),
      this.instantiation.createInstance(UserConfiguredAllowPermissionPolicyService),
      this.instantiation.createInstance(SensitiveFileAccessAskPermissionPolicyService),
      this.instantiation.createInstance(GitControlPathAccessAskPermissionPolicyService),
      this.instantiation.createInstance(YoloModeApprovePermissionPolicyService),
      this.instantiation.createInstance(DefaultToolApprovePermissionPolicyService),
      this.instantiation.createInstance(GitCwdWriteApprovePermissionPolicyService),
      this.instantiation.createInstance(BashReadOnlyApprovePermissionPolicyService),
      this.instantiation.createInstance(FallbackAskPermissionPolicyService),
    ];
  }

  async evaluate(
    context: ResolvedToolExecutionHookContext,
    options?: PermissionPolicyEvaluateOptions,
  ): Promise<PermissionPolicyEvaluation | undefined> {
    const skipDangerousCommandAsk =
      this.bootstrap.current?.args.nonInteractive === true &&
      this.flags.current?.enabled(AUTO_REVIEW_FLAG_ID) !== true &&
      options?.mode !== 'manual';
    for (const policy of this.policies) {
      if (skipDangerousCommandAsk && policy.name === 'dangerous-command-ask') continue;
      const result = await policy.evaluate(context, options?.mode ?? this.modeService.mode);
      if (result !== undefined) return { policyName: policy.name, result };
    }
    return undefined;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionPolicyService,
  AgentPermissionPolicyService,
  ScopeActivation.OnScopeCreated,
  'permissionPolicy',
);
