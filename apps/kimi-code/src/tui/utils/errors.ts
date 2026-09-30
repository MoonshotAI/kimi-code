import { isKimiError } from '@moonshot-ai/kimi-code-sdk';

function isAbortMessage(message: string): boolean {
  return message === 'Aborted' || message.endsWith(': Aborted');
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || isAbortMessage(error.message);
  }
  if (typeof error === 'object' && error !== null) {
    const message = (error as { readonly message?: unknown }).message;
    return typeof message === 'string' && isAbortMessage(message);
  }
  return isAbortMessage(String(error));
}

export function formatErrorMessage(error: unknown): string {
  if (isKimiError(error)) {
    return formatErrorPayload({
      code: error.code,
      message: error.message,
      details: error.details,
    });
  }
  return error instanceof Error ? error.message : String(error);
}

interface ErrorPayloadLike {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export function formatErrorPayload(error: ErrorPayloadLike): string {
  const filteredMessage = formatProviderFilteredMessage(error.details);
  if (filteredMessage !== undefined) return `[${error.code}] ${filteredMessage}`;
  return `[${error.code}] ${error.message}`;
}

function formatProviderFilteredMessage(
  details: Record<string, unknown> | undefined,
): string | undefined {
  const finishReason = stringDetail(details, 'finishReason');
  const rawFinishReason = stringDetail(details, 'rawFinishReason');
  if (finishReason !== 'filtered' && rawFinishReason !== 'content_filter') return undefined;

  const normalizedFinishReason = finishReason ?? 'filtered';
  const raw = rawFinishReason === undefined ? '' : `, rawFinishReason=${rawFinishReason}`;
  return `Provider filtered the response before visible output (finishReason=${normalizedFinishReason}${raw}).`;
}

function stringDetail(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  return typeof value === 'string' ? value : undefined;
}
