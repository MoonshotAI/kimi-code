/**
 * `kosong/provider` domain (L2) — Anthropic Messages wire base.
 *
 * Speaks the Anthropic Messages wire format: system blocks with ephemeral
 * cache control, tool-result user blocks, consecutive-user merging, beta
 * headers vs the beta endpoint, and the thinking profile matrix (budget vs
 * adaptive) from `anthropic-profile`.
 *
 * The only hook surface is `withThinking` — a vendor dialect running over
 * this transport re-encodes the thinking intent and nothing else. When the
 * per-turn thinking intent carries `keep`, the BASE overlays the
 * context-management edit uniformly on top of whatever thinking encoding
 * happened (hook or base path), so a trait never handles `keep` itself.
 *
 * `convertAnthropicError`'s FIRST line is the contract's `throwIfAbortError`
 * guard: a user cancellation is THROWN as the standard abort DOMException at
 * the very front of the classification chain.
 */

import Anthropic, {
  APIError as AnthropicAPIError,
  APIConnectionError as AnthropicConnectionError,
  AnthropicError,
  APIConnectionTimeoutError as AnthropicTimeoutError,
} from '@anthropic-ai/sdk';
import type {
  Tool as AnthropicTool,
  ContentBlockParam,
  MessageCreateParams,
  MessageCreateParamsStreaming,
  MessageParam,
  MessageStreamEvent,
  RawContentBlockDeltaEvent,
  RawContentBlockStartEvent,
  RawMessageStartEvent,
  TextBlockParam,
  ThinkingBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages.js';

import {
  APIConnectionError,
  APITimeoutError,
  ChatProviderError,
  classifyBaseApiError,
  normalizeAPIStatusError,
  parseRetryAfterMs,
  throwIfAbortError,
} from '#/kosong/contract/errors';
import type {
  ContentPart,
  Message,
  StreamedMessagePart,
  ToolCall,
} from '#/kosong/contract/message';
import { isToolDeclarationOnlyMessage } from '#/kosong/contract/message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  ProviderRequestAuth,
  ResponseFormat,
  StreamedMessage,
  ThinkingEffort,
  ToolCallIdPolicy,
} from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import type { TokenUsage } from '#/kosong/contract/usage';

import {
  BUDGET_THINKING_EFFORTS,
  inferAnthropicModelProfile,
  matchKnownAnthropicModelProfile,
  parseAnthropicModelVersion,
  type AnthropicModelProfile,
  type AnthropicModelVersion,
} from './anthropic-profile';
import { mergeConsecutiveUserMessages } from '../merge-user-messages';
import { mergeRequestHeaders, resolveAuthBackedClient } from '../request-auth';
import { normalizeToolCallIdsForProvider, sanitizeToolCallId } from '../tool-call-id';

function normalizeAnthropicStopReason(raw: string | null | undefined): {
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
} {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return { finishReason: 'completed', rawFinishReason: raw };
    case 'max_tokens':
      return { finishReason: 'truncated', rawFinishReason: raw };
    case 'tool_use':
      return { finishReason: 'tool_calls', rawFinishReason: raw };
    case 'pause_turn':
      return { finishReason: 'paused', rawFinishReason: raw };
    case 'refusal':
      return { finishReason: 'filtered', rawFinishReason: raw };
    default:
      return { finishReason: 'other', rawFinishReason: raw };
  }
}

export interface AnthropicGenerationKwargs {
  max_tokens?: number | undefined;
  temperature?: number | undefined;
  top_k?: number | undefined;
  top_p?: number | undefined;
  thinking?: MessageCreateParams['thinking'] | undefined;
  output_config?: MessageCreateParams['output_config'] | undefined;
  betaFeatures?: string[] | undefined;
  contextManagement?: AnthropicContextManagement;
}

interface AnthropicContextManagement {
  edits: Array<{ type: string; keep?: unknown }>;
}

/**
 * The base-internal hook set: the L1 `withThinking` hook with the context
 * already bound away. It receives a defensive COPY of the seeded kwargs, so a
 * hook can never mutate base state — and a construction-headers synthetic
 * trait can never shadow a real dialect hook (the compositor picks the last
 * declarer).
 */
export interface AnthropicHooks {
  withThinking?(
    effort: ThinkingEffort,
    options: { readonly keep?: string },
    generationKwargs: AnthropicGenerationKwargs,
  ): AnthropicGenerationKwargs | undefined;
}

