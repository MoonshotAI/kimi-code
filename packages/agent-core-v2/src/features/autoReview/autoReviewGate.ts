import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionPolicyEvaluation } from '#/agent/permissionPolicy/permissionPolicy';
import type { PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';

import { AUTO_REVIEW_FLAG_ID } from './flag';
import { IAutoReviewGate, IAutoReviewService, type AutoReviewResult } from './review';

const AUTO_REVIEW_ORIGIN = 'auto-review';

const EXEMPT_TOOLS = new Set([
  'Read',
  'ReadMediaFile',
  'Grep',
  'Glob',
  'TodoList',
  'TaskList',
  'TaskOutput',
  'CronList',
  'GetGoal',
  'ExitPlanMode',
]);

export class AutoReviewGate implements IAutoReviewGate {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IAgentPermissionModeService private readonly modes: IAgentPermissionModeService,
    @IAutoReviewService private readonly reviewService: IAutoReviewService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  applies(context: ResolvedToolExecutionHookContext, { result }: PermissionPolicyEvaluation): boolean {
    if (result.kind === 'deny') return false;
    if (result.kind === 'approve' && result.approvedByUser === true) return false;
    const mode = this.modes.mode;
    return (
      (mode === 'auto' || mode === 'yolo') &&
      this.flags.enabled(AUTO_REVIEW_FLAG_ID) &&
      !EXEMPT_TOOLS.has(context.toolCall.name)
    );
  }

  async resolve(
    context: ResolvedToolExecutionHookContext,
    evaluation: PermissionPolicyEvaluation,
  ): Promise<PermissionPolicyEvaluation> {
    const startedAt = Date.now();
    const review = await this.reviewService.review(context);
    this.track(context, review, startedAt);
    const mode = this.modes.mode;
    const allowed = review.kind === 'decision' && review.decision.decision === 'allow';
    if (allowed && mode !== 'manual') return evaluation;
    if (mode === 'auto') {
      return { policyName: AUTO_REVIEW_ORIGIN, result: denial(context, review) };
    }
    if (evaluation.result.kind === 'ask') return evaluation;
    return { policyName: AUTO_REVIEW_ORIGIN, result: fallbackAsk(context, review, evaluation.result) };
  }

  private track(context: ResolvedToolExecutionHookContext, review: AutoReviewResult, startedAt: number): void {
    this.telemetry.track2('auto_review_decision', {
      turn_id: context.turnId,
      tool_call_id: context.toolCall.id,
      tool_name: context.toolCall.name,
      decision: review.kind === 'failed' ? 'failed' : review.decision.decision,
      risk: review.kind === 'failed' ? undefined : review.decision.risk,
      duration_ms: Date.now() - startedAt,
    });
  }
}

function denial(context: ResolvedToolExecutionHookContext, review: AutoReviewResult): PermissionPolicyResult {
  if (review.kind === 'failed') {
    return {
      kind: 'deny',
      message: `Auto Review could not complete; the tool was not executed: ${review.reason} Resolve the review error or ask the user for guidance.`,
      reason: { review_error: true },
    };
  }
  return {
    kind: 'deny',
    message: `Auto Review denied tool "${context.toolCall.name}"; it was not executed.${reasonSuffix(review)} Do not retry the same action or bypass the review.`,
    reason: { review_risk: review.decision.risk },
  };
}

function fallbackAsk(
  context: ResolvedToolExecutionHookContext,
  review: AutoReviewResult,
  approved: PermissionPolicyResult | undefined,
): PermissionPolicyResult {
  if (review.kind === 'failed') {
    return {
      kind: 'ask',
      reason: { review_error: true },
      resolveApproval: (response) => response.decision === 'approved' ? approved : undefined,
      resolveError: () => ({
        kind: 'deny',
        message: 'Auto Review and the fallback approval both failed; the tool was not executed.',
        reason: { review_error: true },
      }),
    };
  }
  const { decision } = review;
  if (decision.decision === 'allow') {
    return {
      kind: 'ask',
      reason: { review_risk: decision.risk, review_mode_changed: true },
      resolveApproval: (response) => response.decision === 'approved' ? approved : undefined,
    };
  }
  return {
    kind: 'ask',
    reason: { review_risk: decision.risk },
    resolveApproval: (response) => response.decision === 'approved'
      ? approved
      : {
          kind: 'deny',
          message: `Tool "${context.toolCall.name}" was not run after Auto Review denial.${reasonSuffix(review)}`,
        },
  };
}

function reasonSuffix(review: Extract<AutoReviewResult, { kind: 'decision' }>): string {
  return review.decision.decision === 'deny' && review.decision.reason !== undefined
    ? ` ${review.decision.reason}`
    : '';
}
