import type OpenAI from 'openai';
import { assign, shake } from 'radashi';

import type { LlmRemoteErrorMessage } from '#/llm/errors';
import { NO_FINISH, type FinishInfo } from '#/llm/finish-reason';
import type { FormatRequestInput, ProtocolFormat, StreamParserOptions } from '#/llm/protocol/format';
import type { StreamedMessagePart, ToolDescription } from '#/llm/message';
import { applyThinking } from '#/llm/protocol/trait';
import type { ResponseFormat } from '#/llm/response-format';
import { encodeReasoningEffortFallback } from '#/llm/thinking';
import type { TokenUsage } from '#/llm/usage';

import { isContextOverflowErrorCode, isOpenAIInsufficientQuotaCode } from '../openai/format';
import { lowerMessage, type ResponsesInputItem } from './lower';

type RawObject = Record<string, unknown>;

function responseFormatToResponsesText(format: ResponseFormat): RawObject {
  if (format.type === 'json_object') {
    return { type: 'json_object' };
  }
  return {
    type: 'json_schema',
    name: format.jsonSchema.name,
    schema: format.jsonSchema.schema,
    strict: format.jsonSchema.strict,
    description: format.jsonSchema.description,
  };
}

export type { ResponsesInputContentItem, ResponsesInputItem } from './lower';

type ResponseOutputItemView =
  | {
      type: 'message';
      content: RawObject[];
    }
  | {
      type: 'function_call';
      itemId?: string;
      callId?: string;
      name?: string;
      arguments?: string | null;
    }
  | {
      type: 'reasoning';
      encryptedContent?: string;
      summary: RawObject[];
    }
  | {
      type: 'other';
    };

function asRawObject(value: unknown): RawObject | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as RawObject;
}

function readStringField(object: RawObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' ? value : undefined;
}

function hasOwn(object: RawObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function readNullableStringField(object: RawObject, key: string): string | null | undefined {
  const value = object[key];
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function readNumberField(object: RawObject, key: string): number | undefined {
  const value = object[key];
  return typeof value === 'number' ? value : undefined;
}

function readObjectField(object: RawObject, key: string): RawObject | undefined {
  return asRawObject(object[key]) ?? undefined;
}

function readObjectArrayField(object: RawObject, key: string): RawObject[] | undefined {
  const value = object[key];
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const objectItem = asRawObject(item);
    return objectItem === null ? [] : [objectItem];
  });
}

function failResponsesDecode(context: string, detail: string): never {
  throw new Error(`OpenAI Responses decode error: ${context} ${detail}`);
}

function requireStringField(object: RawObject, key: string, context: string): string {
  const value = readStringField(object, key);
  if (value === undefined) {
    failResponsesDecode(`${context}.${key}`, 'must be a string.');
  }
  return value;
}

function requireObjectField(object: RawObject, key: string, context: string): RawObject {
  const value = readObjectField(object, key);
  if (value === undefined) {
    failResponsesDecode(`${context}.${key}`, 'must be an object.');
  }
  return value;
}

function readResponseOutputItem(value: unknown, context: string): ResponseOutputItemView {
  const item = asRawObject(value);
  if (item === null) {
    failResponsesDecode(context, 'must be an object.');
  }

  const type = requireStringField(item, 'type', context);

  if (type === 'message') {
    return {
      type,
      content: readObjectArrayField(item, 'content') ?? [],
    };
  }

  if (type === 'function_call') {
    return {
      type,
      itemId: readStringField(item, 'id'),
      callId: readStringField(item, 'call_id'),
      name: readStringField(item, 'name'),
      arguments: readNullableStringField(item, 'arguments'),
    };
  }

  if (type === 'reasoning') {
    return {
      type,
      encryptedContent: readStringField(item, 'encrypted_content'),
      summary: readObjectArrayField(item, 'summary') ?? [],
    };
  }

  return { type: 'other' };
}

function responseStreamIndex(
  itemId: string | undefined,
  outputIndex: number | undefined,
): string | number | undefined {
  return itemId ?? outputIndex;
}