export interface AnthropicOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  defaultMaxTokens?: number | undefined;
  betaFeatures?: string[] | undefined;
  defaultHeaders?: Record<string, string>;
  metadata?: Record<string, string> | undefined;
  stream?: boolean | undefined;
  adaptiveThinking?: boolean | undefined;
  supportEfforts?: readonly string[] | undefined;
  betaApi?: boolean | undefined;
  thinkingEffort?: ThinkingEffort | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => Anthropic;
  hooks?: AnthropicHooks | undefined;
}

const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';
const CLEAR_THINKING_EDIT = 'clear_thinking_20251015';
const ANTHROPIC_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
  maxLength: 64,
};

function applyResponseFormat(
  kwargs: Record<string, unknown>,
  format: ResponseFormat | undefined,
): void {
  if (format === undefined) return;
  if (format.type === 'json_object') {
    throw new ChatProviderError(
      'Anthropic provider requires a JSON schema for structured response output.',
    );
  }
  const outputConfig =
    kwargs['output_config'] !== undefined && kwargs['output_config'] !== null
      ? { ...(kwargs['output_config'] as Record<string, unknown>) }
      : {};
  outputConfig['format'] = {
    type: 'json_schema',
    schema: format.jsonSchema.schema,
  };
  kwargs['output_config'] = outputConfig;
}

const CEILING_BY_FAMILY_VERSION: Readonly<Record<string, number>> = {
  'fable-5': 128000,
  'mythos-5': 128000,
  'opus-4-8': 128000,
  'opus-4-7': 128000,
  'opus-4-6': 128000,
  'opus-4-5': 64000,
  'opus-4-1': 32000,
  'opus-4-0': 32000,
  'opus-4': 32000,
  'sonnet-5': 128000,
  'sonnet-4-6': 128000,
  'sonnet-4-5': 64000,
  'sonnet-4-0': 64000,
  'sonnet-4': 64000,
  'haiku-4-5': 64000,
  'haiku-4': 64000,
  'opus-3-5': 8192,
  'sonnet-3-5': 8192,
  'sonnet-3-7': 8192,
  'haiku-3-5': 8192,
  'opus-3': 4096,
  'sonnet-3': 4096,
  'haiku-3': 4096,
};

const FALLBACK_MAX_TOKENS = 128000;

function lookupClaudeCeiling(version: AnthropicModelVersion): number | undefined {
  const { family, major, minor } = version;
  if (minor !== null) {
    for (let candidate = minor; candidate >= 0; candidate--) {
      const ceiling = CEILING_BY_FAMILY_VERSION[`${family}-${major}-${candidate}`];
      if (ceiling !== undefined) return ceiling;
    }
  }
  return CEILING_BY_FAMILY_VERSION[`${family}-${major}`];
}

export function resolveDefaultMaxTokens(model: string, override?: number): number {
  const parsed = parseAnthropicModelVersion(model, true);
  const ceiling = parsed === null ? undefined : lookupClaudeCeiling(parsed);
  if (ceiling === undefined) {
    return override ?? FALLBACK_MAX_TOKENS;
  }
  return override === undefined ? ceiling : Math.min(override, ceiling);
}

function requiresAdaptiveThinking(efforts: readonly string[]): boolean {
  return efforts.some((effort) => effort !== 'low' && effort !== 'medium' && effort !== 'high');
}

function resolveThinkingProfile(
  model: string,
  supportEfforts: readonly string[] | undefined,
  adaptiveThinking: boolean | undefined,
): AnthropicModelProfile {
  const inferred = inferAnthropicModelProfile(model);
  if (adaptiveThinking === false) {
    return {
      ...inferred,
      mode: 'budget',
      efforts: supportEfforts ?? BUDGET_THINKING_EFFORTS,
      supportsEffortParam: false,
    };
  }

  if (adaptiveThinking === true) {
    return {
      ...inferred,
      mode: 'adaptive',
      efforts: supportEfforts ?? inferred.efforts,
      supportsEffortParam: true,
    };
  }

  if (supportEfforts === undefined) {
    return inferred;
  }
  return {
    ...inferred,
    mode: requiresAdaptiveThinking(supportEfforts) ? 'adaptive' : inferred.mode,
    efforts: supportEfforts,
    supportsEffortParam: requiresAdaptiveThinking(supportEfforts) || inferred.supportsEffortParam,
  };
}

function budgetTokensForEffort(effort: ThinkingEffort): number | undefined {
  if (effort === 'low') return 1024;
  if (effort === 'medium') return 4096;
  if (effort === 'on' || effort === 'high') return 32_000;
  return undefined;
}

const CACHE_CONTROL = { type: 'ephemeral' as const };

type CacheableBlock = ContentBlockParam & { cache_control?: { type: 'ephemeral' } };

