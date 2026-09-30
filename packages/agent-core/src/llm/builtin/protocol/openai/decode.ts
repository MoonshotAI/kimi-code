import {
  APIConnectionError as RawOpenAISDKConnectionError,
  APIConnectionTimeoutError as RawOpenAISDKConnectionTimeoutError,
  APIError as RawOpenAISDKAPIError,
  OpenAIError as RawOpenAISDKError,
} from 'openai';

import type { StreamedMessagePart } from '#/llm/message';
import { headersToRecord, parseRetryAfterMs } from '#/llm/protocol/kit/http';
import type { DecodeSink, StreamDecoder } from '#/llm/protocol/protocol';
import {
  sanitizeStatusErrorMessage,
  toLlmStatusErrorMessage,
  toLlmTransportErrorMessage,
} from '#/llm/protocol/rules/status';
import {
  NO_FINISH,
  type FinishInfo,
  type FinishReason,
  type LlmRemoteErrorMessage,
  type TokenUsage,
} from '#/llm/response';

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

type RawToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string } | null;
};

export type RawResponse = {
  id?: string;
  choices?: {
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: RawToolCall[];
    } | null;
    finish_reason?: string | null;
  }[];
  usage?: RawUsage | null;
};

export const KNOWN_REASONING_KEYS: readonly string[] = ['reasoning_content', 'reasoning'];

function extractReasoningStrings(
  source: unknown,
  explicitKey: string | undefined,
): { key: string; value: string }[] {
  if (typeof source !== 'object' || source === null) return [];
  const record = source as Record<string, unknown>;
  const found: { key: string; value: string }[] = [];
  for (const key of explicitKey === undefined ? KNOWN_REASONING_KEYS : [explicitKey]) {
    const value = record[key];
    if (typeof value === 'string') found.push({ key, value });
  }
  return found;
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

function parseUsage(usage: RawUsage | null | undefined): TokenUsage | undefined {
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

function decodeEnvelope(payload: RawChunk | RawResponse, sink: DecodeSink): void {
  if (typeof payload.id === 'string' && payload.id.length > 0) {
    sink.onMessageId?.(payload.id);
  }
  const usage = parseUsage(payload.usage);
  if (usage !== undefined) {
    sink.onUsage?.(usage);
  }
  const finishReason = payload.choices?.[0]?.finish_reason;
  if (finishReason !== undefined && finishReason !== null) {
    sink.onFinish(normalizeFinishReason(finishReason));
  }
}

function decodeReasoningAndText(
  source: { readonly content?: string | null },
  sink: DecodeSink,
  reasoningKey: string | undefined,
): void {
  for (const reasoning of extractReasoningStrings(source, reasoningKey)) {
    sink.onDelta({ type: 'think', think: reasoning.value, reasoningKey: reasoning.key });
  }
  if (typeof source.content === 'string' && source.content.length > 0) {
    sink.onDelta({ type: 'text', text: source.content });
  }
}

export function decodeResponse(
  response: RawResponse,
  sink: DecodeSink,
  reasoningKey?: string,
): void {
  decodeEnvelope(response, sink);
  const message = response.choices?.[0]?.message;
  if (message === undefined || message === null) {
    return;
  }
  decodeReasoningAndText(message, sink, reasoningKey);
  for (const toolCall of message.tool_calls ?? []) {
    const fn = toolCall.function;
    if ((toolCall.type !== undefined && toolCall.type !== 'function') || fn === undefined || fn === null) {
      continue;
    }
    sink.onDelta({
      type: 'function',
      id: toolCall.id || crypto.randomUUID(),
      name: fn.name ?? '',
      arguments: fn.arguments ?? null,
    });
  }
}

export function createStreamDecoder(reasoningKey?: string): StreamDecoder<RawChunk> {
  const bufferedToolCalls = new Map<number | string, BufferedStreamToolCall>();

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
    decodeEnvelope(chunk, sink);
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) {
      return;
    }
    decodeReasoningAndText(delta, sink, reasoningKey);
    for (const toolCall of delta.tool_calls ?? []) {
      for (const part of convertStreamToolCall(toolCall)) {
        sink.onDelta(part);
      }
    }
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

export function decodeError(error: unknown): LlmRemoteErrorMessage {
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
