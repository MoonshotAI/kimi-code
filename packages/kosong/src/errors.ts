import type { FinishReason } from './provider';

/**
 * Base error for all chat provider errors.
 */
export class ChatProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatProviderError';
  }
}

/**
 * Network-level connection failure.
 */
export class APIConnectionError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'APIConnectionError';
  }
}

/**
 * Request timed out.
 */
export class APITimeoutError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'APITimeoutError';
  }
}

/**
 * HTTP status error from the API.
 */
export class APIStatusError extends ChatProviderError {
  readonly statusCode: number;
  readonly requestId: string | null;

  constructor(statusCode: number, message: string, requestId?: string | null) {
    super(message);
    this.name = 'APIStatusError';
    this.statusCode = statusCode;
    this.requestId = requestId ?? null;
  }
}

/**
 * HTTP status error that specifically means the request exceeded the model
 * context window.
 */
export class APIContextOverflowError extends APIStatusError {
  constructor(statusCode: number, message: string, requestId?: string | null) {
    super(statusCode, message, requestId);
    this.name = 'APIContextOverflowError';
  }
}

/**
 * HTTP status error that specifically means the provider rate-limited the
 * request.
 */
export class APIProviderRateLimitError extends APIStatusError {
  constructor(message: string, requestId?: string | null) {
    super(429, message, requestId);
    this.name = 'APIProviderRateLimitError';
  }
}

/**
 * The API returned an empty response (no content, no tool calls).
 */
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

export function isRetryableGenerateError(error: unknown): boolean {
  if (error instanceof APIConnectionError || error instanceof APITimeoutError) {
    return true;
  }
  if (error instanceof APIEmptyResponseError) {
    return true;
  }
  if (error instanceof APIStatusError) {
    if ([429, 500, 502, 503, 504].includes(error.statusCode)) {
      return true;
    }
    // Status-code fallback: some reverse proxies (e.g. Xunfei) wrap upstream
    // transient failures with non-5xx status codes (200 / 4xx) while embedding
    // the real failure in the message body. Match the same overload /
    // rate-limit / known-transient-code patterns we use for status-less errors
    // so those still get retried.
    return isRetryableProviderMessage(error.message);
  }
  // Heuristic fallback: generic ChatProviderErrors whose message matches
  // known transient/server-overload patterns — classified as retryable
  // so errors like "Engine Busy" from reverse proxies are retried
  // even when the SDK doesn't carry an HTTP status code.
  if (error instanceof ChatProviderError) {
    return isRetryableProviderMessage(error.message);
  }
  return false;
}

export const PROVIDER_OVERLOAD_MESSAGE_PATTERN =
  /\b(?:engine\s*busy|overloaded|too\s+(?:many|much)\s+(?:load|traffic)|server\s+(?:busy|overloaded))\b/i;
export const PROVIDER_RATE_LIMIT_MESSAGE_PATTERN =
  /\b(?:rate[ _-]?limit(?:ed)?|too\s+many\s+requests|quota\s+exceeded)\b/i;

// Transient Xunfei reverse-proxy failure codes:
//   11210 - upstream/engine internal error
//   10012 - "The system is busy, please try again later." (EngineInternalError:1105)
//   10015 - upstream engine transient failure
//
// Uses a tempered greedy token `(?:(?!\bcode\s*[:=]).)*` to match "code: 11210"
// only when it is the FIRST code= occurrence after "xunfei request failed".
// This prevents false positives like "code: 10001 ... code: 11210" where the
// first code is non-transient (e.g. invalid api key).
export const PROVIDER_REVERSE_PROXY_ERROR_PATTERN =
  /\bxunfei\s+(?:claude\s+)?request\s+failed\b(?:(?!\bcode\s*[:=]).)*\bcode\s*[:=]\s*(?:11210|10012|10015)\b/i;

const RETRYABLE_PROVIDER_MESSAGE_PATTERNS: readonly RegExp[] = [
  PROVIDER_OVERLOAD_MESSAGE_PATTERN,
  PROVIDER_RATE_LIMIT_MESSAGE_PATTERN,
  PROVIDER_REVERSE_PROXY_ERROR_PATTERN,
];

function isRetryableProviderMessage(message: string): boolean {
  return RETRYABLE_PROVIDER_MESSAGE_PATTERNS.some((p) => p.test(message));
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

export function isContextOverflowErrorCode(code: string | null | undefined): boolean {
  return code === 'context_length_exceeded';
}

export function normalizeAPIStatusError(
  statusCode: number,
  message: string,
  requestId?: string | null,
): APIStatusError {
  if (statusCode === 429) {
    return new APIProviderRateLimitError(message, requestId);
  }
  if (isContextOverflowStatusError(statusCode, message)) {
    return new APIContextOverflowError(statusCode, message, requestId);
  }
  return new APIStatusError(statusCode, message, requestId);
}

export function isContextOverflowStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 400 && statusCode !== 413 && statusCode !== 422) return false;
  const lowerMessage = message.toLowerCase();
  return CONTEXT_OVERFLOW_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
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