function shouldPreserveUnsignedThinking(model: string): boolean {
  return (
    parseAnthropicModelVersion(model) === null &&
    matchKnownAnthropicModelProfile(model) === undefined
  );
}

const CACHEABLE_TYPES = new Set([
  'text',
  'image',
  'document',
  'search_result',
  'tool_use',
  'tool_result',
  'server_tool_use',
  'web_search_tool_result',
]);

function injectCacheControlOnLastBlock(messages: MessageParam[]): void {
  const lastMessage = messages.at(-1);
  if (lastMessage === undefined) return;
  const content = lastMessage.content;
  if (!Array.isArray(content) || content.length === 0) return;
  const lastBlock = content.at(-1) as CacheableBlock | undefined;
  if (lastBlock === undefined) return;
  if (CACHEABLE_TYPES.has(lastBlock.type)) {
    lastBlock.cache_control = CACHE_CONTROL;
  }
}

function isToolResultOnly(message: MessageParam): boolean {
  if (message.role !== 'user') return false;
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block) => block.type === 'tool_result');
}

interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; data: string; media_type: string } | { type: 'url'; url: string };
  cache_control?: { type: 'ephemeral' };
}

interface AnthropicVideoBlock {
  type: 'video';
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
}

const OMITTED_MEDIA_PLACEHOLDER = {
  audio_url: '(audio omitted: not supported by this provider)',
} as const;

const SUPPORTED_B64_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const SUPPORTED_B64_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/mpeg',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
  'video/x-flv',
  'video/3gpp',
]);

function imageUrlPartToAnthropic(url: string): AnthropicImageBlock {
  if (url.startsWith('data:')) {
    const withoutScheme = url.slice(5);
    const parts = withoutScheme.split(';base64,', 2);
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new ChatProviderError(`Invalid data URL for image: ${url}`);
    }
    const mediaType = parts[0];
    const data = parts[1];
    if (!SUPPORTED_B64_MEDIA_TYPES.has(mediaType)) {
      throw new ChatProviderError(
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

function videoUrlPartToAnthropic(url: string): AnthropicVideoBlock {
  if (url.startsWith('data:')) {
    const withoutScheme = url.slice(5);
    const parts = withoutScheme.split(';base64,', 2);
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new ChatProviderError(`Invalid data URL for video: ${url}`);
    }
    const mediaType = parts[0];
    const data = parts[1];
    if (!SUPPORTED_B64_VIDEO_TYPES.has(mediaType)) {
      throw new ChatProviderError(
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

interface AnthropicToolParam extends AnthropicTool {
  cache_control?: { type: 'ephemeral' } | null;
}

function convertTool(tool: Tool): AnthropicToolParam {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as AnthropicTool['input_schema'],
  };
}

function toolResultToBlock(toolCallId: string, content: ContentPart[]): ToolResultBlockParam {
  const blocks: Array<TextBlockParam | AnthropicImageBlock | AnthropicVideoBlock> = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) {
        blocks.push({ type: 'text', text: part.text });
      }
    } else if (part.type === 'image_url') {
      blocks.push(imageUrlPartToAnthropic(part.imageUrl.url));
    } else if (part.type === 'video_url') {
      blocks.push(videoUrlPartToAnthropic(part.videoUrl.url));
    } else if (part.type === 'audio_url') {
      const placeholder = OMITTED_MEDIA_PLACEHOLDER[part.type];
      const last = blocks.at(-1);
      if (!(last?.type === 'text' && last.text === placeholder)) {
        blocks.push({ type: 'text', text: placeholder });
      }
    }
  }
  return {
    type: 'tool_result',
    tool_use_id: toolCallId,
    content: blocks,
  } as ToolResultBlockParam;
}

function convertMessage(message: Message, model: string): MessageParam {
  const role = message.role;

  if (role === 'system') {
    const text = message.content
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    return {
      role: 'user',
      content: [{ type: 'text', text: `<system>${text}</system>` }],
    };
  }

  if (role === 'tool') {
    if (message.toolCallId === undefined) {
      throw new ChatProviderError('Tool message missing `toolCallId`.');
    }
    const block = toolResultToBlock(message.toolCallId, message.content);
    return { role: 'user', content: [block as ContentBlockParam] };
  }

  const blocks: ContentBlockParam[] = [];
  for (const part of message.content) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text } satisfies TextBlockParam);
    } else if (part.type === 'image_url') {
      blocks.push(imageUrlPartToAnthropic(part.imageUrl.url) as unknown as ContentBlockParam);
    } else if (part.type === 'think') {
      if (part.encrypted !== undefined) {
        blocks.push({
          type: 'thinking',
          thinking: part.think,
          signature: part.encrypted,
        } satisfies ThinkingBlockParam);
      } else if (shouldPreserveUnsignedThinking(model)) {
        blocks.push({ type: 'thinking', thinking: part.think } as unknown as ThinkingBlockParam);
      }
    } else if (part.type === 'video_url') {
      blocks.push(videoUrlPartToAnthropic(part.videoUrl.url) as unknown as ContentBlockParam);
    } else if (part.type === 'audio_url') {
      const placeholder = OMITTED_MEDIA_PLACEHOLDER[part.type];
      const last = blocks.at(-1);
      if (!(last?.type === 'text' && last.text === placeholder)) {
        blocks.push({ type: 'text', text: placeholder } satisfies TextBlockParam);
      }
    }
  }

  if (message.toolCalls.length > 0) {
    for (const tc of message.toolCalls) {
      let toolInput: Record<string, unknown> = {};
      if (tc.arguments) {
        try {
          const parsed: unknown = JSON.parse(tc.arguments);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            toolInput = parsed as Record<string, unknown>;
          } else {
            throw new ChatProviderError('Tool call arguments must be a JSON object.');
          }
        } catch (error) {
          if (error instanceof ChatProviderError) throw error;
          throw new ChatProviderError('Tool call arguments must be valid JSON.');
        }
      }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: toolInput,
      } satisfies ToolUseBlockParam);
    }
  }

  return { role: role, content: blocks };
}

