import type Anthropic from '@anthropic-ai/sdk';
import { shake } from 'radashi';

import { mediaUrlOf, providerImagePolicy } from '#/llm/protocol/kit/media';
import type { Message, TextPart, ToolDescription } from '#/llm/message';
import type { LlmModelSpec, LlmSampling, ResponseFormat, ThinkingEffort, ThinkingRequestOptions } from '#/llm/request';
import { SyntaxRequestFormatError, ThinkingConfigError } from '#/llm/protocol/errors';
import { withExtras } from '#/llm/protocol/kit/params';
import { mergeConsecutiveUsers } from '#/llm/protocol/patterns';
import type { NativeModule, PipelineSpec } from '#/llm/protocol/pipeline';
import type { LlmModule } from '#/llm/protocol/protocol';
import type { Pattern } from '#/llm/protocol/pattern';
import type { MediaSupport } from '#/llm/protocol/rules/media';

import { sanitizeToolCallId } from '../tool-call-id';
import { CONTEXT_MANAGEMENT_BETA } from './contract';
import type { AnthropicWireContentBlock, AnthropicWireMessage } from './contract';
import {
  anthropicModelLegality,
  anthropicPatterns,
  anthropicThinkingHistoryPatterns,
  resolveDefaultMaxTokens,
  resolveThinkingProfile,
} from './legalize';
import type { AnthropicOptions } from './index';

const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';

export type NativePart = AnthropicWireContentBlock;

export type NativeMessage = AnthropicWireMessage;

export type NativeTool = Readonly<Record<string, unknown>>;

export type AnthropicParams = {
  readonly thinking?: Record<string, unknown>;
  readonly output_config?: Record<string, unknown>;
  readonly max_tokens?: number;
  readonly metadata?: { readonly user_id: string };
  readonly context_management?: {
    readonly edits?: readonly { readonly type: string; readonly keep?: string }[];
  };
  readonly betaFeatures?: readonly string[];
  readonly temperature?: number;
  readonly top_p?: number;
  readonly top_k?: number;
  readonly stop_sequences?: readonly string[];
} & Readonly<Record<string, unknown>>;

export interface Request {
  readonly params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'stream'>;
  readonly betas: readonly string[];
  readonly useBetaApi: boolean;
}

type AnthropicNativeModule = NativeModule<NativeMessage, NativeTool, AnthropicParams>;
type AnthropicModule = LlmModule<AnthropicOptions>;

const DEFAULT_ACCEPTED_IMAGE_MIMES = providerImagePolicy().acceptedMimes;

const SUPPORTED_B64_VIDEO_TYPES: ReadonlySet<string> = new Set([
  'video/mp4',
  'video/mpeg',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
  'video/x-flv',
  'video/3gpp',
]);

type AnthropicWireImageBlock = Extract<AnthropicWireContentBlock, { type: 'image' }>;

type AnthropicWireVideoBlock = Extract<AnthropicWireContentBlock, { type: 'video' }>;

function imageUrlPartToAnthropic(url: string, acceptedMimes: ReadonlySet<string>): AnthropicWireImageBlock {
  if (url.startsWith('data:')) {
    const withoutScheme = url.slice(5);
    const parts = withoutScheme.split(';base64,', 2);
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new SyntaxRequestFormatError(`Invalid data URL for image: ${url}`);
    }
    const mediaType = parts[0];
    const data = parts[1];
    if (!acceptedMimes.has(mediaType)) {
      throw new SyntaxRequestFormatError(
        `Unsupported media type for base64 image: ${mediaType}, url: ${url}`,
      );
    }
    return {
      type: 'image',
      source: { type: 'base64', data, media_type: mediaType },
    };
  }
  return {
    type: 'image',
    source: { type: 'url', url },
  };
}

function videoUrlPartToAnthropic(url: string): AnthropicWireVideoBlock {
  if (url.startsWith('data:')) {
    const withoutScheme = url.slice(5);
    const parts = withoutScheme.split(';base64,', 2);
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new SyntaxRequestFormatError(`Invalid data URL for video: ${url}`);
    }
    const mediaType = parts[0];
    const data = parts[1];
    if (!SUPPORTED_B64_VIDEO_TYPES.has(mediaType)) {
      throw new SyntaxRequestFormatError(
        `Unsupported media type for base64 video: ${mediaType}, url: ${url}`,
      );
    }
    return {
      type: 'video',
      source: { type: 'base64', media_type: mediaType, data },
    };
  }

  return {
    type: 'video',
    source: { type: 'url', url },
  };
}

