import type { LlmRemoteErrorMessage, LlmStatusErrorInfo } from '#/llm/response';

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

function matchesAny(message: string, patterns: readonly RegExp[]): boolean {
  const lowerMessage = message.toLowerCase();
  return patterns.some((pattern) => pattern.test(lowerMessage));
}

function isContextOverflowStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 400 && statusCode !== 413 && statusCode !== 422) return false;
  return matchesAny(message, CONTEXT_OVERFLOW_MESSAGE_PATTERNS);
}

function isProviderOverloadStatusError(statusCode: number, message: string): boolean {
  if (statusCode === 529) return true;
  if (statusCode !== 500 && statusCode !== 503) return false;
  return matchesAny(message, PROVIDER_OVERLOAD_MESSAGE_PATTERNS);
}

function isRequestTooLargeStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 413) return false;
  return matchesAny(message, REQUEST_TOO_LARGE_MESSAGE_PATTERNS);
}

function isRequestStructureStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 400 && statusCode !== 422) return false;
  return (
    matchesAny(message, TOOL_EXCHANGE_ADJACENCY_MESSAGE_PATTERNS) ||
    matchesAny(message, STRUCTURAL_REQUEST_MESSAGE_PATTERNS)
  );
}

function isImageFormatStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 400) return false;
  const lowerMessage = message.toLowerCase();
  return (
    matchesAny(message, IMAGE_FORMAT_STATUS_MESSAGE_PATTERNS) ||
    (MEDIA_TYPE_FIELD_PATTERN.test(lowerMessage) && lowerMessage.includes('image'))
  );
}

export function withoutUndefinedStatusCode(error: LlmRemoteErrorMessage): LlmRemoteErrorMessage {
  if (!('statusCode' in error) || error.statusCode !== undefined) return error;
  const { statusCode: _statusCode, ...withoutStatus } = error;
  return withoutStatus;
}

export interface LlmStatusErrorInput {
  readonly statusCode?: number;
  readonly message: string;
  readonly requestId?: string | null;
  readonly retryAfterMs?: number | null;
  readonly headers?: Record<string, string> | null;
  readonly retryable?: boolean;
}

const STREAM_RETRYABLE_ERROR_CODES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export function toLlmStreamErrorMessage(
  input: Omit<LlmStatusErrorInput, 'statusCode'> & { readonly businessCode?: number },
): LlmRemoteErrorMessage {
  const info = {
    requestId: input.requestId ?? null,
    retryAfterMs: input.retryAfterMs ?? null,
    headers: input.headers ?? null,
  };
  if (input.businessCode === 429) {
    return { kind: 'rate_limit', message: input.message, ...info };
  }
  if (input.businessCode === 529) {
    return { kind: 'overloaded', message: input.message, ...info };
  }
  if (input.businessCode === 413) {
    return { kind: 'request_too_large', message: input.message, ...info };
  }
  return {
    kind: 'status',
    message: input.message,
    retryable: input.businessCode === undefined || STREAM_RETRYABLE_ERROR_CODES.has(input.businessCode),
    ...info,
  };
}

export function toLlmStatusErrorMessage(input: LlmStatusErrorInput): LlmRemoteErrorMessage {
  const statusInfo: LlmStatusErrorInfo =
    input.statusCode === undefined
      ? {
          requestId: input.requestId ?? null,
          retryAfterMs: input.retryAfterMs ?? null,
          headers: input.headers ?? null,
        }
      : {
          statusCode: input.statusCode,
          requestId: input.requestId ?? null,
          retryAfterMs: input.retryAfterMs ?? null,
          headers: input.headers ?? null,
        };
  const info =
    input.retryable === undefined ? statusInfo : { ...statusInfo, retryable: input.retryable };
  if (input.statusCode === 429) {
    return { kind: 'rate_limit', message: input.message, ...info };
  }
  if (input.statusCode !== undefined) {
    if (isContextOverflowStatusError(input.statusCode, input.message)) {
      return { kind: 'context_overflow', message: input.message, ...info };
    }
    if (isRequestTooLargeStatusError(input.statusCode, input.message)) {
      return { kind: 'request_too_large', message: input.message, ...info };
    }
    if (isProviderOverloadStatusError(input.statusCode, input.message)) {
      return { kind: 'overloaded', message: input.message, ...info };
    }
    if (isRequestStructureStatusError(input.statusCode, input.message)) {
      return { kind: 'request_structure', message: input.message, ...info };
    }
    if (isImageFormatStatusError(input.statusCode, input.message)) {
      return { kind: 'image_format', message: input.message, ...info };
    }
  }
  return { kind: 'status', message: input.message, ...info };
}
