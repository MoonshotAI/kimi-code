import type OpenAI from 'openai';

import type { LlmRemoteErrorMessage } from '#/llm/errors';
import {
  createMediaLowerer,
  dataUrlOf,
  mediaContextOf,
  type MaterializedMedia,
} from '#/llm/media/materialize';
import type { ContentPart, Message, StreamedMessagePart, ToolDescription } from '#/llm/message';
import type { ResponseFormat } from '#/llm/model';
import type {
  FormatRequestInput,
  ProtocolFormat,
  StreamParserOptions,
} from '#/llm/protocol/format';
import { NO_FINISH, type FinishInfo, type TokenUsage } from '#/llm/usage';

import { isContextOverflowCode, isInsufficientQuotaCode } from '../openai/codec';
import { convertToolResultToPlainText } from '#/llm/protocol/tool-result-text';

export type NativePart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; detail?: string; image_url: string }
  | { type: 'input_file'; file_data: string; filename: string }
  | { type: 'input_file'; file_url: string }
  | { type: 'output_text'; text: string; annotations: unknown[] };

export type NativeMessage =
  | { type: 'message'; role: string; content: NativePart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string | NativePart[] }
  | {
      type: 'reasoning';
      summary: { type: 'summary_text'; text: string }[];
      encrypted_content?: string;
    };

export type RawChunk = Record<string, unknown>;

export type RawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
};

const OMITTED_AUDIO_PLACEHOLDER = '(audio omitted: unsupported audio format)';
const OMITTED_VIDEO_PLACEHOLDER = '(video omitted: not supported by this provider)';

function imageItemFromMaterialized(
  materialized: MaterializedMedia,
  detail?: 'auto',
): NativePart {
  if (materialized.form === 'omit') return { type: 'input_text', text: materialized.text };
  const image_url =
    materialized.form === 'inline'
      ? dataUrlOf(materialized.mimeType, materialized.data)
      : materialized.url;
  return detail === undefined
    ? { type: 'input_image', image_url }
    : { type: 'input_image', detail, image_url };
}

function audioItemFromMaterialized(materialized: MaterializedMedia): NativePart {
  if (materialized.form === 'omit') return { type: 'input_text', text: materialized.text };
  if (materialized.form === 'inline') {
    return (
      mapAudioUrlToInputItem(dataUrlOf(materialized.mimeType, materialized.data)) ?? {
        type: 'input_text',
        text: OMITTED_AUDIO_PLACEHOLDER,
      }
    );
  }
  return mapAudioUrlToInputItem(materialized.url) ?? {
    type: 'input_text',
    text: OMITTED_AUDIO_PLACEHOLDER,
  };
}

async function contentPartsToInputItems(
  parts: readonly ContentPart[],
  materialize: ReturnType<typeof createMediaLowerer>,
): Promise<NativePart[]> {
  const items: NativePart[] = [];
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        if (part.text) {
          items.push({ type: 'input_text', text: part.text });
        }
        break;
      case 'image_url':
        items.push(imageItemFromMaterialized(await materialize(part), 'auto'));
        break;
      case 'audio_url':
        items.push(audioItemFromMaterialized(await materialize(part)));
        break;
      case 'video_url':
        items.push({ type: 'input_text', text: OMITTED_VIDEO_PLACEHOLDER });
        break;
      case 'think':
        break;
    }
  }
  return items;
}

function contentPartsToOutputItems(parts: readonly ContentPart[]): NativePart[] {
  const items: NativePart[] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      items.push({ type: 'output_text', text: part.text, annotations: [] });
    }
  }
  return items;
}

async function messageContentToFunctionOutputItems(
  content: readonly ContentPart[],
  materialize: ReturnType<typeof createMediaLowerer>,
): Promise<NativePart[]> {
  const items: NativePart[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        if (part.text) {
          items.push({ type: 'input_text', text: part.text });
        }
        break;
      case 'image_url':
        items.push(imageItemFromMaterialized(await materialize(part)));
        break;
      case 'audio_url':
        items.push(audioItemFromMaterialized(await materialize(part)));
        break;
      case 'video_url':
        items.push({ type: 'input_text', text: OMITTED_VIDEO_PLACEHOLDER });
        break;
      case 'think':
        break;
    }
  }
  return items;
}

function mapAudioUrlToInputItem(url: string): NativePart | null {
  if (url.startsWith('data:audio/')) {
    try {
      const parts = url.split(',', 2);
      if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return null;
      const header = parts[0];
      const b64 = parts[1];
      const subtypePart = header.split('/')[1];
      if (subtypePart === undefined) return null;
      const [subtypeHead = ''] = subtypePart.split(';');
      const subtype = subtypeHead.toLowerCase();
      const ext =
        subtype === 'mp3' || subtype === 'mpeg' ? 'mp3' : subtype === 'wav' ? 'wav' : null;
      if (ext === null) return null;
      return { type: 'input_file', file_data: b64, filename: `inline.${ext}` };
    } catch {
      return null;
    }
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return { type: 'input_file', file_url: url };
  }
  return null;
}

const OPENAI_RESPONSES_DEVELOPER_ROLE_MODELS = new Set([
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-5-codex',
  'o1',
  'o1-mini',
  'o1-pro',
  'o3',
  'o3-mini',
  'o3-pro',
  'o4-mini',
]);

function usesOpenAIResponsesDeveloperRole(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  if (OPENAI_RESPONSES_DEVELOPER_ROLE_MODELS.has(normalized)) return true;
  for (const cataloguedModel of OPENAI_RESPONSES_DEVELOPER_ROLE_MODELS) {
    if (normalized.startsWith(cataloguedModel + '-')) return true;
  }
  return false;
}

