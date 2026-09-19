import OpenAI, {
  APIConnectionError as RawOpenAISDKConnectionError,
  APIConnectionTimeoutError as RawOpenAISDKConnectionTimeoutError,
  APIError as RawOpenAISDKAPIError,
  OpenAIError as RawOpenAISDKError,
} from 'openai';

import {
  headersToRecord,
  isAbortError,
  parseRetryAfterMs,
  sanitizeStatusErrorMessage,
  toLlmErrorMessage,
  toLlmStatusErrorMessage,
  toLlmTransportErrorMessage,
  type LlmRemoteErrorMessage,
} from '#/llm/errors';
import {
  createMediaLowerer,
  dataUrlOf,
  mediaContextOf,
  type MaterializedMedia,
} from '#/llm/media/materialize';
import {
  extractText,
  type AudioURLPart,
  type ContentPart,
  type ImageURLPart,
  type Message,
  type StreamedMessagePart,
  type ThinkPart,
  type ToolDescription,
  type ToolMessage,
  type UserMessage,
  type VideoURLPart,
} from '#/llm/message';
import type { ResponseFormat } from '#/llm/model';
import type {
  FormatRequestInput,
  ProtocolFormat,
  StreamParser,
  StreamParserOptions,
} from '#/llm/protocol/format';
import { applyPatterns, toolResultToPlainText, type Pattern } from '#/llm/protocol/rewrite';
import type { ToolMessageConversion } from '#/llm/requester/requester';
import { NO_FINISH, type FinishInfo, type FinishReason, type TokenUsage } from '#/llm/usage';

import {
  convertReasoningDetails,
  extractReasoningDetails,
  extractReasoningStrings,
  REASONING_DETAILS_KEY,
} from './reasoning-key';

export type NativePart = {
  type: 'text' | 'image_url' | 'audio_url' | 'video_url';
  text?: string | undefined;
  image_url?: { url: string; id?: string | null } | undefined;
  audio_url?: { url: string; id?: string | null } | undefined;
  video_url?: { url: string; id?: string | null } | undefined;
};

export type NativeToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type NativeMessage =
  | { role: 'system' | 'user'; content: string | NativePart[] }
  | {
      role: 'assistant';
      content: string | NativePart[] | null;
      tool_calls?: NativeToolCall[];
    }
  | { role: 'tool'; tool_call_id: string; content: string | NativePart[] };

export type RawUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
};

export type RawStreamToolCallDelta = {
  index?: number | string;
  id?: string;
  function?: { name?: string; arguments?: string } | null;
};

export type RawChunk = {
  id?: string;
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: RawStreamToolCallDelta[];
    };
    finish_reason?: string | null;
  }[];
  usage?: RawUsage | null;
};

export const TOOL_RESULT_MEDIA_PROMPT = 'Attached media from tool result:';
export const TOOL_RESULT_MEDIA_PLACEHOLDER = '(see attached media)';

function isExtractableMedia(part: ContentPart): boolean {
  if (part.type === 'image_url') return true;
  return part.type === 'video_url' && !part.videoUrl.url.startsWith('data:');
}

export const extractToolMedia: Pattern<Message> = {
  name: 'extractToolMedia',
  rewrite(items, index) {
    const first = items[index];
    if (first === undefined || first.role !== 'tool') return null;
    let end = index;
    while (end < items.length && items[end]?.role === 'tool') {
      end += 1;
    }
    const run = items.slice(index, end) as ToolMessage[];
    const media: ContentPart[] = [];
    for (const message of run) {
      for (const part of message.content) {
        if (isExtractableMedia(part)) {
          media.push(part);
        }
      }
    }
    if (media.length === 0) return null;
    const stripped = run.map((message) => {
      const content = message.content.filter((part) => !isExtractableMedia(part));
      const hadImage = message.content.some((part) => part.type === 'image_url');
      const hasText = content.some((part) => part.type === 'text' && part.text.length > 0);
      const hasAudio = content.some((part) => part.type === 'audio_url');
      const hasDataVideo = content.some((part) => part.type === 'video_url');
      if (!hasText && !hasAudio && !hasDataVideo && hadImage) {
        return {
          ...message,
          content: [
            { type: 'text', text: TOOL_RESULT_MEDIA_PLACEHOLDER } as ContentPart,
            ...message.content.filter((part): part is ThinkPart => part.type === 'think'),
          ],
        };
      }
      if (content.length === message.content.length) return message;
      return { ...message, content };
    });
    const mediaUser: UserMessage = {
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_MEDIA_PROMPT }, ...media],
    };
    return { consumed: run.length, replacement: [...stripped, mediaUser] };
  },
};

