import { Error2, type Error2Options } from '#/_base/errors/errors';
import {
  appendThinkingEffortConfigHint,
  isAbortError,
  isContextOverflowStatusError,
  isImageFormatStatusError,
  isProviderOverloadStatusError,
  isRequestStructureStatusError,
  isRequestTooLargeStatusError,
  isToolExchangeAdjacencyStatusError,
  llmStatusErrorMessage,
  sanitizeStatusErrorMessage,
  type LlmErrorKind,
  type LlmErrorMessage,
  type LlmRemoteErrorMessage,
} from '#human/llm/errors';
import type { FinishReason } from '#human/llm/finish-reason';

export {
  isAbortError,
  parseRetryAfterMs,
  sanitizeStatusErrorMessage,
} from '#human/llm/errors';

export const CONFIG_INVALID_ERROR_CODE = 'config.invalid';

export const PROVIDER_API_ERROR_CODE = 'provider.api_error';
export const PROVIDER_FILTERED_ERROR_CODE = 'provider.filtered';
export const PROVIDER_RATE_LIMIT_ERROR_CODE = 'provider.rate_limit';
export const PROVIDER_AUTH_ERROR_CODE = 'provider.auth_error';
export const PROVIDER_CONNECTION_ERROR_CODE = 'provider.connection_error';
export const PROVIDER_OVERLOADED_ERROR_CODE = 'provider.overloaded';
export const CONTEXT_OVERFLOW_ERROR_CODE = 'context.overflow';

export type ProviderErrorCode =
  | typeof PROVIDER_API_ERROR_CODE
  | typeof PROVIDER_FILTERED_ERROR_CODE
  | typeof PROVIDER_RATE_LIMIT_ERROR_CODE
  | typeof PROVIDER_AUTH_ERROR_CODE
  | typeof PROVIDER_CONNECTION_ERROR_CODE
  | typeof PROVIDER_OVERLOADED_ERROR_CODE
  | typeof CONTEXT_OVERFLOW_ERROR_CODE;

function codeForStatusError(statusCode: number): ProviderErrorCode {
  if (statusCode === 429) return PROVIDER_RATE_LIMIT_ERROR_CODE;
  if (statusCode === 401 || statusCode === 403) return PROVIDER_AUTH_ERROR_CODE;
  if (statusCode === 529) return PROVIDER_OVERLOADED_ERROR_CODE;
  return PROVIDER_API_ERROR_CODE;
}

export class ChatProviderError extends Error2 {
  constructor(
    message: string,
    code: ProviderErrorCode = PROVIDER_API_ERROR_CODE,
    options?: Error2Options,
  ) {
    super(code, message, { ...options, name: 'ChatProviderError' });
  }
}

export class APIConnectionError extends ChatProviderError {
  constructor(message: string) {
    super(message, PROVIDER_CONNECTION_ERROR_CODE);
    this.name = 'APIConnectionError';
  }
}

export class VideoUploadUnsupportedError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'VideoUploadUnsupportedError';
  }
}

export class ImageUploadUnsupportedError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'ImageUploadUnsupportedError';
  }
}

export class APITimeoutError extends ChatProviderError {
  constructor(message: string) {
    super(message, PROVIDER_CONNECTION_ERROR_CODE);
    this.name = 'APITimeoutError';
  }
}

export class APIStatusError extends ChatProviderError {
  readonly statusCode: number;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
  readonly traceId: string | null;

  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
    code: ProviderErrorCode = codeForStatusError(statusCode),
  ) {
    super(sanitizeStatusErrorMessage(message), code, {
      details: { statusCode, requestId: requestId ?? null, traceId: traceId ?? null },
    });
    this.name = 'APIStatusError';
    this.statusCode = statusCode;
    this.requestId = requestId ?? null;
    this.retryAfterMs = retryAfterMs ?? null;
    this.traceId = traceId ?? null;
  }
}

export class APIContextOverflowError extends APIStatusError {
  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
  ) {
    super(statusCode, message, requestId, retryAfterMs, traceId, CONTEXT_OVERFLOW_ERROR_CODE);
    this.name = 'APIContextOverflowError';
  }
}

