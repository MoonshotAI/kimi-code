/**
 * `kosong/contract` domain (L0) — the provider error taxonomy.
 *
 * The single authority on error classification for the LLM wire layer:
 * the `API*Error` class family, the retry verdict (`isRetryableGenerateError`),
 * the telemetry classification (`ApiErrorKind` / `classifyApiError`), and the
 * status-error normalizer every dialect's error converter funnels through.
 * Alongside the wire-status classes, `VideoUploadUnsupportedError` marks the
 * by-design capability gap (provider has no video upload hook) so callers
 * can tell it apart from an upload that failed at runtime.
 *
 * Abort has exactly one standard shape here: the DOMException built by
 * `createAbortError`. Provider error converters must run the `throwIfAbortError`
 * guard FIRST in their classification chain — a user cancellation is thrown
 * as the standard abort shape, never converted into (and never returned as)
 * a retryable provider error.
 */

import type { FinishReason } from './provider';

/**
 * Wire error code for invalid model/provider configuration (`config.invalid`).
 * The code string is a wire contract matched downstream (protocol event
 * schemas, clients), so it is declared here in the L0 contract; the error
 * registry entry is owned by the `config` domain's error module, which
 * registers this constant. Kosong code throws it without registering, keeping
 * a single registry owner.
 */
export const CONFIG_INVALID_ERROR_CODE = 'config.invalid';

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

export class VideoUploadUnsupportedError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'VideoUploadUnsupportedError';
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
  /** Trace id from the `x-trace-id` response header (Kimi only; `null` otherwise). */
  readonly traceId: string | null;

  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
  ) {
    super(message);
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
    super(statusCode, message, requestId, retryAfterMs, traceId);
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

export class APIProviderOverloadedError extends APIStatusError {
  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
  ) {
    super(statusCode, message, requestId, retryAfterMs, traceId);
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

/**
 * The single standard abort shape for the wire layer: a DOMException named
 * `'AbortError'`, matching the platform's own `AbortSignal.reason`
 * convention. Every user-cancellation path — the `generate()` driver,
 * provider error converters, stream wrappers — throws exactly this shape so
 * upstream code can recognize cancellation without SDK knowledge.
 */
export function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Whether `error` is any abort shape that can surface from a provider call:
 *
 *  - the standard abort DOMException (`createAbortError`, `signal.reason`),
 *  - a bare `Error` named `'AbortError'` (generic abort helpers), or
 *  - an SDK user-abort (`APIUserAbortError` in both the OpenAI and Anthropic
 *    SDKs) — recognized structurally by constructor name so this module
 *    stays SDK-free.
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as object).constructor?.name === 'APIUserAbortError'
  );
}

/**
 * The abort guard for provider error converters. Must run at the very front
 * of every error classification chain: when `error` is abort-shaped this
 * THROWS the standard abort DOMException — it never returns a converted
 * error — so a user cancellation can never be misclassified as a retryable
 * provider failure. Does nothing for non-abort errors.
 */
export function throwIfAbortError(error: unknown): void {
  if (isAbortError(error)) {
    throw createAbortError();
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

const THINKING_EFFORT_CONFIG_DOCS_URL =
  'https://moonshotai.github.io/kimi-code/en/configuration/config-files.html#thinking';

const THINKING_EFFORT_STATUS_MESSAGE_PATTERNS = [
  /reasoning[_ .-]?effort/,
  /thinking[_ .-]?effort/,
  /output_config[\s\S]*effort/,
  /unsupported[\s\S]*effort/,
  /invalid[\s\S]*effort/,
] as const;

function appendThinkingEffortConfigHint(statusCode: number, message: string): string {
  if (statusCode !== 400 && statusCode !== 422) return message;
  const lowerMessage = message.toLowerCase();
  if (!THINKING_EFFORT_STATUS_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage))) {
    return message;
  }
  if (message.includes(THINKING_EFFORT_CONFIG_DOCS_URL)) return message;
  return `${message}

The provider rejected the configured thinking effort. Non-Kimi providers receive effort strings without client-side mapping; choose an effort supported by the selected model. For Kimi models, check support_efforts and default_effort. See ${THINKING_EFFORT_CONFIG_DOCS_URL}`;
}

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
  /message at position \d+ with role ['"`]?[a-z]+['"`]? must not be empty/,
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

/**
 * Telemetry-level classification of a failed generation. Callers pass the
 * already-unwrapped cause; aborts are expected to be filtered out before
 * classification (a cancellation is not an API error).
 */
export type ApiErrorKind =
  | 'context_overflow'
  | 'overloaded'
  | 'rate_limit'
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
  if (error instanceof APIStatusError) {
    if (isContextOverflowStatusError(error.statusCode, error.message)) {
      return { kind: 'context_overflow', statusCode };
    }
    if (error.statusCode === 429) return { kind: 'rate_limit', statusCode };
    if (error.statusCode === 529) return { kind: 'overloaded', statusCode };
    if (error.statusCode === 401 || error.statusCode === 403) return { kind: 'auth', statusCode };
    if (error.statusCode >= 500) return { kind: '5xx_server', statusCode };
    if (error.statusCode >= 400) return { kind: '4xx_client', statusCode };
  }
  if (error instanceof APIConnectionError) return { kind: 'network', statusCode };
  if (error instanceof APITimeoutError) return { kind: 'timeout', statusCode };
  if (error instanceof APIEmptyResponseError) return { kind: 'empty_response', statusCode };
  return { kind: 'other', statusCode };
}
