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

/**
 * HTTP status error that specifically means the request exceeded the model
 * context window.
 */
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

/**
 * HTTP 413 that specifically means the serialized request body exceeded the
 * provider's byte ceiling (e.g. accumulated base64 images), as opposed to a
 * token-count overflow. Token overflow is recoverable by compaction; a body
 * size rejection is not — it needs media to be dropped or shrunk.
 */
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

/**
 * HTTP status error that specifically means the provider rate-limited the
 * request.
 */
export class APIProviderRateLimitError extends APIStatusError {
  constructor(message: string, requestId?: string | null, retryAfterMs?: number | null) {
    super(429, message, requestId, retryAfterMs);
    this.name = 'APIProviderRateLimitError';
  }
}

/**
 * HTTP status error that specifically means the provider is overloaded / at
 * capacity (Anthropic 529 `overloaded_error`, OpenAI 503 "server is currently
 * overloaded"). Distinct from rate limiting: the caller's quota is not the
 * constraint, the provider is simply saturated — retry with backoff.
 */
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

// Client-side image rejections thrown before the request is sent (the
// provider adapter's own media whitelist).
const IMAGE_FORMAT_PROVIDER_MESSAGE_PATTERNS = [
  /unsupported media type for base64 image/,
  /invalid data url for image/,
] as const;

// Server-side image rejections that are safe to recover by stripping media:
// an unsupported/invalid media type or undecodable image data. These are
// deliberately narrow and grounded in the documented messages of the major
// providers (Anthropic, OpenAI, Moonshot/Kimi, Gemini) — image COUNT/SIZE
// limits or image-input-disabled errors also mention "image", but stripping
// media either over-recovers or hides a real configuration problem the user
// should see; only format/data rejections are guaranteed to be fixed by
// removing the offending image.
//
// Matching on provider message text is inherently best-effort: these strings
// are not a stable contract, so a novel phrasing is missed and the error
// propagates (the pre-recovery behavior). The entry-point format gate is the
// structural defense; this recovery only backstops the residue.
// Every pattern mentions "image" literally, and MEDIA_TYPE_FIELD_PATTERN is
// separately gated on an "image" anchor — so audio/video media rejections
// ("unsupported media type", "invalid media type") can never be classified
// as image errors here. All documented provider image rejections mention
// "image", so the restriction costs no known match.
const IMAGE_FORMAT_STATUS_MESSAGE_PATTERNS = [
  // Unsupported format — OpenAI / Moonshot "unsupported image …".
  /unsupported image (?:url|format|type)/,
  // Undecodable / corrupt image data.
  /does not represent a valid image/,
  /could not (?:process|decode) (?:the |input )?image/,
  /unable to process (?:the |input )?image/,
  /failed to decode (?:the )?image/,
  /invalid image(?: data| type| format)?/,
] as const;

// Anthropic `media_type` & Gemini `mime_type` enum violations name the field
// — recoverable only when the message is about an IMAGE. A video/audio
// `media_type` rejection must surface instead of being blindly
// media-stripped: unlike images there is no conversion-guidance path for
// video today, so dropping the user's video silently would hide the real
// error. Every documented image media_type message also mentions "image",
// so the anchor costs nothing on the known cases.
const MEDIA_TYPE_FIELD_PATTERN = /(?:media|mime)_?type/;

/**
 * Whether the provider rejected an IMAGE in the request because of its
 * FORMAT or DATA — an unsupported media type or undecodable image bytes.
 * The rejection is deterministic for a given history (the same image is
 * re-sent on every request, so the session would fail every turn), and the
 * only recovery is to resend once with all media stripped (see the
 * media-stripped resend in `llmRequester`). Body-size (413), context
 * overflow, image count/size limits, image-input-disabled rejections, and
 * non-image (audio/video) media rejections are excluded — the first two
 * have their own recoveries, and the rest are not fixed by stripping media.
 */
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
  // Fallback safety net: an unclassified provider failure — typically an
  // upstream gateway that forwards the original error only as text, with no
  // usable HTTP status — lands here as a base `ChatProviderError`. Retrying
  // beats failing the run on the first transient blip. Image-format
  // rejections are excluded: they are deterministic per history and recovered
  // by the media-stripped resend (see isImageFormatError), so retrying the
  // identical request first would only burn the retry budget.
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

// Wordings that mean the provider itself is saturated rather than throttling
// this caller. Anchored on "overload" (Anthropic's `overloaded_error`, OpenAI's
// "server is currently overloaded", Gemini's "model is overloaded") so a bare
// proxy 503 ("Service Unavailable") does not get misclassified as overload.
const PROVIDER_OVERLOAD_MESSAGE_PATTERNS = [/overload/] as const;

// Wordings that mean the serialized request BODY was too big, matched against
// the lowercased message of a 413. Kept separate from the context-overflow
// patterns above: those describe token counts, these describe bytes. A 413
// whose message matches neither family stays a plain `APIStatusError` —
// Vertex phrases prompt-too-long as a 413, so the status alone is not proof
// of a body-size rejection.
const REQUEST_TOO_LARGE_MESSAGE_PATTERNS = [
  // Moonshot / Kimi: "Request exceeds the maximum size".
  /request exceeds the maximum size/,
  // Reverse proxies (nginx-style HTML body): "413 Request Entity Too Large".
  /request entity too large/,
  // Anthropic: error type `request_too_large`, message "Request exceeds the
  // maximum allowed number of bytes".
  /request_too_large/,
  /exceeds? the maximum allowed number of bytes/,
  // RFC 9110 reason phrase (both the pre-2022 and current names).
  /payload too large/,
  /content too large/,
  // Plain wordings: generic gateways say "request too large"; Go's
  // http.MaxBytesReader (common in Go proxies) says "request body too large".
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
  // Context overflow first: Vertex returns prompt-too-long as a 413, and a
  // token overflow must keep routing to compaction even on that status.
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
  // 529 is Anthropic's dedicated overloaded status — always overload.
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
