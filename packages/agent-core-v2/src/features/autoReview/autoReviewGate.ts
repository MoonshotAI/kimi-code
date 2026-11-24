import type { PermissionGateReviewer } from '#/agent/permissionGate/permissionGate';
import type { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionPolicyEvaluation } from '#/agent/permissionPolicy/permissionPolicy';
import type {
  PermissionDecisionReason,
  PermissionMode,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type { IFlagService } from '#/app/flag/flag';

import { AUTO_REVIEW_FLAG_ID } from './flag';
import type { AutoReviewResult, IAutoReviewService } from './review';

const AUTO_REVIEW_ORIGIN = 'auto-review';

export function createAutoReviewReviewer(
  flags: IFlagService,
  modes: IAgentPermissionModeService,
  reviewService: IAutoReviewService,
): PermissionGateReviewer {
  return {
    evaluateOptions: () => ({
      includeUnderlying: flags.enabled(AUTO_REVIEW_FLAG_ID) && modes.mode !== 'manual',
    }),
    review: (context, evaluation) => {
      const trigger = autoReviewTrigger(flags.enabled(AUTO_REVIEW_FLAG_ID), modes.mode, evaluation);
      if (trigger === undefined) return undefined;
      return async () => resolveAutoReview(
        context,
        evaluation,
        await reviewService.review(context, trigger),
        flags.enabled(AUTO_REVIEW_FLAG_ID) ? modes.mode : 'manual',
      );
    },
  };
}

export function autoReviewTrigger(
  enabled: boolean,
  mode: PermissionMode,
  evaluation: PermissionPolicyEvaluation,
): string | undefined {
  if (!enabled || mode === 'manual') return undefined;
  if (evaluation.result.kind === 'ask') return evaluation.policyName;
  const underlying = evaluation.underlying;
  return underlying?.result.kind === 'ask' ? underlying.policyName : undefined;
}

export function resolveAutoReview(
  context: ResolvedToolExecutionHookContext,
  evaluation: PermissionPolicyEvaluation,
  review: AutoReviewResult,
  mode: PermissionMode,
): PermissionPolicyEvaluation {
  const baseAsk = evaluation.result.kind === 'ask'
    ? evaluation.result
    : evaluation.underlying?.result.kind === 'ask'
      ? evaluation.underlying.result
      : undefined;
  const allowed = review.kind === 'decision' && review.decision.decision === 'allow';
  if (allowed && mode !== 'manual') {
    return {
      policyName: AUTO_REVIEW_ORIGIN,
      result: {
        kind: 'approve',
        reason: withReason(baseAsk?.reason, { review_risk: review.decision.risk }),
        executionMetadata: evaluation.result.kind === 'approve' ? evaluation.result.executionMetadata : undefined,
      },
    };
  }
  if (mode === 'auto') {
    return { policyName: AUTO_REVIEW_ORIGIN, result: denial(context, review, baseAsk?.reason) };
  }
  return { policyName: AUTO_REVIEW_ORIGIN, result: fallbackAsk(context, review, baseAsk) };
}

function denial(
  context: ResolvedToolExecutionHookContext,
  review: AutoReviewResult,
  baseReason?: PermissionDecisionReason,
): Extract<PermissionPolicyResult, { kind: 'deny' }> {
  if (review.kind === 'failed') {
    return {
      kind: 'deny',
      message: `Auto Review could not complete; the tool was not executed: ${review.reason} Resolve the review error or ask the user for guidance.`,
      reason: withReason(baseReason, { review_error: true }),
    };
  }
  return {
    kind: 'deny',
    message: `Auto Review denied tool "${context.toolCall.name}"; it was not executed.${reasonSuffix(review)} Do not retry the same action or bypass the review.`,
    reason: withReason(baseReason, { review_risk: review.decision.risk }),
  };
}

function fallbackAsk(
  context: ResolvedToolExecutionHookContext,
  review: AutoReviewResult,
  baseAsk?: Extract<PermissionPolicyResult, { kind: 'ask' }>,
): PermissionPolicyResult {
  if (review.kind === 'failed') {
    return {
      ...baseAsk,
      kind: 'ask',
      reason: withReason(baseAsk?.reason, { review_error: true }),
      approvalDetail: { title: 'Auto Review failed', detail: review.reason },
      resolveNonInteractive: () => denial(context, review, baseAsk?.reason),
      resolveError: (error) =>
        baseAsk?.resolveError?.(error) ?? {
          kind: 'deny',
          message: 'Auto Review and the fallback approval both failed; the tool was not executed.',
          reason: withReason(baseAsk?.reason, { review_error: true }),
        },
    };
  }
  const { decision } = review;
  if (decision.decision === 'allow') {
    return {
      ...baseAsk,
      kind: 'ask',
      reason: withReason(baseAsk?.reason, { review_risk: decision.risk, review_mode_changed: true }),
    };
  }
  return {
    ...baseAsk,
    kind: 'ask',
    reason: withReason(baseAsk?.reason, { review_risk: decision.risk }),
    approvalDetail: {
      title: `Auto Review: denied (${decision.risk} risk)`,
      detail: decision.reason ?? 'The reviewer did not provide a reason.',
    },
    resolveNonInteractive: () => denial(context, review, baseAsk?.reason),
    resolveApproval: (response) => response.decision === 'approved'
      ? baseAsk?.resolveApproval?.(response)
      : {
          kind: 'deny',
          message: `Tool "${context.toolCall.name}" was not run after Auto Review denial.${reasonSuffix(review)}${feedbackSuffix(response.feedback)}`,
        },
  };
}

function withReason(
  base: PermissionDecisionReason | undefined,
  extra: PermissionDecisionReason,
): PermissionDecisionReason {
  return base === undefined ? extra : { ...base, ...extra };
}

function reasonSuffix(review: Extract<AutoReviewResult, { kind: 'decision' }>): string {
  return review.decision.decision === 'deny' && review.decision.reason !== undefined
    ? ` ${review.decision.reason}`
    : '';
}

function feedbackSuffix(feedback: string | undefined): string {
  return feedback !== undefined && feedback.length > 0 ? ` Reason: ${feedback}` : '';
}
