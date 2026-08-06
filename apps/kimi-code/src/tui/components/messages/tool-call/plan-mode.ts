/**
 * ExitPlanMode result parsing logic.
 *
 * Extracted from tool-call.ts as a pure data-parsing module with no
 * UI or state dependencies.
 */

const APPROVED_PLAN_MARKER = '## Approved Plan:';
const AUTO_APPROVED_PLAN_MARKER = '## Plan (auto-approved, not user-reviewed):';
const AUTO_APPROVED_NOTE = 'auto-approved without user review';
const REJECT_PREFIX = 'User rejected the plan.';
const REJECT_FEEDBACK_PREFIX = 'User rejected the plan. Feedback:';
const APPROVED_OPTION_RE = /^User approve option "([^"]+)"\./;
const PLAN_REJECT_PREFIX = 'Plan rejected by user.';
const SELECTED_APPROACH_RE = /^Exited plan mode\. Selected approach: ([^\n]+)\n/;
const PLAN_SAVED_TO_RE = /\nPlan saved to: ([^\n]+)\n/;

export interface ExitPlanModeOutcome {
  readonly kind: 'approved' | 'rejected';
  readonly chosen?: string;
  readonly feedback?: string;
  readonly path?: string;
  readonly autoApproved?: boolean;
}

export function extractApprovedPlan(output: string): string {
  const autoIndex = output.indexOf(AUTO_APPROVED_PLAN_MARKER);
  if (autoIndex >= 0) {
    return output.slice(autoIndex + AUTO_APPROVED_PLAN_MARKER.length).trim();
  }
  const markerIndex = output.indexOf(APPROVED_PLAN_MARKER);
  if (markerIndex < 0) return '';
  return output.slice(markerIndex + APPROVED_PLAN_MARKER.length).trim();
}

/**
 * Parses the ExitPlanMode result content string to recover the approval outcome
 * and optional plan path.
 */
export function interpretExitPlanModeOutcome(output: string): ExitPlanModeOutcome {
  if (output.startsWith(REJECT_PREFIX)) {
    if (output.startsWith(REJECT_FEEDBACK_PREFIX)) {
      const feedback = output.slice(REJECT_FEEDBACK_PREFIX.length).trimStart();
      return { kind: 'rejected', feedback };
    }
    return { kind: 'rejected' };
  }
  if (output.startsWith(PLAN_REJECT_PREFIX)) {
    return { kind: 'rejected' };
  }
  const pathMatch = PLAN_SAVED_TO_RE.exec(output);
  const path = pathMatch?.[1]?.trim();
  const autoApproved = output.includes(AUTO_APPROVED_NOTE);
  const optionMatch = SELECTED_APPROACH_RE.exec(output) ?? APPROVED_OPTION_RE.exec(output);
  if (optionMatch !== null) {
    return path !== undefined && path.length > 0
      ? { kind: 'approved', chosen: optionMatch[1], path, autoApproved }
      : { kind: 'approved', chosen: optionMatch[1], autoApproved };
  }
  return path !== undefined && path.length > 0
    ? { kind: 'approved', path, autoApproved }
    : { kind: 'approved', autoApproved };
}

export function isExitPlanModeOutcomeOutput(output: string): boolean {
  return (
    output.startsWith(REJECT_PREFIX) ||
    output.startsWith(PLAN_REJECT_PREFIX) ||
    output.startsWith('Exited plan mode.') ||
    APPROVED_OPTION_RE.test(output) ||
    output.includes(APPROVED_PLAN_MARKER) ||
    output.includes(AUTO_APPROVED_PLAN_MARKER)
  );
}
