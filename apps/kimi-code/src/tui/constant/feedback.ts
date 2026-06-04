/**
 * Constants for the /feedback command — endpoints, telemetry keys, and
 * the status messages shown around the feedback submission flow.
 *
 * Dialog-internal copy (the box title, subtitle, footer) lives next to
 * the dialog component itself, since it is part of that component's
 * visual contract.
 */

import { FEEDBACK_VERSION_PREFIX } from '#/constant/app';

export {
  FEEDBACK_ISSUE_URL,
  FEEDBACK_TELEMETRY_EVENT,
  FEEDBACK_VERSION_PREFIX,
} from '#/constant/app';

export const FEEDBACK_STATUS_SUBMITTING = 'Submitting feedback…';
export const FEEDBACK_STATUS_SUCCESS = 'Feedback submitted, thank you!';
export const FEEDBACK_STATUS_CANCELLED = 'Feedback cancelled.';
export const FEEDBACK_STATUS_NETWORK_ERROR = 'Network error, failed to submit feedback.';
export const FEEDBACK_STATUS_FALLBACK = 'Opening GitHub Issues as fallback…';
export const FEEDBACK_STATUS_NOT_SIGNED_IN =
  "You're not signed in. Opening GitHub Issues for feedback…";

export function feedbackHttpErrorMessage(status: number): string {
  return `Failed to submit feedback (HTTP ${String(status)}).`;
}

export function feedbackSessionLine(sessionId: string): string {
  return `Session: ${sessionId}`;
}

// Hint shown beneath session-level error messages in the TUI to point users
// at the `/export-debug-zip` workflow so they can share diagnostics with us.
export function errorReportHintLine(): string {
  return "If this persists, run `/export-debug-zip` and share the file with us for diagnosis. Please don't share it publicly.";
}

export function withFeedbackVersionPrefix(version: string): string {
  return `${FEEDBACK_VERSION_PREFIX}${version}`;
}
