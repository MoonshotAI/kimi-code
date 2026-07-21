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
  /**
   * Server-requested backoff from the `retry-after` response header, in
   * milliseconds. When present, the retry loop honors it instead of its own
   * computed backoff — a server `Retry-After` directive overrides the local
   * exponential delay.
   */
  readonly retryAfterMs: number | null;
  /**
   * Provider trace identifier from the `x-trace-id` response header
   * (Kimi/KFC only), or `null` when the error response did not carry one.
   * A failed request usually still returns response headers, so hosts can
   * attribute the failure to its server-side request.
   */
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
    traceId?: string | null,
  ) {
    super(statusCode, message, requestId, retryAfterMs, traceId);
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
    traceId?: string | null,
  ) {
    super(statusCode, message, requestId, retryAfterMs, traceId);
    this.name = 'APIRequestTooLargeError';
  }
}

/**
 * HTTP status error that specifically means the provider rate-limited the
 * request.
 */
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
    error.constructor?.name === 'APIUserAbortError'
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

export function isRetryableGenerateError(error: unknown): boolean {
  if (error instanceof APIConnectionError || error instanceof APITimeoutError) {
    return true;
  }
  if (error instanceof APIEmptyResponseError) {
    return true;
  }
  if (error instanceof APIStatusError) {
    // Transient statuses worth retrying: 408 (request timeout), 409
    // (lock/conflict timeout), 429 (rate limit), 5xx (server errors) and 529
    // (provider overloaded — the "engine is currently overloaded" case).
    return [408, 409, 429, 500, 502, 503, 504, 529].includes(error.statusCode);
  }
  // Fallback safety net: an unclassified provider failure — typically an
  // upstream gateway that forwards the original error only as text, with no
  // usable HTTP status (e.g. llmproxy embedding `status_code=429` in the
  // message) — lands here as a base `ChatProviderError`. Retrying beats
  // failing the run on the first transient blip. Typed `APIStatusError`
  // instances are deliberately excluded above: deterministic 4xx
  // (400/401/403/404/422) and the recovery-owned context-overflow /
  // request-too-large subclasses keep their dedicated handling instead of
  // burning retries first. Image-format rejections are likewise excluded:
  // they are deterministic per history and recovered by the media-stripped
  // resend (see isImageFormatError), so retrying the identical request first
  // would only burn the retry budget.
  return error instanceof ChatProviderError && !isImageFormatError(error);
}

// Client-side image rejections thrown before the request is sent (kosong's
// own media whitelist in the Anthropic adapter).
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
 * media-stripped resend in the agent loop). Body-size (413), context
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

// `terminated` is the undici signature for an SSE/HTTP body stream that is
// dropped mid-flight (common with Node's native fetch on long reasoning
// streams). It surfaces as a raw `TypeError: terminated`, so it must be
// recognized here as a transport-layer connection failure. Shared by the
// Anthropic and OpenAI providers so a raw, non-SDK transport error classifies
// the same way regardless of which provider was streaming.
const NETWORK_RE = /network|connection|connect|disconnect|terminated/i;
const TIMEOUT_RE = /timed?\s*out|timeout|deadline/i;

/**
 * Classify a raw (non-SDK) error message into the right transport-layer
 * `ChatProviderError` subclass: a timeout becomes a retryable `APITimeoutError`,
 * a dropped connection / undici `terminated` becomes a retryable
 * `APIConnectionError`, and anything else stays a non-retryable base
 * `ChatProviderError`. Timeout is checked first so "connection timed out"
 * classifies as a timeout rather than a bare connection error.
 */
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
  // Context overflow first: Vertex returns prompt-too-long as a 413, and a
  // token overflow must keep routing to compaction even on that status.
  if (isContextOverflowStatusError(statusCode, message)) {
    return new APIContextOverflowError(statusCode, message, requestId, retryAfterMs, traceId);
  }
  if (isRequestTooLargeStatusError(statusCode, message)) {
    return new APIRequestTooLargeError(statusCode, message, requestId, retryAfterMs, traceId);
  }
  return new APIStatusError(
    statusCode,
    appendThinkingEffortConfigHint(statusCode, message),
    requestId,
    retryAfterMs,
    traceId,
  );
}

/**
 * Read a single response header from an unknown headers-like object (anything
 * exposing a `get(name)` method, e.g. the Fetch `Headers` the SDKs carry on
 * their errors). Returns `null` when the object is not headers-like or the
 * header is absent.
 */
function readResponseHeader(headers: unknown, name: string): string | null {
  return headers !== null &&
    typeof headers === 'object' &&
    typeof (headers as { get?: unknown }).get === 'function'
    ? (headers as { get(name: string): string | null }).get(name)
    : null;
}

/**
 * Parse the provider trace identifier from the `x-trace-id` response header
 * (Kimi/KFC only). Returns `null` when the header is absent or empty.
 */
