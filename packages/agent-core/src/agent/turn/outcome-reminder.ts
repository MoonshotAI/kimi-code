import { escapeXml } from '../../utils/xml-escape';

export const TURN_OUTCOME_REMINDER_VARIANT = 'turn_outcome';

const MAX_ERROR_SUMMARY_LENGTH = 500;

interface TurnErrorSummary {
  readonly code: string;
  readonly message: string;
  readonly name?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function renderTurnFailureReminder(error: TurnErrorSummary | undefined): string {
  return [
    'The previous turn ended before producing a final response.',
    '',
    `Error: ${renderPublicError(error)}`,
    '',
    'The preceding user request may still be unfinished. Treat the next user message as a follow-up.',
  ].join('\n');
}

export function renderTurnCancellationReminder(reason: unknown, userInitiated: boolean): string {
  const lines = [
    userInitiated
      ? 'The user interrupted the previous turn before it finished.'
      : 'The previous turn was interrupted by the runtime before it finished.',
  ];
  const renderedReason = userInitiated ? undefined : renderInterruptionReason(reason);
  if (renderedReason !== undefined) lines.push('', `Reason: ${renderedReason}`);
  lines.push(
    '',
    'Some operations may already have taken effect. Treat the next user message as a follow-up, and check existing state before repeating operations.',
  );
  return lines.join('\n');
}

function renderPublicError(error: TurnErrorSummary | undefined): string {
  if (error === undefined) return 'The turn failed.';
  switch (error.code) {
    case 'provider.api_error': {
      const statusCode = numericDetail(error, 'statusCode');
      return statusCode === undefined
        ? 'The model provider API request failed.'
        : `API request failed with HTTP ${String(statusCode)}.`;
    }
    case 'provider.rate_limit':
      return 'The model provider rate-limited the request.';
    case 'provider.auth_error':
      return 'Authentication with the model provider failed.';
    case 'provider.connection_error':
      return error.name?.toLowerCase().includes('timeout') === true
        ? 'The model provider request timed out.'
        : 'The request could not reach the model provider.';
    case 'provider.filtered':
      return 'The model provider blocked the response due to its safety policy.';
    case 'context.overflow':
      return 'The request exceeded the model context limit.';
    case 'loop.max_steps_exceeded': {
      const maxSteps = numericDetail(error, 'maxSteps');
      return maxSteps === undefined
        ? 'The turn exceeded its step limit.'
        : `The turn exceeded its ${String(maxSteps)}-step limit.`;
    }
    case 'model.not_configured':
      return 'No model is configured.';
    case 'model.config_invalid':
      return 'The model configuration is invalid.';
    default:
      return escapeXml(normalizeSummary(error.message) || 'The turn failed.');
  }
}

function renderInterruptionReason(reason: unknown): string | undefined {
  const raw = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : undefined;
  if (raw === undefined) return undefined;
  const normalized = normalizeSummary(raw);
  if (normalized.length === 0 || normalized === 'Aborted' || normalized === 'This operation was aborted') {
    return undefined;
  }
  return escapeXml(normalized);
}

function numericDetail(error: TurnErrorSummary, key: string): number | undefined {
  const value = error.details?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeSummary(value: string): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim();
  return normalized.length <= MAX_ERROR_SUMMARY_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_ERROR_SUMMARY_LENGTH - 3)}...`;
}
