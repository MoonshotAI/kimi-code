import {
  APIConnectionError as RawOpenAISDKConnectionError,
  APIConnectionTimeoutError as RawOpenAISDKConnectionTimeoutError,
  APIError as RawOpenAISDKAPIError,
  OpenAIError as RawOpenAISDKError,
} from 'openai';

import type { StreamedMessagePart } from '#/llm/message';
import { headersToRecord, parseRetryAfterMs } from '#/llm/protocol/kit/http';
import type { DecodeSink, Decoder } from '#/llm/protocol/protocol';
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

export function replay(response: RawResponse): RawChunk[] {
  const { choices, ...envelope } = response;
  return [
    {
      ...envelope,
      choices: choices?.map(({ message, ...choice }) => ({
        ...choice,
        delta:
          message === undefined || message === null
            ? {}
            : {
                ...message,
                tool_calls: message.tool_calls?.flatMap((toolCall, index) =>
                  toolCall.type !== undefined && toolCall.type !== 'function'
                    ? []
                    : [{ index, id: toolCall.id, function: toolCall.function }],
                ),
              },
      })),
    },
  ];
}

export function createDecoder(sink: DecodeSink, reasoningKey?: string): Decoder<RawChunk> {
  const bufferedToolCalls = new Map<number | string, BufferedStreamToolCall>();
  const seenIndexes = new Set<number | string>();
  let lastActiveIndex: number | string | undefined;

  const closeActiveToolCall = (): void => {
    if (lastActiveIndex === undefined) return;
    if (bufferedToolCalls.get(lastActiveIndex)?.emitted === true) {
      sink.onToolCallEnd(lastActiveIndex);
    }
    lastActiveIndex = undefined;
  };

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

  return {
    push(chunk) {
      if (typeof chunk.id === 'string' && chunk.id.length > 0) {
        sink.onMessageId(chunk.id);
      }
      const usage = parseUsage(chunk.usage);
      if (usage !== undefined) {
        sink.onUsage(usage);
      }
      const delta = chunk.choices?.[0]?.delta;
      if (delta) {
        decodeReasoningAndText(delta, sink, reasoningKey);
        for (const toolCall of delta.tool_calls ?? []) {
          const streamIndex = toolCall.index;
          if (
            streamIndex !== undefined &&
            streamIndex !== lastActiveIndex &&
            !seenIndexes.has(streamIndex)
          ) {
            closeActiveToolCall();
            seenIndexes.add(streamIndex);
            lastActiveIndex = streamIndex;
          }
          for (const part of convertStreamToolCall(toolCall)) {
            sink.onDelta(part);
          }
        }
      }
      const finishReason = chunk.choices?.[0]?.finish_reason;
      if (finishReason !== undefined && finishReason !== null) {
        closeActiveToolCall();
        sink.onFinish(normalizeFinishReason(finishReason));
      }
    },
    end: closeActiveToolCall,
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
