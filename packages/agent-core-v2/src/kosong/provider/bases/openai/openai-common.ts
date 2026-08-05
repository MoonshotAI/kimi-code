/**
 * `kosong/provider` domain — shared OpenAI-family wire mechanics.
 *
 * The shared pieces: content-part and tool conversion, usage extraction,
 * finish-reason normalization, the capability constants, and the error
 * converter.
 *
 * `convertOpenAIError`'s FIRST line is the contract's `throwIfAbortError`
 * guard: a user cancellation (SDK `APIUserAbortError`, bare `AbortError`, the
 * standard abort DOMException) is THROWN as the standard abort shape at the
 * very front of the classification chain — it can never be converted into,
 * nor returned as, a retryable provider error. After the guard,
 * already-converted `ChatProviderError`s pass through untouched; only then is
 * the optional trait-composed `convertError` hook consulted, so a vendor
 * classifies each RAW wire failure (e.g. quota 429s) exactly once before the
 * base rules run. The base itself classifies only OpenAI's own documented
 * `insufficient_quota` code as a non-retryable quota exhaustion —
 * vendor-specific quota signals belong on the vendor's trait.
 */

import {
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAITimeoutError,
  APIError as OpenAIAPIError,
  OpenAIError,
} from 'openai';

import { BugIndicatingError } from '#/_base/errors/errors';
import {
  APIConnectionError,
  APIProviderQuotaExhaustedError,
  APITimeoutError,
  ChatProviderError,
  classifyBaseApiError,
  normalizeAPIStatusError,
  parseRetryAfterMs,
  parseTraceId,
  throwIfAbortError,
} from '#/kosong/contract/errors';
import { extractText } from '#/kosong/contract/message';
import type { ContentPart, Message } from '#/kosong/contract/message';
import type { FinishReason } from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import type { TokenUsage } from '#/kosong/contract/usage';

export interface OpenAIContentPart {
  type: string;
  text?: string | undefined;
  image_url?: { url: string; id?: string | null } | undefined;
  audio_url?: { url: string; id?: string | null } | undefined;
  video_url?: { url: string; id?: string | null } | undefined;
}

export function convertContentPart(part: ContentPart): OpenAIContentPart | null {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think':
      return null;
    case 'image_url':
      return {
        type: 'image_url',
        image_url:
          part.imageUrl.id === undefined
            ? { url: part.imageUrl.url }
            : { url: part.imageUrl.url, id: part.imageUrl.id },
      };
    case 'audio_url':
      return {
        type: 'audio_url',
        audio_url:
          part.audioUrl.id === undefined
            ? { url: part.audioUrl.url }
            : { url: part.audioUrl.url, id: part.audioUrl.id },
      };
    case 'video_url':
      return {
        type: 'video_url',
        video_url:
          part.videoUrl.id === undefined
            ? { url: part.videoUrl.url }
            : { url: part.videoUrl.url, id: part.videoUrl.id },
      };
    default:
      throw new BugIndicatingError(`Unknown content part type: ${(part as ContentPart).type}`);
  }
}