function shouldKeepConvertedMessage(message: MessageParam): boolean {
  return message.role !== 'assistant' || message.content.length > 0;
}

export function convertAnthropicError(error: unknown): ChatProviderError {
  // Abort guard FIRST: throws (never returns) the standard abort DOMException
  // for any abort shape, so a user cancellation is never misclassified as a
  // retryable provider failure.
  throwIfAbortError(error);
  if (error instanceof AnthropicTimeoutError) {
    return new APITimeoutError(error.message);
  }
  if (error instanceof AnthropicConnectionError) {
    return new APIConnectionError(error.message);
  }
  if (error instanceof AnthropicAPIError && typeof error.status === 'number') {
    const reqId = error.requestID ?? null;
    return normalizeAPIStatusError(
      error.status,
      error.message,
      reqId,
      parseRetryAfterMs(error.headers),
    );
  }
  if (error instanceof AnthropicError) {
    return new ChatProviderError(`Anthropic error: ${error.message}`);
  }
  if (error instanceof Error) {
    return classifyBaseApiError(error.message);
  }
  return new ChatProviderError(`Error: ${String(error)}`);
}

class AnthropicStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage = {
    inputOther: 0,
    output: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  };
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(response: unknown, isStream: boolean) {
    if (isStream) {
      this._iter = this._convertStreamResponse(response as AsyncIterable<MessageStreamEvent>);
    } else {
      this._iter = this._convertNonStreamResponse(
        response as {
          id: string;
          stop_reason?: string | null;
          usage: {
            input_tokens: number;
            output_tokens: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          content: Array<{
            type: string;
            text?: string;
            thinking?: string;
            signature?: string;
            data?: string;
            id?: string;
            name?: string;
            input?: unknown;
          }>;
        },
      );
    }
  }

  get id(): string | null {
    return this._id;
  }

  get usage(): TokenUsage | null {
    return this._usage;
  }

  get finishReason(): FinishReason | null {
    return this._finishReason;
  }

  get rawFinishReason(): string | null {
    return this._rawFinishReason;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    yield* this._iter;
  }

  private _captureStopReason(raw: string | null | undefined): void {
    const normalized = normalizeAnthropicStopReason(raw);
    this._finishReason = normalized.finishReason;
    this._rawFinishReason = normalized.rawFinishReason;
  }

  private _extractUsage(usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  }): void {
    this._usage = {
      inputOther: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      inputCacheRead: usage.cache_read_input_tokens ?? 0,
      inputCacheCreation: usage.cache_creation_input_tokens ?? 0,
    };
  }

  private async *_convertNonStreamResponse(response: {
    id: string;
    stop_reason?: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
      signature?: string;
      data?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
  }): AsyncGenerator<StreamedMessagePart> {
    this._id = response.id;
    this._extractUsage(response.usage);
    this._captureStopReason(response.stop_reason);

    for (const block of response.content) {
      switch (block.type) {
        case 'text':
          if (block.text !== undefined) {
            yield { type: 'text', text: block.text };
          }
          break;
        case 'thinking':
          yield block.signature !== undefined
            ? { type: 'think' as const, think: block.thinking ?? '', encrypted: block.signature }
            : { type: 'think' as const, think: block.thinking ?? '' };
          break;
        case 'redacted_thinking':
          yield block.data !== undefined
            ? { type: 'think' as const, think: '', encrypted: block.data }
            : { type: 'think' as const, think: '' };
          break;
        case 'tool_use':
          yield {
            type: 'function',
            id: block.id ?? crypto.randomUUID(),
            name: block.name ?? '',
            arguments: block.input !== undefined ? JSON.stringify(block.input) : null,
          } satisfies ToolCall;
          break;
      }
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<MessageStreamEvent>,
  ): AsyncGenerator<StreamedMessagePart> {
    const toolUseBlockIndexes = new Set<number>();

    try {
      for await (const event of response) {
        const evt = event as unknown as Record<string, unknown>;
        const eventType = evt['type'] as string;

        if (eventType === 'message_start') {
          const startEvt = evt as unknown as RawMessageStartEvent;
          this._id = startEvt.message.id;
          this._extractUsage(
            startEvt.message.usage as {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            },
          );
        } else if (eventType === 'content_block_start') {
          const blockEvt = evt as unknown as RawContentBlockStartEvent;
          const block = blockEvt.content_block;
          const blockIndex = blockEvt.index;
          // eslint-disable-next-line typescript-eslint/switch-exhaustiveness-check
          switch (block.type) {
            case 'text':
              yield { type: 'text', text: block.text };
              break;
            case 'thinking':
              yield { type: 'think', think: block.thinking ?? '' };
              break;
            case 'redacted_thinking':
              yield {
                type: 'think',
                think: '',
                encrypted: (block as unknown as { data: string }).data,
              };
              break;
            case 'tool_use':
              toolUseBlockIndexes.add(blockIndex);
              yield {
                type: 'function',
                id: block.id,
                name: block.name,
                arguments: '',
                _streamIndex: blockIndex,
              } satisfies ToolCall;
              break;
          }
        } else if (eventType === 'content_block_delta') {
          const deltaEvt = evt as unknown as RawContentBlockDeltaEvent;
          const delta = deltaEvt.delta;
          const blockIndex = deltaEvt.index;
          // eslint-disable-next-line typescript-eslint/switch-exhaustiveness-check
          switch (delta.type) {
            case 'text_delta':
              yield { type: 'text', text: delta.text };
              break;
            case 'thinking_delta':
              yield { type: 'think', think: delta.thinking ?? '' };
              break;
            case 'input_json_delta':
              yield {
                type: 'tool_call_part',
                argumentsPart: delta.partial_json,
                index: blockIndex,
              };
              break;
            case 'signature_delta':
              yield {
                type: 'think',
                think: '',
                encrypted: delta.signature,
              };
              break;
          }
        } else if (eventType === 'content_block_stop') {
        } else if (eventType === 'message_delta') {
          const deltaUsage = (evt as { usage?: Record<string, unknown> }).usage;
          if (deltaUsage !== undefined) {
            if (typeof deltaUsage['output_tokens'] === 'number') {
              this._usage.output = deltaUsage['output_tokens'];
            }
            if (typeof deltaUsage['cache_read_input_tokens'] === 'number') {
              this._usage.inputCacheRead = deltaUsage['cache_read_input_tokens'];
            }
            if (typeof deltaUsage['cache_creation_input_tokens'] === 'number') {
              this._usage.inputCacheCreation = deltaUsage['cache_creation_input_tokens'];
            }
            if (typeof deltaUsage['input_tokens'] === 'number') {
              this._usage.inputOther = deltaUsage['input_tokens'];
            }
          }
          const messageDeltaPayload = (evt as { delta?: Record<string, unknown> }).delta;
          if (messageDeltaPayload !== undefined && 'stop_reason' in messageDeltaPayload) {
            this._captureStopReason(
              messageDeltaPayload['stop_reason'] as string | null | undefined,
            );
          }
        }
      }
    } catch (error: unknown) {
      throw convertAnthropicError(error);
    }
  }
}

