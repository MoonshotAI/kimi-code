import { FEEDBACK_VERSION_PREFIX } from '#/constant/app';

export {
  FEEDBACK_ISSUE_URL,
  FEEDBACK_TELEMETRY_EVENT,
  FEEDBACK_VERSION_PREFIX,
  kimiCodeSignupUrl,
} from '#/constant/app';

export const FEEDBACK_STATUS_SUBMITTING = 'Submitting feedback…';
export const FEEDBACK_STATUS_UPLOADING = 'Uploading attachments, this could take a few minutes…';
export const FEEDBACK_STATUS_SUCCESS = "Thanks for taking the time to write this. It'll help us make Kimi better";
export const FEEDBACK_STATUS_CANCELLED = 'Feedback cancelled.';
export const FEEDBACK_STATUS_NETWORK_ERROR = 'Network error, failed to submit feedback.';
export const FEEDBACK_STATUS_FALLBACK = 'Opening GitHub Issues as fallback…';
export const FEEDBACK_STATUS_NOT_SIGNED_IN =
  "You're not signed in. Sign up or leave feedback on GitHub:";
export const FEEDBACK_STATUS_UPLOAD_FAILED =
  'Feedback sent; attachment upload failed — see feedback-upload.log.';

export function feedbackHttpErrorMessage(status: number): string {
  return `Failed to submit feedback (HTTP ${String(status)}).`;
}

export function feedbackSessionLine(sessionId: string): string {
  return `Session: ${sessionId}`;
}

export function feedbackIdLine(feedbackId: number): string {
  return `Feedback ID: ${String(feedbackId)}`;
}

export function errorReportHintLine(): string {
  return "If this persists, run `/export-debug-zip` and share the file with us for diagnosis. Please don't share it publicly.";
}

export function withFeedbackVersionPrefix(version: string): string {
  return `${FEEDBACK_VERSION_PREFIX}${version}`;
}