export class APIRequestTooLargeError extends APIStatusError {
  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
  ) {
    super(statusCode, message, requestId, retryAfterMs, traceId);
    this.name = 'APIRequestTooLargeError';
  }
}

export class APIProviderRateLimitError extends APIStatusError {
  constructor(
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
  ) {
    super(429, message, requestId, retryAfterMs, traceId);
    this.name = 'APIProviderRateLimitError';
  }
}

export class APIProviderQuotaExhaustedError extends APIStatusError {
  constructor(
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
  ) {
    super(429, message, requestId, retryAfterMs, traceId, PROVIDER_API_ERROR_CODE);
    this.name = 'APIProviderQuotaExhaustedError';
  }
}

export class APIProviderOverloadedError extends APIStatusError {
  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
  ) {
    super(statusCode, message, requestId, retryAfterMs, traceId, PROVIDER_OVERLOADED_ERROR_CODE);
    this.name = 'APIProviderOverloadedError';
  }
}

export class APIEmptyResponseError extends ChatProviderError {
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;

  constructor(
    message: string,
    options: {
      readonly finishReason?: FinishReason | null;
      readonly rawFinishReason?: string | null;
    } = {},
  ) {
    const finishReason = options.finishReason ?? null;
    const rawFinishReason = options.rawFinishReason ?? null;
    super(
      message,
      finishReason === 'filtered' ? PROVIDER_FILTERED_ERROR_CODE : PROVIDER_API_ERROR_CODE,
      { details: { finishReason, rawFinishReason } },
    );
    this.name = 'APIEmptyResponseError';
    this.finishReason = finishReason;
    this.rawFinishReason = rawFinishReason;
  }
}

function legacyFieldsForLlmError(
  error: Exclude<LlmErrorMessage, LlmErrorMessage<'abort'>>,
): {
  readonly code: ProviderErrorCode;
  readonly name: string;
  readonly details?: Readonly<Record<string, unknown>>;
} {
  let code: ProviderErrorCode = PROVIDER_API_ERROR_CODE;
  let name = 'ChatProviderError';
  switch (error.kind) {
    case 'rate_limit':
      code = PROVIDER_RATE_LIMIT_ERROR_CODE;
      name = 'APIProviderRateLimitError';
      break;
    case 'quota_exhausted':
      name = 'APIProviderQuotaExhaustedError';
      break;
    case 'overloaded':
      code = PROVIDER_OVERLOADED_ERROR_CODE;
      name = 'APIProviderOverloadedError';
      break;
    case 'context_overflow':
      code = CONTEXT_OVERFLOW_ERROR_CODE;
      name = 'APIContextOverflowError';
      break;
    case 'request_too_large':
      code = error.statusCode === undefined ? PROVIDER_API_ERROR_CODE : codeForStatusError(error.statusCode);
      name = 'APIRequestTooLargeError';
      break;
    case 'request_structure':
    case 'image_format':
    case 'status':
      code = error.statusCode === undefined ? PROVIDER_API_ERROR_CODE : codeForStatusError(error.statusCode);
      name = 'APIStatusError';
      break;
    case 'empty_response':
      code = error.finishReason === 'filtered' ? PROVIDER_FILTERED_ERROR_CODE : PROVIDER_API_ERROR_CODE;
      name = 'APIEmptyResponseError';
      break;
    case 'connection':
      code = PROVIDER_CONNECTION_ERROR_CODE;
      name = 'APIConnectionError';
      break;
    case 'timeout':
      code = PROVIDER_CONNECTION_ERROR_CODE;
      name = 'APITimeoutError';
      break;
    case 'syntax':
    case 'provider':
    case 'unknown':
      break;
  }
  const status = llmStatusErrorMessage(error);
  const traceId = status === null ? null : traceIdFromHeadersRecord(status.headers);
  const details =
    error.kind === 'empty_response'
      ? { finishReason: error.finishReason, rawFinishReason: error.rawFinishReason }
      : status !== null && status.statusCode !== undefined
        ? { statusCode: status.statusCode, requestId: status.requestId, traceId }
        : status !== null && (status.requestId !== null || traceId !== null)
          ? { requestId: status.requestId, traceId }
          : undefined;
  return { code, name, details };
}