export class AnthropicChatProvider implements ChatProvider {
  readonly name: string = 'anthropic';

  private readonly _model: string;
  private readonly _stream: boolean;
  private readonly _client: Anthropic | undefined;
  private readonly _generationKwargs: AnthropicGenerationKwargs;
  private readonly _metadata: Record<string, string> | undefined;
  private readonly _apiKey: string | undefined;
  private readonly _baseUrl: string | undefined;
  private readonly _defaultHeaders: Record<string, string | null> | undefined;
  private readonly _clientFactory: ((auth: ProviderRequestAuth) => Anthropic) | undefined;
  private readonly _adaptiveThinking: boolean | undefined;
  private readonly _supportEfforts: readonly string[] | undefined;
  private readonly _betaApi: boolean;
  private readonly _thinkingEffort: ThinkingEffort | undefined;
  private readonly _explicitMaxTokens: boolean;
  private readonly _hooks: AnthropicHooks | undefined;

  constructor(options: AnthropicOptions) {
    this._model = options.model;
    this._stream = options.stream ?? true;
    this._metadata = options.metadata;
    this._adaptiveThinking = options.adaptiveThinking;
    this._supportEfforts = options.supportEfforts;
    this._betaApi = options.betaApi ?? false;
    this._thinkingEffort = options.thinkingEffort;
    this._hooks = options.hooks;
    this._apiKey =
      options.apiKey === undefined || options.apiKey.length === 0 ? undefined : options.apiKey;
    this._baseUrl = options.baseUrl;
    this._defaultHeaders = options.defaultHeaders;
    this._clientFactory = options.clientFactory;
    this._client = this._apiKey === undefined ? undefined : this._buildClient(this._apiKey);
    this._explicitMaxTokens = options.defaultMaxTokens !== undefined;
    this._generationKwargs = {
      max_tokens: options.defaultMaxTokens ?? resolveDefaultMaxTokens(options.model),
      betaFeatures: options.betaFeatures ?? [INTERLEAVED_THINKING_BETA],
    };
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return this._thinkingEffort ?? null;
  }