const OMITTED_AUDIO_PLACEHOLDER = '(audio omitted: not supported by this provider)';
const OMITTED_VIDEO_PLACEHOLDER = '(video omitted: not supported by this provider)';

function nativeMediaUrl(
  materialized: Exclude<MaterializedMedia, { form: 'omit' }>,
): { url: string; id?: string } {
  if (materialized.form === 'inline') {
    return { url: dataUrlOf(materialized.mimeType, materialized.data) };
  }
  return materialized.id === undefined
    ? { url: materialized.url }
    : { url: materialized.url, id: materialized.id };
}

async function convertContentPart(
  part: ContentPart,
  materialize: (part: ImageURLPart | AudioURLPart | VideoURLPart) => Promise<MaterializedMedia>,
): Promise<NativePart | null> {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think':
      return null;
    case 'image_url':
    case 'audio_url':
    case 'video_url': {
      const materialized = await materialize(part);
      if (materialized.form === 'omit') return { type: 'text', text: materialized.text };
      const media = nativeMediaUrl(materialized);
      if (part.type === 'image_url') return { type: 'image_url', image_url: media };
      if (part.type === 'audio_url') return { type: 'audio_url', audio_url: media };
      return { type: 'video_url', video_url: media };
    }
  }
}

function convertToolMessageMediaText(message: Message): string {
  const text = extractText(message);
  const lines: string[] = text.length > 0 ? [text] : [];
  if (message.content.some((part) => part.type === 'audio_url')) {
    lines.push(OMITTED_AUDIO_PLACEHOLDER);
  }
  if (
    message.content.some(
      (part) => part.type === 'video_url' && part.videoUrl.url.startsWith('data:'),
    )
  ) {
    lines.push(OMITTED_VIDEO_PLACEHOLDER);
  }
  if (lines.length === 0 && message.content.some((part) => part.type === 'image_url')) {
    return TOOL_RESULT_MEDIA_PLACEHOLDER;
  }
  return lines.join('\n');
}

export interface LowerContext {
  readonly reasoningKey: string;
  readonly preserveThinking: boolean;
  readonly toolMessageConversion: ToolMessageConversion | undefined;
}

