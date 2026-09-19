import Anthropic, {
  APIConnectionError as RawAnthropicSDKConnectionError,
  APIConnectionTimeoutError as RawAnthropicSDKConnectionTimeoutError,
  APIError as RawAnthropicSDKAPIError,
} from '@anthropic-ai/sdk';

import {
  headersToRecord,
  isAbortError,
  parseRetryAfterMs,
  SyntaxRequestFormatError,
  toLlmErrorMessage,
  toLlmStatusErrorMessage,
  toLlmTransportErrorMessage,
  type LlmRemoteErrorMessage,
} from '#/llm/errors';
import type { ContentPart, Message, TextPart, ToolDescription } from '#/llm/message';
import {
  createMediaLowerer,
  mediaContextOf,
  type MaterializedMedia,
} from '#/llm/media/materialize';
import type { ResponseFormat } from '#/llm/model';
import type { FormatRequestInput, ProtocolFormat } from '#/llm/protocol/format';
import { applyPatterns, mergeConsecutiveUsers, type Pattern } from '#/llm/protocol/rewrite';
import { NO_FINISH, type FinishInfo, type FinishReason, type TokenUsage } from '#/llm/usage';

import { resolveDefaultMaxTokens, shouldPreserveUnsignedThinking } from './profile';

export const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';

export type NativePart =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | {
      type: 'image';
      source: { type: 'base64'; data: string; media_type: string } | { type: 'url'; url: string };
      cache_control?: { type: 'ephemeral' };
    }
  | {
      type: 'video';
      source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
      cache_control?: { type: 'ephemeral' };
    }
  | {
      type: 'thinking';
      thinking: string;
      signature?: string;
      cache_control?: { type: 'ephemeral' };
    }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: unknown;
      cache_control?: { type: 'ephemeral' };
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: NativePart[];
      cache_control?: { type: 'ephemeral' };
    };

export type NativeMessage = {
  role: 'user' | 'assistant';
  content: NativePart[];
};

export type RawUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export type RawBlock = {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: unknown;
};

export type RawChunk = {
  type: string;
  index?: number;
  content_block?: RawBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    signature?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
  };
  message?: { id?: string; usage?: RawUsage };
  usage?: RawUsage;
};

const OMITTED_AUDIO_PLACEHOLDER = '(audio omitted: not supported by this provider)';

export function stripUnsignedThinking(options: { readonly preserve: boolean }): Pattern<Message> {
  return {
    name: 'stripUnsignedThinking',
    rewrite(items, index) {
      const message = items[index];
      if (message === undefined) return null;
      const content = message.content.filter((part) => {
        if (part.type !== 'think') return true;
        if (part.encrypted !== undefined) return true;
        return options.preserve;
      });
      if (content.length === message.content.length) return null;
      return { consumed: 1, replacement: [{ ...message, content }] };
    },
  };
}

export const audioToPlaceholder: Pattern<Message> = {
  name: 'audioToPlaceholder',
  rewrite(items, index) {
    const message = items[index];
    if (message === undefined || message.role === 'system') return null;
    let changed = false;
    const content: ContentPart[] = [];
    for (const part of message.content) {
      if (part.type === 'audio_url') {
        const last = content.at(-1);
        if (last === undefined || last.type !== 'text' || last.text !== OMITTED_AUDIO_PLACEHOLDER) {
          content.push({ type: 'text', text: OMITTED_AUDIO_PLACEHOLDER });
        }
        changed = true;
      } else if (message.role === 'tool' && part.type === 'text' && part.text === '') {
        changed = true;
      } else {
        content.push(part);
      }
    }
    if (!changed) return null;
    return { consumed: 1, replacement: [{ ...message, content }] };
  },
};

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

function imageFromMaterialized(
  materialized: MaterializedMedia,
  acceptedMimes: ReadonlySet<string>,
): NativePart {
  if (materialized.form === 'omit') return { type: 'text', text: materialized.text };
  if (materialized.form === 'inline') {
    if (!acceptedMimes.has(materialized.mimeType)) {
      throw new SyntaxRequestFormatError(
        `Unsupported media type for base64 image: ${materialized.mimeType}`,
      );
    }
    return {
      type: 'image',
      source: { type: 'base64', data: materialized.data, media_type: materialized.mimeType },
    };
  }
  return {
    type: 'image',
    source: { type: 'url', url: materialized.url },
  };
}