export class LlmError extends Error2 {
  readonly kind: Exclude<LlmErrorKind, 'abort'>;
  readonly statusCode?: number;
  readonly retryable?: boolean;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
  readonly traceId: string | null;
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;

  constructor(readonly llmError: Exclude<LlmErrorMessage, LlmErrorMessage<'abort'>>) {
    const fields = legacyFieldsForLlmError(llmError);
    super(fields.code, llmError.message, { name: fields.name, details: fields.details });
    const status = llmStatusErrorMessage(llmError);
    this.kind = llmError.kind;
    this.statusCode = status?.statusCode;
    this.retryable = status?.retryable;
    this.requestId = status?.requestId ?? null;
    this.retryAfterMs = status?.retryAfterMs ?? null;
    this.traceId = traceIdFromHeadersRecord(status?.headers ?? null);
    this.finishReason = llmError.kind === 'empty_response' ? llmError.finishReason : null;
    this.rawFinishReason = llmError.kind === 'empty_response' ? llmError.rawFinishReason : null;
  }
}

export function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function throwIfAbortError(error: unknown): void {
  if (isAbortError(error)) {
    throw createAbortError();
  }
}

const IMAGE_FORMAT_PROVIDER_MESSAGE_PATTERNS = [
  /unsupported media type for base64 image/,
  /invalid data url for image/,
] as const;

export function isImageFormatError(error: unknown): boolean {
  if (error instanceof LlmError) {
    switch (error.kind) {
      case 'image_format':
        return error.statusCode === undefined || isImageFormatStatusError(error.statusCode, error.message);
      case 'status':
      case 'request_structure':
        return error.statusCode !== undefined && isImageFormatStatusError(error.statusCode, error.message);
      case 'rate_limit':
      case 'quota_exhausted':
      case 'overloaded':
      case 'context_overflow':
      case 'request_too_large':
        return false;
      default: {
        const lowerMessage = error.message.toLowerCase();
        return IMAGE_FORMAT_PROVIDER_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
      }
    }
  }
  if (error instanceof APIStatusError) {
    if (error instanceof APIContextOverflowError) return false;
    if (error instanceof APIRequestTooLargeError) return false;
    return isImageFormatStatusError(error.statusCode, error.message);
  }
  if (error instanceof ChatProviderError) {
    const lowerMessage = error.message.toLowerCase();
    return IMAGE_FORMAT_PROVIDER_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
  }
  return false;
}

function isRetryableStatusCode(statusCode: number | undefined): boolean {
  return statusCode !== undefined && [408, 409, 429, 500, 502, 503, 504, 529].includes(statusCode);
}

export function isRetryableGenerateError(error: unknown): boolean {
  if (error instanceof LlmError) {
    switch (error.kind) {
      case 'connection':
      case 'timeout':
      case 'rate_limit':
      case 'overloaded':
        return true;
      case 'quota_exhausted':
        return false;
      case 'empty_response':
        return error.finishReason !== 'filtered';
      case 'status':
        return error.retryable ?? isRetryableStatusCode(error.statusCode);
      case 'context_overflow':
      case 'request_too_large':
      case 'request_structure':
      case 'image_format':
        return isRetryableStatusCode(error.statusCode);
      default:
        return !isImageFormatError(error);
    }
  }
  if (error instanceof APIConnectionError || error instanceof APITimeoutError) {
    return true;
  }
  if (error instanceof APIEmptyResponseError) {
    return error.finishReason !== 'filtered';
  }
  if (error instanceof APIProviderOverloadedError) {
    return true;
  }
  if (error instanceof APIStatusError) {
    if (error instanceof APIProviderQuotaExhaustedError) {
      return false;
    }
    return isRetryableStatusCode(error.statusCode);
  }
  return error instanceof ChatProviderError && !isImageFormatError(error);
}

const NETWORK_RE = /network|connection|connect|disconnect|terminated/i;
const TIMEOUT_RE = /timed?\s*out|timeout|deadline/i;

