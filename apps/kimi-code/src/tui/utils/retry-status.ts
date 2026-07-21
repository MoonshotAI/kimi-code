import type { TurnStepRetryingEvent } from '@moonshot-ai/kimi-code-sdk';

import type { RetryStatus } from '#/tui/types';

const TIMEOUT_RE = /timeout|timed out/i;

export function buildRetryStatus(
  event: TurnStepRetryingEvent,
  now = Date.now(),
): RetryStatus {
  return {
    failedAttempt: event.failedAttempt,
    nextAttempt: event.nextAttempt,
    maxAttempts: event.maxAttempts,
    delayMs: event.delayMs,
    nextRetryAt: now + event.delayMs,
    errorName: event.errorName,
    errorMessage: event.errorMessage,
    statusCode: event.statusCode,
  };
}

export function retryReasonText(
  status: Pick<RetryStatus, 'statusCode' | 'errorName' | 'errorMessage'>,
): string {
  const code = status.statusCode;
  if (code !== undefined) {
    if (code === 429) return 'Rate limited (429)';
    if (code === 408) return 'Request timed out (408)';
    if (code >= 500) return `Server error (${code})`;
    return `Provider error (${code})`;
  }
  if (TIMEOUT_RE.test(status.errorName) || TIMEOUT_RE.test(status.errorMessage)) {
    return 'Connection timed out';
  }
  return 'Connection issue';
}

export function formatRetryLabel(status: RetryStatus, now = Date.now()): string {
  const reason = retryReasonText(status);
  const attempt = `attempt ${status.nextAttempt}/${status.maxAttempts}`;
  const remaining = status.nextRetryAt - now;
  if (remaining > 0) {
    return `${reason} · ${attempt} · retrying in ${Math.ceil(remaining / 1000)}s`;
  }
  return `${reason} · ${attempt} · retrying now…`;
}