function videoFromMaterialized(materialized: MaterializedMedia): NativePart {
  if (materialized.form === 'omit') return { type: 'text', text: materialized.text };
  if (materialized.form === 'inline') {
    if (!SUPPORTED_B64_VIDEO_TYPES.has(materialized.mimeType)) {
      throw new SyntaxRequestFormatError(
        `Unsupported media type for base64 video: ${materialized.mimeType}`,
      );
    }
    return {
      type: 'video',
      source: { type: 'base64', media_type: materialized.mimeType, data: materialized.data },
    };
  }
  return {
    type: 'video',
    source: { type: 'url', url: materialized.url },
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

export function messageContent(message: NativeMessage): NativePart[] {
  return Array.isArray(message.content) ? message.content : [];
}

export function isEmpty(message: NativeMessage): boolean {
  return messageContent(message).length === 0;
}

async function lowerMessage(
  message: Message,
  acceptedMimes: ReadonlySet<string>,
  materialize: ReturnType<typeof createMediaLowerer>,
): Promise<NativeMessage[]> {
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
        blocks.push(imageFromMaterialized(await materialize(part), acceptedMimes));
      } else if (part.type === 'video_url') {
        blocks.push(videoFromMaterialized(await materialize(part)));
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
        content.push(imageFromMaterialized(await materialize(part), acceptedMimes));
      } else if (part.type === 'video_url') {
        content.push(videoFromMaterialized(await materialize(part)));
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

function injectCacheControlOnLastBlock(messages: NativeMessage[]): void {
  const lastMessage = messages.at(-1);
  if (lastMessage === undefined) return;
  const content = messageContent(lastMessage);
  const lastBlock = content.at(-1);
  if (lastBlock === undefined) return;
  if (CACHEABLE_TYPES.has(lastBlock.type)) {
    lastBlock.cache_control = CACHE_CONTROL;
  }
}

function isToolResultOnly(message: NativeMessage): boolean {
  if (message.role !== 'user') return false;
  const content = messageContent(message);
  if (content.length === 0) return false;
  return content.every((block) => block.type === 'tool_result');
}

function normalizeStopReason(raw: string | null | undefined): FinishInfo {
  if (raw === null || raw === undefined) {
    return NO_FINISH;
  }
  const finishReason: FinishReason = (() => {
    switch (raw) {
      case 'end_turn':
      case 'stop_sequence':
        return 'completed';
      case 'max_tokens':
        return 'truncated';
      case 'tool_use':
        return 'tool_calls';
      case 'pause_turn':
        return 'paused';
      case 'refusal':
        return 'filtered';
      default:
        return 'other';
    }
  })();
  return { finishReason, rawFinishReason: raw };
}

function parseUsage(usage: RawUsage | undefined): Partial<TokenUsage> | undefined {
  if (usage === undefined) {
    return undefined;
  }
  const patch: Partial<TokenUsage> = { raw: usage as Record<string, unknown> };
  if (typeof usage.input_tokens === 'number') {
    patch.inputOther = usage.input_tokens;
  }
  if (typeof usage.output_tokens === 'number') {
    patch.output = usage.output_tokens;
  }
  if (typeof usage.cache_read_input_tokens === 'number') {
    patch.inputCacheRead = usage.cache_read_input_tokens;
  }
  if (typeof usage.cache_creation_input_tokens === 'number') {
    patch.inputCacheCreation = usage.cache_creation_input_tokens;
  }
  return patch;
}

export function applyResponseFormat(
  kwargs: Record<string, unknown>,
  format: ResponseFormat,
): Record<string, unknown> {
  if (format.type === 'json_object') {
    throw new SyntaxRequestFormatError(
      'Anthropic requires a JSON schema for structured response output.',
    );
  }
  const existing = kwargs['output_config'];
  const outputConfig =
    existing !== undefined && existing !== null
      ? { ...(existing as Record<string, unknown>) }
      : {};
  outputConfig['format'] = { type: 'json_schema', schema: format.jsonSchema.schema };
  return { ...kwargs, output_config: outputConfig };
}

export function applyThinkingKeep(
  kwargs: Record<string, unknown>,
  keep: string,
): Record<string, unknown> {
  const betaFeatures = kwargs['betaFeatures'];
  const existing = kwargs['context_management'] as
    | { edits?: Array<{ type: string }> }
    | undefined;
  return {
    ...kwargs,
    betaFeatures: Array.isArray(betaFeatures)
      ? betaFeatures.includes(CONTEXT_MANAGEMENT_BETA)
        ? betaFeatures
        : [...betaFeatures, CONTEXT_MANAGEMENT_BETA]
      : [CONTEXT_MANAGEMENT_BETA],
    context_management: {
      edits: [
        { type: CLEAR_THINKING_EDIT, keep },
        ...(existing?.edits ?? []).filter((edit) => edit.type !== CLEAR_THINKING_EDIT),
      ],
    },
  };
}

export function encodeMaxTokens(cap: number): Record<string, unknown> {
  return { max_tokens: cap };
}

export function defaultTool(tool: ToolDescription): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

export function defaultMergeHistory(
  messages: readonly NativeMessage[],
): NativeMessage[] {
  return applyPatterns(messages.filter((message) => !isEmpty(message)), [
    mergeConsecutiveUsers({
      isUser: (param) => param.role === 'user',
      isToolResultOnly,
      merge: (last, next) => ({
        ...last,
        content: [...messageContent(last), ...messageContent(next)],
      }),
    }),
  ]);
}

export interface LoweredMessage {
  readonly source: Message;
  readonly message: NativeMessage;
}

export async function lower(
  input: FormatRequestInput,
  acceptedMimes: ReadonlySet<string>,
): Promise<LoweredMessage[]> {
  const normalized = applyPatterns(input.messages, [
    stripUnsignedThinking({ preserve: shouldPreserveUnsignedThinking(input.model.model) }),
    audioToPlaceholder,
  ]);
  const materialize = createMediaLowerer(mediaContextOf(input));
  const out: LoweredMessage[] = [];
  for (const message of normalized) {
    const natives = await lowerMessage(message, acceptedMimes, materialize);
    for (const native of natives) {
      out.push({ source: message, message: native });
    }
  }
  return out;
}

export interface Request {
  readonly params: Anthropic.MessageCreateParamsStreaming;
  readonly betas: readonly string[];
  readonly useBetaApi: boolean;
}

export interface FormatOptions {
  readonly betaApi?: boolean;
}

export interface AssembleParts {
  readonly messages: readonly NativeMessage[];
  readonly tools: readonly Record<string, unknown>[];
  readonly kwargs: Readonly<Record<string, unknown>>;
  readonly betaApi: boolean;
}

export interface Assembled {
  readonly params: Record<string, unknown>;
  readonly betas: readonly string[];
  readonly useBetaApi: boolean;
}

export function assemble(
  input: FormatRequestInput,
  parts: AssembleParts,
): Assembled {
  const messages = [...parts.messages];
  injectCacheControlOnLastBlock(messages);
  const tools = parts.tools.map((tool) => ({ ...tool }));
  const lastTool = tools.at(-1);
  if (lastTool !== undefined) {
    lastTool['cache_control'] = CACHE_CONTROL;
  }
  const { betaFeatures, ...restKwargs } = parts.kwargs;
  const betas = Array.isArray(betaFeatures) ? (betaFeatures as string[]) : [];
  const useBetaApi =
    parts.betaApi || input.model.betaApi === true || input.thinking?.keep !== undefined;
  const params: Record<string, unknown> = {
    model: input.model.model,
    max_tokens: resolveDefaultMaxTokens(input.model.model),
    metadata: input.cacheKey === undefined ? undefined : { user_id: input.cacheKey },
    ...restKwargs,
    system: input.systemPrompt
      ? [{ type: 'text', text: input.systemPrompt, cache_control: CACHE_CONTROL }]
      : undefined,
    messages,
    tools: tools.length === 0 ? undefined : tools,
    betas: useBetaApi && betas.length > 0 ? betas : undefined,
    stream: true,
  };
  return { params, betas, useBetaApi };
}

export function encode(
  assembly: Assembled,
): Request {
  return {
    params: assembly.params as unknown as Anthropic.MessageCreateParamsStreaming,
    betas: assembly.betas,
    useBetaApi: assembly.useBetaApi,
  };
}

export function createFormat(): ProtocolFormat<RawChunk> {
  return {
    createStreamParser() {
      return (chunk, sink) => {
        if (chunk.type === 'message_start') {
          const messageId = chunk.message?.id;
          if (typeof messageId === 'string' && messageId.length > 0) {
            sink.onMessageId?.(messageId);
          }
          const usage = parseUsage(chunk.message?.usage);
          if (usage !== undefined) {
            const inputUsage = { ...usage };
            delete inputUsage.output;
            sink.onUsage?.(inputUsage);
          }
          return;
        }
        if (chunk.type === 'message_delta') {
          const usage = parseUsage(chunk.usage);
          if (usage !== undefined) {
            sink.onUsage?.(usage);
          }
          const stopReason = chunk.delta?.stop_reason;
          if (stopReason !== undefined && stopReason !== null) {
            sink.onFinish(normalizeStopReason(stopReason));
          }
          return;
        }
        if (chunk.type === 'content_block_start' && chunk.content_block !== undefined) {
          const block = chunk.content_block;
          const index = chunk.index ?? 0;
          if (block.type === 'tool_use') {
            sink.onDelta({
              type: 'function',
              id: block.id ?? crypto.randomUUID(),
              name: block.name ?? '',
              arguments: '',
              _streamIndex: index,
            });
            return;
          }
          if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
            sink.onDelta({ type: 'think', think: block.thinking });
            return;
          }
          if (block.type === 'redacted_thinking' && typeof block.data === 'string' && block.data) {
            sink.onDelta({ type: 'think', think: '', encrypted: block.data });
            return;
          }
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            sink.onDelta({ type: 'text', text: block.text });
          }
          return;
        }
        if (chunk.type === 'content_block_delta' && chunk.delta !== undefined) {
          const delta = chunk.delta;
          const index = chunk.index ?? 0;
          if (delta.type === 'text_delta' && delta.text) {
            sink.onDelta({ type: 'text', text: delta.text });
            return;
          }
          if (delta.type === 'thinking_delta' && delta.thinking) {
            sink.onDelta({ type: 'think', think: delta.thinking });
            return;
          }
          if (delta.type === 'input_json_delta' && delta.partial_json) {
            sink.onDelta({ type: 'tool_call_part', argumentsPart: delta.partial_json, index });
            return;
          }
          if (delta.type === 'signature_delta' && delta.signature) {
            sink.onDelta({ type: 'think', think: '', encrypted: delta.signature });
          }
          return;
        }
      };
    },
  };
}

export function convertError(
  error: unknown,
  classifyErrorHook?: (error: unknown) => LlmRemoteErrorMessage | undefined,
): LlmRemoteErrorMessage {
  if (isAbortError(error)) {
    return toLlmErrorMessage(error);
  }
  const hooked = classifyErrorHook?.(error);
  if (hooked !== undefined) {
    return hooked;
  }
  if (error instanceof RawAnthropicSDKConnectionTimeoutError) {
    return { kind: 'timeout', message: error.message };
  }
  if (error instanceof RawAnthropicSDKConnectionError) {
    return { kind: 'connection', message: error.message };
  }
  if (error instanceof RawAnthropicSDKAPIError && typeof error.status === 'number') {
    return toLlmStatusErrorMessage({
      statusCode: error.status,
      message: error.message,
      requestId: error.requestID ?? null,
      retryAfterMs: parseRetryAfterMs(error.headers),
      headers: headersToRecord(error.headers),
    });
  }
  if (error instanceof Error) {
    return toLlmTransportErrorMessage(error.message);
  }
  return { kind: 'unknown', message: String(error) };
}
