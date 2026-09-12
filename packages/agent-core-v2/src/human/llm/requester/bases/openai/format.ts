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
import { NO_FINISH, type FinishInfo, type FinishReason } from '#/llm/finish-reason';
import type {
  FormatRequestInput,
  ProtocolFormat,
  StreamParser,
  StreamParserOptions,
} from '#/llm/protocol/format';
import { type Message, type StreamedMessagePart, type ToolDescription } from '#/llm/message';
import { toolResultToPlainText } from '#/llm/protocol/patterns';
import { applyPatterns } from '#/llm/protocol/rewrite';
import type { ToolMessageConversion } from '#/llm/requester/requester';
import type { ResponseFormat } from '#/llm/response-format';
import type { TokenUsage } from '#/llm/usage';

import type {
  OpenAIRawChunk,
  OpenAIRawStreamToolCallDelta,
  OpenAIRawUsage,
  OpenAIWireMessage,
} from './contract';
import { lowerMessage } from './lower';
import { extractToolMedia } from './patterns';
import {
  convertReasoningDetails,
  extractReasoning,
  extractReasoningDetails,
} from './reasoning-key';
import { isOfficialOpenAIBaseUrl } from '../openai-base-url';

export function responseFormatToOpenAI(format: ResponseFormat): Record<string, unknown> {
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

export function encodeOpenAICacheKey(
  cacheKey: string,
  baseUrl?: string,
): Record<string, unknown> {
  return isOfficialOpenAIBaseUrl(baseUrl) ? { prompt_cache_key: cacheKey } : {};
}

export function encodeOpenAIThinkHistoryKwargs(): Record<string, unknown> {
  return { reasoning_effort: 'medium' };
}

const CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING = 128 * 1024;

function usesMaxCompletionTokens(model: string): boolean {
  const normalized = model.toLowerCase();
  return /^o\d(?:$|[-.])/.test(normalized) || /^gpt-5(?:$|[-.])/.test(normalized);
}

export function encodeOpenAIMaxCompletionTokens(
  model: string,
  cap: number,
): Record<string, unknown> {
  const capped = Math.max(1, Math.min(cap, CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING));
  return usesMaxCompletionTokens(model)
    ? { max_completion_tokens: capped }
    : { max_tokens: capped };
}

export function defaultOpenAITool(tool: ToolDescription): Record<string, unknown> {
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

export function parseOpenAIUsage(usage: OpenAIRawUsage | null | undefined): TokenUsage | undefined {
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

export interface OpenAIRequestParams {
  readonly params: OpenAI.Chat.ChatCompletionCreateParamsStreaming;
  readonly headers?: Record<string, string>;
}

export interface OpenAILowerOptions {
  readonly reasoningKey: string;
  readonly preserveThinking: boolean;
  readonly toolMessageConversion: ToolMessageConversion | undefined;
}

export interface OpenAILoweredMessage {
  readonly source: Message;
  readonly message: OpenAIWireMessage;
}

export function lowerOpenAIRequest(
  input: FormatRequestInput,
  options: OpenAILowerOptions,
): OpenAILoweredMessage[] {
  const conversion = options.toolMessageConversion;
  const mediaPattern =
    conversion === 'extract_text'
      ? toolResultToPlainText
      : conversion === 'keep_parts'
        ? undefined
        : extractToolMedia;
  const normalized =
    mediaPattern === undefined ? input.messages : applyPatterns(input.messages, [mediaPattern]);
  return normalized.flatMap((message) =>
    lowerMessage(message, {
      reasoningKey: options.reasoningKey,
      preserveThinking: options.preserveThinking,
      toolMessageConversion: conversion,
    }).map((wire) => ({ source: message, message: wire })),
  );
}

export interface OpenAIRequestParts {
  readonly messages: readonly OpenAIWireMessage[];
  readonly tools: readonly Record<string, unknown>[];
  readonly kwargs: Readonly<Record<string, unknown>>;
}

export function assembleOpenAIRequest(
  input: FormatRequestInput,
  parts: OpenAIRequestParts,
): Record<string, unknown> {
  return {
    model: input.model.model,
    messages: parts.messages,
    tools: parts.tools.length === 0 ? undefined : parts.tools,
    stream: true,
    stream_options: { include_usage: true },
    ...parts.kwargs,
  };
}

export function encodeOpenAIRequest(params: Record<string, unknown>): OpenAIRequestParams {
  return { params: params as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming };
}

export interface OpenAIStreamParserOptions extends StreamParserOptions<OpenAIRawChunk> {
  readonly reasoningKey?: string;
}

export interface OpenAIProtocolFormat extends ProtocolFormat<OpenAIRawChunk> {
  createStreamParser(options?: OpenAIStreamParserOptions): StreamParser<OpenAIRawChunk>;
}

export function createOpenAIFormat(): OpenAIProtocolFormat {
  return {
    createStreamParser(options?: OpenAIStreamParserOptions) {
      const bufferedToolCalls = new Map<number | string, BufferedStreamToolCall>();

      function convertStreamToolCall(
        toolCall: OpenAIRawStreamToolCallDelta,
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
        const defaultUsage = parseOpenAIUsage(chunk.usage);
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
        const reasoningDetails =
          options?.reasoningKey === undefined ? extractReasoningDetails(delta) : undefined;
        if (reasoningDetails !== undefined) {
          for (const part of convertReasoningDetails(reasoningDetails)) {
            sink.onDelta(part);
          }
        } else {
          const reasoning = extractReasoning(delta);
          if (reasoning !== undefined) {
            sink.onDelta({ type: 'think', think: reasoning.value });
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

export function isOpenAIInsufficientQuotaCode(code: string | null | undefined): boolean {
  return code === 'insufficient_quota';
}

export function isContextOverflowErrorCode(code: string | null | undefined): boolean {
  return code === 'context_length_exceeded';
}

function isOpenAIInsufficientQuotaError(error: RawOpenAISDKAPIError): boolean {
  if (error.status !== 429) return false;
  if (typeof error.code === 'string' && isOpenAIInsufficientQuotaCode(error.code)) return true;
  if (typeof error.type === 'string' && isOpenAIInsufficientQuotaCode(error.type)) return true;
  return error.message.toLowerCase().includes('insufficient_quota');
}

export function convertOpenAIError(
  error: unknown,
  convertErrorHook?: (error: unknown) => LlmRemoteErrorMessage | undefined,
): LlmRemoteErrorMessage {
  if (isAbortError(error)) {
    return toLlmErrorMessage(error);
  }
  const hooked = convertErrorHook?.(error);
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