function formatResponseStreamIndex(streamIndex: string | number | undefined): string {
  return streamIndex === undefined ? '<unindexed>' : String(streamIndex);
}

function requireFunctionCallName(item: { name?: string }): string {
  if (item.name === undefined) {
    throw new Error('OpenAI Responses function_call item is missing a name.');
  }
  return item.name;
}

function functionCallId(callId: string | undefined): string {
  return callId === undefined || callId.length === 0 ? crypto.randomUUID() : callId;
}

function formatResponsesErrorEvent(
  code: string | null,
  message: string,
  param: string | null,
): string {
  const codeText = code ?? 'unknown';
  const paramText = param === null ? '' : ` (param: ${param})`;
  return `${codeText}: ${message}${paramText}`;
}

const EMBEDDED_STATUS_CODE_RE = /\bstatus_code\s*[:=]\s*(\d{3})\b/;

function readEmbeddedStatusCode(message: string): number | undefined {
  const match = EMBEDDED_STATUS_CODE_RE.exec(message);
  return match === null ? undefined : Number(match[1]);
}

function errorFromOpenAIResponsesEvent(
  prefix: string,
  code: string | null,
  message: string,
  param: string | null,
): LlmRemoteErrorMessage {
  const formatted = formatResponsesErrorEvent(code, message, param);
  const fullMessage = `${prefix}: ${formatted}`;
  const statusInfo = {
    requestId: null,
    retryAfterMs: null,
    headers: null,
  };
  if (isContextOverflowErrorCode(code)) {
    return { kind: 'context_overflow', message: fullMessage, statusCode: 400, ...statusInfo };
  }
  if (isOpenAIInsufficientQuotaCode(code)) {
    return { kind: 'quota_exhausted', message: fullMessage, statusCode: 429, ...statusInfo };
  }
  if (code === 'rate_limit_exceeded' || readEmbeddedStatusCode(message) === 429) {
    return { kind: 'rate_limit', message: fullMessage, statusCode: 429, ...statusInfo };
  }
  return { kind: 'provider', message: fullMessage };
}

function parseNestedGatewayStreamError(message: string):
  | {
      code: string | null;
      message: string;
      param: string | null;
    }
  | undefined {
  const marker = 'received error while streaming:';
  const markerIndex = message.indexOf(marker);
  if (markerIndex === -1) return undefined;

  const jsonText = message.slice(markerIndex + marker.length).trim();
  if (jsonText.length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }

  const error = asRawObject(parsed);
  if (error === null) return undefined;

  const nestedMessage = readStringField(error, 'message');
  if (nestedMessage === undefined) return undefined;

  return {
    code: readNullableStringField(error, 'code') ?? null,
    message: nestedMessage,
    param: readNullableStringField(error, 'param') ?? null,
  };
}

function malformedStreamErrorEvent(message: string): LlmRemoteErrorMessage {
  const nested = parseNestedGatewayStreamError(message);
  if (nested !== undefined) {
    return errorFromOpenAIResponsesEvent(
      'OpenAI Responses malformed stream error',
      nested.code,
      nested.message,
      nested.param,
    );
  }

  return errorFromOpenAIResponsesEvent(
    'OpenAI Responses malformed stream error',
    null,
    message,
    null,
  );
}

function readResponsesFailedResponseError(response: RawObject):
  | {
      code: string | null;
      message: string;
    }
  | undefined {
  const error = readObjectField(response, 'error');
  if (error !== undefined) {
    const code = readNullableStringField(error, 'code') ?? 'unknown';
    const message = readStringField(error, 'message') ?? 'no message';
    return { code, message };
  }
  return undefined;
}

function formatResponsesFailedResponse(response: RawObject): string {
  const error = readResponsesFailedResponseError(response);
  if (error !== undefined) {
    return formatResponsesErrorEvent(error.code, error.message, null);
  }

  const incompleteDetails = readObjectField(response, 'incomplete_details');
  const reason =
    incompleteDetails === undefined ? undefined : readStringField(incompleteDetails, 'reason');
  return reason === undefined
    ? 'Unknown error (no error details in response)'
    : `incomplete: ${reason}`;
}

