import type { FinishReason } from './provider';

export class ChatProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatProviderError';
  }
}

export class APIConnectionError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'APIConnectionError';
  }
}

export class APITimeoutError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'APITimeoutError';
  }
}

export class APIStatusError extends ChatProviderError {
  readonly statusCode: number;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;

  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
  ) {
    super(message);
    this.name = 'APIStatusError';
    this.statusCode = statusCode;
    this.requestId = requestId ?? null;
    this.retryAfterMs = retryAfterMs ?? null;
  }
}

export class APIContextOverflowError extends APIStatusError {
  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
  ) {
    super(statusCode, message, requestId, retryAfterMs);
    this.name = 'APIContextOverflowError';
  }
}

export class APIRequestTooLargeError extends APIStatusError {
  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
  ) {
    super(statusCode, message, requestId, retryAfterMs);
    this.name = 'APIRequestTooLargeError';
  }
}

export class APIProviderRateLimitError extends APIStatusError {
  constructor(message: string, requestId?: string | null, retryAfterMs?: number | null) {
    super(429, message, requestId, retryAfterMs);
    this.name = 'APIProviderRateLimitError';
  }
}

export class APIProviderOverloadedError extends APIStatusError {
  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
  ) {
    super(statusCode, message, requestId, retryAfterMs);
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
    super(message);
    this.name = 'APIEmptyResponseError';
    this.finishReason = options.finishReason ?? null;
    this.rawFinishReason = options.rawFinishReason ?? null;
  }
}

const IMAGE_FORMAT_PROVIDER_MESSAGE_PATTERNS = [
  /unsupported media type for base64 image/,
  /invalid data url for image/,
] as const;

const IMAGE_FORMAT_STATUS_MESSAGE_PATTERNS = [
  /unsupported image (?:url|format|type)/,
  /does not represent a valid image/,
  /could not (?:process|decode) (?:the |input )?image/,
  /unable to process (?:the |input )?image/,
  /failed to decode (?:the )?image/,
  /invalid image(?: data| type| format)?/,
] as const;

const MEDIA_TYPE_FIELD_PATTERN = /(?:media|mime)_?type/;

export function isImageFormatError(error: unknown): boolean {
  if (error instanceof APIStatusError) {
    if (error instanceof APIContextOverflowError) return false;
    if (error instanceof APIRequestTooLargeError) return false;
    if (error.statusCode !== 400) return false;
    const lowerMessage = error.message.toLowerCase();
    return (
      IMAGE_FORMAT_STATUS_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage)) ||
      (MEDIA_TYPE_FIELD_PATTERN.test(lowerMessage) && lowerMessage.includes('image'))
    );
  }
  if (error instanceof ChatProviderError) {
    const lowerMessage = error.message.toLowerCase();
    return IMAGE_FORMAT_PROVIDER_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
  }
  return false;
}

