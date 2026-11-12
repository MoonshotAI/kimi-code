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
  type LlmErrorMessage,
  type LlmRemoteErrorMessage,
} from '#human/llm-requester/errors';
import type { FinishReason } from '#human/llm-requester/finish-reason';
import { isTransientHttpStatus } from '#human/llm/protocol/rules/status';
import type { LlmErrorDiagnostics } from '#human/llm/response';

export {
  isAbortError,
  parseRetryAfterMs,
  sanitizeStatusErrorMessage,
} from '#human/llm-requester/errors';

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

function isProviderErrorCode(value: string): value is ProviderErrorCode {
  switch (value) {
    case PROVIDER_API_ERROR_CODE:
    case PROVIDER_FILTERED_ERROR_CODE:
    case PROVIDER_RATE_LIMIT_ERROR_CODE:
    case PROVIDER_AUTH_ERROR_CODE:
    case PROVIDER_CONNECTION_ERROR_CODE:
    case PROVIDER_OVERLOADED_ERROR_CODE:
    case CONTEXT_OVERFLOW_ERROR_CODE:
      return true;
    default:
      return false;
  }
}

function codeForStatusError(statusCode: number | undefined): ProviderErrorCode {
  if (statusCode === 429) return PROVIDER_RATE_LIMIT_ERROR_CODE;
  if (statusCode === 401 || statusCode === 403) return PROVIDER_AUTH_ERROR_CODE;
  if (statusCode === 529) return PROVIDER_OVERLOADED_ERROR_CODE;
  return PROVIDER_API_ERROR_CODE;
}

export class ChatProviderError extends Error2 {
  readonly diagnostics: LlmErrorDiagnostics | undefined;
  readonly retryable: boolean;

  constructor(
    message: string,
    code: ProviderErrorCode = PROVIDER_API_ERROR_CODE,
    options?: Error2Options,
    diagnostics?: LlmErrorDiagnostics,
    retryable = true,
  ) {
    super(code, message, { ...options, name: 'ChatProviderError' });
    this.diagnostics = diagnostics;
    this.retryable = retryable;
  }
}

export class APIConnectionError extends ChatProviderError {
  constructor(message: string, diagnostics?: LlmErrorDiagnostics) {
    super(message, PROVIDER_CONNECTION_ERROR_CODE, undefined, diagnostics, true);
    this.name = 'APIConnectionError';
  }
}

export class VideoUploadUnsupportedError extends ChatProviderError {
  constructor(message: string) {
    super(message, PROVIDER_API_ERROR_CODE, undefined, undefined, false);
    this.name = 'VideoUploadUnsupportedError';
  }
}

export class ImageUploadUnsupportedError extends ChatProviderError {
  constructor(message: string) {
    super(message, PROVIDER_API_ERROR_CODE, undefined, undefined, false);
    this.name = 'ImageUploadUnsupportedError';
  }
}

export class APITimeoutError extends ChatProviderError {
  constructor(message: string, diagnostics?: LlmErrorDiagnostics) {
    super(message, PROVIDER_CONNECTION_ERROR_CODE, undefined, diagnostics, true);
    this.name = 'APITimeoutError';
  }
}

export class APIStatusError extends ChatProviderError {
  readonly statusCode?: number;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
  readonly traceId: string | null;
  override readonly retryable: boolean;

