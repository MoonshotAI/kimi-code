import OpenAI, {
  APIConnectionError as RawOpenAISDKConnectionError,
  APIConnectionTimeoutError as RawOpenAISDKConnectionTimeoutError,
  APIError as RawOpenAISDKAPIError,
  OpenAIError as RawOpenAISDKError,
} from 'openai';
import { assign, shake } from 'radashi';

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
  FormatRequestOptions,
  ProtocolFormat,
  StreamParserOptions,
} from '#/llm/protocol/format';
import {
  type StreamedMessagePart,
  type ToolDescription,
} from '#/llm/message';
import { toolResultToPlainText } from '#/llm/protocol/patterns';
import { applyPatterns } from '#/llm/protocol/rewrite';
import { applyThinking } from '#/llm/protocol/trait';
import type { ResponseFormat } from '#/llm/response-format';
import { encodeReasoningEffortFallback } from '#/llm/thinking';
import type { TokenUsage } from '#/llm/usage';

import { lowerMessage, type OpenAIWireMessage } from './lower';
import { extractToolMedia } from './patterns';
import { DEFAULT_REASONING_KEY, extractReasoning } from './reasoning-key';

function responseFormatToOpenAI(format: ResponseFormat): Record<string, unknown> {
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

export type { OpenAIContentPart, OpenAIWireMessage, OpenAIWireToolCall } from './lower';

type RawUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
};

interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: string } | null;
}

interface RawResponseMessage {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: RawToolCall[];
}

interface RawStreamToolCallDelta {
  index?: number | string;
  id?: string;
  function?: { name?: string; arguments?: string } | null;
}

interface BufferedStreamToolCall {
  id?: string;
  arguments: string;
  emitted: boolean;
}

type RawChunk = {
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

type RawResponse = {
  choices?: { message?: RawResponseMessage }[];
  usage?: RawUsage | null;
};

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

function parseRawUsage(usage: RawUsage | null | undefined): TokenUsage | undefined {
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

const CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING = 128 * 1024;

function usesMaxCompletionTokens(model: string): boolean {
  const normalized = model.toLowerCase();
  return /^o\d(?:$|[-.])/.test(normalized) || /^gpt-5(?:$|[-.])/.test(normalized);
}

function completionTokenKwargs(
  model: string,
  maxCompletionTokens: number,
): Record<string, unknown> {
  return usesMaxCompletionTokens(model)
    ? { max_completion_tokens: maxCompletionTokens }
    : { max_tokens: maxCompletionTokens };
}

interface ResolvedRequestKwargs {
  kwargs: Record<string, unknown>;
  preserveThinking: boolean;
}

function resolveRequestKwargs(input: FormatRequestInput): ResolvedRequestKwargs {
  const {
    messages,
    trait,
    ctx,
    cacheKey,
    thinking,
    responseFormat,
    maxCompletionTokens,
    usedContextTokens,
    maxContextTokens,
    extraParams,
  } = input;
  let kwargs: Record<string, unknown> = {};
  if (cacheKey !== undefined) {
    kwargs = trait?.cacheKey?.(cacheKey, ctx) ?? { prompt_cache_key: cacheKey };
  }
  let preserveThinking = false;
  if (thinking !== undefined) {
    const applied = applyThinking(kwargs, thinking, trait, ctx, (t) =>
      encodeReasoningEffortFallback(t, ctx.model, trait?.strictThinkingValidation === true),
    );
    kwargs = applied.kwargs;
    preserveThinking = applied.preserveThinking;
  }
  if (
    trait?.withThinking === undefined &&
    thinking?.effort !== 'off' &&
    kwargs['reasoning_effort'] === undefined &&
    messages.some((message) => message.content.some((part) => part.type === 'think'))
  ) {
    kwargs = { ...kwargs, reasoning_effort: 'medium' };
  }
  if (responseFormat !== undefined) {
    kwargs = { ...kwargs, response_format: responseFormatToOpenAI(responseFormat) };
  }
  if (maxCompletionTokens !== undefined) {
    let cap = maxCompletionTokens;
    if (
      usedContextTokens !== undefined &&
      maxContextTokens !== undefined &&
      maxContextTokens > 0
    ) {
      cap = Math.min(cap, maxContextTokens - usedContextTokens);
    }
    cap = Math.max(1, cap);
    const hooked = trait?.withMaxCompletionTokens?.(cap, ctx);
    if (hooked !== undefined) {
      kwargs = { ...kwargs, ...hooked };
    } else {
      const capped = Math.min(cap, CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING);
      kwargs = { ...kwargs, ...completionTokenKwargs(ctx.model.model, Math.max(1, capped)) };
    }
  }
  kwargs = assign(kwargs, extraParams?.openai ?? {});
  kwargs = shake(kwargs);
  return { kwargs, preserveThinking };
}

export interface OpenAIRequestParams {
  readonly params: OpenAI.Chat.ChatCompletionCreateParamsStreaming;
  readonly headers?: Record<string, string>;
}

export const openAIFormat: ProtocolFormat<OpenAIRequestParams, RawResponse, RawChunk> = {
  formatRequest(input, options?: FormatRequestOptions) {
    const { messages, systemPrompt, tools, trait, ctx } = input;
    const reasoningKey = options?.reasoningKey ?? DEFAULT_REASONING_KEY;
    const { kwargs, preserveThinking } = resolveRequestKwargs(input);

    const conversion = trait?.toolMessageConversion?.(ctx);
    const mediaPattern =
      conversion === 'extract_text'
        ? toolResultToPlainText
        : conversion === 'keep_parts'
          ? undefined
          : extractToolMedia;
    const normalized =
      mediaPattern === undefined ? messages : applyPatterns(messages, [mediaPattern]);
    const converted: OpenAIWireMessage[] = [];
    if (systemPrompt) {
      converted.push({ role: 'system', content: systemPrompt });
    }
    for (const message of normalized) {
      converted.push(...lowerMessage(message, { trait, ctx, reasoningKey, preserveThinking }));
    }
    const finalMessages =
      (trait?.mergeHistory?.(converted, ctx) as OpenAIWireMessage[] | undefined) ?? converted;
    const createParams: Record<string, unknown> = {
      model: ctx.model.model,
      messages: finalMessages,
      tools:
        tools.length === 0
          ? undefined
          : tools.map((tool) => trait?.convertTool?.(tool, ctx) ?? defaultConvertTool(tool)),
      stream: true,
      stream_options: { include_usage: true },
      ...kwargs,
    };
    const finalParams = trait?.buildParams?.(createParams, ctx) ?? createParams;
    return { params: finalParams as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming };
  },

  createStreamParser(options?: StreamParserOptions) {
    const bufferedToolCalls = new Map<number | string, BufferedStreamToolCall>();

    function convertStreamToolCall(toolCall: RawStreamToolCallDelta): StreamedMessagePart[] {
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
      const hooked =
        options?.trait?.extractUsage !== undefined && options.ctx !== undefined
          ? options.trait.extractUsage(chunk as Record<string, unknown>, options.ctx)
          : undefined;
      const usage = parseRawUsage(
        (hooked !== undefined ? hooked : chunk.usage) as RawUsage | null | undefined,
      );
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
      const reasoning = extractReasoning(delta);
      if (reasoning !== undefined) {
        sink.onDelta({ type: 'think', think: reasoning.value });
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

function defaultConvertTool(tool: ToolDescription): Record<string, unknown> {
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