function normalizeResponsesFinish(
  status: string | undefined,
  incompleteReason: string | undefined,
): FinishInfo {
  if (status === 'completed') {
    return { finishReason: 'completed', rawFinishReason: 'completed' };
  }
  if (status === 'incomplete') {
    if (incompleteReason === 'max_output_tokens') {
      return { finishReason: 'truncated', rawFinishReason: 'max_output_tokens' };
    }
    if (incompleteReason === 'content_filter') {
      return { finishReason: 'filtered', rawFinishReason: 'content_filter' };
    }
    return { finishReason: 'other', rawFinishReason: incompleteReason ?? 'incomplete' };
  }
  if (status === 'failed') {
    return { finishReason: 'other', rawFinishReason: 'failed' };
  }
  return NO_FINISH;
}

function defaultConvertTool(tool: ToolDescription): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
}

function parseResponsesUsage(usage: RawObject | null | undefined): TokenUsage | undefined {
  if (usage === null || usage === undefined) {
    return undefined;
  }
  const inputTokens = readNumberField(usage, 'input_tokens') ?? 0;
  const outputTokens = readNumberField(usage, 'output_tokens') ?? 0;
  const details = readObjectField(usage, 'input_tokens_details');
  const cached = details === undefined ? 0 : (readNumberField(details, 'cached_tokens') ?? 0);
  return {
    inputOther: inputTokens - cached,
    output: outputTokens,
    inputCacheRead: cached,
    inputCacheCreation: 0,
    raw: usage,
  };
}

function extractEventUsage(event: RawObject): RawObject | undefined {
  const type = readStringField(event, 'type');
  if (type === 'response.completed' || type === 'response.incomplete') {
    const response = readObjectField(event, 'response');
    return response === undefined ? undefined : readObjectField(response, 'usage');
  }
  return readObjectField(event, 'usage');
}

function resolveRequestKwargs(input: FormatRequestInput): Record<string, unknown> {
  const {
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
  if (thinking !== undefined) {
    kwargs = applyThinking(kwargs, thinking, trait, ctx, (t) =>
      encodeReasoningEffortFallback(t, ctx.model, trait?.strictThinkingValidation === true),
    ).kwargs;
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
      kwargs = { ...kwargs, max_output_tokens: cap };
    }
  }
  if (responseFormat !== undefined) {
    kwargs['text'] = {
      ...asRawObject(kwargs['text']),
      format: responseFormatToResponsesText(responseFormat),
    };
  }
  const reasoningEffort = kwargs['reasoning_effort'] as string | undefined;
  delete kwargs['reasoning_effort'];
  if (reasoningEffort !== undefined) {
    kwargs['reasoning'] = { effort: reasoningEffort, summary: 'auto' };
    kwargs['include'] = ['reasoning.encrypted_content'];
  }
  kwargs = assign(kwargs, extraParams?.responses ?? {});
  kwargs = shake(kwargs);
  return kwargs;
}

export interface OpenAIResponsesRequestParams {
  readonly params: OpenAI.Responses.ResponseCreateParamsStreaming;
  readonly headers?: Record<string, string>;
}