export type OpenAIToolParam = {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export function toolToOpenAI(tool: Tool): OpenAIToolParam {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

export function isOpenAIInsufficientQuotaCode(code: string | null | undefined): boolean {
  return code === 'insufficient_quota';
}

function isOpenAIInsufficientQuotaError(error: OpenAIAPIError): boolean {
  if (error.status !== 429) return false;
  if (typeof error.code === 'string' && isOpenAIInsufficientQuotaCode(error.code)) return true;
  if (typeof error.type === 'string' && isOpenAIInsufficientQuotaCode(error.type)) return true;
  return error.message.toLowerCase().includes('insufficient_quota');
}

export function convertOpenAIError(
  error: unknown,
  convertErrorHook?: (error: unknown) => ChatProviderError | undefined,
): ChatProviderError {
  throwIfAbortError(error);
  if (error instanceof ChatProviderError) {
    return error;
  }
  const hooked = convertErrorHook?.(error);
  if (hooked !== undefined) {
    return hooked;
  }
  if (error instanceof OpenAITimeoutError) {
    return new APITimeoutError(error.message);
  }
  if (error instanceof OpenAIConnectionError) {
    return new APIConnectionError(error.message);
  }
  if (error instanceof OpenAIAPIError && typeof error.status === 'number') {
    const reqId = error.requestID ?? null;
    const retryAfterMs = parseRetryAfterMs(error.headers);
    const traceId = parseTraceId(error.headers);
    if (isOpenAIInsufficientQuotaError(error)) {
      return new APIProviderQuotaExhaustedError(error.message, reqId, retryAfterMs, traceId);
    }
    return normalizeAPIStatusError(error.status, error.message, reqId, retryAfterMs, traceId);
  }
  if (
    error instanceof OpenAIAPIError &&
    error.constructor === OpenAIAPIError &&
    error.error === undefined
  ) {
    return classifyBaseApiError(error.message);
  }
  if (error instanceof OpenAIError) {
    return new ChatProviderError(`Error: ${error.message}`);
  }
  if (error instanceof Error) {
    return classifyBaseApiError(error.message);
  }
  return new ChatProviderError(`Error: ${String(error)}`);
}

export interface FunctionToolCallShape {
  type: 'function';
  id: string;
  function: { name: string; arguments: string | null };
}

export function isFunctionToolCall<T extends { type: string }>(
  tc: T,
): tc is T & FunctionToolCallShape {
  return tc.type === 'function';
}

export function extractUsage(usage: unknown): TokenUsage | null {
  if (usage === null || usage === undefined || typeof usage !== 'object') {
    return null;
  }
  const u = usage as Record<string, unknown>;
  const promptTokens = typeof u['prompt_tokens'] === 'number' ? u['prompt_tokens'] : 0;
  const completionTokens = typeof u['completion_tokens'] === 'number' ? u['completion_tokens'] : 0;

  let cached = 0;
  if (typeof u['cached_tokens'] === 'number') {
    cached = u['cached_tokens'];
  } else if (
    typeof u['prompt_tokens_details'] === 'object' &&
    u['prompt_tokens_details'] !== null
  ) {
    const details = u['prompt_tokens_details'] as Record<string, unknown>;
    if (typeof details['cached_tokens'] === 'number') {
      cached = details['cached_tokens'];
    }
  }

  return {
    inputOther: promptTokens - cached,
    output: completionTokens,
    inputCacheRead: cached,
    inputCacheCreation: 0,
  };
}

export function normalizeOpenAIFinishReason(raw: string | null | undefined): {
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
} {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  switch (raw) {
    case 'stop':
      return { finishReason: 'completed', rawFinishReason: raw };
    case 'tool_calls':
    case 'function_call':
      return { finishReason: 'tool_calls', rawFinishReason: raw };
    case 'length':
      return { finishReason: 'truncated', rawFinishReason: raw };
    case 'content_filter':
      return { finishReason: 'filtered', rawFinishReason: raw };
    default:
      return { finishReason: 'other', rawFinishReason: raw };
  }
}

export type ToolMessageConversion = 'extract_text' | null;

export const TOOL_RESULT_MEDIA_PROMPT = 'Attached media from tool result:';
export const TOOL_RESULT_MEDIA_PLACEHOLDER = '(see attached media)';

export function isMediaPart(part: ContentPart): boolean {
  return part.type !== 'text' && part.type !== 'think';
}

export function convertToolMessageContent(
  message: Message,
  conversion: ToolMessageConversion,
): string | OpenAIContentPart[] {
  if (conversion === 'extract_text') {
    return extractText(message);
  }
  return message.content
    .map((p) => convertContentPart(p))
    .filter((p): p is OpenAIContentPart => p !== null);
}


export const OPENAI_REASONING_CAPABILITY = Object.freeze({
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 0,
});

export const OPENAI_VISION_TOOL_CAPABILITY = Object.freeze({
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 0,
});

export const OPENAI_TEXT_TOOL_CAPABILITY = Object.freeze({
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 0,
});

export const OPENAI_VISION_TOOL_PREFIXES = ['gpt-4o', 'gpt-4-turbo', 'gpt-4.1', 'gpt-4.5'] as const;

export function isOpenAIReasoningModel(normalizedModelName: string): boolean {
  return /^o\d/.test(normalizedModelName);
}

export function hasModelPrefix(modelName: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => modelName.startsWith(prefix));
}
