import { RETRY_DETAIL_MAX_CHARS } from '../constant/rendering';
import type { StepRetryState } from '../types';

export function formatStepRetryLabel(retry: StepRetryState): string {
  const base = `Retrying (${retry.nextAttempt}/${retry.maxAttempts}) · ${retry.errorName}`;
  if (retry.phase === 'attempt') return base;
  const delaySeconds = Math.max(1, Math.ceil(retry.delayMs / 1000));
  return `${base} · in ${delaySeconds}s`;
}

/** Detail line under the spinner: status code + provider message, single-line, capped. */
export function formatStepRetryDetail(retry: StepRetryState): string {
  const message = retry.errorMessage.replaceAll(/\s+/g, ' ').trim();
  const code = retry.statusCode === undefined ? '' : String(retry.statusCode);
  const detail = [code, message].filter((part) => part.length > 0).join(' · ');
  return detail.length > RETRY_DETAIL_MAX_CHARS
    ? `${detail.slice(0, RETRY_DETAIL_MAX_CHARS - 1)}…`
    : detail;
}
