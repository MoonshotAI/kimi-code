/**
 * Constants for the /feedback command — endpoints, telemetry keys, and
 * the status messages shown around the feedback submission flow.
 *
 * Dialog-internal copy (the box title, subtitle, footer) lives next to
 * the dialog component itself, since it is part of that component's
 * visual contract.
 */

import { t } from '#/i18n';

import { FEEDBACK_VERSION_PREFIX } from '#/constant/app';

export {
  FEEDBACK_ISSUE_URL,
  FEEDBACK_TELEMETRY_EVENT,
  FEEDBACK_VERSION_PREFIX,
} from '#/constant/app';

export const FEEDBACK_STATUS_SUBMITTING = t('tui.messages.feedbackSubmitting');
export const FEEDBACK_STATUS_UPLOADING = t('tui.messages.feedbackUploading');
export const FEEDBACK_STATUS_SUCCESS = t('tui.messages.feedbackSubmitted');
export const FEEDBACK_STATUS_CANCELLED = t('tui.messages.feedbackCancelled');
export const FEEDBACK_STATUS_NETWORK_ERROR = t('tui.messages.feedbackNetworkError');
export const FEEDBACK_STATUS_FALLBACK = t('tui.messages.feedbackOpeningGithub');
export const FEEDBACK_STATUS_NOT_SIGNED_IN = t('tui.messages.feedbackNotSignedIn');
export const FEEDBACK_STATUS_UPLOAD_FAILED = t('tui.messages.feedbackSentUploadFailed');

export function feedbackHttpErrorMessage(status: number): string {
  return t('tui.messages.feedbackHttpFailed', { status: String(status) });
}

export function feedbackSessionLine(sessionId: string): string {
  return t('tui.messages.feedbackSession', { sessionId });
}

export function feedbackIdLine(feedbackId: number): string {
  return t('tui.messages.feedbackId', { id: String(feedbackId) });
}

// Hint shown beneath session-level error messages in the TUI to point users
// at the `/export-debug-zip` workflow so they can share diagnostics with us.
export function errorReportHintLine(): string {
  return t('tui.messages.feedbackPersistHint');
}

export function withFeedbackVersionPrefix(version: string): string {
  return `${FEEDBACK_VERSION_PREFIX}${version}`;
}