export function isRetryableGenerateError(error: unknown): boolean {
  if (error instanceof APIConnectionError || error instanceof APITimeoutError) {
    return true;
  }
  if (error instanceof APIEmptyResponseError) {
    return true;
  }
  if (error instanceof APIProviderOverloadedError) {
    return true;
  }
  if (error instanceof APIStatusError) {
    return [408, 409, 429, 500, 502, 503, 504, 529].includes(error.statusCode);
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

const CONTEXT_OVERFLOW_MESSAGE_PATTERNS = [
  /context[ _-]?length/,
  /(?:context[ _-]?window.*exceed|exceed.*context[ _-]?window)/,
  /maximum context/,
  /exceed(?:ed|s|ing)?\s+(?:the\s+)?max(?:imum)?\s+tokens?/,
  /(?:too many tokens.*(?:prompt|input|context)|(?:prompt|input|context).*too many tokens)/,
  /prompt is too long.*maximum/,
  /input token count.*exceeds?.*maximum number of tokens/,
  /request.*exceed(?:ed|s|ing)?.*model token limit/,
] as const;

const PROVIDER_RATE_LIMIT_MESSAGE_PATTERNS = [
  /(?:apistatuserror.*429|429.*apistatuserror)/,
  /429.*too many requests/,
  /too many requests/,
  /provider\.rate_limit/,
  /reached .*max rpm/,
  /rate[ _-]?limit(?:ed)?/,
  /rate-limited/,
] as const;

const PROVIDER_OVERLOAD_MESSAGE_PATTERNS = [/overload/] as const;

const REQUEST_TOO_LARGE_MESSAGE_PATTERNS = [
  /request exceeds the maximum size/,
  /request entity too large/,
  /request_too_large/,
  /exceeds? the maximum allowed number of bytes/,
  /payload too large/,
  /content too large/,
  /request (?:body )?too large/,
] as const;

export function isContextOverflowErrorCode(code: string | null | undefined): boolean {
  return code === 'context_length_exceeded';
}

export function normalizeAPIStatusError(
  statusCode: number,
  message: string,
  requestId?: string | null,
  retryAfterMs?: number | null,
): APIStatusError {
  if (statusCode === 429) {
    return new APIProviderRateLimitError(message, requestId, retryAfterMs);
  }
  if (isContextOverflowStatusError(statusCode, message)) {
    return new APIContextOverflowError(statusCode, message, requestId, retryAfterMs);
  }
  if (isRequestTooLargeStatusError(statusCode, message)) {
    return new APIRequestTooLargeError(statusCode, message, requestId, retryAfterMs);
  }
  if (isProviderOverloadStatusError(statusCode, message)) {
    return new APIProviderOverloadedError(statusCode, message, requestId, retryAfterMs);
  }
  return new APIStatusError(statusCode, message, requestId, retryAfterMs);
}

export function parseRetryAfterMs(headers: unknown): number | null {
  const raw =
    headers !== null &&
    typeof headers === 'object' &&
    typeof (headers as { get?: unknown }).get === 'function'
      ? (headers as { get(name: string): string | null }).get('retry-after')
      : null;
  if (raw === null || raw === undefined) return null;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

export function isContextOverflowStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 400 && statusCode !== 413 && statusCode !== 422) return false;
  const lowerMessage = message.toLowerCase();
  return CONTEXT_OVERFLOW_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

export function isProviderOverloadStatusError(statusCode: number, message: string): boolean {
  if (statusCode === 529) return true;
  if (statusCode !== 500 && statusCode !== 503) return false;
  const lowerMessage = message.toLowerCase();
  return PROVIDER_OVERLOAD_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

export function isRequestTooLargeStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 413) return false;
  const lowerMessage = message.toLowerCase();
  return REQUEST_TOO_LARGE_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

const TOOL_EXCHANGE_ADJACENCY_MESSAGE_PATTERNS = [
  /tool_use[\s\S]*tool_result/,
  /tool_result[\s\S]*tool_use/,
  /unexpected\s+`?tool_result/,
  /tool_call_id[\s\S]*not found/,
  /role\s+['"`]?tool['"`]?\s+must be a response to a preceding message/,
  /assistant message with\s+['"`]?tool_calls['"`]?\s+must be followed by tool messages/,
  /tool_call_ids? did not have response messages/,
  /insufficient tool messages following/,
] as const;

export function isToolExchangeAdjacencyError(error: unknown): boolean {
  if (!(error instanceof APIStatusError)) return false;
  if (error instanceof APIContextOverflowError) return false;
  if (error.statusCode !== 400 && error.statusCode !== 422) return false;
  const lowerMessage = error.message.toLowerCase();
  return TOOL_EXCHANGE_ADJACENCY_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

const STRUCTURAL_REQUEST_MESSAGE_PATTERNS = [
  /text content blocks must be non-empty/,
  /text content blocks must contain non-whitespace/,
  /first message must use the .*user.* role/,
  /roles must alternate/,
  /multiple .*(?:user|assistant).* roles in a row/,
  /tool_use[\s\S]*ids must be unique/,
] as const;

export function isRecoverableRequestStructureError(error: unknown): boolean {
  if (isToolExchangeAdjacencyError(error)) return true;
  if (!(error instanceof APIStatusError)) return false;
  if (error instanceof APIContextOverflowError) return false;
  if (error.statusCode !== 400 && error.statusCode !== 422) return false;
  const lowerMessage = error.message.toLowerCase();
  return STRUCTURAL_REQUEST_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

export function isProviderRateLimitError(error: unknown): boolean {
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
