// apps/desktop/src/renderer/lib/approvalTelemetry.ts
export type ApprovalVia = 'button' | 'number-key';

export function approvalDecisionName(action: string, selectedLabel?: string): string {
  if (action.startsWith('option:')) return 'approveOption';
  if (action === 'feedback') return selectedLabel === 'Revise' ? 'revisePlan' : 'reject';
  return action;
}