  constructor(
    statusCode: number | undefined,
    message: string,
    retryable: boolean,
    requestId?: string | null,
    retryAfterMs?: number | null,
    diagnosticsOrTraceId?: LlmErrorDiagnostics | string | null,
    codeOrTraceId?: string | null,
    traceId?: string | null,
  ) {
    const diagnostics =
      diagnosticsOrTraceId !== null && typeof diagnosticsOrTraceId === 'object'
        ? diagnosticsOrTraceId
        : undefined;
    const legacyTraceId =
      typeof diagnosticsOrTraceId === 'string' || diagnosticsOrTraceId === null
        ? diagnosticsOrTraceId
        : typeof codeOrTraceId === 'string' && !isProviderErrorCode(codeOrTraceId)
          ? codeOrTraceId
          : undefined;
    const code =
      typeof codeOrTraceId === 'string' && isProviderErrorCode(codeOrTraceId)
        ? codeOrTraceId
        : codeForStatusError(statusCode);
    const resolvedTraceId = traceId === undefined ? legacyTraceId : traceId;
    super(
      message,
      code,
      {
        details: {
          statusCode,
          requestId: requestId ?? null,
          traceId: resolvedTraceId ?? null,
          diagnostics: diagnostics ?? {},
        },
      },
      diagnostics,
      retryable,
    );
    this.name = 'APIStatusError';
    this.statusCode = statusCode;
    this.requestId = requestId ?? null;
    this.retryAfterMs = retryAfterMs ?? null;
    this.traceId = resolvedTraceId ?? null;
    this.retryable = retryable;
  }
}

export class APIContextOverflowError extends APIStatusError {
  constructor(
    statusCode: number | undefined,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    diagnosticsOrTraceId?: LlmErrorDiagnostics | string | null,
    traceId?: string | null,
  ) {
    super(
      statusCode,
      message,
      false,
      requestId,
      retryAfterMs,
      diagnosticsOrTraceId,
      CONTEXT_OVERFLOW_ERROR_CODE,
      traceId,
    );
    this.name = 'APIContextOverflowError';
  }
}

export class APIRequestTooLargeError extends APIStatusError {
  constructor(
    statusCode: number | undefined,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    diagnosticsOrTraceId?: LlmErrorDiagnostics | string | null,
    traceId?: string | null,
  ) {
    super(statusCode, message, false, requestId, retryAfterMs, diagnosticsOrTraceId, traceId);
    this.name = 'APIRequestTooLargeError';
  }
}

export class APIProviderRateLimitError extends APIStatusError {
  constructor(
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    diagnosticsOrTraceId?: LlmErrorDiagnostics | string | null,
    options?: { readonly statusCode?: number },
    traceId?: string | null,
  ) {
    super(
      options === undefined ? 429 : options.statusCode,
      message,
      true,
      requestId,
      retryAfterMs,
      diagnosticsOrTraceId,
      PROVIDER_RATE_LIMIT_ERROR_CODE,
      traceId,
    );
    this.name = 'APIProviderRateLimitError';
  }
}

export class APIProviderQuotaExhaustedError extends APIStatusError {
  constructor(
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    diagnosticsOrTraceId?: LlmErrorDiagnostics | string | null,
    options?: { readonly statusCode?: number },
    traceId?: string | null,
  ) {
    super(
      options === undefined ? 429 : options.statusCode,
      message,
      false,
      requestId,
      retryAfterMs,
      diagnosticsOrTraceId,
      PROVIDER_API_ERROR_CODE,
      traceId,
    );
    this.name = 'APIProviderQuotaExhaustedError';
  }
}

export class APIProviderOverloadedError extends APIStatusError {
  constructor(
    statusCode: number | undefined,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    diagnosticsOrTraceId?: LlmErrorDiagnostics | string | null,
    traceId?: string | null,
  ) {
    super(
      statusCode,
      message,
      true,
      requestId,
      retryAfterMs,
      diagnosticsOrTraceId,
      PROVIDER_OVERLOADED_ERROR_CODE,
      traceId,
    );
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
      readonly diagnostics?: LlmErrorDiagnostics;
    } = {},
  ) {
    const finishReason = options.finishReason ?? null;
    const rawFinishReason = options.rawFinishReason ?? null;
    super(
      message,
      finishReason === 'filtered' ? PROVIDER_FILTERED_ERROR_CODE : PROVIDER_API_ERROR_CODE,
      { details: { finishReason, rawFinishReason, diagnostics: options.diagnostics } },
      options.diagnostics,
      finishReason !== 'filtered',
    );
    this.name = 'APIEmptyResponseError';
    this.finishReason = finishReason;
    this.rawFinishReason = rawFinishReason;
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
  if (error instanceof APIStatusError) {
    if (error instanceof APIContextOverflowError) return false;
    if (error instanceof APIRequestTooLargeError) return false;
    return error.statusCode !== undefined && isImageFormatStatusError(error.statusCode, error.message);
  }
  if (error instanceof ChatProviderError) {
    const lowerMessage = error.message.toLowerCase();
    return IMAGE_FORMAT_PROVIDER_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
  }
  return false;
}

