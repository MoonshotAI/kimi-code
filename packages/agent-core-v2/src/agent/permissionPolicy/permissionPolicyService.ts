/**
 * `permissionPolicy` domain (L3) — `IAgentPermissionPolicyService` implementation.
 *
 * Runs the static, ordered permission chain: every node adjudicates the *risk*
 * of a tool call (mode posture, user rules, session approval memory, sensitive
 * paths, intrinsic tool risk, workspace write trust, fallback). Harness
 * constraints (plan guard, swarm batch exclusivity, btw deny) are NOT here —
 * they live in their owning domains as `onBeforeExecuteTool` veto listeners.
 * Bound at Agent scope.
 */

import { IInstantiationService } from "#/_base/di/instantiation";
import { Disposable } from "#/_base/di/lifecycle";
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { AutoModeApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/auto-mode-approve';
import { AutoModeAskUserQuestionDenyPermissionPolicyService } from '#/agent/permissionPolicy/policies/auto-mode-ask-user-question-deny';
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

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {
    super();
    this.policies = [
      this.instantiation.createInstance(AutoModeAskUserQuestionDenyPermissionPolicyService),
      this.instantiation.createInstance(UserConfiguredDenyPermissionPolicyService),
      this.instantiation.createInstance(AutoModeApprovePermissionPolicyService),
      this.instantiation.createInstance(SessionApprovalHistoryPermissionPolicyService),
      this.instantiation.createInstance(UserConfiguredAskPermissionPolicyService),
      this.instantiation.createInstance(UserConfiguredAllowPermissionPolicyService),
      this.instantiation.createInstance(SensitiveFileAccessAskPermissionPolicyService),
      this.instantiation.createInstance(GitControlPathAccessAskPermissionPolicyService),
      this.instantiation.createInstance(YoloModeApprovePermissionPolicyService),
      this.instantiation.createInstance(DefaultToolApprovePermissionPolicyService),
      this.instantiation.createInstance(GitCwdWriteApprovePermissionPolicyService),
      this.instantiation.createInstance(FallbackAskPermissionPolicyService),
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

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionPolicyService,
  AgentPermissionPolicyService,
  InstantiationType.Eager,
  'permissionPolicy',
);
