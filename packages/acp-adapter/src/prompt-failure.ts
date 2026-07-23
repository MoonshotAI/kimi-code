import { RequestError, type PromptResponse } from '@agentclientprotocol/sdk';
import { ErrorCodes, KIMI_ERROR_INFO } from '@moonshot-ai/kimi-code-sdk';

export type PromptFailureOutcome =
  | { readonly kind: 'authRequired'; readonly error: RequestError }
  | { readonly kind: 'refusal'; readonly response: PromptResponse }
  | { readonly kind: 'internalError'; readonly error: RequestError };

export function mapPromptFailure(error: unknown): PromptFailureOutcome {
  const code = kimiErrorCodeFromUnknown(error);
  if (code === ErrorCodes.AUTH_LOGIN_REQUIRED || code === ErrorCodes.PROVIDER_AUTH_ERROR) {
    return { kind: 'authRequired', error: RequestError.authRequired() };
  }
  if (code === ErrorCodes.PROVIDER_FILTERED) {
    return { kind: 'refusal', response: { stopReason: 'refusal' } };
  }

  const info = code === undefined ? undefined : KIMI_ERROR_INFO[code];
  const data =
    info?.public === true
      ? {
          code,
          retryable: info.retryable,
          statusCode: validHttpStatusCode(detailsFromUnknown(error)?.['statusCode']),
        }
      : undefined;
  return {
    kind: 'internalError',
    error: RequestError.internalError(data, 'session prompt failed'),
  };
}

function kimiErrorCodeFromUnknown(
  error: unknown,
): keyof typeof KIMI_ERROR_INFO | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' && Object.hasOwn(KIMI_ERROR_INFO, code)
    ? (code as keyof typeof KIMI_ERROR_INFO)
    : undefined;
}

function detailsFromUnknown(error: unknown): Record<string, unknown> | undefined {
  if (error === null || typeof error !== 'object' || !('details' in error)) return undefined;
  const details = error.details;
  return details !== null && typeof details === 'object' && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : undefined;
}

function validHttpStatusCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}