  get maxCompletionTokens(): number | undefined {
    return this._generationKwargs.max_tokens;
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    const system: TextBlockParam[] | undefined = systemPrompt
      ? [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: CACHE_CONTROL,
          } as TextBlockParam,
        ]
      : undefined;

    const messages = mergeConsecutiveUserMessages(
      normalizeToolCallIdsForProvider(
        history.filter((msg) => !isToolDeclarationOnlyMessage(msg)),
        ANTHROPIC_TOOL_CALL_ID_POLICY,
      )
        .map((msg) => convertMessage(msg, this._model))
        .filter(shouldKeepConvertedMessage),
      {
        isUser: (message) => message.role === 'user',
        isToolResultOnly,
        merge: (last, next) => ({
          ...last,
          content: [
            ...(last.content as ContentBlockParam[]),
            ...(next.content as ContentBlockParam[]),
          ],
        }),
      },
    );

    injectCacheControlOnLastBlock(messages);

    // Per-turn intent overlays in the fixed contract order:
    // cacheKey → sampling → thinking → maxCompletionTokens.
    let kwargs: AnthropicGenerationKwargs = { ...this._generationKwargs };
    let useBetaApi = this._betaApi;

    let metadata = this._metadata;
    if (options?.cacheKey !== undefined) {
      // The cache key is encoded as `metadata.user_id` on this transport.
      metadata = { ...metadata, user_id: options.cacheKey };
    }

    if (options?.sampling?.temperature !== undefined) {
      kwargs = { ...kwargs, temperature: options.sampling.temperature };
    }
    if (options?.sampling?.topP !== undefined) {
      kwargs = { ...kwargs, top_p: options.sampling.topP };
    }

    const thinking =
      options?.thinking ??
      (this._thinkingEffort !== undefined ? { effort: this._thinkingEffort } : undefined);
    if (thinking !== undefined) {
      const hooked = this._hooks?.withThinking?.(
        thinking.effort,
        { keep: thinking.keep },
        { ...kwargs },
      );
      if (hooked !== undefined) {
        kwargs = { ...kwargs, ...hooked };
      } else {
        kwargs = { ...kwargs, ...this._encodeThinking(thinking.effort, kwargs) };
      }
      // The keep context-management edit is overlaid by the base on top of
      // whatever thinking encoding happened — a trait never handles keep.
      if (thinking.keep !== undefined) {
        kwargs = { ...kwargs, ...applyThinkingKeep(kwargs, thinking.keep) };
        useBetaApi = true;
      }
    }

    if (options?.maxCompletionTokens !== undefined) {
      let cap = options.maxCompletionTokens;
      // Window clamp first — it cannot be skipped.
      if (
        options.usedContextTokens !== undefined &&
        options.maxContextTokens !== undefined &&
        options.maxContextTokens > 0
      ) {
        cap = Math.min(cap, options.maxContextTokens - options.usedContextTokens);
      }
      cap = Math.max(1, cap);
      const requestedCap = resolveDefaultMaxTokens(this._model, cap);
      const existingCap = kwargs.max_tokens;
      kwargs = {
        ...kwargs,
        max_tokens:
          existingCap === undefined || this._explicitMaxTokens
            ? (existingCap ?? requestedCap)
            : Math.min(existingCap, requestedCap),
      };
    }

