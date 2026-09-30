import type OpenAI from 'openai';
import { shake } from 'radashi';

import type { ContentPart, MediaSource, Message, ToolDescription } from '#/llm/message';
import { SyntaxRequestFormatError, ThinkingConfigError, unresolvedMediaRefError } from '#/llm/protocol/errors';
import { sanitizeToolCallId } from '#/llm/protocol/kit/ids';
import { BASELINE_IMAGE_MIMES } from '#/llm/protocol/kit/media';
import { withExtras } from '#/llm/protocol/kit/params';
import type { NativeModule, PipelineSpec } from '#/llm/protocol/pipeline';
import type { LlmModule } from '#/llm/protocol/protocol';
import type { MediaSupport } from '#/llm/protocol/rules/media';
import type {
  LlmModelSpec,
  LlmSampling,
  ResponseFormat,
  ThinkingRequestOptions,
} from '#/llm/request';

import { KNOWN_REASONING_KEYS } from './decode';
import type { OpenAIOptions } from './index';
import { openAIModelLegality, openAIThinkingHistoryPatterns } from './legalize';

export type NativePart = {
  type: 'text' | 'image_url' | 'audio_url' | 'video_url' | 'file';
  text?: string | undefined;
  file_id?: string | undefined;
  image_url?: { url: string } | undefined;
  audio_url?: { url: string } | undefined;
  video_url?: { url: string } | undefined;
};

export type NativeToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type NativeMessage = (
  | { role: 'system' | 'user'; content: string | NativePart[] }
  | {
      role: 'assistant';
      content?: string | NativePart[] | null;
      tool_calls?: NativeToolCall[];
    }
  | { role: 'tool'; tool_call_id: string; content: string | NativePart[] }
) & { [extension: string]: unknown };

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

function dataUrlOf(mimeType: string, data: string): string {
  return `data:${mimeType};base64,${data}`;
}

export function wireUrlOfMediaSource(source: MediaSource): string {
  switch (source.kind) {
    case 'url':
      return source.url;
    case 'inline':
      return dataUrlOf(source.mimeType, source.data);
    case 'store':
      throw unresolvedMediaRefError(source.ref);
    case 'file':
      throw new SyntaxRequestFormatError('Only image file references are supported by chat completions.');
  }
}

function convertContentPart(part: ContentPart): NativePart | null {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think':
      return null;
    case 'image_url':
      return part.source.kind === 'file'
        ? { type: 'file', file_id: part.source.id }
        : { type: 'image_url', image_url: { url: wireUrlOfMediaSource(part.source) } };
    case 'audio_url':
      return { type: 'audio_url', audio_url: { url: wireUrlOfMediaSource(part.source) } };
    case 'video_url':
      return { type: 'video_url', video_url: { url: wireUrlOfMediaSource(part.source) } };
  }
}

function lowerMessage(message: Message): NativeMessage[] {
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
  const textOnly = nonThinkParts.every((part) => part.type === 'text');
  if (nonThinkParts.length > 0 && textOnly && (message.role === 'tool' || nonThinkParts.length === 1)) {
    content = nonThinkParts.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  } else if (nonThinkParts.length > 0) {
    const parts: NativePart[] = [];
    for (const part of nonThinkParts) {
      const native = convertContentPart(part);
      if (native !== null) parts.push(native);
    }
    content = parts;
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
  const stringFields = new Map<string, string>();
  for (const part of message.content) {
    if (part.type !== 'think') continue;
    const key = part.reasoningKey ?? KNOWN_REASONING_KEYS[0]!;
    const current = stringFields.get(key) ?? '';
    stringFields.set(key, part.hidden === true ? current : current + part.think);
  }
  for (const [key, value] of stringFields) {
    (converted as Record<string, unknown>)[key] = value;
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

type OpenAIModule = LlmModule<OpenAIOptions>;

function replaysThinkHistory(module: OpenAIModule): boolean {
  return (
    module.model.thinking?.effort !== 'off' &&
    module.content.messages.some((message) => message.content.some((part) => part.type === 'think'))
  );
}

function encodeThinking(
  thinking: ThinkingRequestOptions | undefined,
  module: OpenAIModule,
): Partial<OpenAIParams> | undefined {
  const effort =
    thinking === undefined ? undefined : resolveReasoningEffort(thinking, module.model.spec);
  if (effort !== undefined) return { reasoning_effort: effort };
  return replaysThinkHistory(module) ? { reasoning_effort: 'medium' } : undefined;
}

function flatten(
  native: NativeModule<NativeMessage, NativeTool, OpenAIParams>,
  module: OpenAIModule,
): Request {
  const { extra_body: extraBody, ...extras } = module.options?.extras ?? {};
  const params = withExtras(
    {
      model: module.model.spec.name,
      messages:
        native.system === undefined
          ? native.messages
          : [{ role: 'system', content: native.system }, ...native.messages],
      tools: native.tools.length === 0 ? undefined : native.tools,
      ...native.params,
    },
    { ...extras, ...extraBody },
  );
  return { params: params as unknown as Request['params'] };
}

export const openAIChatMedia: MediaSupport = {
  kinds: {
    image: { mimes: BASELINE_IMAGE_MIMES, sources: ['inline', 'url'], inToolResult: 'relocate' },
    audio: { mimes: 'any', sources: ['inline', 'url'], inToolResult: 'unsupported' },
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
  thinkingHistory: (module) =>
    openAIThinkingHistoryPatterns(module.content.messages, module.options?.reasoningKey),
  legality: openAIModelLegality,
  cacheKey: (key) => ({ prompt_cache_key: key }),
  thinking: encodeThinking,
  responseFormat: (params, format) => ({ ...params, response_format: encodeResponseFormat(format) }),
  maxOutputTokens: encodeMaxTokens,
  sampling: encodeSampling,
  tool: defaultTool,
  message: lowerMessage,
  flatten,
};
