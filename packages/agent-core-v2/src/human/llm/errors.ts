import type { FinishReason } from '#/llm/finish-reason';

export function sanitizeStatusErrorMessage(message: string): string {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(message);
  const extracted = titleMatch?.[1]?.trim();
  const normalized = extracted !== undefined && extracted.length > 0 ? extracted : message;
  return normalized.replaceAll('\r', '');
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as object).constructor?.name === 'APIUserAbortError'
  );
}

export type LlmErrorKind =
  | 'syntax'
  | 'abort'
  | 'connection'
  | 'timeout'
  | 'status'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'overloaded'
  | 'context_overflow'
  | 'request_too_large'
  | 'request_structure'
  | 'image_format'
  | 'empty_response'
  | 'provider'
  | 'unknown';

export type LlmRemoteErrorKind = Exclude<LlmErrorKind, 'syntax'>;

export type LlmSyntaxErrorCode = 'request_format' | 'thinking_config' | 'internal';

export type LlmStatusErrorKind =
  | 'status'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'overloaded'
  | 'context_overflow'
  | 'request_too_large'
  | 'request_structure'
  | 'image_format';

export interface LlmStatusErrorInfo {
  readonly statusCode: number;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
  readonly headers: Record<string, string> | null;
}

export type LlmErrorMessage<T extends LlmErrorKind = LlmErrorKind> =
  T extends LlmStatusErrorKind
    ? { readonly kind: T; readonly message: string } & LlmStatusErrorInfo
    : T extends 'syntax'
      ? { readonly kind: T; readonly message: string; readonly code: LlmSyntaxErrorCode }
      : T extends 'empty_response'
        ? {
            readonly kind: T;
            readonly message: string;
            readonly finishReason: FinishReason | null;
            readonly rawFinishReason: string | null;
          }
        : { readonly kind: T; readonly message: string };

export type LlmRemoteErrorMessage = LlmErrorMessage<LlmRemoteErrorKind>;

export function llmStatusErrorMessage(
  error: LlmErrorMessage,
): LlmErrorMessage<LlmStatusErrorKind> | null {
  switch (error.kind) {
    case 'status':
    case 'rate_limit':
    case 'quota_exhausted':
    case 'overloaded':
    case 'context_overflow':
    case 'request_too_large':
    case 'request_structure':
    case 'image_format':
      return error;
    default:
      return null;
  }
}

function abortErrorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return 'The operation was aborted.';
}

export function toLlmErrorMessage(error: unknown): LlmRemoteErrorMessage {
  if (isAbortError(error)) {
    return { kind: 'abort', message: abortErrorMessage(error) };
  }
  return { kind: 'unknown', message: error instanceof Error ? error.message : String(error) };
}

const NETWORK_RE = /network|connection|connect|disconnect|terminated/i;
const TIMEOUT_RE = /timed?\s*out|timeout|deadline/i;

export function toLlmTransportErrorMessage(message: string): LlmRemoteErrorMessage {
  if (TIMEOUT_RE.test(message)) {
    return { kind: 'timeout', message };
  }
  if (NETWORK_RE.test(message)) {
    return { kind: 'connection', message };
  }
  return { kind: 'provider', message: `Error: ${message}` };
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

const STRUCTURAL_REQUEST_MESSAGE_PATTERNS = [
  /text content blocks must be non-empty/,
  /text content blocks must contain non-whitespace/,
  /first message must use the .*user.* role/,
  /roles must alternate/,
  /multiple .*(?:user|assistant).* roles in a row/,
  /tool_use[\s\S]*ids must be unique/,
  /message at position \d+ with role ['"`]?[a-z]+['"`]? must not be empty/,
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

const THINKING_EFFORT_CONFIG_DOCS_URL =
  'https://moonshotai.github.io/kimi-code/en/configuration/config-files.html#thinking';

const THINKING_EFFORT_STATUS_MESSAGE_PATTERNS = [
  /reasoning[_ .-]?effort/,
  /thinking[_ .-]?effort/,
  /output_config[\s\S]*effort/,
  /unsupported[\s\S]*effort/,
  /invalid[\s\S]*effort/,
] as const;

export function appendThinkingEffortConfigHint(statusCode: number, message: string): string {
  if (statusCode !== 400 && statusCode !== 422) return message;
  const lowerMessage = message.toLowerCase();
  if (!THINKING_EFFORT_STATUS_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage))) {
    return message;
  }
  if (message.includes(THINKING_EFFORT_CONFIG_DOCS_URL)) return message;
  return `${message}

The provider rejected the configured thinking effort. Non-Kimi providers receive effort strings without client-side mapping; choose an effort supported by the selected model. For Kimi models, check support_efforts and default_effort. See ${THINKING_EFFORT_CONFIG_DOCS_URL}`;
}

export interface LlmStatusErrorInput {
  readonly statusCode: number;
  readonly message: string;
  readonly requestId?: string | null;
  readonly retryAfterMs?: number | null;
  readonly headers?: Record<string, string> | null;
}

export function toLlmStatusErrorMessage(input: LlmStatusErrorInput): LlmRemoteErrorMessage {
  const info: LlmStatusErrorInfo = {
    statusCode: input.statusCode,
    requestId: input.requestId ?? null,
    retryAfterMs: input.retryAfterMs ?? null,
    headers: input.headers ?? null,
  };
  const message = sanitizeStatusErrorMessage(input.message);
  if (input.statusCode === 429) {
    return { kind: 'rate_limit', message, ...info };
  }
  if (isContextOverflowStatusError(input.statusCode, input.message)) {
    return { kind: 'context_overflow', message, ...info };
  }
  if (isRequestTooLargeStatusError(input.statusCode, input.message)) {
    return { kind: 'request_too_large', message, ...info };
  }
  if (isProviderOverloadStatusError(input.statusCode, input.message)) {
    return { kind: 'overloaded', message, ...info };
  }
  if (isRequestStructureStatusError(input.statusCode, input.message)) {
    return { kind: 'request_structure', message, ...info };
  }
  if (isImageFormatStatusError(input.statusCode, input.message)) {
    return { kind: 'image_format', message, ...info };
  }
  return {
    kind: 'status',
    message: appendThinkingEffortConfigHint(input.statusCode, message),
    ...info,
  };
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

export function headersToRecord(headers: unknown): Record<string, string> | null {
  if (
    headers === null ||
    typeof headers !== 'object' ||
    typeof (headers as { forEach?: unknown }).forEach !== 'function'
  ) {
    return null;
  }
  const record: Record<string, string> = {};
  (headers as { forEach(callback: (value: string, key: string) => void): void }).forEach(
    (value, key) => {
      record[key] = value;
    },
  );
  return record;
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

export function isToolExchangeAdjacencyStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 400 && statusCode !== 422) return false;
  const lowerMessage = message.toLowerCase();
  return TOOL_EXCHANGE_ADJACENCY_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

export function isRequestStructureStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 400 && statusCode !== 422) return false;
  if (isToolExchangeAdjacencyStatusError(statusCode, message)) return true;
  const lowerMessage = message.toLowerCase();
  return STRUCTURAL_REQUEST_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

export function isImageFormatStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 400) return false;
  const lowerMessage = message.toLowerCase();
  return (
    IMAGE_FORMAT_STATUS_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage)) ||
    (MEDIA_TYPE_FIELD_PATTERN.test(lowerMessage) && lowerMessage.includes('image'))
  );
}
