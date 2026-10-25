import type OpenAI from 'openai';
import { shake } from 'radashi';

import { extractText, type ContentPart, type Message, type ToolDescription } from '#/llm/message';
import type { LlmModelSpec, LlmSampling, ResponseFormat, ThinkingRequestOptions } from '#/llm/request';
import { ThinkingConfigError } from '#/llm/protocol/errors';
import { mediaFileIdOf, mediaUrlOf } from '#/llm/protocol/kit/media';
import { withExtras } from '#/llm/protocol/kit/params';
import type { NativeModule, PipelineSpec } from '#/llm/protocol/pipeline';
import type { LlmModule, ToolMessageConversion } from '#/llm/protocol/protocol';
import type { MediaSupport } from '#/llm/protocol/rules/media';

import { sanitizeToolCallId } from '../tool-call-id';
import type { OpenAIContentPart, OpenAIWireMessage, OpenAIWireToolCall } from './contract';
import { DEFAULT_REASONING_KEY, REASONING_DETAILS_KEY } from './decode';
import {
  openAIModelLegality,
  openAIThinkingHistoryPatterns,
  resolveOpenAIReasoningKey,
} from './legalize';
import { openAIMediaConversionPatterns, TOOL_RESULT_MEDIA_PLACEHOLDER } from './media-conversion';
import type { OpenAIOptions } from './index';

export type NativePart = OpenAIContentPart;

export type NativeToolCall = OpenAIWireToolCall;

export type NativeMessage = OpenAIWireMessage & { [extension: string]: unknown };

export type NativeTool = Readonly<Record<string, unknown>>;

export type OpenAIParams = {
  readonly prompt_cache_key?: string;
  readonly reasoning_effort?: string;
  readonly response_format?: Record<string, unknown>;
  readonly max_tokens?: number;
  readonly max_completion_tokens?: number;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly top_k?: number;
  readonly stop?: readonly string[];
  readonly seed?: number;
  readonly presence_penalty?: number;
  readonly frequency_penalty?: number;
} & Readonly<Record<string, unknown>>;

export interface Request {
  readonly params: Omit<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, 'stream'>;
}

const OMITTED_AUDIO_PLACEHOLDER = '(audio omitted: not supported by this provider)';
const OMITTED_VIDEO_PLACEHOLDER = '(video omitted: not supported by this provider)';

function convertContentPart(part: ContentPart): NativePart | null {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think':
      return null;
    case 'image_url': {
      const url = mediaUrlOf(part);
      const id = mediaFileIdOf(part);
      return {
        type: 'image_url',
        image_url: id === undefined ? { url } : { url, id },
      };
    }
    case 'audio_url': {
      const url = mediaUrlOf(part);
      const id = mediaFileIdOf(part);
      return {
        type: 'audio_url',
        audio_url: id === undefined ? { url } : { url, id },
      };
    }
    case 'video_url': {
      const url = mediaUrlOf(part);
      const id = mediaFileIdOf(part);
      return {
        type: 'video_url',
        video_url: id === undefined ? { url } : { url, id },
      };
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
      (part) => part.type === 'video_url' && mediaUrlOf(part).startsWith('data:'),
    )
  ) {
    lines.push(OMITTED_VIDEO_PLACEHOLDER);
  }
  if (lines.length === 0 && message.content.some((part) => part.type === 'image_url')) {
    return TOOL_RESULT_MEDIA_PLACEHOLDER;
  }
  return lines.join('\n');
}

export interface OpenAILowerContext {
  readonly reasoningKey: string;
  readonly preserveThinking: boolean;
  readonly toolMessageConversion: ToolMessageConversion | undefined;
}

