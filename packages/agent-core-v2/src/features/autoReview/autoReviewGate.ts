import type { PermissionGateReviewer } from '#/agent/permissionGate/permissionGate';
import type { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionPolicyEvaluation } from '#/agent/permissionPolicy/permissionPolicy';
import type { PermissionMode, PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type { IFlagService } from '#/app/flag/flag';

import { AUTO_REVIEW_FLAG_ID } from './flag';
import type { AutoReviewGateCallbacks, AutoReviewResult, IAutoReviewService } from './review';

const AUTO_REVIEW_ORIGIN = 'auto-review';

type GateCallbacksInput = ((toolCallId: string) => void) | AutoReviewGateCallbacks;

export function createAutoReviewReviewer(
  flags: IFlagService,
  modes: IAgentPermissionModeService,
  reviewService: () => IAutoReviewService,
  callbacks?: GateCallbacksInput,
): PermissionGateReviewer {
  return {
    evaluateOptions: () => {
      const reviewing = flags.enabled(AUTO_REVIEW_FLAG_ID) && modes.mode !== 'manual';
      return {
        includeUnderlying: reviewing,
        skipDangerousCommand: reviewing && modes.mode === 'yolo',
      };
    },
    review: (context, evaluation) => {
      const trigger = autoReviewTrigger(
        flags.enabled(AUTO_REVIEW_FLAG_ID),
        modes.mode,
        evaluation,
        context.toolCall.name,
      );
      if (trigger === undefined) return undefined;
      let pending: Promise<AutoReviewResult> | undefined;
      const start = (): Promise<AutoReviewResult> => {
        pending ??= reviewService().review(context, trigger, context.reviewSignal);
        void pending.catch(() => undefined);
        return pending;
      };
      context.deferReview(() => {
        void start();
      });
      return async () => {
        const review = await start();
        return resolveAutoReview(
          context,
          evaluation,
          review,
          flags.enabled(AUTO_REVIEW_FLAG_ID) ? modes.mode : 'manual',
          callbacks,
        );
      };
    },
  };
}

const UNREVIEWED_TOOLS = new Set(['Write', 'Edit']);

export function autoReviewTrigger(
  enabled: boolean,
  mode: PermissionMode,
  evaluation: PermissionPolicyEvaluation,
  toolName?: string,
): string | undefined {
  if (!enabled || mode === 'manual') return undefined;
  if (toolName !== undefined && UNREVIEWED_TOOLS.has(toolName)) return undefined;
  if (evaluation.result.kind === 'ask') return evaluation.policyName;
  const underlying = evaluation.underlying;
  return underlying?.result.kind === 'ask' ? underlying.policyName : undefined;
}

export function resolveAutoReview(
  context: ResolvedToolExecutionHookContext,
  evaluation: PermissionPolicyEvaluation,
  review: AutoReviewResult,
  mode: PermissionMode,
  callbacks?: GateCallbacksInput,
): PermissionPolicyEvaluation {
  const handlers = normalizeCallbacks(callbacks);
  const allowed = review.kind === 'decision' && review.decision.decision === 'allow';
  if (allowed && mode !== 'manual') {
    if (mode === 'auto') handlers?.onAutoAllow?.(context.turnId);
    return {
      policyName: AUTO_REVIEW_ORIGIN,
      result: {
        kind: 'approve',
        reason: { review_risk: review.decision.risk },
        executionMetadata: evaluation.result.kind === 'approve' ? evaluation.result.executionMetadata : undefined,
      },
    };
  }
  if (mode === 'auto') {
    if (review.kind === 'failed') {
      handlers?.onAutoFailed?.(context.turnId);
      return { policyName: AUTO_REVIEW_ORIGIN, result: denial(context, review, false) };
    }
    const circuitBroken = handlers?.onAutoDeny?.(context.turnId) === true;
    return { policyName: AUTO_REVIEW_ORIGIN, result: denial(context, review, circuitBroken) };
  }
  return { policyName: AUTO_REVIEW_ORIGIN, result: fallbackAsk(context, review, handlers?.onApproved) };
}

function normalizeCallbacks(callbacks: GateCallbacksInput | undefined): AutoReviewGateCallbacks | undefined {
  if (callbacks === undefined) return undefined;
  return typeof callbacks === 'function' ? { onApproved: callbacks } : callbacks;
}

function denial(
  context: ResolvedToolExecutionHookContext,
  review: AutoReviewResult,
  circuitBroken = false,
): Extract<PermissionPolicyResult, { kind: 'deny' }> {
  if (review.kind === 'failed') {
    return {
      kind: 'deny',
      message: `Auto Review could not complete; the tool was not executed: ${review.reason} Resolve the review error or ask the user for guidance.`,
      reason: { review_error: true },
    };
  }
  const followUp = circuitBroken
    ? 'Auto Review stopped this turn after repeated denials. Stop and ask the user for explicit authorization before continuing.'
    : 'Do not retry the same action or bypass the review.';
  return {
    kind: 'deny',
    message: `Auto Review denied tool "${context.toolCall.name}"; it was not executed.${reasonSuffix(review)} ${followUp}`,
    reason: circuitBroken
      ? { review_risk: review.decision.risk, review_circuit_breaker: true }
      : { review_risk: review.decision.risk },
  };
}

function fallbackAsk(
  context: ResolvedToolExecutionHookContext,
  review: AutoReviewResult,
  onApproved?: (toolCallId: string) => void,
): PermissionPolicyResult {
  const approve = (): undefined => {
    onApproved?.(context.toolCall.id);
    return undefined;
  };
  if (review.kind === 'failed') {
    return {
      kind: 'ask',
      reason: { review_error: true },
      approvalDetail: { title: 'Auto Review failed', detail: review.reason },
      resolveNonInteractive: () => denial(context, review),
      resolveApproval: (response) => (response.decision === 'approved' ? approve() : undefined),
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
      resolveApproval: (response) => (response.decision === 'approved' ? approve() : undefined),
    };
  }
  return {
    kind: 'ask',
    reason: { review_risk: decision.risk },
    approvalDetail: {
      title: `Auto Review: denied (${decision.risk} risk)`,
      detail: decision.reason ?? 'The reviewer did not provide a reason.',
    },
    resolveNonInteractive: () => denial(context, review),
    resolveApproval: (response) => response.decision === 'approved'
      ? approve()
      : {
          kind: 'deny',
          message: `Tool "${context.toolCall.name}" was not run after Auto Review denial.${reasonSuffix(review)}${feedbackSuffix(response.feedback)}`,
        },
  };
}

function reasonSuffix(review: Extract<AutoReviewResult, { kind: 'decision' }>): string {
  return review.decision.decision === 'deny' && review.decision.reason !== undefined
    ? ` ${review.decision.reason}`
    : '';
}

function feedbackSuffix(feedback: string | undefined): string {
  return feedback !== undefined && feedback.length > 0 ? ` Reason: ${feedback}` : '';
}
