import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import {
  IAgentPermissionPolicyService,
  type PermissionPolicyEvaluation,
} from '#/agent/permissionPolicy/permissionPolicy';
import type { PermissionData } from '#/agent/permissionPolicy/types';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { BeforeToolExecuteEvent } from '#/agent/toolExecutor/toolHooks';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { autoReviewTrigger, resolveAutoReview } from '#/features/autoReview/autoReviewGate';
import { AUTO_REVIEW_FLAG_ID } from '#/features/autoReview/flag';
import { IAutoReviewService } from '#/features/autoReview/review';

import { IAgentPermissionGate } from './permissionGate';

export class AgentPermissionGate extends Service implements IAgentPermissionGate {
  declare readonly _serviceBrand: undefined;
  constructor(
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IAgentPermissionRulesService private readonly rulesService: IAgentPermissionRulesService,
    @IAgentPermissionPolicyService private readonly policyService: IAgentPermissionPolicyService,
    @IFlagService private readonly flags: IFlagService,
    @IAutoReviewService private readonly autoReview: IAutoReviewService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();
    this._register(toolExecutor.onBeforeExecuteTool((event) => this.adjudicate(event)));
  }

  data(): PermissionData {
    return {
      mode: this.modeService.mode,
      rules: [...this.rulesService.rules],
    };
  }

  private async adjudicate(event: BeforeToolExecuteEvent): Promise<void> {
    const evaluation = await this.policyService.evaluate(event);
    if (evaluation === undefined) return;
    const reviewTrigger = autoReviewTrigger(
      this.flags.enabled(AUTO_REVIEW_FLAG_ID),
      this.modeService.mode,
      evaluation,
    );
    if (reviewTrigger !== undefined) {
      event.waitUntil(async () => {
        const review = await this.autoReview.review(event, reviewTrigger);
        const resolved = resolveAutoReview(
          event,
          evaluation,
          review,
          this.flags.enabled(AUTO_REVIEW_FLAG_ID) ? this.modeService.mode : 'manual',
        );
        this.trackPolicyDecision(event, resolved);
        return this.toolApproval.resolvePermissionResolution(
          resolved.result,
          event,
          resolved.policyName,
        );
      });
      return;
    }
    this.trackPolicyDecision(event, evaluation);
    const { result, policyName } = evaluation;
    if (result.kind === 'ask') {
      event.waitUntil(() => this.toolApproval.requestToolApproval(event, result, policyName));
      return;
    }
    if (result.kind === 'approve') {
      event.pass(result.executionMetadata);
      return;
    }
    const resolved = await this.toolApproval.resolvePermissionResolution(result, event, policyName);
    if (resolved?.veto !== undefined) {
      event.veto(resolved.veto);
    }
  }

  private trackPolicyDecision(
    event: BeforeToolExecuteEvent,
    evaluation: PermissionPolicyEvaluation,
  ): void {
    this.telemetry.track2('permission_policy_decision', {
      turn_id: event.turnId,
      tool_call_id: event.toolCall.id,
      policy_name: evaluation.policyName,
      tool_name: event.toolCall.name,
      permission_mode: this.modeService.mode,
      decision: evaluation.result.kind,
      ...evaluation.result.reason,
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionGate,
  AgentPermissionGate,
  ScopeActivation.OnScopeCreated,
  'permissionGate',
);
