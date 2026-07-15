import {
  APIConnectionError,
  APITimeoutError,
  ChatProviderError,
  classifyBaseApiError,
  normalizeAPIStatusError,
  parseRetryAfterMs,
} from '../errors';
import { extractText } from '../message';
import type { ContentPart, Message } from '../message';
import type { FinishReason, ThinkingEffort } from '../provider';
import type { Tool } from '../tool';
import type { TokenUsage } from '../usage';
import {
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAITimeoutError,
  APIError as OpenAIAPIError,
  OpenAIError,
} from 'openai';
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
      throw new Error(`Unknown content part type: ${(part as ContentPart).type}`);
  }
}
export interface OpenAIToolParam {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

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

export function convertOpenAIError(error: unknown): ChatProviderError {
  if (error instanceof ChatProviderError) {
    return error;
  }
  if (error instanceof OpenAITimeoutError) {
    return new APITimeoutError(error.message);
  }
  if (error instanceof OpenAIConnectionError) {
    return new APIConnectionError(error.message);
  }
  if (error instanceof OpenAIAPIError && typeof error.status === 'number') {
    const reqId = error.requestID ?? null;
    return normalizeAPIStatusError(
      error.status,
      error.message,
      reqId,
      parseRetryAfterMs(error.headers),
    );
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
export function thinkingEffortToReasoningEffort(effort: ThinkingEffort): string | undefined {
  switch (effort) {
    case 'off':
      return undefined;
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
      return 'xhigh';
    default:
      return undefined;
  }
}

export function reasoningEffortToThinkingEffort(
  reasoning: string | undefined,
): ThinkingEffort | null {
  if (reasoning === undefined || reasoning === null) {
    return null;
  }
  switch (reasoning) {
    case 'low':
    case 'minimal':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
      return 'xhigh';
    case 'none':
      return 'off';
    default:
      return 'off';
  }
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