export function isRetryableGenerateError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  return error instanceof ChatProviderError && error.retryable;
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
  diagnostics?: LlmErrorDiagnostics,
): APIStatusError {
  if (statusCode === 429) {
    return new APIProviderRateLimitError(message, requestId, retryAfterMs, diagnostics);
  }
  if (isContextOverflowStatusError(statusCode, message)) {
    return new APIContextOverflowError(statusCode, message, requestId, retryAfterMs, diagnostics);
  }
  if (isRequestTooLargeStatusError(statusCode, message)) {
    return new APIRequestTooLargeError(statusCode, message, requestId, retryAfterMs, diagnostics);
  }
  if (isProviderOverloadStatusError(statusCode, message)) {
    return new APIProviderOverloadedError(statusCode, message, requestId, retryAfterMs, diagnostics);
  }
  return new APIStatusError(
    statusCode,
    appendThinkingEffortConfigHint(statusCode, message),
    isTransientHttpStatus(statusCode),
    requestId,
    retryAfterMs,
    diagnostics,
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
  if (!(error instanceof APIStatusError)) return false;
  if (error instanceof APIContextOverflowError) return false;
  return (
    error.statusCode !== undefined &&
    isToolExchangeAdjacencyStatusError(error.statusCode, error.message)
  );
}

export function isRecoverableRequestStructureError(error: unknown): boolean {
  if (!(error instanceof APIStatusError)) return false;
  if (error instanceof APIContextOverflowError) return false;
  return (
    error.statusCode !== undefined &&
    isRequestStructureStatusError(error.statusCode, error.message)
  );
}

export function isProviderRateLimitError(error: unknown): boolean {
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

export function classifyApiError(error: unknown): ApiErrorClassification {
  const statusCode = getStatusCode(error);
  if (error instanceof APIContextOverflowError) return { kind: 'context_overflow', statusCode };
  if (error instanceof APIProviderOverloadedError) return { kind: 'overloaded', statusCode };
  if (error instanceof APIProviderQuotaExhaustedError) {
    return { kind: 'quota_exhausted', statusCode };
  }
  if (error instanceof APIProviderRateLimitError) return { kind: 'rate_limit', statusCode };
  if (error instanceof APIStatusError) {
    if (error.statusCode !== undefined && isContextOverflowStatusError(error.statusCode, error.message)) {
      return { kind: 'context_overflow', statusCode };
    }
    if (error.statusCode === 429) return { kind: 'rate_limit', statusCode };
    if (error.statusCode === 529) return { kind: 'overloaded', statusCode };
    if (error.statusCode === 401 || error.statusCode === 403) return { kind: 'auth', statusCode };
    if (error.statusCode !== undefined && error.statusCode >= 500) return { kind: '5xx_server', statusCode };
    if (error.statusCode !== undefined && error.statusCode >= 400) return { kind: '4xx_client', statusCode };
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

export function errorDiagnostics(error: unknown): LlmErrorDiagnostics | undefined {
  if (error instanceof ChatProviderError) return error.diagnostics;
  if (error instanceof Error2) {
    return error.details?.['diagnostics'] as LlmErrorDiagnostics | undefined;
  }
  return undefined;
}

export function withErrorDiagnostics<T extends Error>(
  error: T,
  diagnostics: LlmErrorDiagnostics | undefined,
): T {
  if (diagnostics === undefined) return error;
  if (error instanceof ChatProviderError) {
    (error as { diagnostics: LlmErrorDiagnostics | undefined }).diagnostics = diagnostics;
  }
  if (error instanceof Error2) {
    (error as { details?: Record<string, unknown> }).details = {
      ...error.details,
      diagnostics,
    };
  }
  return error;
}

export function errorFromLlmMessage(
  error: LlmErrorMessage,
  diagnostics?: LlmErrorDiagnostics,
): Error {
  switch (error.kind) {
    case 'abort':
      return createAbortError();
    case 'connection':
      return new APIConnectionError(error.message, diagnostics);
    case 'timeout':
      return new APITimeoutError(error.message, diagnostics);
    case 'rate_limit':
      return new APIProviderRateLimitError(
        error.message,
        error.requestId,
        error.retryAfterMs,
        diagnostics,
        { statusCode: error.statusCode },
        traceIdFromHeadersRecord(error.headers),
      );
    case 'quota_exhausted':
      return new APIProviderQuotaExhaustedError(
        error.message,
        error.requestId,
        error.retryAfterMs,
        diagnostics,
        { statusCode: error.statusCode },
        traceIdFromHeadersRecord(error.headers),
      );
    case 'overloaded':
      return new APIProviderOverloadedError(
        error.statusCode,
        error.message,
        error.requestId,
        error.retryAfterMs,
        diagnostics,
        traceIdFromHeadersRecord(error.headers),
      );
    case 'context_overflow':
      return new APIContextOverflowError(
        error.statusCode,
        error.message,
        error.requestId,
        error.retryAfterMs,
        diagnostics,
        traceIdFromHeadersRecord(error.headers),
      );
    case 'request_too_large':
      return new APIRequestTooLargeError(
        error.statusCode,
        error.message,
        error.requestId,
        error.retryAfterMs,
        diagnostics,
        traceIdFromHeadersRecord(error.headers),
      );
    case 'request_structure':
    case 'image_format':
    case 'status':
      return new APIStatusError(
        error.statusCode,
        error.message,
        error.retryable,
        error.requestId,
        error.retryAfterMs,
        diagnostics,
        undefined,
        traceIdFromHeadersRecord(error.headers),
      );
    case 'empty_response':
      return new APIEmptyResponseError(error.message, {
        finishReason: error.finishReason,
        rawFinishReason: error.rawFinishReason,
        diagnostics,
      });
    case 'syntax':
    case 'unknown':
      return new ChatProviderError(
        error.message,
        PROVIDER_API_ERROR_CODE,
        undefined,
        diagnostics,
        false,
      );
    case 'provider':
      return new ChatProviderError(
        error.message,
        PROVIDER_API_ERROR_CODE,
        undefined,
        diagnostics,
        error.retryable,
      );
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
      statusCode: error.statusCode,
      requestId: error.requestId,
      retryAfterMs: error.retryAfterMs,
      headers: traceHeadersOf(error),
      retryable: error.retryable,
    };
  }
  if (error instanceof APIProviderQuotaExhaustedError) {
    return {
      kind: 'quota_exhausted',
      message: error.message,
      statusCode: error.statusCode,
      requestId: error.requestId,
      retryAfterMs: error.retryAfterMs,
      headers: traceHeadersOf(error),
      retryable: error.retryable,
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
      retryable: error.retryable,
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
      retryable: error.retryable,
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
      retryable: error.retryable,
    };
  }
  if (error instanceof APIConnectionError) {
    return { kind: 'connection', message: error.message, retryable: error.retryable };
  }
  if (error instanceof APITimeoutError) {
    return { kind: 'timeout', message: error.message, retryable: error.retryable };
  }
  if (error instanceof APIEmptyResponseError) {
    return {
      kind: 'empty_response',
      message: error.message,
      finishReason: error.finishReason,
      rawFinishReason: error.rawFinishReason,
      retryable: error.retryable,
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
      retryable: error.retryable,
    };
  }
  if (error instanceof ChatProviderError) {
    return { kind: 'provider', message: error.message, retryable: error.retryable };
  }
  return undefined;
}
