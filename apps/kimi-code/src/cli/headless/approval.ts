import type { HeadlessWarning } from './status-file';

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
