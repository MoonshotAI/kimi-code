import type { PermissionGateReviewer } from '#/agent/permissionGate/permissionGate';
import type { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type {
  IAgentPermissionPolicyService,
  PermissionPolicyEvaluation,
} from '#/agent/permissionPolicy/permissionPolicy';
import type {
  PermissionDecisionReason,
  PermissionMode,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type { IFlagService } from '#/app/flag/flag';
import { isMcpToolName } from '#/tool/toolContract';

import { AUTO_REVIEW_FLAG_ID } from './flag';
import type { AutoReviewOutcome, IAutoReviewService } from './review';

const AUTO_REVIEW_ORIGIN = 'auto-review';

type AskPolicyResult = Extract<PermissionPolicyResult, { readonly kind: 'ask' }>;

export function createAutoReviewReviewer(
  flags: IFlagService,
  modes: IAgentPermissionModeService,
  policies: IAgentPermissionPolicyService,
  reviewService: Pick<IAutoReviewService, 'review'>,
): PermissionGateReviewer {
  return async (context, evaluation) => {
    if (
      !flags.enabled(AUTO_REVIEW_FLAG_ID) ||
      modes.mode === 'manual' ||
      (context.toolCall.name !== 'Bash' && !isMcpToolName(context.toolCall.name))
    ) {
      return undefined;
    }
    const askEval = evaluation.result.kind === 'ask'
      ? evaluation
      : evaluation.result.kind === 'approve'
        ? await policies.evaluate(context, { mode: 'manual' })
        : undefined;
    if (askEval?.result.kind !== 'ask' || askEval.policyName === 'user-configured-ask') return undefined;
    const baseAsk = askEval.result;
    return async () => resolveAutoReview(
      context,
      evaluation,
      baseAsk,
      await reviewService.review(context, askEval.policyName),
      flags.enabled(AUTO_REVIEW_FLAG_ID) ? modes.mode : 'manual',
    );
  };
}

export function resolveAutoReview(
  context: ResolvedToolExecutionHookContext,
  evaluation: PermissionPolicyEvaluation,
  baseAsk: AskPolicyResult,
  review: AutoReviewOutcome,
  mode: PermissionMode,
): PermissionPolicyEvaluation {
  if (review.decision === 'allow' && mode !== 'manual') {
    return {
      policyName: AUTO_REVIEW_ORIGIN,
      result: {
        kind: 'approve',
        reason: { ...baseAsk.reason, review_risk: review.risk },
        executionMetadata: evaluation.result.kind === 'approve' ? evaluation.result.executionMetadata : undefined,
      },
    };
  }
  if (mode === 'auto') {
    return { policyName: AUTO_REVIEW_ORIGIN, result: denial(context, review, baseAsk.reason) };
  }
  return { policyName: AUTO_REVIEW_ORIGIN, result: fallbackAsk(context, review, baseAsk) };
}

function denial(
  context: ResolvedToolExecutionHookContext,
  review: AutoReviewOutcome,
  baseReason?: PermissionDecisionReason,
): Extract<PermissionPolicyResult, { kind: 'deny' }> {
  if (review.decision === 'failed') {
    return {
      kind: 'deny',
      message: `Auto Review could not complete; the tool was not executed: ${review.reason} Do not retry the same action or attempt to fix the review configuration yourself; inform the user in your response that Auto Review failed and include this reason.`,
      reason: { ...baseReason, review_error: true },
    };
  }
  const suffix = review.decision === 'deny' && review.reason !== undefined ? ` ${review.reason}` : '';
  const guidance = review.risk === 'high'
    ? 'High-risk actions cannot be authorized through Auto Review. Do not retry it or work around the review; tell the user it was blocked.'
    : 'Do not retry it or work around the review. If the action is still required, end your reply by stating the exact action and its target and asking the user to confirm.';
  return {
    kind: 'deny',
    message: `Auto Review denied tool "${context.toolCall.name}"; it was not executed.${suffix} ${guidance}`,
    reason: { ...baseReason, review_risk: review.risk },
  };
}

function fallbackAsk(
  context: ResolvedToolExecutionHookContext,
  review: AutoReviewOutcome,
  baseAsk: AskPolicyResult,
): AskPolicyResult {
  if (review.decision === 'allow') {
    return {
      ...baseAsk,
      kind: 'ask',
      reason: { ...baseAsk.reason, review_risk: review.risk, review_mode_changed: true },
    };
  }
  if (review.decision === 'failed') {
    return {
      ...baseAsk,
      kind: 'ask',
      reason: { ...baseAsk.reason, review_error: true },
      approvalDetail: { outcome: 'failed', reason: review.reason },
      resolveNonInteractive: () => denial(context, review, baseAsk.reason),
      resolveApproval: (response) => response.decision === 'approved'
        ? baseAsk.resolveApproval?.(response)
        : {
            kind: 'deny',
            message: `Tool "${context.toolCall.name}" was not run because ${response.decision === 'cancelled' ? 'the approval request was cancelled' : 'the user rejected the approval request'} (Auto Review failed: ${review.reason}).${feedbackSuffix(response.feedback)}`,
          },
      resolveError: (error) =>
        baseAsk.resolveError?.(error) ?? {
          kind: 'deny',
          message: 'Auto Review and the fallback approval both failed; the tool was not executed.',
          reason: { ...baseAsk.reason, review_error: true },
        },
    };
  }
  const suffix = review.reason !== undefined ? ` ${review.reason}` : '';
  return {
    ...baseAsk,
    kind: 'ask',
    reason: { ...baseAsk.reason, review_risk: review.risk },
    approvalDetail: {
      outcome: 'denied',
      risk: review.risk,
      reason: review.reason ?? 'The reviewer did not provide a reason.',
    },
    resolveNonInteractive: () => denial(context, review, baseAsk.reason),
    resolveApproval: (response) => response.decision === 'approved'
      ? baseAsk.resolveApproval?.(response)
      : {
          kind: 'deny',
          message: `Tool "${context.toolCall.name}" was not run after Auto Review denial.${suffix}${feedbackSuffix(response.feedback)}`,
        },
  };
}

function feedbackSuffix(feedback: string | undefined): string {
  return feedback !== undefined && feedback.length > 0 ? ` Reason: ${feedback}` : '';
}