export const openAIResponsesFormat: ProtocolFormat<OpenAIResponsesRequestParams> = {
  formatRequest(input) {
    const { messages, systemPrompt, tools, trait, ctx } = input;
    const kwargs = resolveRequestKwargs(input);
    const inputItems = messages.flatMap((message) =>
      lowerMessage(message, {
        modelName: ctx.model.model,
        extractText: trait?.toolMessageConversion?.(ctx) === 'extract_text',
      }),
    );
    const finalInput =
      (trait?.mergeHistory?.(inputItems, ctx) as ResponsesInputItem[] | undefined) ?? inputItems;
    const createParams: Record<string, unknown> = {
      model: ctx.model.model,
      instructions: systemPrompt ? systemPrompt : undefined,
      input: finalInput,
      tools:
        tools.length === 0
          ? undefined
          : tools.map((tool) => trait?.convertTool?.(tool, ctx) ?? defaultConvertTool(tool)),
      store: false,
      stream: true,
      ...kwargs,
    };
    const finalParams = trait?.buildParams?.(createParams, ctx) ?? createParams;
    return { params: finalParams as unknown as OpenAI.Responses.ResponseCreateParamsStreaming };
  },

  createStreamParser(options?: StreamParserOptions) {
    const functionCallArgumentsByIndex = new Map<number | string, string>();
    let unindexedFunctionCallArguments: string | undefined;

    const hasFunctionCallArguments = (streamIndex: number | string | undefined): boolean =>
      streamIndex === undefined
        ? unindexedFunctionCallArguments !== undefined
        : functionCallArgumentsByIndex.has(streamIndex);

    const getFunctionCallArguments = (streamIndex: number | string | undefined): string =>
      streamIndex === undefined
        ? (unindexedFunctionCallArguments as string)
        : functionCallArgumentsByIndex.get(streamIndex)!;

    const setFunctionCallArguments = (
      streamIndex: number | string | undefined,
      argumentsValue: string,
    ): void => {
      if (streamIndex === undefined) {
        unindexedFunctionCallArguments = argumentsValue;
      } else {
        functionCallArgumentsByIndex.set(streamIndex, argumentsValue);
      }
    };

    const appendFunctionCallArguments = (
      streamIndex: number | string | undefined,
      argumentsPart: string,
      context: string,
    ): void => {
      if (!hasFunctionCallArguments(streamIndex)) {
        failResponsesDecode(
          context,
          `received function-call arguments for unknown stream index ${formatResponseStreamIndex(streamIndex)}.`,
        );
      }
      setFunctionCallArguments(streamIndex, getFunctionCallArguments(streamIndex) + argumentsPart);
    };

    const finalArgumentsSuffix = (
      streamIndex: number | string | undefined,
      finalArguments: string,
      context: string,
    ): StreamedMessagePart[] => {
      if (!hasFunctionCallArguments(streamIndex)) {
        failResponsesDecode(
          context,
          `received final function-call arguments for unknown stream index ${formatResponseStreamIndex(streamIndex)}.`,
        );
      }

      const accumulatedArguments = getFunctionCallArguments(streamIndex);
      if (finalArguments === accumulatedArguments) {
        return [];
      }

      if (!finalArguments.startsWith(accumulatedArguments)) {
        throw new Error(
          `OpenAI Responses final function-call arguments for stream index ${formatResponseStreamIndex(
            streamIndex,
          )} do not match the streamed argument deltas.`,
        );
      }

      const suffix = finalArguments.slice(accumulatedArguments.length);
      setFunctionCallArguments(streamIndex, finalArguments);
      if (suffix.length === 0) {
        return [];
      }

      return [{ type: 'tool_call_part', argumentsPart: suffix, index: streamIndex }];
    };

    return (chunk, sink) => {
      const event = asRawObject(chunk);
      if (event === null) {
        return;
      }
      const hookedUsage =
        options?.trait?.extractUsage !== undefined && options.ctx !== undefined
          ? options.trait.extractUsage(event, options.ctx)
          : undefined;
      const usage = parseResponsesUsage(
        hookedUsage !== undefined ? hookedUsage : extractEventUsage(event),
      );
      if (usage !== undefined) {
        sink.onUsage?.(usage);
      }
      const type = readStringField(event, 'type');
      if (type === undefined) {
        if (!hasOwn(event, 'type')) {
          const message = readStringField(event, 'message');
          if (message !== undefined) {
            sink.onError?.(malformedStreamErrorEvent(message));
            return;
          }
        }
        failResponsesDecode('stream event.type', 'must be a string.');
      }

      switch (type) {
        case 'response.output_text.delta':
          sink.onDelta({ type: 'text', text: requireStringField(event, 'delta', type) });
          return;
        case 'response.output_item.added': {
          const item = readResponseOutputItem(event['item'], `${type}.item`);
          const outputIndex = readNumberField(event, 'output_index');
          if (item.type !== 'function_call') {
            return;
          }
          const streamIndex = responseStreamIndex(item.itemId, outputIndex);
          setFunctionCallArguments(streamIndex, item.arguments ?? '');
          sink.onDelta({
            type: 'function',
            id: functionCallId(item.callId),
            name: requireFunctionCallName(item),
            arguments: item.arguments ?? null,
            _streamIndex: streamIndex,
          });
          return;
        }
        case 'response.output_item.done': {
          const item = readResponseOutputItem(event['item'], `${type}.item`);
          const outputIndex = readNumberField(event, 'output_index');
          if (item.type === 'reasoning') {
            sink.onDelta({ type: 'think', think: '', encrypted: item.encryptedContent });
            return;
          }
          if (item.type === 'function_call' && typeof item.arguments === 'string') {
            const streamIndex = responseStreamIndex(item.itemId, outputIndex);
            for (const part of finalArgumentsSuffix(streamIndex, item.arguments, type)) {
              sink.onDelta(part);
            }
          }
          return;
        }
        case 'response.function_call_arguments.delta': {
          const streamIndex = responseStreamIndex(
            readStringField(event, 'item_id'),
            readNumberField(event, 'output_index'),
          );
          const argumentsPart = requireStringField(event, 'delta', type);
          appendFunctionCallArguments(streamIndex, argumentsPart, type);
          sink.onDelta({ type: 'tool_call_part', argumentsPart, index: streamIndex });
          return;
        }
        case 'response.function_call_arguments.done': {
          const functionArguments = requireStringField(event, 'arguments', type);
          const streamIndex = responseStreamIndex(
            readStringField(event, 'item_id'),
            readNumberField(event, 'output_index'),
          );
          for (const part of finalArgumentsSuffix(streamIndex, functionArguments, type)) {
            sink.onDelta(part);
          }
          return;
        }
        case 'response.reasoning_summary_part.added':
          sink.onDelta({ type: 'think', think: '' });
          return;
        case 'response.reasoning_summary_text.delta':
          sink.onDelta({ type: 'think', think: requireStringField(event, 'delta', type) });
          return;
        case 'response.completed':
        case 'response.incomplete': {
          const response = readObjectField(event, 'response');
          const messageId = response === undefined ? undefined : readStringField(response, 'id');
          if (messageId !== undefined) {
            sink.onMessageId?.(messageId);
          }
          const status = response === undefined ? undefined : readStringField(response, 'status');
          const incompleteDetails =
            response === undefined ? undefined : readObjectField(response, 'incomplete_details');
          const reason =
            incompleteDetails === undefined
              ? undefined
              : readStringField(incompleteDetails, 'reason');
          sink.onFinish(normalizeResponsesFinish(status ?? type.slice('response.'.length), reason));
          return;
        }
        case 'error': {
          const message = requireStringField(event, 'message', type);
          sink.onError?.(
            errorFromOpenAIResponsesEvent(
              'OpenAI Responses stream error',
              readNullableStringField(event, 'code') ?? null,
              message,
              readNullableStringField(event, 'param') ?? null,
            ),
          );
          return;
        }
        case 'response.failed': {
          const response = requireObjectField(event, 'response', type);
          const error = readResponsesFailedResponseError(response);
          if (error !== undefined) {
            sink.onError?.(
              errorFromOpenAIResponsesEvent(
                'OpenAI Responses response.failed',
                error.code,
                error.message,
                null,
              ),
            );
            return;
          }
          sink.onError?.({
            kind: 'provider',
            message: `OpenAI Responses response.failed: ${formatResponsesFailedResponse(response)}`,
          });
          return;
        }
        default:
          return;
      }
    };
  },
};
