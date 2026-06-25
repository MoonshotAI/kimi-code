import {
  Disposable,
  IInstantiationService,
  registerSingleton,
  SyncDescriptor,
} from "#/_base/di";
import type { ResolvedToolExecutionHookContext } from '../../../loop';
import type { PathClass } from '../../../tools/policies/path-access';
import {
  type PermissionGitWorkTreeMarker,
  type PermissionServiceOptions,
} from '../permission/permission';
import { IExternalHooksService } from '../externalHooks/externalHooks';
import { IPermissionModeService } from '../permissionMode/permissionMode';
import { IPermissionRulesService } from '../permissionRules/permissionRules';
import { IProfileService } from '../profile/profile';
import { ITelemetryService } from '../telemetry/telemetry';
import { AgentSwarmExclusiveDenyPermissionPolicyService } from './policies/agent-swarm-exclusive-deny';
import { AutoModeApprovePermissionPolicyService } from './policies/auto-mode-approve';
import { AutoModeAskUserQuestionDenyPermissionPolicyService } from './policies/auto-mode-ask-user-question-deny';
import { DefaultToolApprovePermissionPolicyService } from './policies/default-tool-approve';
import { ExitPlanModeReviewAskPermissionPolicyService } from './policies/exit-plan-mode-review-ask';
import { FallbackAskPermissionPolicyService } from './policies/fallback-ask';
import { GitControlPathAccessAskPermissionPolicyService } from './policies/git-control-path-access-ask';
import { GitCwdWriteApprovePermissionPolicyService } from './policies/git-cwd-write-approve';
import { GoalStartReviewAskPermissionPolicyService } from './policies/goal-start-review-ask';
import {
  defaultPathClass,
  findLocalGitWorkTreeMarker,
} from './policies/path-utils';
import { PlanModeGuardDenyPermissionPolicyService } from './policies/plan-mode-guard-deny';
import { PlanModeToolApprovePermissionPolicyService } from './policies/plan-mode-tool-approve';
import { PreToolCallHookPermissionPolicyService } from './policies/pre-tool-call-hook';
import type { PermissionPolicyRuntime } from './policies/runtime';
import { SensitiveFileAccessAskPermissionPolicyService } from './policies/sensitive-file-access-ask';
import { SessionApprovalHistoryPermissionPolicyService } from './policies/session-approval-history';
import { SwarmModeAgentSwarmApprovePermissionPolicyService } from './policies/swarm-mode-agent-swarm-approve';
import { UserConfiguredAllowPermissionPolicyService } from './policies/user-configured-allow';
import { UserConfiguredAskPermissionPolicyService } from './policies/user-configured-ask';
import { UserConfiguredDenyPermissionPolicyService } from './policies/user-configured-deny';
import { YoloModeApprovePermissionPolicyService } from './policies/yolo-mode-approve';
import {
  IPermissionPolicyService,
  type PermissionPolicy,
  type PermissionPolicyEvaluation,
} from './permissionPolicy';

interface PlanModeRuntimeState {
  isActive: boolean;
  planFilePath: string | null;
}

export class PermissionPolicyService
  extends Disposable
  implements IPermissionPolicyService, PermissionPolicyRuntime
{
  declare readonly _serviceBrand: undefined;

  private optionsValue: PermissionServiceOptions = {};
  private readonly planModeState: PlanModeRuntimeState = {
    isActive: false,
    planFilePath: null,
  };
  private swarmModeActive = false;
  private readonly policies: readonly PermissionPolicy[];

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {
    super();
    this.policies = this.instantiation.invokeFunction((accessor) => {
      const modeService = accessor.get(IPermissionModeService);
      const rulesService = accessor.get(IPermissionRulesService);
      const profile = accessor.get(IProfileService);
      const telemetry = accessor.get(ITelemetryService);
      const externalHooks = accessor.get(IExternalHooksService);

      return [
        new PreToolCallHookPermissionPolicyService(externalHooks),
        new AgentSwarmExclusiveDenyPermissionPolicyService(),
        new AutoModeAskUserQuestionDenyPermissionPolicyService(modeService),
        new PlanModeGuardDenyPermissionPolicyService(this),
        new UserConfiguredDenyPermissionPolicyService(this, rulesService),
        new AutoModeApprovePermissionPolicyService(modeService),
        new SessionApprovalHistoryPermissionPolicyService(rulesService),
        new UserConfiguredAskPermissionPolicyService(this, rulesService),
        new UserConfiguredAllowPermissionPolicyService(this, rulesService),
        new ExitPlanModeReviewAskPermissionPolicyService(this, modeService, telemetry),
        new GoalStartReviewAskPermissionPolicyService(modeService),
        new PlanModeToolApprovePermissionPolicyService(this),
        new SensitiveFileAccessAskPermissionPolicyService(),
        new GitControlPathAccessAskPermissionPolicyService(this, profile),
        new YoloModeApprovePermissionPolicyService(modeService),
        new SwarmModeAgentSwarmApprovePermissionPolicyService(this),
        new DefaultToolApprovePermissionPolicyService(),
        new GitCwdWriteApprovePermissionPolicyService(this, profile),
        new FallbackAskPermissionPolicyService(),
      ];
    });
  }

  get options(): PermissionServiceOptions {
    return this.optionsValue;
  }

  configure(options: PermissionServiceOptions): void {
    this.optionsValue = options;
    this.planModeState.isActive = options.planMode?.isActive ?? false;
    this.planModeState.planFilePath = options.planMode?.planFilePath ?? null;
    this.swarmModeActive = options.swarmMode?.isActive ?? false;
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

  planModeActive(): boolean {
    return this.options.planMode?.isActive ?? this.planModeState.isActive;
  }

  planFilePath(): string | null {
    return this.options.planMode?.planFilePath ?? this.planModeState.planFilePath;
  }

  swarmModeIsActive(): boolean {
    return this.options.swarmMode?.isActive ?? this.swarmModeActive;
  }

  pathClass(): PathClass {
    return this.options.pathClass ?? defaultPathClass();
  }

  findGitWorkTreeMarker(cwd: string): Promise<PermissionGitWorkTreeMarker | null> {
    if (this.options.gitWorkTreeMarker !== undefined) {
      return Promise.resolve(this.options.gitWorkTreeMarker(cwd));
    }
    return findLocalGitWorkTreeMarker(cwd);
  }

  exitPlanMode(): { readonly isError: true; readonly output: string } | undefined {
    const planMode = this.options.planMode;
    if (planMode === undefined) return undefined;
    try {
      planMode.exit();
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to exit plan mode.';
      return {
        isError: true,
        output: `Failed to exit plan mode: ${message}`,
      };
    }
  }

  formatPermissionRuleDenyMessage(tool: string, reason: string | undefined): string {
    const suffix = reason !== undefined && reason.length > 0 ? ` Reason: ${reason}` : '';
    if (this.options.agentType === 'sub') {
      return `Tool "${tool}" was denied.${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return `Tool "${tool}" was denied by permission rule.${suffix}`;
  }
}

registerSingleton(
  IPermissionPolicyService,
  new SyncDescriptor(PermissionPolicyService, [], true),
);