    const requestKwargs: Record<string, unknown> = {};
    if (kwargs.max_tokens !== undefined) {
      requestKwargs['max_tokens'] = kwargs.max_tokens;
    }
    if (kwargs.temperature !== undefined) {
      requestKwargs['temperature'] = kwargs.temperature;
    }
    if (kwargs.top_k !== undefined) {
      requestKwargs['top_k'] = kwargs.top_k;
    }
    if (kwargs.top_p !== undefined) {
      requestKwargs['top_p'] = kwargs.top_p;
    }
    if (kwargs.thinking !== undefined) {
      requestKwargs['thinking'] = kwargs.thinking;
    }
    if (kwargs.output_config !== undefined) {
      requestKwargs['output_config'] = kwargs.output_config;
    }
    if (kwargs.contextManagement !== undefined) {
      requestKwargs['context_management'] = kwargs.contextManagement;
    }
    applyResponseFormat(requestKwargs, options?.responseFormat);

    const betas = kwargs.betaFeatures ?? [];
    const extraHeaders: Record<string, string> = {};
    if (!useBetaApi && betas.length > 0) {
      extraHeaders['anthropic-beta'] = betas.join(',');
    }

    const anthropicTools: AnthropicToolParam[] = tools.map((t) => convertTool(t));
    if (anthropicTools.length > 0) {
      const lastTool = anthropicTools.at(-1);
      if (lastTool !== undefined) {
        lastTool.cache_control = CACHE_CONTROL;
      }
    }

    const createParams: Record<string, unknown> = {
      model: this._model,
      messages,
      ...requestKwargs,
    };

    if (system !== undefined) {
      createParams['system'] = system;
    }

    if (anthropicTools.length > 0) {
      createParams['tools'] = anthropicTools;
    }

    if (metadata !== undefined) {
      createParams['metadata'] = metadata;
    }

    if (useBetaApi && betas.length > 0) {
      createParams['betas'] = betas;
    }

    const requestOptions: Record<string, unknown> = {};
    const headers = mergeRequestHeaders(extraHeaders, options?.auth?.headers);
    if (headers !== undefined) {
      requestOptions['headers'] = headers;
    }
    if (options?.signal) {
      requestOptions['signal'] = options.signal;
    }
    const finalRequestOptions = Object.keys(requestOptions).length > 0 ? requestOptions : undefined;
    const client = this._createClient(options?.auth);
    options?.onRequestSent?.();

    if (this._stream) {
      try {
        const stream = useBetaApi
          ? await client.beta.messages.create(
              { ...createParams, stream: true } as unknown as MessageCreateParamsStreaming,
              finalRequestOptions,
            )
          : await client.messages.create(
              { ...createParams, stream: true } as unknown as MessageCreateParamsStreaming,
              finalRequestOptions,
            );
        return new AnthropicStreamedMessage(stream, true);
      } catch (error: unknown) {
        throw convertAnthropicError(error);
      }
    }

