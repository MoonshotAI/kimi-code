import type OpenAI from 'openai';
import { shake } from 'radashi';

import type { ContentPart, Message, ToolDescription } from '#/llm/message';
import type { LlmSampling, ResponseFormat, ThinkingRequestOptions } from '#/llm/request';
import { mediaUrlOf } from '#/llm/protocol/kit/media';
import { withExtras } from '#/llm/protocol/kit/params';
import type { NativeModule, PipelineSpec } from '#/llm/protocol/pipeline';
import type { LlmModule } from '#/llm/protocol/protocol';
import type { MediaSupport } from '#/llm/protocol/rules/media';
import { resolveReasoningEffort } from '../openai/lower';

import { sanitizeOpenAIResponsesCallId } from '../tool-call-id';
import { convertToolResultToPlainText } from '../tool-result-text';
import type { ResponsesInputContentItem, ResponsesInputItem } from './contract';
import { asRawObject } from './decode';
import { openAIResponsesModelLegality } from './legalize';
import type { OpenAIResponsesOptions } from './index';

export type NativePart = ResponsesInputContentItem;

export type NativeMessage = ResponsesInputItem;

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

const OMITTED_AUDIO_PLACEHOLDER = '(audio omitted: unsupported audio format)';
const OMITTED_VIDEO_PLACEHOLDER = '(video omitted: not supported by this provider)';

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

function contentPartsToInputItems(
  parts: readonly ContentPart[],
  detail: 'auto' | undefined,
): NativePart[] {
  const items: NativePart[] = [];
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        if (part.text) {
          items.push({ type: 'input_text', text: part.text });
        }
        break;
      case 'image_url':
        items.push(
          detail === undefined
            ? { type: 'input_image', image_url: mediaUrlOf(part) }
            : { type: 'input_image', detail, image_url: mediaUrlOf(part) },
        );
        break;
      case 'audio_url': {
        const mapped = mapAudioUrlToInputItem(mediaUrlOf(part));
        items.push(mapped ?? { type: 'input_text', text: OMITTED_AUDIO_PLACEHOLDER });
        break;
      }
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

type OpenAIResponsesModule = LlmModule<OpenAIResponsesOptions>;

function lowerMessage(message: Message, module: OpenAIResponsesModule): NativeMessage[] {
  if (message.role === 'tool') {
    return [
      {
        call_id: message.toolCallId,
        output:
          module.options?.toolMessageConversion === 'extract_text'
            ? convertToolResultToPlainText(message)
            : contentPartsToInputItems(message.content, undefined),
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

function encodeThinking(
  thinking: ThinkingRequestOptions | undefined,
  module: OpenAIResponsesModule,
): Partial<OpenAIResponsesParams> | undefined {
  if (thinking === undefined) return undefined;
  const effort = resolveReasoningEffort(thinking, module.model.spec);
  if (effort === undefined) return undefined;
  return {
    reasoning: { effort, summary: 'auto' },
    include: ['reasoning.encrypted_content'],
  };
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

function encodeSampling(sampling: LlmSampling): Partial<OpenAIResponsesParams> {
  return shake({
    temperature: sampling.temperature,
    top_p: sampling.topP,
  });
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

export const openAIResponsesMedia: MediaSupport = {
  kinds: {
    image: { mimes: 'any', sources: ['url', 'inline', 'file'], inToolResult: 'native' },
    audio: { mimes: 'any', sources: ['url', 'inline', 'file'], inToolResult: 'native' },
    video: { mimes: 'any', sources: ['url', 'inline', 'file'], inToolResult: 'native' },
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
