import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import {
  IAgentPermissionPolicyService,
  type PermissionPolicyEvaluation,
} from '#/agent/permissionPolicy/permissionPolicy';
import type { PermissionData, PermissionPolicyResult } from '#/agent/permissionPolicy/types';
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

interface ReviewedResolution {
  readonly result: PermissionPolicyResult;
  readonly origin: string;
  readonly executionMetadata?: unknown;
}

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
    const reviewed = await this.review(event);
    if (reviewed === undefined) return;
    if (reviewed.result.kind === 'ask') {
      const ask = reviewed.result;
      const resolved = await this.toolApproval.requestToolApproval(event, ask, reviewed.origin);
      if (resolved?.veto !== undefined) {
        event.veto(resolved.veto);
        return;
      }
      event.pass(reviewed.executionMetadata ?? resolved?.executionMetadata);
      return;
    }
    if (reviewed.result.kind === 'approve') {
      event.pass(reviewed.executionMetadata);
      return;
    }
    const resolved = await this.toolApproval.resolvePermissionResolution(
      reviewed.result,
      event,
      reviewed.origin,
    );
    if (resolved?.veto !== undefined) event.veto(resolved.veto);
  }

  async authorize(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    const reviewed = await this.review(context);
    if (reviewed === undefined) return undefined;
    if (reviewed.result.kind === 'approve') {
      return reviewed.executionMetadata === undefined
        ? undefined
        : { executionMetadata: reviewed.executionMetadata };
    }
    const resolved = await this.toolApproval.resolvePermissionResolution(
      reviewed.result,
      context,
      reviewed.origin,
    );
    if (resolved?.veto !== undefined || reviewed.executionMetadata === undefined) return resolved;
    return { executionMetadata: reviewed.executionMetadata };
  }

  private async review(
    context: ResolvedToolExecutionHookContext,
  ): Promise<ReviewedResolution | undefined> {
    const evaluation = await this.policyService.evaluate(context);
    if (evaluation !== undefined) this.trackPolicyDecision(context, evaluation);
    if (terminal(evaluation)) {
      return { result: evaluation.result, origin: evaluation.policyName };
    }
    if (evaluation?.policyName === 'session-approval-history' && evaluation.result.kind === 'approve') {
      return {
        result: evaluation.result,
        origin: evaluation.policyName,
        executionMetadata: evaluation.result.executionMetadata,
      };
    }
    const review = await this.autoReview.evaluate(context);
    return combine(evaluation, review, this.autoReview.name);
  }

  private trackPolicyDecision(
    context: ResolvedToolExecutionHookContext,
    evaluation: PermissionPolicyEvaluation,
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
}

function terminal(
  evaluation: PermissionPolicyEvaluation | undefined,
): evaluation is PermissionPolicyEvaluation & {
  readonly result: Exclude<PermissionPolicyResult, { kind: 'ask' | 'approve' }>;
} {
  return (
    evaluation !== undefined &&
    evaluation.result.kind !== 'ask' &&
    evaluation.result.kind !== 'approve'
  );
}

function combine(
  evaluation: PermissionPolicyEvaluation | undefined,
  review: PermissionPolicyResult | undefined,
  reviewOrigin: string,
): ReviewedResolution | undefined {
  if (review?.kind === 'ask') {
    const staticAsk = evaluation?.result.kind === 'ask' ? evaluation.result : undefined;
    return {
      result: staticAsk ?? review,
      origin: staticAsk === undefined ? reviewOrigin : evaluation!.policyName,
      executionMetadata: evaluation?.result.kind === 'approve'
        ? evaluation.result.executionMetadata
        : undefined,
    };
  }
  if (evaluation?.result.kind === 'ask') {
    if (review?.kind === 'deny') return { result: review, origin: reviewOrigin };
    return { result: evaluation.result, origin: evaluation.policyName };
  }
  if (review?.kind === 'deny') return { result: review, origin: reviewOrigin };
  if (evaluation?.result.kind === 'approve') {
    return {
      result: evaluation.result,
      origin: evaluation.policyName,
      executionMetadata: evaluation.result.executionMetadata,
    };
  }
  return undefined;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionGate,
  AgentPermissionGate,
  ScopeActivation.OnScopeCreated,
  'permissionGate',
);
