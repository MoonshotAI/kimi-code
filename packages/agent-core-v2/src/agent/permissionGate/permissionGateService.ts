import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicy';
import type { PermissionData, PermissionPolicyResolution } from '#/agent/permissionPolicy/types';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  BeforeToolExecuteEvent,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAutoReviewGate } from '#/features/autoReview/review';

import { IAgentPermissionGate } from './permissionGate';

export class AgentPermissionGate extends Service implements IAgentPermissionGate {
  declare readonly _serviceBrand: undefined;
  constructor(
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IAgentPermissionRulesService private readonly rulesService: IAgentPermissionRulesService,
    @IAgentPermissionPolicyService private readonly policyService: IAgentPermissionPolicyService,
    @IAutoReviewGate private readonly autoReview: IAutoReviewGate,
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
    if (evaluation !== undefined) this.trackPolicyDecision(event, evaluation);
    if (
      evaluation !== undefined &&
      evaluation.result.kind !== 'ask' &&
      evaluation.result.kind !== 'approve'
    ) {
      await this.veto(event, evaluation.result, evaluation.policyName);
      return;
    }
    if (evaluation?.policyName === 'session-approval-history' && evaluation.result.kind === 'approve') {
      event.pass(evaluation.result.executionMetadata);
      return;
    }
    const review = await this.autoReview.evaluate(event);
    if (review?.kind === 'ask') {
      const staticAsk = evaluation?.result.kind === 'ask' ? evaluation.result : undefined;
      const result = staticAsk ?? review;
      const origin = evaluation?.result.kind === 'ask' ? evaluation.policyName : this.autoReview.name;
      const resolved = await this.toolApproval.requestToolApproval(event, result, origin);
      if (resolved?.veto !== undefined) {
        event.veto(resolved.veto);
        return;
      }
      if (evaluation?.result.kind === 'approve') event.pass(evaluation.result.executionMetadata);
      else event.pass(resolved?.executionMetadata);
      return;
    }
    if (evaluation?.result.kind === 'ask') {
      if (review?.kind === 'deny') {
        await this.veto(event, review, this.autoReview.name);
        return;
      }
      const result = evaluation.result;
      event.waitUntil(() => this.toolApproval.requestToolApproval(event, result, evaluation.policyName));
      return;
    }
    if (review?.kind === 'deny') {
      await this.veto(event, review, this.autoReview.name);
      return;
    }
    if (evaluation?.result.kind === 'approve') event.pass(evaluation.result.executionMetadata);
  }

  async authorize(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    const evaluation = await this.policyService.evaluate(context);
    if (evaluation !== undefined) this.trackPolicyDecision(context, evaluation);
    if (
      evaluation !== undefined &&
      evaluation.result.kind !== 'ask' &&
      evaluation.result.kind !== 'approve'
    ) {
      return this.toolApproval.resolvePermissionResolution(
        evaluation.result,
        context,
        evaluation.policyName,
      );
    }
    if (evaluation?.policyName === 'session-approval-history') {
      return this.toolApproval.resolvePermissionResolution(
        evaluation.result,
        context,
        evaluation.policyName,
      );
    }
    const review = await this.autoReview.evaluate(context);
    if (evaluation?.result.kind === 'ask' && review?.kind !== 'deny') {
      return this.toolApproval.resolvePermissionResolution(
        evaluation.result,
        context,
        evaluation.policyName,
      );
    }
    if (review?.kind === 'deny') {
      return this.toolApproval.resolvePermissionResolution(review, context, this.autoReview.name);
    }
    if (review?.kind === 'ask') {
      const reviewed = await this.toolApproval.resolvePermissionResolution(review, context, this.autoReview.name);
      if (reviewed?.veto !== undefined || evaluation === undefined) return reviewed;
    }
    if (evaluation === undefined) return undefined;
    return this.toolApproval.resolvePermissionResolution(
      evaluation.result,
      context,
      evaluation.policyName,
    );
  }

  private trackPolicyDecision(
    context: ResolvedToolExecutionHookContext,
    evaluation: NonNullable<Awaited<ReturnType<IAgentPermissionPolicyService['evaluate']>>>,
  ): void {
    this.telemetry.track2('permission_policy_decision', {
      turn_id: context.turnId,
      tool_call_id: context.toolCall.id,
      policy_name: evaluation.policyName,
      tool_name: context.toolCall.name,
      permission_mode: this.modeService.mode,
      decision: evaluation.result.kind,
      ...evaluation.result.reason,
    });
  }

  private async veto(
    event: BeforeToolExecuteEvent,
    result: PermissionPolicyResolution,
    policyName: string,
  ): Promise<void> {
    const resolved = await this.toolApproval.resolvePermissionResolution(result, event, policyName);
    if (resolved?.veto !== undefined) event.veto(resolved.veto);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionGate,
  AgentPermissionGate,
  ScopeActivation.OnScopeCreated,
  'permissionGate',
);
