// apps/desktop/src/renderer/lib/approvalTelemetry.ts
import type { ApprovalDecisionName } from '../../shared/track-events';

export type ApprovalVia = 'button' | 'number-key';

export type ApprovalTelemetryAction =
  | 'approve'
  | 'approveSession'
  | 'reject'
  | 'approvePlan'
  | 'rejectAndExit'
  | 'feedback'
  | `option:${string}`;

export function approvalDecisionName(
  action: ApprovalTelemetryAction,
  selectedLabel?: string,
): ApprovalDecisionName {
  switch (action) {
    case 'feedback':
      return selectedLabel === 'Revise' ? 'revisePlan' : 'reject';
    case 'approve':
    case 'approveSession':
    case 'reject':
    case 'approvePlan':
    case 'rejectAndExit':
      return action;
    default:
      return 'approveOption';
  }
}