export function parseTraceId(headers: unknown): string | null {
  const raw = readResponseHeader(headers, 'x-trace-id');
  if (raw === null || raw === undefined || raw.length === 0) return null;
  return raw;
}

/**
 * Parse a `retry-after` response header into milliseconds. Only integer
 * seconds is honored; an HTTP-date (or any non-integer / missing value)
 * returns null and the caller falls back to its computed backoff. Shared by
 * the provider error converters so every backend honors the same server
 * backoff directive.
 */
export function parseRetryAfterMs(headers: unknown): number | null {
  const raw = readResponseHeader(headers, 'retry-after');
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

export function isRequestTooLargeStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 413) return false;
  const lowerMessage = message.toLowerCase();
  return REQUEST_TOO_LARGE_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

// Strict providers reject a request whose assistant `tool_use`/`tool_calls` and
// `tool_result`/`tool` blocks are not correctly paired and adjacent — a missing
// result, a stray result with no matching call, or a result that does not
// immediately follow its call. Anthropic phrases this in terms of
// `tool_use`/`tool_result`. OpenAI-compatible providers phrase it in terms of
// `tool_call_id` / `role 'tool'` / `tool_calls`: Moonshot / Kimi as a
// `tool_call_id` that "is not found", and OpenAI / DeepSeek / vLLM / Qwen as a
// `role 'tool'` message without a preceding `tool_calls`, or an assistant
// `tool_calls` not followed by its tool results. The validation runs before any
// generation, so the error is a non-retryable 4xx. A caller can react by
// resending a re-projected, strictly wire-compliant request rather than leaving
// the session permanently stuck.
const TOOL_EXCHANGE_ADJACENCY_MESSAGE_PATTERNS = [
  /tool_use[\s\S]*tool_result/,
  /tool_result[\s\S]*tool_use/,
  /unexpected\s+`?tool_result/,
  // OpenAI-compatible (Moonshot / Kimi): a `tool` message references a
  // `tool_call_id` with no matching `tool_calls` entry in the preceding
  // assistant message. Observed verbatim as `tool_call_id  is not found`
  // (doubled space). Anchored on `tool_call_id` so an unrelated "not found"
  // (e.g. a 404-style body) cannot trip the recovery.
  /tool_call_id[\s\S]*not found/,
  // OpenAI / DeepSeek / vLLM and other OpenAI-compatible providers phrase the
  // same structural rejection in terms of `role 'tool'` / `tool_calls` instead
  // of Anthropic's `tool_use` / `tool_result`, in two mirror-image shapes:
  //
  //   - An orphan `tool` result whose preceding assistant carries no matching
  //     `tool_calls`: "messages with role 'tool' must be a response to a
  //     preceding message with 'tool_calls'".
  //   - An assistant `tool_calls` with no following `tool` results: "an
  //     assistant message with 'tool_calls' must be followed by tool messages
  //     responding to each 'tool_call_id'. the following tool_call_ids did not
  //     have response messages: ...", or the terse "(insufficient tool messages
  //     following tool_calls message)".
  //
  // Both are wire-structure defects the strict resend repairs (drop the orphan
  // result / synthesize the missing one). Quote style around `tool`/`tool_calls`
  // varies by provider (straight or backtick), so the anchors tolerate an
  // optional surrounding quote char.
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

// The broader family of structural request rejections a strict provider returns
// when the message array itself is malformed — tool_use/tool_result pairing,
// empty or whitespace-only text blocks, a non-user first message, or
// non-alternating roles. All are deterministic 4xx validation failures (no
// generation happened) on a history that is re-sent every turn, so the only
// recovery is to resend a re-projected, strictly wire-compliant request rather
// than leave the session permanently stuck. Context-overflow 400s are excluded —
// they are handled by compaction, not by re-projection.
const STRUCTURAL_REQUEST_MESSAGE_PATTERNS = [
  /text content blocks must be non-empty/,
  /text content blocks must contain non-whitespace/,
  /first message must use the .*user.* role/,
  /roles must alternate/,
  /multiple .*(?:user|assistant).* roles in a row/,
  // Anthropic rejects a request whose assistant messages carry two `tool_use`
  // blocks with the same id: "messages: `tool_use` ids must be unique". Seen
  // when a provider reused a call id (e.g. per-response counter ids) earlier
  // in the session; the strict resend dedupes the ids.
  /tool_use[\s\S]*ids must be unique/,
  // Moonshot / Kimi rejects a message whose serialized form carries nothing —
  // no content, no tool_calls, an empty reasoning_content: "the message at
  // position N with role 'assistant' must not be empty". Seen when a filtered
  // response left an assistant message holding only an empty thinking part in
  // the history; the strict resend's projection drops such vacuous messages.
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