function parseToolArguments(args: string | null): unknown {
  if (args === null || args.trim() === '') {
    return {};
  }
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

function messageContent(message: NativeMessage): NativePart[] {
  return Array.isArray(message.content) ? message.content : [];
}

function isEmpty(message: NativeMessage): boolean {
  return messageContent(message).length === 0;
}

export function lowerMessage(
  message: Message,
  acceptedMimes: ReadonlySet<string> = DEFAULT_ACCEPTED_IMAGE_MIMES,
): NativeMessage[] {
  const content: NativePart[] = [];
  if (message.role === 'system') {
    const text = message.content
      .filter((part): part is TextPart => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    content.push({ type: 'text', text: `<system>${text}</system>` });
  } else if (message.role === 'tool') {
    const blocks: NativePart[] = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        if (part.text) {
          blocks.push({ type: 'text', text: part.text });
        }
      } else if (part.type === 'image_url') {
        blocks.push(imageUrlPartToAnthropic(mediaUrlOf(part), acceptedMimes));
      } else if (part.type === 'video_url') {
        blocks.push(videoUrlPartToAnthropic(mediaUrlOf(part)));
      }
    }
    content.push({
      type: 'tool_result',
      tool_use_id: message.toolCallId,
      content: blocks,
    });
  } else {
    for (const part of message.content) {
      if (part.type === 'think') {
        if (part.encrypted !== undefined) {
          content.push({ type: 'thinking', thinking: part.think, signature: part.encrypted });
        } else {
          content.push({ type: 'thinking', thinking: part.think });
        }
      } else if (part.type === 'text') {
        content.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        content.push(imageUrlPartToAnthropic(mediaUrlOf(part), acceptedMimes));
      } else if (part.type === 'video_url') {
        content.push(videoUrlPartToAnthropic(mediaUrlOf(part)));
      }
    }
    if (message.role === 'assistant') {
      for (const toolCall of message.toolCalls) {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: parseToolArguments(toolCall.arguments),
        });
      }
    }
  }
  const converted: NativeMessage = {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content,
  };
  return [converted];
}

const CLEAR_THINKING_EDIT = 'clear_thinking_20251015';

const CACHE_CONTROL = { type: 'ephemeral' as const };

const CACHEABLE_TYPES: ReadonlySet<string> = new Set([
  'text',
  'image',
  'document',
  'search_result',
  'tool_use',
  'tool_result',
  'server_tool_use',
  'web_search_tool_result',
]);

function annotateCache(module: AnthropicNativeModule): AnthropicNativeModule {
  const messages = [...module.messages];
  const lastMessage = messages.at(-1);
  const content = lastMessage === undefined ? [] : messageContent(lastMessage);
  const lastBlock = content.at(-1);
  if (lastMessage !== undefined && lastBlock !== undefined && CACHEABLE_TYPES.has(lastBlock.type)) {
    messages[messages.length - 1] = {
      ...lastMessage,
      content: [...content.slice(0, -1), { ...lastBlock, cache_control: CACHE_CONTROL }],
    };
  }
  const tools = module.tools.map((tool, index) =>
    index === module.tools.length - 1 ? { ...tool, cache_control: CACHE_CONTROL } : tool,
  );
  return { ...module, messages, tools };
}

function isToolResultOnly(message: NativeMessage): boolean {
  if (message.role !== 'user') return false;
  const content = messageContent(message);
  if (content.length === 0) return false;
  return content.every((block) => block.type === 'tool_result');
}

function applyResponseFormat(params: AnthropicParams, format: ResponseFormat): AnthropicParams {
  if (format.type !== 'json_schema') return params;
  return {
    ...params,
    output_config: {
      ...params.output_config,
      format: { type: 'json_schema', schema: format.jsonSchema.schema },
    },
  };
}

function applyThinkingKeep(params: AnthropicParams, keep: string): AnthropicParams {
  const betaFeatures = params.betaFeatures ?? [];
  return {
    ...params,
    betaFeatures: betaFeatures.includes(CONTEXT_MANAGEMENT_BETA)
      ? betaFeatures
      : [...betaFeatures, CONTEXT_MANAGEMENT_BETA],
    context_management: {
      edits: [
        { type: CLEAR_THINKING_EDIT, keep },
        ...(params.context_management?.edits ?? []).filter(
          (edit) => edit.type !== CLEAR_THINKING_EDIT,
        ),
      ],
    },
  };
}

function defaultTool(tool: ToolDescription): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

const dropEmptyMessages: Pattern<NativeMessage> = {
  name: 'dropEmptyMessages',
  rewrite(items, index) {
    const message = items[index];
    return message !== undefined && isEmpty(message) ? { consumed: 1, replacement: [] } : null;
  },
};

