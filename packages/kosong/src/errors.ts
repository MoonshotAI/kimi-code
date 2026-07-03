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
  return error instanceof APIStatusError && [429, 500, 502, 503, 504].includes(error.statusCode);
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