export function lowerMessage(message: Message, lower: OpenAILowerContext): NativeMessage[] {
  const { reasoningKey, preserveThinking } = lower;
  let reasoningContent = '';
  let hasReasoningPart = false;
  const nonThinkParts: ContentPart[] = [];
  for (const part of message.content) {
    if (part.type === 'think') {
      hasReasoningPart = true;
      if (part.hidden !== true) {
        reasoningContent += part.think;
      }
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
      content = nonThinkParts
        .map((part) => convertContentPart(part))
        .filter((part): part is NativePart => part !== null);
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
  if (hasUnstamped) {
    stringFields.set(reasoningKey, (stringFields.get(reasoningKey) ?? '') + unstamped);
  }
  if (reasoningDetails.length > 0) {
    (converted as Record<string, unknown>)[REASONING_DETAILS_KEY] = reasoningDetails;
    (converted as Record<string, unknown>)[DEFAULT_REASONING_KEY] =
      stringFields.get(DEFAULT_REASONING_KEY) ?? reasoningContent;
  }
  for (const [key, value] of stringFields) {
    (converted as Record<string, unknown>)[key] = value;
  }
  if (
    stringFields.size === 0 &&
    reasoningDetails.length === 0 &&
    (hasReasoningPart || (preserveThinking && message.role === 'assistant'))
  ) {
    (converted as Record<string, unknown>)[reasoningKey] = reasoningContent;
  }
  return [converted];
}

type ThinkingResolution =
  | { readonly ok: true; readonly encode: 'silent' }
  | { readonly ok: true; readonly encode: 'effort'; readonly value: string }
  | { readonly ok: false; readonly error: ThinkingConfigError };

function effortList(efforts: readonly string[] | undefined): string | undefined {
  return efforts !== undefined && efforts.length > 0 ? efforts.join(', ') : undefined;
}

function resolveThinkingEffort(
  options: ThinkingRequestOptions,
  model: LlmModelSpec,
): ThinkingResolution {
  const effort = options.effort;
  const meta = model.thinking;
  if (effort === 'on') {
    return { ok: true, encode: 'silent' };
  }
  if (effort === 'off') {
    if (meta?.offEffort !== undefined) {
      return { ok: true, encode: 'effort', value: meta.offEffort };
    }
    if (meta?.alwaysThinking === true) {
      const list = effortList(meta.supportEfforts);
      return {
        ok: false,
        error: new ThinkingConfigError(
          'thinking-cannot-disable',
          list === undefined
            ? `Model '${model.name}' always reasons and thinking cannot be turned off. Choose a concrete thinking effort instead of 'off'.`
            : `Model '${model.name}' always reasons and thinking cannot be turned off. Choose a concrete thinking effort (${list}) instead of 'off'.`,
        ),
      };
    }
    if (meta?.supportEfforts !== undefined) {
      return {
        ok: false,
        error: new ThinkingConfigError(
          'off-needs-offeffort',
          `Model '${model.name}' reasons by default but declares no off effort, so thinking cannot be turned off. Declare offEffort (for example 'none') for this model in the model catalog configuration.`,
        ),
      };
    }
    return { ok: true, encode: 'silent' };
  }
  if (meta === undefined && model.capability?.thinking === false) {
    return {
      ok: false,
      error: new ThinkingConfigError(
        'thinking-unsupported',
        `Model '${model.name}' does not support thinking, but thinking effort '${effort}' was requested. Remove the thinking effort setting or choose a thinking-capable model.`,
      ),
    };
  }
  return { ok: true, encode: 'effort', value: effort };
}

export function resolveReasoningEffort(
  thinking: ThinkingRequestOptions,
  model: LlmModelSpec,
): string | undefined {
  const resolution = resolveThinkingEffort(thinking, model);
  if (!resolution.ok) throw resolution.error;
  return resolution.encode === 'effort' ? resolution.value : undefined;
}

type OpenAIModule = LlmModule<OpenAIOptions>;

function replaysThinkHistory(module: OpenAIModule): boolean {
  return module.content.messages.some((message) =>
    message.content.some((part) => part.type === 'think'),
  );
}

function encodeThinking(
  thinking: ThinkingRequestOptions | undefined,
  module: OpenAIModule,
): Partial<OpenAIParams> | undefined {
  const effort = thinking === undefined ? undefined : resolveReasoningEffort(thinking, module.model.spec);
  if (effort !== undefined) return { reasoning_effort: effort };
  return thinking?.effort !== 'off' && replaysThinkHistory(module)
    ? { reasoning_effort: 'medium' }
    : undefined;
}

function encodeResponseFormat(format: ResponseFormat): Record<string, unknown> {
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

const CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING = 128 * 1024;

function usesMaxCompletionTokens(model: string): boolean {
  const normalized = model.toLowerCase();
  return /^o\d(?:$|[-.])/.test(normalized) || /^gpt-5(?:$|[-.])/.test(normalized);
}

function encodeMaxTokens(cap: number, model: LlmModelSpec): Partial<OpenAIParams> {
  const capped = Math.max(1, Math.min(cap, CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING));
  return usesMaxCompletionTokens(model.name)
    ? { max_completion_tokens: capped }
    : { max_tokens: capped };
}

function defaultTool(tool: ToolDescription): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function encodeSampling(sampling: LlmSampling): Partial<OpenAIParams> {
  return shake({
    temperature: sampling.temperature,
    top_p: sampling.topP,
    top_k: sampling.topK,
    stop: sampling.stop,
    seed: sampling.seed,
    presence_penalty: sampling.presencePenalty,
    frequency_penalty: sampling.frequencyPenalty,
  });
}

function flatten(
  native: NativeModule<NativeMessage, NativeTool, OpenAIParams>,
  module: OpenAIModule,
): Request {
  const params = withExtras(
    {
      model: module.model.spec.name,
      messages: native.system
        ? [{ role: 'system', content: native.system }, ...native.messages]
        : native.messages,
      tools: native.tools.length === 0 ? undefined : native.tools,
      ...native.params,
    },
    module.options?.extras,
  );
  return { params: params as unknown as Request['params'] };
}

export const openAIChatMedia: MediaSupport = {
  kinds: {
    image: { mimes: 'any', sources: ['url', 'inline', 'file'], inToolResult: 'native' },
    audio: { mimes: 'any', sources: ['url', 'inline', 'file'], inToolResult: 'native' },
    video: { mimes: 'any', sources: ['url', 'inline', 'file'], inToolResult: 'native' },
  },
};

export const openAIPipeline: PipelineSpec<
  OpenAIOptions,
  NativeMessage,
  NativeTool,
  OpenAIParams,
  Request
> = {
  media: openAIChatMedia,
  toolCallId: { normalize: (id) => sanitizeToolCallId(id, 64), maxLength: 64 },
  patterns: (module) => openAIMediaConversionPatterns(module.options?.toolMessageConversion),
  thinkingHistory: (module) =>
    openAIThinkingHistoryPatterns(
      module.content.messages,
      module.options?.reasoningKey,
      module.options?.detectedReasoningKey,
    ),
  legality: openAIModelLegality,
  cacheKey: (key) => ({ prompt_cache_key: key }),
  thinking: encodeThinking,
  responseFormat: (params, format) => ({ ...params, response_format: encodeResponseFormat(format) }),
  maxOutputTokens: encodeMaxTokens,
  sampling: encodeSampling,
  tool: defaultTool,
  message: (message, module) => {
    const converted = lowerMessage(message, {
      reasoningKey: resolveOpenAIReasoningKey(
        module.content.messages,
        module.options?.reasoningKey,
        module.options?.detectedReasoningKey,
      ),
      preserveThinking: false,
      toolMessageConversion: module.options?.toolMessageConversion,
    });
    const [native] = converted;
    if (
      message.role === 'system' &&
      message.content.length === 0 &&
      message.tools !== undefined &&
      message.tools.length > 0 &&
      converted.length === 1 &&
      native?.role === 'system' &&
      native.content === '' &&
      !('tools' in native)
    ) {
      return [];
    }
    return converted;
  },
  flatten,
};
