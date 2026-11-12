import { llmErrorName as coreLlmErrorName, type LlmErrorMessage as CoreLlmErrorMessage } from '@moonshot-ai/core/llm/response';
import { CoreErrors, errorInfo, isErrorCode } from './codes';
import type { ErrorCode } from '#/errors';
import { Error2 } from './errors';

export interface ErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;
  readonly cause?: ErrorPayload;
}

export type KimiErrorPayload = ErrorPayload;

export interface CodedErrorShape {
  readonly code: ErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable?: boolean;
}

const MAX_CAUSE_DEPTH = 8;

export function isCodedError(error: unknown): error is CodedErrorShape {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return isErrorCode(code);
}

export function makeErrorPayload(
  code: ErrorCode,
  message: string,
  options?: {
    readonly details?: Readonly<Record<string, unknown>>;
    readonly name?: string;
  },
): ErrorPayload {
  return {
    code,
    message,
    name: options?.name,
    details: options?.details,
    retryable: errorInfo(code).retryable,
  };
}

export function toErrorPayload(error: unknown): ErrorPayload {
  return toErrorPayloadAtDepth(error, 0);
}

function toErrorPayloadAtDepth(error: unknown, depth: number): ErrorPayload {
  const payload = toShallowErrorPayload(error);
  if (depth >= MAX_CAUSE_DEPTH) {
    return payload;
  }
  const cause = readErrorCause(error);
  if (cause === undefined) {
    return payload;
  }
  return { ...payload, cause: toErrorPayloadAtDepth(cause, depth + 1) };
}

function toShallowErrorPayload(error: unknown): ErrorPayload {
  if (isCodedError(error)) {
    return {
      code: error.code,
      message: error.message,
      name: error.name,
      details: detailsForErrorPayload(error),
      retryable: error.retryable ?? errorInfo(error.code).retryable,
    };
  }
  if (error instanceof Error) {
    return makeErrorPayload(CoreErrors.codes.INTERNAL, error.message, { name: error.name });
  }
  if (isLlmErrorMessage(error)) {
    const code = llmErrorCode(error);
    if (code === undefined) return makeErrorPayload(CoreErrors.codes.INTERNAL, error.message);
    return {
      ...makeErrorPayload(code, error.message),
      name: llmErrorName(error),
      details: llmErrorDetails(error),
      retryable: error.kind !== 'syntax' && error.retryable,
    };
  }
  return makeErrorPayload(CoreErrors.codes.INTERNAL, String(error));
}

function detailsForErrorPayload(
  error: CodedErrorShape,
): Readonly<Record<string, unknown>> | undefined {
  const details = error.details;
  if (details === undefined || details === null) return undefined;
  if (!Object.prototype.hasOwnProperty.call(details, 'statusCode')) {
    return details;
  }
  const directStatusCode = (error as { readonly statusCode?: unknown }).statusCode;
  if (typeof directStatusCode === 'number' && details['statusCode'] === directStatusCode) {
    return details;
  }
  const { statusCode: _statusCode, ...remaining } = details;
  return remaining;
}

type LlmErrorMessage = CoreLlmErrorMessage;

function isLlmErrorMessage(error: unknown): error is LlmErrorMessage {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { readonly kind?: unknown }).kind === 'string' &&
    typeof (error as { readonly message?: unknown }).message === 'string'
  );
}

function llmErrorCode(error: LlmErrorMessage): ErrorCode | undefined {
  if ('code' in error && isErrorCode(error.code)) return error.code as ErrorCode;
  switch (error.kind) {
    case 'rate_limit':
      return 'provider.rate_limit' as ErrorCode;
    case 'connection':
    case 'timeout':
      return 'provider.connection_error' as ErrorCode;
    case 'auth':
      return 'provider.auth_error' as ErrorCode;
    case 'context_overflow':
      return 'context.overflow' as ErrorCode;
    case 'overloaded':
      return 'provider.overloaded' as ErrorCode;
    case 'empty_response':
      return (error.finishReason === 'filtered'
        ? 'provider.filtered'
        : 'provider.api_error') as ErrorCode;
    case 'status':
    case 'request_too_large':
    case 'request_structure':
    case 'image_format':
    case 'provider':
    case 'quota_exhausted':
    case 'syntax':
    case 'unknown':
      return 'provider.api_error' as ErrorCode;
    default:
      return undefined;
  }
}

function llmErrorName(error: LlmErrorMessage): string | undefined {
  if ('error' in error) {
    const body = error.error;
    if (typeof body === 'object' && body !== null && 'name' in body) {
      const name = (body as { readonly name?: unknown }).name;
      if (typeof name === 'string') return name;
    }
  }
  return coreLlmErrorName(error);
}

function llmErrorDetails(error: LlmErrorMessage): Readonly<Record<string, unknown>> | undefined {
  if (!('statusCode' in error) && !('requestId' in error) && !('headers' in error)) return undefined;
  const headers = 'headers' in error ? error.headers : null;
  const traceId =
    headers === null || headers === undefined
      ? undefined
      : Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-trace-id')?.[1];
  return {
    requestId: 'requestId' in error ? error.requestId : undefined,
    statusCode: 'statusCode' in error ? error.statusCode : undefined,
    traceId,
  };
}

function readErrorCause(error: unknown): unknown {
  if (error === null || typeof error !== 'object') {
    return undefined;
  }
  return (error as { readonly cause?: unknown }).cause;
}

export const toKimiErrorPayload = toErrorPayload;

export function fromErrorPayload(payload: ErrorPayload): Error2 {
  const error = new Error2(payload.code, payload.message, {
    name: payload.name,
    details: payload.details,
    cause: payload.cause === undefined ? undefined : fromErrorPayload(payload.cause),
  });
  Object.assign(error, { retryable: payload.retryable });
  const statusCode = payload.details?.['statusCode'];
  if (
    typeof statusCode === 'number' &&
    (payload.name === 'APIStatusError' ||
      payload.name === 'APIContextOverflowError' ||
      payload.name === 'APIRequestTooLargeError' ||
      payload.name === 'APIProviderRateLimitError' ||
      payload.name === 'APIProviderQuotaExhaustedError' ||
      payload.name === 'APIProviderOverloadedError')
  ) {
    return Object.assign(error, { statusCode });
  }
  return error;
}
