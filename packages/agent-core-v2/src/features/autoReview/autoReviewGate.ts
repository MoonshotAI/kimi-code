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

import { AUTO_REVIEW_FLAG_ID } from './flag';
import type { AutoReviewOutcome, IAutoReviewService } from './review';

const AUTO_REVIEW_ORIGIN = 'auto-review';
const MODE_APPROVAL_POLICIES: ReadonlySet<string> = new Set([
  'auto-mode-approve',
  'yolo-mode-approve',
]);

type AskPolicyResult = Extract<PermissionPolicyResult, { readonly kind: 'ask' }>;

export function createAutoReviewReviewer(
  flags: IFlagService,
  modes: IAgentPermissionModeService,
  policies: IAgentPermissionPolicyService,
  reviewService: IAutoReviewService,
): PermissionGateReviewer {
  return async (context, evaluation) => {
    if (!flags.enabled(AUTO_REVIEW_FLAG_ID) || modes.mode === 'manual') return undefined;
    const askEval = evaluation.result.kind === 'ask'
      ? evaluation
      : MODE_APPROVAL_POLICIES.has(evaluation.policyName)
        ? await policies.evaluate(context, { skipModeApprovals: true })
        : undefined;
    if (askEval?.result.kind !== 'ask') return undefined;
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
  baseAsk: AskPolicyResult | undefined,
  review: AutoReviewOutcome,
  mode: PermissionMode,
): PermissionPolicyEvaluation {
  if (review.decision === 'allow' && mode !== 'manual') {
    return {
      policyName: AUTO_REVIEW_ORIGIN,
      result: {
        kind: 'approve',
        reason: withReason(baseAsk?.reason, { review_risk: review.risk }),
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
  review: AutoReviewOutcome,
  baseReason?: PermissionDecisionReason,
): Extract<PermissionPolicyResult, { kind: 'deny' }> {
  if (review.decision === 'failed') {
    return {
      kind: 'deny',
      message: `Auto Review could not complete; the tool was not executed: ${review.reason} Resolve the review error or ask the user for guidance.`,
      reason: withReason(baseReason, { review_error: true }),
    };
  }
  const suffix = review.decision === 'deny' && review.reason !== undefined ? ` ${review.reason}` : '';
  return {
    kind: 'deny',
    message: `Auto Review denied tool "${context.toolCall.name}"; it was not executed.${suffix} Do not retry the same action or bypass the review.`,
    reason: withReason(baseReason, { review_risk: review.risk }),
  };
}

function fallbackAsk(
  context: ResolvedToolExecutionHookContext,
  review: AutoReviewOutcome,
  baseAsk?: AskPolicyResult,
): AskPolicyResult {
  if (review.decision === 'allow') {
    return {
      ...baseAsk,
      kind: 'ask',
      reason: withReason(baseAsk?.reason, { review_risk: review.risk, review_mode_changed: true }),
    };
  }
  if (review.decision === 'failed') {
    return {
      ...baseAsk,
      kind: 'ask',
      reason: withReason(baseAsk?.reason, { review_error: true }),
      approvalDetail: { outcome: 'failed', reason: review.reason },
      resolveNonInteractive: () => denial(context, review, baseAsk?.reason),
      resolveError: (error) =>
        baseAsk?.resolveError?.(error) ?? {
          kind: 'deny',
          message: 'Auto Review and the fallback approval both failed; the tool was not executed.',
          reason: withReason(baseAsk?.reason, { review_error: true }),
        },
    };
  }
  const suffix = review.reason !== undefined ? ` ${review.reason}` : '';
  return {
    ...baseAsk,
    kind: 'ask',
    reason: withReason(baseAsk?.reason, { review_risk: review.risk }),
    approvalDetail: {
      outcome: 'denied',
      risk: review.risk,
      reason: review.reason ?? 'The reviewer did not provide a reason.',
    },
    resolveNonInteractive: () => denial(context, review, baseAsk?.reason),
    resolveApproval: (response) => response.decision === 'approved'
      ? baseAsk?.resolveApproval?.(response)
      : {
          kind: 'deny',
          message: `Tool "${context.toolCall.name}" was not run after Auto Review denial.${suffix}${feedbackSuffix(response.feedback)}`,
        },
  };
}

function withReason(
  base: PermissionDecisionReason | undefined,
  extra: PermissionDecisionReason,
): PermissionDecisionReason {
  return base === undefined ? extra : { ...base, ...extra };
}

function feedbackSuffix(feedback: string | undefined): string {
  return feedback !== undefined && feedback.length > 0 ? ` Reason: ${feedback}` : '';
}