export interface LowerContext {
  readonly modelName: string;
  readonly extractText: boolean;
}

async function lowerMessage(
  message: Message,
  lower: LowerContext,
  materialize: ReturnType<typeof createMediaLowerer>,
): Promise<NativeMessage[]> {
  const { modelName, extractText } = lower;
  if (message.role === 'tool') {
    return [
      {
        call_id: message.toolCallId,
        output: extractText
          ? convertToolResultToPlainText(message)
          : await messageContentToFunctionOutputItems(message.content, materialize),
        type: 'function_call_output',
      },
    ];
  }

  let role: string = message.role;
  if (usesOpenAIResponsesDeveloperRole(modelName) && role === 'system') {
    role = 'developer';
  }
  const result: NativeMessage[] = [];

  if (message.content.length > 0) {
    const pendingParts: ContentPart[] = [];

    const flushPendingParts = async (): Promise<void> => {
      if (pendingParts.length === 0) return;
      if (role === 'assistant') {
        result.push({
          content: contentPartsToOutputItems(pendingParts),
          role,
          type: 'message',
        });
      } else {
        result.push({
          content: await contentPartsToInputItems(pendingParts, materialize),
          role,
          type: 'message',
        });
      }
      pendingParts.length = 0;
    };

    let i = 0;
    const n = message.content.length;
    while (i < n) {
      const part = message.content[i];
      if (part === undefined) break;
      if (part.type === 'think') {
        await flushPendingParts();
        const encryptedValue = part.encrypted;
        const summaries: { type: 'summary_text'; text: string }[] = [
          { type: 'summary_text', text: part.think },
        ];
        i += 1;
        while (i < n) {
          const nextPart = message.content[i];
          if (nextPart === undefined) break;
          if (nextPart.type !== 'think') break;
          if (nextPart.encrypted !== encryptedValue) break;
          summaries.push({ type: 'summary_text', text: nextPart.think });
          i += 1;
        }
        result.push({
          summary: summaries,
          type: 'reasoning',
          encrypted_content: encryptedValue,
        });
      } else {
        pendingParts.push(part);
        i += 1;
      }
    }

    await flushPendingParts();
  }

  if (message.role === 'assistant') {
    for (const toolCall of message.toolCalls) {
      result.push({
        arguments: toolCall.arguments ?? '{}',
        call_id: toolCall.id,
        name: toolCall.name,
        type: 'function_call',
      });
    }
  }

  return result;
}

type RawObject = Record<string, unknown>;

export function encodeResponseFormat(format: ResponseFormat): RawObject {
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
  if (isContextOverflowCode(code)) {
    return { kind: 'context_overflow', message: fullMessage, statusCode: 400, ...statusInfo };
  }
  if (isInsufficientQuotaCode(code)) {
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

export function defaultTool(tool: ToolDescription): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
}

export function encodeCacheKey(cacheKey: string): Record<string, unknown> {
  return { prompt_cache_key: cacheKey };
}

export function encodeMaxTokens(cap: number): Record<string, unknown> {
  return { max_output_tokens: cap };
}

export function applyResponseFormat(
  kwargs: Record<string, unknown>,
  format: ResponseFormat,
): Record<string, unknown> {
  return {
    ...kwargs,
    text: { ...asRawObject(kwargs['text']), format: encodeResponseFormat(format) },
  };
}

export function normalizeReasoning(
  kwargs: Record<string, unknown>,
): Record<string, unknown> {
  const reasoningEffort = kwargs['reasoning_effort'] as string | undefined;
  if (reasoningEffort === undefined) {
    return kwargs;
  }
  const { reasoning_effort: _dropped, ...rest } = kwargs;
  return {
    ...rest,
    reasoning: { effort: reasoningEffort, summary: 'auto' },
    include: ['reasoning.encrypted_content'],
  };
}

export function parseUsage(usage: RawObject | null | undefined): TokenUsage | undefined {
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

export interface Request {
  readonly params: OpenAI.Responses.ResponseCreateParamsStreaming;
  readonly headers?: Record<string, string>;
}

export async function lower(
  input: FormatRequestInput,
  context: Pick<LowerContext, 'extractText'>,
): Promise<NativeMessage[]> {
  const materialize = createMediaLowerer(mediaContextOf(input));
  const out: NativeMessage[] = [];
  for (const message of input.messages) {
    out.push(
      ...(await lowerMessage(
        message,
        { modelName: input.model.model, extractText: context.extractText },
        materialize,
      )),
    );
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
    instructions: input.systemPrompt ? input.systemPrompt : undefined,
    input: parts.messages,
    tools: parts.tools.length === 0 ? undefined : parts.tools,
    store: false,
    stream: true,
    ...parts.kwargs,
  };
}

export function encode(
  params: Record<string, unknown>,
): Request {
  return { params: params as unknown as OpenAI.Responses.ResponseCreateParamsStreaming };
}

export function createFormat(): ProtocolFormat {
  return {
    createStreamParser(options?: StreamParserOptions<unknown>) {
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
        const defaultUsage = parseUsage(extractEventUsage(event));
        const usage =
          options?.resolveUsage === undefined
            ? defaultUsage
            : options.resolveUsage(event, defaultUsage);
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
            sink.onFinish(
              normalizeResponsesFinish(status ?? type.slice('response.'.length), reason),
            );
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
}