export function classifyBaseApiError(message: string): ChatProviderError {
  if (TIMEOUT_RE.test(message)) {
    return new APITimeoutError(message);
  }
  if (NETWORK_RE.test(message)) {
    return new APIConnectionError(message);
  }
  return new ChatProviderError(`Error: ${message}`);
}

const PROVIDER_RATE_LIMIT_MESSAGE_PATTERNS = [
  /(?:apistatuserror.*429|429.*apistatuserror)/,
  /429.*too many requests/,
  /too many requests/,
  /provider\.rate_limit/,
  /reached .*max rpm/,
  /rate[ _-]?limit(?:ed)?/,
  /rate-limited/,
] as const;

export function isContextOverflowErrorCode(code: string | null | undefined): boolean {
  return code === 'context_length_exceeded';
}

export function normalizeAPIStatusError(
  statusCode: number,
  message: string,
  requestId?: string | null,
  retryAfterMs?: number | null,
  traceId?: string | null,
): APIStatusError {
  if (statusCode === 429) {
    return new APIProviderRateLimitError(message, requestId, retryAfterMs, traceId);
  }
  if (isContextOverflowStatusError(statusCode, message)) {
    return new APIContextOverflowError(statusCode, message, requestId, retryAfterMs, traceId);
  }
  if (isRequestTooLargeStatusError(statusCode, message)) {
    return new APIRequestTooLargeError(statusCode, message, requestId, retryAfterMs, traceId);
  }
  if (isProviderOverloadStatusError(statusCode, message)) {
    return new APIProviderOverloadedError(statusCode, message, requestId, retryAfterMs, traceId);
  }
  return new APIStatusError(
    statusCode,
    appendThinkingEffortConfigHint(statusCode, message),
    requestId,
    retryAfterMs,
    traceId,
  );
}

export function parseTraceId(headers: unknown): string | null {
  const raw =
    headers !== null &&
    typeof headers === 'object' &&
    typeof (headers as { get?: unknown }).get === 'function'
      ? (headers as { get(name: string): string | null }).get('x-trace-id')
      : null;
  if (raw === null || raw === undefined || raw.length === 0) return null;
  return raw;
}

export function traceIdFromHeadersRecord(headers: Record<string, string> | null): string | null {
  if (headers === null) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'x-trace-id' && value.length > 0) return value;
  }
  return null;
}

export function isToolExchangeAdjacencyError(error: unknown): boolean {
  if (error instanceof LlmError) {
    switch (error.kind) {
      case 'context_overflow':
      case 'rate_limit':
      case 'quota_exhausted':
        return false;
      case 'status':
      case 'overloaded':
      case 'request_too_large':
      case 'request_structure':
      case 'image_format':
        return isToolExchangeAdjacencyStatusError(error.statusCode, error.message);
      default:
        return false;
    }
  }
  if (!(error instanceof APIStatusError)) return false;
  if (error instanceof APIContextOverflowError) return false;
  return isToolExchangeAdjacencyStatusError(error.statusCode, error.message);
}

export function isRecoverableRequestStructureError(error: unknown): boolean {
  if (error instanceof LlmError) {
    if (error.kind === 'request_structure' && error.statusCode === undefined) return true;
    switch (error.kind) {
      case 'context_overflow':
      case 'rate_limit':
      case 'quota_exhausted':
        return false;
      case 'status':
      case 'overloaded':
      case 'request_too_large':
      case 'request_structure':
      case 'image_format':
        return error.statusCode !== undefined && isRequestStructureStatusError(error.statusCode, error.message);
      default:
        return false;
    }
  }
  if (!(error instanceof APIStatusError)) return false;
  if (error instanceof APIContextOverflowError) return false;
  return isRequestStructureStatusError(error.statusCode, error.message);
}

