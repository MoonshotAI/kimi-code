// apps/desktop/src/renderer/lib/approvalTelemetry.ts
// Decision naming for the `approval_decision` telemetry event (ApprovalCard).
// Kept pure and component-free so the naming rules are unit-testable without
// mounting the card.

/** How the user delivered the decision: a footer/option button click, or one
 *  of the number-key shortcuts (1/2/3/4) handled by the card's keydown. */
export type ApprovalVia = 'button' | 'number-key';

/**
 * Maps the card's pending-action key to the telemetry decision name. Most
 * keys already ARE the public decision name ('approve', 'approveSession',
 * 'reject', 'approvePlan', 'rejectAndExit'); the two composite keys flatten:
 *   option:<label>  → 'approveOption' (the clicked/numbered plan approach)
 *   feedback        → 'revisePlan' for a plan review (selectedLabel 'Revise'),
 *                     'reject' otherwise (a rejection carrying feedback text)
 */
export function approvalDecisionName(action: string, selectedLabel?: string): string {
  if (action.startsWith('option:')) return 'approveOption';
  if (action === 'feedback') return selectedLabel === 'Revise' ? 'revisePlan' : 'reject';
  return action;
}