async function lowerMessage(
  message: Message,
  lower: LowerContext,
  materialize: (part: ImageURLPart | AudioURLPart | VideoURLPart) => Promise<MaterializedMedia>,
): Promise<NativeMessage[]> {
  const { reasoningKey, preserveThinking } = lower;
  let hasReasoningPart = false;
  const nonThinkParts: ContentPart[] = [];
  for (const part of message.content) {
    if (part.type === 'think') {
      hasReasoningPart = true;
    } else {
      nonThinkParts.push(part);
    }
  }
  let content: string | NativePart[] | undefined;
  if (message.role === 'tool' && lower.toolMessageConversion !== 'keep_parts') {
    content = message.content.some((part) => part.type !== 'text' && part.type !== 'think')
      ? convertToolMessageMediaText(message)
      : extractText(message);
  } else {
    const firstPart = nonThinkParts[0];
    if (nonThinkParts.length === 1 && firstPart?.type === 'text') {
      content = firstPart.text;
    } else if (nonThinkParts.length > 0) {
      const parts: NativePart[] = [];
      for (const part of nonThinkParts) {
        const native = await convertContentPart(part, materialize);
        if (native !== null) parts.push(native);
      }
      content = parts;
    }
  }
  let converted: NativeMessage;
  if (message.role === 'assistant') {
    converted = {
      role: 'assistant',
      content:
        content !== undefined
          ? content
          : hasReasoningPart && message.toolCalls.length === 0
            ? ''
            : null,
      tool_calls:
        message.toolCalls.length > 0
          ? message.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: 'function' as const,
              function: { name: toolCall.name, arguments: toolCall.arguments ?? '' },
            }))
          : undefined,
    };
  } else if (message.role === 'tool') {
    converted = { role: 'tool', tool_call_id: message.toolCallId, content: content ?? '' };
  } else {
    converted = { role: message.role, content: content ?? '' };
  }
  const reasoningDetails: Record<string, unknown>[] = [];
  const stringFields = new Map<string, string>();
  let unstamped = '';
  let hasUnstamped = false;
  for (const part of message.content) {
    if (part.type !== 'think') continue;
    if (part.detailsIndex !== undefined) {
      if (part.think.length > 0) {
        reasoningDetails.push({ type: 'summary', summary: part.think });
      }
      if (part.encrypted !== undefined) {
        reasoningDetails.push({ type: 'encrypted', encrypted: part.encrypted });
      }
      continue;
    }
    if (part.reasoningKey !== undefined && part.reasoningKey !== REASONING_DETAILS_KEY) {
      const current = stringFields.get(part.reasoningKey) ?? '';
      stringFields.set(
        part.reasoningKey,
        part.hidden === true ? current : current + part.think,
      );
      continue;
    }
    hasUnstamped = true;
    if (part.hidden !== true) {
      unstamped += part.think;
    }
  }
  if (reasoningDetails.length > 0) {
    (converted as Record<string, unknown>)[REASONING_DETAILS_KEY] = reasoningDetails;
  }
  if (hasUnstamped) {
    stringFields.set(reasoningKey, (stringFields.get(reasoningKey) ?? '') + unstamped);
  }
  for (const [key, value] of stringFields) {
    (converted as Record<string, unknown>)[key] = value;
  }
  if (
    stringFields.size === 0 &&
    reasoningDetails.length === 0 &&
    (hasReasoningPart || (preserveThinking && message.role === 'assistant'))
  ) {
    (converted as Record<string, unknown>)[reasoningKey] = '';
  }
  return [converted];
}

export function applyResponseFormat(
  kwargs: Record<string, unknown>,
  format: ResponseFormat,
): Record<string, unknown> {
  return { ...kwargs, response_format: encodeResponseFormat(format) };
}

export function encodeResponseFormat(format: ResponseFormat): Record<string, unknown> {
  if (format.type === 'json_object') {
    return { type: 'json_object' };
  }
  return {
    type: 'json_schema',
    json_schema: {
      name: format.jsonSchema.name,
      schema: format.jsonSchema.schema,
      strict: format.jsonSchema.strict,
      description: format.jsonSchema.description,
    },
  };
}

export function encodeCacheKey(cacheKey: string): Record<string, unknown> {
  return { prompt_cache_key: cacheKey };
}

export function encodeThinkHistory(): Record<string, unknown> {
  return { reasoning_effort: 'medium' };
}

const CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING = 128 * 1024;

function usesMaxCompletionTokens(model: string): boolean {
  const normalized = model.toLowerCase();
  return /^o\d(?:$|[-.])/.test(normalized) || /^gpt-5(?:$|[-.])/.test(normalized);
}

export function encodeMaxTokens(
  model: string,
  cap: number,
): Record<string, unknown> {
  const capped = Math.max(1, Math.min(cap, CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING));
  return usesMaxCompletionTokens(model)
    ? { max_completion_tokens: capped }
    : { max_tokens: capped };
}

export function defaultTool(tool: ToolDescription): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

interface BufferedStreamToolCall {
  id?: string;
  arguments: string;
  emitted: boolean;
}

function normalizeFinishReason(raw: string | null | undefined): FinishInfo {
  if (raw === null || raw === undefined) {
    return NO_FINISH;
  }
  const finishReason: FinishReason = (() => {
    switch (raw) {
      case 'stop':
        return 'completed';
      case 'tool_calls':
      case 'function_call':
        return 'tool_calls';
      case 'length':
        return 'truncated';
      case 'content_filter':
        return 'filtered';
      default:
        return 'other';
    }
  })();
  return { finishReason, rawFinishReason: raw };
}