export function isProviderRateLimitError(error: unknown): boolean {
  if (error instanceof LlmError) {
    if (error.kind === 'quota_exhausted') return false;
    if (error.kind === 'rate_limit') return true;
  }
  if (error instanceof APIProviderQuotaExhaustedError) return false;
  if (error instanceof APIProviderRateLimitError) return true;

  const statusCode = getStatusCode(error);
  if (statusCode !== undefined) return statusCode === 429;

  const lowerMessage = errorMessage(error).toLowerCase();
  return PROVIDER_RATE_LIMIT_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const record = error as Record<string, unknown>;
  const statusCode = record['statusCode'];
  if (typeof statusCode === 'number') return statusCode;
  const status = record['status'];
  if (typeof status === 'number') return status;

  const response = record['response'];
  if (typeof response !== 'object' || response === null) return undefined;
  const responseRecord = response as Record<string, unknown>;
  const responseStatusCode = responseRecord['statusCode'];
  if (typeof responseStatusCode === 'number') return responseStatusCode;
  const responseStatus = responseRecord['status'];
  return typeof responseStatus === 'number' ? responseStatus : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ApiErrorKind =
  | 'context_overflow'
  | 'overloaded'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'auth'
  | '5xx_server'
  | '4xx_client'
  | 'network'
  | 'timeout'
  | 'empty_response'
  | 'other';

export interface ApiErrorClassification {
  readonly kind: ApiErrorKind;
  readonly statusCode?: number;
}

function classifyStatus(
  statusCode: number,
  message: string,
): ApiErrorClassification | undefined {
  if (isContextOverflowStatusError(statusCode, message)) {
    return { kind: 'context_overflow', statusCode };
  }
  if (statusCode === 429) return { kind: 'rate_limit', statusCode };
  if (statusCode === 529) return { kind: 'overloaded', statusCode };
  if (statusCode === 401 || statusCode === 403) return { kind: 'auth', statusCode };
  if (statusCode >= 500) return { kind: '5xx_server', statusCode };
  if (statusCode >= 400) return { kind: '4xx_client', statusCode };
  return undefined;
}

export function classifyApiError(error: unknown): ApiErrorClassification {
  const statusCode = getStatusCode(error);
  if (error instanceof LlmError) {
    switch (error.kind) {
      case 'context_overflow':
        return { kind: 'context_overflow', statusCode };
      case 'overloaded':
        return { kind: 'overloaded', statusCode };
      case 'rate_limit':
        return { kind: 'rate_limit', statusCode };
      case 'quota_exhausted':
        return { kind: 'quota_exhausted', statusCode };
      case 'connection':
        return { kind: 'network', statusCode };
      case 'timeout':
        return { kind: 'timeout', statusCode };
      case 'empty_response':
        return { kind: 'empty_response', statusCode };
      case 'status':
      case 'request_too_large':
      case 'request_structure':
      case 'image_format': {
        const classification = statusCode === undefined ? undefined : classifyStatus(statusCode, error.message);
        return classification ?? { kind: 'other', statusCode };
      }
      default:
        return { kind: 'other', statusCode };
    }
  }
  if (error instanceof APIContextOverflowError) return { kind: 'context_overflow', statusCode };
  if (error instanceof APIProviderOverloadedError) return { kind: 'overloaded', statusCode };
  if (error instanceof APIProviderQuotaExhaustedError) {
    return { kind: 'quota_exhausted', statusCode };
  }
  if (error instanceof APIStatusError) {
    const classification = classifyStatus(error.statusCode, error.message);
    if (classification !== undefined) return classification;
  }
  if (error instanceof APIConnectionError) return { kind: 'network', statusCode };
  if (error instanceof APITimeoutError) return { kind: 'timeout', statusCode };
  if (error instanceof APIEmptyResponseError) return { kind: 'empty_response', statusCode };
  return { kind: 'other', statusCode };
}

export function isLlmErrorMessage(error: unknown): error is LlmErrorMessage {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { kind?: unknown }).kind === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

export function isUnauthorizedLlmError(error: unknown): boolean {
  return isLlmErrorMessage(error) && llmStatusErrorMessage(error)?.statusCode === 401;
}

export function errorFromLlmMessage(error: LlmErrorMessage): Error {
  switch (error.kind) {
    case 'abort':
      return createAbortError();
    case 'connection':
      return new APIConnectionError(error.message);
    case 'timeout':
      return new APITimeoutError(error.message);
    case 'rate_limit':
      if (error.statusCode === undefined) return new LlmError(error);
      return new APIProviderRateLimitError(
        error.message,
        error.requestId,
        error.retryAfterMs,
        traceIdFromHeadersRecord(error.headers),
      );
    case 'quota_exhausted':
      if (error.statusCode === undefined) return new LlmError(error);
      return new APIProviderQuotaExhaustedError(
        error.message,
        error.requestId,
        error.retryAfterMs,
        traceIdFromHeadersRecord(error.headers),
      );
    case 'overloaded':
      if (error.statusCode === undefined) return new LlmError(error);
      return new APIProviderOverloadedError(
        error.statusCode,
        error.message,
        error.requestId,
        error.retryAfterMs,
        traceIdFromHeadersRecord(error.headers),
      );
    case 'context_overflow':
      if (error.statusCode === undefined) return new LlmError(error);
      return new APIContextOverflowError(
        error.statusCode,
        error.message,
        error.requestId,
        error.retryAfterMs,
        traceIdFromHeadersRecord(error.headers),
      );
    case 'request_too_large':
      if (error.statusCode === undefined) return new LlmError(error);
      return new APIRequestTooLargeError(
        error.statusCode,
        error.message,
        error.requestId,
        error.retryAfterMs,
        traceIdFromHeadersRecord(error.headers),
      );
    case 'request_structure':
    case 'image_format':
    case 'status':
      if (error.statusCode === undefined) return new LlmError(error);
      return new APIStatusError(
        error.statusCode,
        error.message,
        error.requestId,
        error.retryAfterMs,
        traceIdFromHeadersRecord(error.headers),
      );
    case 'empty_response':
      return new APIEmptyResponseError(error.message, {
        finishReason: error.finishReason,
        rawFinishReason: error.rawFinishReason,
      });
    case 'syntax':
    case 'provider':
    case 'unknown':
      return new ChatProviderError(error.message);
  }
}

function traceHeadersOf(error: APIStatusError): Record<string, string> | null {
  return error.traceId === null ? null : { 'x-trace-id': error.traceId };
}

export function llmMessageFromError(error: unknown): LlmRemoteErrorMessage | undefined {
  if (error instanceof APIProviderRateLimitError) {
    return {
      kind: 'rate_limit',
      message: error.message,
      statusCode: 429,
      requestId: error.requestId,
      retryAfterMs: error.retryAfterMs,
      headers: traceHeadersOf(error),
    };
  }
  if (error instanceof APIProviderQuotaExhaustedError) {
    return {
      kind: 'quota_exhausted',
      message: error.message,
      statusCode: 429,
      requestId: error.requestId,
      retryAfterMs: error.retryAfterMs,
      headers: traceHeadersOf(error),
    };
  }
  if (error instanceof APIContextOverflowError) {
    return {
      kind: 'context_overflow',
      message: error.message,
      statusCode: error.statusCode,
      requestId: error.requestId,
      retryAfterMs: error.retryAfterMs,
      headers: traceHeadersOf(error),
    };
  }
  if (error instanceof APIRequestTooLargeError) {
    return {
      kind: 'request_too_large',
      message: error.message,
      statusCode: error.statusCode,
      requestId: error.requestId,
      retryAfterMs: error.retryAfterMs,
      headers: traceHeadersOf(error),
    };
  }
  if (error instanceof APIProviderOverloadedError) {
    return {
      kind: 'overloaded',
      message: error.message,
      statusCode: error.statusCode,
      requestId: error.requestId,
      retryAfterMs: error.retryAfterMs,
      headers: traceHeadersOf(error),
    };
  }
  if (error instanceof APIConnectionError) {
    return { kind: 'connection', message: error.message };
  }
  if (error instanceof APITimeoutError) {
    return { kind: 'timeout', message: error.message };
  }
  if (error instanceof APIEmptyResponseError) {
    return {
      kind: 'empty_response',
      message: error.message,
      finishReason: error.finishReason,
      rawFinishReason: error.rawFinishReason,
    };
  }
  if (error instanceof APIStatusError) {
    return {
      kind: 'status',
      message: error.message,
      statusCode: error.statusCode,
      requestId: error.requestId,
      retryAfterMs: error.retryAfterMs,
      headers: traceHeadersOf(error),
    };
  }
  if (error instanceof ChatProviderError) {
    return { kind: 'provider', message: error.message };
  }
  return undefined;
}
