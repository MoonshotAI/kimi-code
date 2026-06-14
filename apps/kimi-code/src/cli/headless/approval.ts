import type { ApprovalHandler, ApprovalRequest, ApprovalResponse } from '@moonshot-ai/kimi-code-sdk';

import type { HeadlessApprovalStatus } from './status-file';
import type { HeadlessWarning } from './status-file';

export interface HeadlessApprovalOptions {
  readonly approvePlan: boolean;
  readonly rejectPlan: boolean;
  readonly onPlanApprovalRequired: (approval: HeadlessApprovalStatus) => void;
}

export function createHeadlessApprovalHandler(options: HeadlessApprovalOptions): ApprovalHandler {
  return (request) => {
    if (!isPlanApprovalRequest(request)) return { decision: 'approved' };

    const approval: HeadlessApprovalStatus = {
      kind: 'plan',
      toolCallId: request.toolCallId,
      decision: options.approvePlan ? 'approved' : options.rejectPlan ? 'rejected' : 'required',
      decidedByFlag: options.approvePlan ? 'approve-plan' : options.rejectPlan ? 'reject-plan' : null,
      message: options.approvePlan
        ? 'Plan approved by --approve-plan.'
        : options.rejectPlan
          ? 'Plan rejected by --reject-plan.'
          : 'rerun with --approve-plan or --reject-plan',
    };
    options.onPlanApprovalRequired(approval);

    if (options.approvePlan) {
      return approvePlanRequest(request);
    }
    if (options.rejectPlan) {
      return {
        decision: 'rejected',
        selectedLabel: 'Reject and Exit',
        feedback: 'Rejected by --reject-plan.',
      };
    }
    return {
      decision: 'cancelled',
      feedback: 'Plan approval requires --approve-plan or --reject-plan in headless mode.',
    };
  };
}

export function getUnusedPlanFlagWarning(options: {
  readonly approvePlan: boolean;
  readonly rejectPlan: boolean;
  readonly planApprovalSeen: boolean;
}): HeadlessWarning | null {
  if (options.planApprovalSeen) return null;
  if (options.approvePlan) {
    return {
      code: 'PLAN_FLAG_UNUSED',
      message: '--approve-plan was set, but no plan approval was requested.',
    };
  }
  if (options.rejectPlan) {
    return {
      code: 'PLAN_FLAG_UNUSED',
      message: '--reject-plan was set, but no plan approval was requested.',
    };
  }
  return null;
}

function isPlanApprovalRequest(request: ApprovalRequest): boolean {
  return request.toolName === 'ExitPlanMode' || request.display.kind === 'plan_review';
}

function approvePlanRequest(request: ApprovalRequest): ApprovalResponse {
  const firstOption =
    request.display.kind === 'plan_review' ? request.display.options?.[0]?.label : undefined;
  return {
    decision: 'approved',
    selectedLabel: firstOption,
  };
}