const mergeTurnPatterns: readonly Pattern<NativeMessage>[] = [
  dropEmptyMessages,
  mergeConsecutiveUsers({
    isUser: (message) => message.role === 'user',
    isToolResultOnly,
    merge: (last, next) => ({
      ...last,
      content: [...messageContent(last), ...messageContent(next)],
    }),
  }),
];

function encodeSampling(sampling: LlmSampling): Partial<AnthropicParams> {
  return shake({
    temperature: sampling.temperature,
    top_p: sampling.topP,
    top_k: sampling.topK,
    stop_sequences: sampling.stop,
  });
}

function budgetTokensForEffort(effort: ThinkingEffort): number | undefined {
  if (effort === 'low') return 1024;
  if (effort === 'medium') return 4096;
  if (effort === 'on' || effort === 'high') return 32_000;
  return undefined;
}

function encodeThinkingParams(
  thinking: ThinkingRequestOptions,
  spec: LlmModelSpec,
): Partial<AnthropicParams> | undefined {
  const profile = resolveThinkingProfile(spec);
  const effort = thinking.effort;
  if (effort === 'off') {
    if (!profile.canDisableThinking) {
      throw new ThinkingConfigError(
        'thinking-cannot-disable',
        `Model '${spec.name}' always reasons and thinking cannot be turned off. Choose a concrete thinking effort (${profile.efforts.join(', ')}) instead of 'off'.`,
      );
    }
    return {
      thinking: { type: 'disabled' },
      betaFeatures: profile.mode === 'adaptive' ? [] : undefined,
    };
  }
  if (profile.mode === 'adaptive') {
    return {
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: effort === 'on' ? undefined : { effort },
      betaFeatures: [],
    };
  }
  const budgetTokens = budgetTokensForEffort(effort);
  const thinkingParam =
    budgetTokens === undefined
      ? { type: 'enabled' }
      : { type: 'enabled', budget_tokens: budgetTokens };
  return (profile.supportsEffortParam || budgetTokens === undefined) && effort !== 'on'
    ? { thinking: thinkingParam, output_config: { effort } }
    : { thinking: thinkingParam };
}

function finalizeParams(
  module: AnthropicNativeModule,
  llm: AnthropicModule,
): AnthropicNativeModule {
  const params =
    module.params.betaFeatures === undefined
      ? { ...module.params, betaFeatures: [INTERLEAVED_THINKING_BETA] }
      : module.params;
  const keep = llm.model.thinking?.keep;
  return { ...module, params: keep === undefined ? params : applyThinkingKeep(params, keep) };
}

function flatten(native: AnthropicNativeModule, module: AnthropicModule): Request {
  const { betaFeatures, ...rest } = native.params;
  const betas: readonly string[] = Array.isArray(betaFeatures) ? betaFeatures : [];
  const useBetaApi =
    module.options?.betaApi === true || module.model.thinking?.keep !== undefined;
  const params = withExtras(
    {
      model: module.model.spec.name,
      max_tokens: resolveDefaultMaxTokens(module.model.spec.name),
      ...rest,
      system: native.system
        ? [{ type: 'text', text: native.system, cache_control: CACHE_CONTROL }]
        : undefined,
      messages: native.messages,
      tools: native.tools.length === 0 ? undefined : native.tools,
      betas: useBetaApi && betas.length > 0 ? betas : undefined,
    },
    module.options?.extras,
  );
  return { params: params as unknown as Request['params'], betas, useBetaApi };
}

export const anthropicMedia: MediaSupport = {
  kinds: {
    image: { mimes: 'any', sources: ['url', 'inline', 'file'], inToolResult: 'native' },
    video: { mimes: 'any', sources: ['url', 'inline', 'file'], inToolResult: 'native' },
    audio: { mimes: 'any', sources: ['url', 'inline', 'file'], inToolResult: 'native' },
  },
};

export const anthropicPipeline: PipelineSpec<
  AnthropicOptions,
  NativeMessage,
  NativeTool,
  AnthropicParams,
  Request
> = {
  media: anthropicMedia,
  toolCallId: { normalize: (id) => sanitizeToolCallId(id, 64), maxLength: 64 },
  patterns: (module) => [
    ...anthropicThinkingHistoryPatterns(module.model.spec),
    ...anthropicPatterns(),
  ],
  legality: anthropicModelLegality,
  cacheKey: (key) => ({ metadata: { user_id: key } }),
  thinking: (thinking, module) =>
    thinking === undefined ? undefined : encodeThinkingParams(thinking, module.model.spec),
  responseFormat: applyResponseFormat,
  maxOutputTokens: (cap) => ({ max_tokens: cap }),
  sampling: encodeSampling,
  tool: defaultTool,
  message: (message) => lowerMessage(message),
  mergeTurns: mergeTurnPatterns,
  annotate: annotateCache,
  finalize: finalizeParams,
  flatten,
};
