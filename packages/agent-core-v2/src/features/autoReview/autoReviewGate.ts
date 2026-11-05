import { IFlagService } from '#/app/flag/flag';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import {
  IAgentPermissionPolicyService,
  type PermissionPolicyEvaluation,
} from '#/agent/permissionPolicy/permissionPolicy';
import type { PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';

import { AUTO_REVIEW_FLAG_ID } from './flag';
import { IAutoReviewGate, IAutoReviewService, type AutoReviewResult } from './review';

const AUTO_REVIEW_ORIGIN = 'auto-review';

export class AutoReviewGate implements IAutoReviewGate {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IAgentPermissionModeService private readonly modes: IAgentPermissionModeService,
    @IAgentPermissionPolicyService private readonly policies: IAgentPermissionPolicyService,
    @IAutoReviewService private readonly reviewService: IAutoReviewService,
  ) {}

  async trigger(
    context: ResolvedToolExecutionHookContext,
    evaluation: PermissionPolicyEvaluation,
  ): Promise<string | undefined> {
    if (evaluation.modeApproval !== true || !this.flags.enabled(AUTO_REVIEW_FLAG_ID)) return undefined;
    const withoutModeApproval = await this.policies.evaluateWithoutModeApproval(context);
    return withoutModeApproval?.result.kind === 'ask' ? withoutModeApproval.policyName : undefined;
  }

  async resolve(
    context: ResolvedToolExecutionHookContext,
    evaluation: PermissionPolicyEvaluation,
    trigger: string,
  ): Promise<PermissionPolicyEvaluation> {
    const review = await this.reviewService.review(context, trigger);
    const mode = this.modes.mode;
    const allowed = review.kind === 'decision' && review.decision.decision === 'allow';
    if (allowed && mode !== 'manual') return evaluation;
    if (mode === 'auto') {
      return { policyName: AUTO_REVIEW_ORIGIN, result: denial(context, review) };
    }
    return { policyName: AUTO_REVIEW_ORIGIN, result: fallbackAsk(context, review) };
  }
}

function denial(
  context: ResolvedToolExecutionHookContext,
  review: AutoReviewResult,
): Extract<PermissionPolicyResult, { kind: 'deny' }> {
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
): PermissionPolicyResult {
  if (review.kind === 'failed') {
    return {
      kind: 'ask',
      reason: { review_error: true },
      resolveNonInteractive: () => denial(context, review),
      resolveError: () => ({
        kind: 'deny',
        message: 'Auto Review and the fallback approval both failed; the tool was not executed.',
        reason: { review_error: true },
      }),
    };
  }
  const { decision } = review;
  if (decision.decision === 'allow') {
    return { kind: 'ask', reason: { review_risk: decision.risk, review_mode_changed: true } };
  }
  return {
    kind: 'ask',
    reason: { review_risk: decision.risk },
    resolveNonInteractive: () => denial(context, review),
    resolveApproval: (response) => response.decision === 'approved'
      ? undefined
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
