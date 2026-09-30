import type OpenAI from 'openai';
import { shake } from 'radashi';

import type { ContentPart, MediaSource, Message, ToolDescription } from '#/llm/message';
import { SyntaxRequestFormatError, unresolvedMediaRefError } from '#/llm/protocol/errors';
import { sanitizeToolCallId } from '#/llm/protocol/kit/ids';
import { BASELINE_IMAGE_MIMES } from '#/llm/protocol/kit/media';
import { withExtras } from '#/llm/protocol/kit/params';
import type { NativeModule, PipelineSpec } from '#/llm/protocol/pipeline';
import type { LlmModule } from '#/llm/protocol/protocol';
import type { MediaSupport } from '#/llm/protocol/rules/media';
import type { LlmSampling, ResponseFormat, ThinkingRequestOptions } from '#/llm/request';

import { resolveReasoningEffort, wireUrlOfMediaSource } from '../openai/lower';
import { asRawObject } from './decode';
import type { OpenAIResponsesOptions } from './index';
import { openAIResponsesModelLegality } from './legalize';

export type NativePart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; detail?: string; image_url: string }
  | { type: 'input_image'; detail?: string; file_id: string }
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

export type NativeTool = Readonly<Record<string, unknown>>;

export type OpenAIResponsesParams = {
  readonly prompt_cache_key?: string;
  readonly reasoning?: { readonly effort?: string; readonly summary?: string };
  readonly include?: readonly string[];
  readonly text?: Record<string, unknown>;
  readonly max_output_tokens?: number;
  readonly temperature?: number;
  readonly top_p?: number;
} & Readonly<Record<string, unknown>>;

export interface Request {
  readonly params: Omit<OpenAI.Responses.ResponseCreateParamsNonStreaming, 'stream'>;
}

function imageItemFromSource(source: MediaSource, detail?: 'auto'): NativePart {
  const reference =
    source.kind === 'file' ? { file_id: source.id } : { image_url: wireUrlOfMediaSource(source) };
  return detail === undefined
    ? { type: 'input_image', ...reference }
    : { type: 'input_image', detail, ...reference };
}

function audioItemFromSource(source: MediaSource): NativePart {
  if (source.kind === 'store') {
    throw unresolvedMediaRefError(source.ref);
  }
  if (source.kind === 'file') {
    throw new SyntaxRequestFormatError('Audio file references are not supported by OpenAI Responses.');
  }
  if (source.kind === 'inline') {
    const subtype = source.mimeType.split('/')[1]?.toLowerCase();
    return {
      type: 'input_file',
      file_data: source.data,
      filename: `inline.${subtype === 'wav' ? 'wav' : 'mp3'}`,
    };
  }
  return { type: 'input_file', file_url: source.url };
}

function inputItemOf(part: ContentPart, detail: 'auto' | undefined): NativePart | null {
  switch (part.type) {
    case 'text':
      return part.text ? { type: 'input_text', text: part.text } : null;
    case 'image_url':
      return imageItemFromSource(part.source, detail);
    case 'audio_url':
      return audioItemFromSource(part.source);
    case 'video_url':
      throw new SyntaxRequestFormatError('Video reached OpenAI Responses lowering.');
    case 'think':
      return null;
  }
}

function contentPartsToInputItems(
  parts: readonly ContentPart[],
  detail: 'auto' | undefined,
): NativePart[] {
  return parts.flatMap((part) => {
    const item = inputItemOf(part, detail);
    return item === null ? [] : [item];
  });
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

function lowerMessage(message: Message, module: OpenAIResponsesModule): NativeMessage[] {
  if (message.role === 'tool') {
    return [
      {
        call_id: message.toolCallId,
        output: contentPartsToInputItems(message.content, undefined),
        type: 'function_call_output',
      },
    ];
  }

  let role: string = message.role;
  if (usesOpenAIResponsesDeveloperRole(module.model.spec.name) && role === 'system') {
    role = 'developer';
  }
  const result: NativeMessage[] = [];

  if (message.content.length > 0) {
    const pendingParts: ContentPart[] = [];

    const flushPendingParts = (): void => {
      if (pendingParts.length === 0) return;
      if (role === 'assistant') {
        result.push({
          content: contentPartsToOutputItems(pendingParts),
          role,
          type: 'message',
        });
      } else {
        result.push({
          content: contentPartsToInputItems(pendingParts, 'auto'),
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
        flushPendingParts();
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

    flushPendingParts();
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

function encodeResponseFormat(format: ResponseFormat): Record<string, unknown> {
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

function defaultTool(tool: ToolDescription): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
}

export function sanitizeOpenAIResponsesCallId(id: string, maxLength?: number): string {
  const [callId] = id.split('|', 1);
  return sanitizeToolCallId(callId ?? id, maxLength);
}

function encodeSampling(sampling: LlmSampling): Partial<OpenAIResponsesParams> {
  return shake({
    temperature: sampling.temperature,
    top_p: sampling.topP,
  });
}

type OpenAIResponsesModule = LlmModule<OpenAIResponsesOptions>;

function encodeThinking(
  thinking: ThinkingRequestOptions | undefined,
  module: OpenAIResponsesModule,
): Partial<OpenAIResponsesParams> | undefined {
  if (thinking === undefined) return undefined;
  const effort = resolveReasoningEffort(thinking, module.model.spec);
  if (effort === undefined) return undefined;
  return { reasoning: { effort, summary: 'auto' }, include: ['reasoning.encrypted_content'] };
}

function flatten(
  native: NativeModule<NativeMessage, NativeTool, OpenAIResponsesParams>,
  module: OpenAIResponsesModule,
): Request {
  const params = withExtras(
    {
      model: module.model.spec.name,
      instructions: native.system ? native.system : undefined,
      input: native.messages,
      tools: native.tools.length === 0 ? undefined : native.tools,
      store: false,
      ...native.params,
    },
    module.options?.extras,
  );
  return { params: params as unknown as Request['params'] };
}

const RESPONSES_AUDIO_MIMES: ReadonlySet<string> = new Set(['audio/mp3', 'audio/mpeg', 'audio/wav']);

const isHttpUrl = (url: string): boolean => url.startsWith('http://') || url.startsWith('https://');

export const openAIResponsesMedia: MediaSupport = {
  kinds: {
    image: { mimes: BASELINE_IMAGE_MIMES, sources: ['inline', 'url', 'file'], inToolResult: 'native' },
    audio: { mimes: RESPONSES_AUDIO_MIMES, sources: ['inline', 'url'], url: isHttpUrl, inToolResult: 'native' },
  },
};

export const openAIResponsesPipeline: PipelineSpec<
  OpenAIResponsesOptions,
  NativeMessage,
  NativeTool,
  OpenAIResponsesParams,
  Request
> = {
  media: openAIResponsesMedia,
  toolCallId: { normalize: (id) => sanitizeOpenAIResponsesCallId(id, 64), maxLength: 64 },
  legality: openAIResponsesModelLegality,
  cacheKey: (key) => ({ prompt_cache_key: key }),
  thinking: encodeThinking,
  responseFormat: (params, format) => ({
    ...params,
    text: { ...asRawObject(params.text), format: encodeResponseFormat(format) },
  }),
  maxOutputTokens: (cap) => ({ max_output_tokens: cap }),
  sampling: encodeSampling,
  tool: defaultTool,
  message: lowerMessage,
  flatten,
};