export function parseUsage(usage: RawUsage | null | undefined): TokenUsage | undefined {
  if (usage === null || usage === undefined) {
    return undefined;
  }
  const promptTokens = usage.prompt_tokens ?? 0;
  const cached = usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputOther: promptTokens - cached,
    output: usage.completion_tokens ?? 0,
    inputCacheRead: cached,
    inputCacheCreation: 0,
    raw: usage as Record<string, unknown>,
  };
}

export interface Request {
  readonly params: OpenAI.Chat.ChatCompletionCreateParamsStreaming;
  readonly headers?: Record<string, string>;
}

export interface LoweredMessage {
  readonly source: Message;
  readonly message: NativeMessage;
}

export async function lower(
  input: FormatRequestInput,
  options: LowerContext,
): Promise<LoweredMessage[]> {
  const conversion = options.toolMessageConversion;
  const mediaPattern =
    conversion === 'extract_text'
      ? toolResultToPlainText
      : conversion === 'keep_parts'
        ? undefined
        : extractToolMedia;
  const normalized =
    mediaPattern === undefined ? input.messages : applyPatterns(input.messages, [mediaPattern]);
  const materialize = createMediaLowerer(mediaContextOf(input));
  const out: LoweredMessage[] = [];
  for (const message of normalized) {
    const natives = await lowerMessage(message, {
      reasoningKey: options.reasoningKey,
      preserveThinking: options.preserveThinking,
      toolMessageConversion: conversion,
    }, materialize);
    for (const native of natives) {
      out.push({ source: message, message: native });
    }
  }
  return out;
}

export interface AssembleParts {
  readonly messages: readonly NativeMessage[];
  readonly tools: readonly Record<string, unknown>[];
  readonly kwargs: Readonly<Record<string, unknown>>;
}

export function assemble(
  input: FormatRequestInput,
  parts: AssembleParts,
): Record<string, unknown> {
  return {
    model: input.model.model,
    messages:
      input.systemPrompt === undefined
        ? parts.messages
        : [{ role: 'system', content: input.systemPrompt }, ...parts.messages],
    tools: parts.tools.length === 0 ? undefined : parts.tools,
    stream: true,
    stream_options: { include_usage: true },
    ...parts.kwargs,
  };
}

export function encode(params: Record<string, unknown>): Request {
  return { params: params as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming };
}

export type ParserOptions = StreamParserOptions<RawChunk>;

export interface StreamFormat extends ProtocolFormat<RawChunk> {
  createStreamParser(options?: ParserOptions): StreamParser<RawChunk>;
}