    try {
      const response = useBetaApi
        ? await client.beta.messages.create(
            { ...createParams, stream: false } as unknown as MessageCreateParams,
            finalRequestOptions,
          )
        : await client.messages.create(
            { ...createParams, stream: false } as unknown as MessageCreateParams,
            finalRequestOptions,
          );
      return new AnthropicStreamedMessage(response, false);
    } catch (error: unknown) {
      throw convertAnthropicError(error);
    }
  }

  /**
   * The base thinking path: encode the per-turn effort against the model's
   * thinking profile (budget vs adaptive). Runs only when no withThinking
   * hook took over. Reads the seeded beta list from the current kwargs.
   */
  private _encodeThinking(
    effort: ThinkingEffort,
    kwargs: AnthropicGenerationKwargs,
  ): AnthropicGenerationKwargs {
    const profile = resolveThinkingProfile(
      this._model,
      this._supportEfforts,
      this._adaptiveThinking,
    );

    let newBetas = [...(kwargs.betaFeatures ?? [])];
    if (profile.mode === 'adaptive') {
      newBetas = newBetas.filter((b) => b !== INTERLEAVED_THINKING_BETA);
    }

    if (effort === 'off') {
      return {
        thinking: { type: 'disabled' },
        output_config: undefined,
        betaFeatures: newBetas,
      };
    }

    if (profile.mode === 'adaptive') {
      return {
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config:
          effort === 'on' ? undefined : ({ effort } as MessageCreateParams['output_config']),
        betaFeatures: newBetas,
      };
    }

    const budgetTokens = budgetTokensForEffort(effort);
    const patch: AnthropicGenerationKwargs = {
      thinking:
        budgetTokens === undefined
          ? ({ type: 'enabled' } as MessageCreateParams['thinking'])
          : { type: 'enabled', budget_tokens: budgetTokens },
      betaFeatures: newBetas,
    };
    if ((profile.supportsEffortParam || budgetTokens === undefined) && effort !== 'on') {
      patch.output_config = { effort } as MessageCreateParams['output_config'];
    } else {
      patch.output_config = undefined;
    }
    return patch;
  }

  private _createClient(auth: ProviderRequestAuth | undefined): Anthropic {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) => this._buildClient(this._requireApiKey(a)),
    );
  }

  private _requireApiKey(auth: ProviderRequestAuth | undefined): string {
    const apiKey = auth?.apiKey ?? this._apiKey;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new ChatProviderError(
        'AnthropicChatProvider: apiKey is required. Provide it via constructor options, options.auth.apiKey on each request, or an OAuth login. The Anthropic adapter does not read shell API-key environment variables.',
      );
    }
    return apiKey;
  }

  private _anthropicCustomHeaderEnvNames(): string[] {
    const customHeaders = process.env['ANTHROPIC_CUSTOM_HEADERS'];
    if (customHeaders === undefined || customHeaders.length === 0) return [];

    const names: string[] = [];
    for (const line of customHeaders.split('\n')) {
      const colonIndex = line.indexOf(':');
      if (colonIndex < 0) continue;

      const name = line.slice(0, colonIndex).trim().toLowerCase();
      if (name.length > 0) names.push(name);
    }
    return names;
  }

  private _buildDefaultHeaders(apiKey: string): Record<string, string | null> {
    const defaultHeaders: Record<string, string | null> = { authorization: null };
    for (const name of this._anthropicCustomHeaderEnvNames()) {
      defaultHeaders[name] = null;
    }
    for (const [name, value] of Object.entries(this._defaultHeaders ?? {})) {
      defaultHeaders[name.toLowerCase()] = value;
    }
    defaultHeaders['x-api-key'] = apiKey;
    return defaultHeaders;
  }

  private _buildClient(apiKey: string): Anthropic {
    return new Anthropic({
      apiKey,
      authToken: null,
      baseURL: this._baseUrl ?? null,
      defaultHeaders: this._buildDefaultHeaders(apiKey),
    });
  }
}

/**
 * The keep context-management edit, overlaid by the base on top of any
 * thinking encoding: appends the context-management beta and replaces any
 * prior clear-thinking edit with one carrying this keep value.
 */
function applyThinkingKeep(
  kwargs: AnthropicGenerationKwargs,
  keep: string,
): AnthropicGenerationKwargs {
  const current = kwargs.betaFeatures ?? [];
  const betaFeatures = current.includes(CONTEXT_MANAGEMENT_BETA)
    ? current
    : [...current, CONTEXT_MANAGEMENT_BETA];
  const existingEdits = kwargs.contextManagement?.edits ?? [];
  const edits = [
    { type: CLEAR_THINKING_EDIT, keep },
    ...existingEdits.filter((edit) => edit.type !== CLEAR_THINKING_EDIT),
  ];
  return {
    contextManagement: { edits },
    betaFeatures,
  };
}

// ---------------------------------------------------------------------------
// Base capability catalog — the final fallback of capability resolution.
// `undefined` means the base knows nothing about the model.
// ---------------------------------------------------------------------------

const CLAUDE_VISION_TOOL_PREFIXES = ['claude-3-', 'claude-3.5-', 'claude-3.7-'] as const;

const CLAUDE_THINKING_VISION_TOOL_PREFIXES = [
  'claude-opus-4',
  'claude-sonnet-4',
  'claude-haiku-4',
  'claude-fable',
] as const;

const ANTHROPIC_VISION_TOOL_CAPABILITY = Object.freeze({
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 0,
});

const ANTHROPIC_THINKING_VISION_TOOL_CAPABILITY = Object.freeze({
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 0,
});

export function getAnthropicModelCapability(modelName: string) {
  const normalized = modelName.toLowerCase();
  if (CLAUDE_VISION_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return ANTHROPIC_VISION_TOOL_CAPABILITY;
  }
  if (CLAUDE_THINKING_VISION_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return ANTHROPIC_THINKING_VISION_TOOL_CAPABILITY;
  }
  return undefined;
}