export function createFormat(): StreamFormat {
  return {
    createStreamParser(options?: ParserOptions) {
      const bufferedToolCalls = new Map<number | string, BufferedStreamToolCall>();
      let seenReasoningContent = false;

      function convertStreamToolCall(
        toolCall: RawStreamToolCallDelta,
      ): StreamedMessagePart[] {
        if (toolCall.function === undefined || toolCall.function === null) {
          return [];
        }
        const streamIndex = toolCall.index;
        const functionName = toolCall.function.name;
        const functionArguments = toolCall.function.arguments;
        const hasConcreteName = typeof functionName === 'string' && functionName.length > 0;
        const hasArguments = typeof functionArguments === 'string' && functionArguments.length > 0;

        if (streamIndex === undefined) {
          if (hasConcreteName) {
            return [
              {
                type: 'function',
                id: toolCall.id ?? crypto.randomUUID(),
                name: functionName,
                arguments: functionArguments ?? null,
              },
            ];
          }
          if (hasArguments) {
            return [{ type: 'tool_call_part', argumentsPart: functionArguments }];
          }
          return [];
        }

        const buffered = bufferedToolCalls.get(streamIndex) ?? { arguments: '', emitted: false };
        if (toolCall.id !== undefined) {
          buffered.id = toolCall.id;
        }
        if (!buffered.emitted) {
          if (!hasConcreteName) {
            if (hasArguments) {
              buffered.arguments += functionArguments;
            }
            bufferedToolCalls.set(streamIndex, buffered);
            return [];
          }
          buffered.emitted = true;
          const initialArguments =
            buffered.arguments.length > 0
              ? buffered.arguments + (functionArguments ?? '')
              : (functionArguments ?? null);
          buffered.arguments = '';
          bufferedToolCalls.set(streamIndex, buffered);
          return [
            {
              type: 'function',
              id: buffered.id ?? toolCall.id ?? crypto.randomUUID(),
              name: functionName,
              arguments: initialArguments,
              _streamIndex: streamIndex,
            },
          ];
        }
        if (!hasArguments) {
          return [];
        }
        return [{ type: 'tool_call_part', argumentsPart: functionArguments, index: streamIndex }];
      }

      return (chunk, sink) => {
        if (typeof chunk.id === 'string' && chunk.id.length > 0) {
          sink.onMessageId?.(chunk.id);
        }
        const defaultUsage = parseUsage(chunk.usage);
        const usage =
          options?.resolveUsage === undefined
            ? defaultUsage
            : options.resolveUsage(chunk, defaultUsage);
        if (usage !== undefined) {
          sink.onUsage?.(usage);
        }
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
          sink.onFinish(normalizeFinishReason(choice.finish_reason));
        }
        const delta = choice?.delta;
        if (!delta) {
          return;
        }
        const reasoningDetails = extractReasoningDetails(delta);
        for (const reasoning of extractReasoningStrings(delta)) {
          if (reasoning.key === 'reasoning_content') {
            seenReasoningContent = true;
          }
          sink.onDelta({
            type: 'think',
            think: reasoning.value,
            reasoningKey: reasoning.key,
          });
        }
        if (reasoningDetails !== undefined) {
          for (const part of convertReasoningDetails(reasoningDetails, seenReasoningContent)) {
            sink.onDelta(part);
          }
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          sink.onDelta({ type: 'text', text: delta.content });
        }
        for (const toolCall of delta.tool_calls ?? []) {
          for (const part of convertStreamToolCall(toolCall)) {
            sink.onDelta(part);
          }
        }
      };
    },
  };
}

export function isInsufficientQuotaCode(code: string | null | undefined): boolean {
  return code === 'insufficient_quota';
}

export function isContextOverflowCode(code: string | null | undefined): boolean {
  return code === 'context_length_exceeded';
}

function isOpenAIInsufficientQuotaError(error: RawOpenAISDKAPIError): boolean {
  if (error.status !== 429) return false;
  if (typeof error.code === 'string' && isInsufficientQuotaCode(error.code)) return true;
  if (typeof error.type === 'string' && isInsufficientQuotaCode(error.type)) return true;
  return error.message.toLowerCase().includes('insufficient_quota');
}

export function convertError(
  error: unknown,
  classifyErrorHook?: (error: unknown) => LlmRemoteErrorMessage | undefined,
): LlmRemoteErrorMessage {
  if (isAbortError(error)) {
    return toLlmErrorMessage(error);
  }
  const hooked = classifyErrorHook?.(error);
  if (hooked !== undefined) {
    return hooked;
  }
  if (error instanceof RawOpenAISDKConnectionTimeoutError) {
    return { kind: 'timeout', message: error.message };
  }
  if (error instanceof RawOpenAISDKConnectionError) {
    return { kind: 'connection', message: error.message };
  }
  if (error instanceof RawOpenAISDKAPIError && typeof error.status === 'number') {
    const requestId = error.requestID ?? null;
    const retryAfterMs = parseRetryAfterMs(error.headers);
    const headers = headersToRecord(error.headers);
    if (isOpenAIInsufficientQuotaError(error)) {
      return {
        kind: 'quota_exhausted',
        message: sanitizeStatusErrorMessage(error.message),
        statusCode: 429,
        requestId,
        retryAfterMs,
        headers,
      };
    }
    return toLlmStatusErrorMessage({
      statusCode: error.status,
      message: error.message,
      requestId,
      retryAfterMs,
      headers,
    });
  }
  if (
    error instanceof RawOpenAISDKAPIError &&
    error.constructor === RawOpenAISDKAPIError &&
    error.error === undefined
  ) {
    return toLlmTransportErrorMessage(error.message);
  }
  if (error instanceof RawOpenAISDKError) {
    return { kind: 'provider', message: `Error: ${error.message}` };
  }
  if (error instanceof Error) {
    return toLlmTransportErrorMessage(error.message);
  }
  return { kind: 'unknown', message: String(error) };
}
