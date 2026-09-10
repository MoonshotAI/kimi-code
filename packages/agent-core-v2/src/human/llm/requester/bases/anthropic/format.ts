import Anthropic, {
  APIConnectionError as RawAnthropicSDKConnectionError,
  APIConnectionTimeoutError as RawAnthropicSDKConnectionTimeoutError,
  APIError as RawAnthropicSDKAPIError,
} from '@anthropic-ai/sdk';

import {
  headersToRecord,
  isAbortError,
  parseRetryAfterMs,
  toLlmErrorMessage,
  toLlmStatusErrorMessage,
  toLlmTransportErrorMessage,
  type LlmRemoteErrorMessage,
} from '#/llm/errors';
import { NO_FINISH, type FinishInfo, type FinishReason } from '#/llm/finish-reason';
import type { FormatRequestInput, ProtocolFormat } from '#/llm/protocol/format';
import type { ResponseFormat } from '#/llm/response-format';
import { SyntaxRequestFormatError } from '#/llm/syntax-errors';
import type { Message, ToolDescription } from '#/llm/message';
import { mergeConsecutiveUsers } from '#/llm/protocol/patterns';
import { applyPatterns } from '#/llm/protocol/rewrite';
import type { TokenUsage } from '#/llm/usage';

import { CONTEXT_MANAGEMENT_BETA } from './contract';
import type {
  AnthropicRawStreamEvent,
  AnthropicRawUsage,
  AnthropicWireMessage,
} from './contract';
import { lowerMessage, messageContent } from './lower';
import { audioToPlaceholder, stripUnsignedThinking } from './patterns';
import {
  resolveDefaultMaxTokens,
  shouldPreserveUnsignedThinking,
} from './profile';

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

function injectCacheControlOnLastBlock(messages: AnthropicWireMessage[]): void {
  const lastMessage = messages.at(-1);
  if (lastMessage === undefined) return;
  const content = messageContent(lastMessage);
  const lastBlock = content.at(-1);
  if (lastBlock === undefined) return;
  if (CACHEABLE_TYPES.has(lastBlock.type)) {
    lastBlock.cache_control = CACHE_CONTROL;
  }
}

function isToolResultOnly(message: AnthropicWireMessage): boolean {
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

function parseRawUsage(usage: AnthropicRawUsage | undefined): Partial<TokenUsage> | undefined {
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

export function applyAnthropicResponseFormat(
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

export function applyAnthropicThinkingKeep(
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

export function encodeAnthropicMaxTokens(cap: number): Record<string, unknown> {
  return { max_tokens: cap };
}

export function defaultAnthropicTool(tool: ToolDescription): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

export function defaultAnthropicMergeHistory(
  messages: readonly AnthropicWireMessage[],
): AnthropicWireMessage[] {
  return applyPatterns(messages, [
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

export interface AnthropicLoweredMessage {
  readonly source: Message;
  readonly message: AnthropicWireMessage;
}

export function lowerAnthropicRequest(
  input: FormatRequestInput,
  acceptedMimes: ReadonlySet<string>,
): AnthropicLoweredMessage[] {
  const normalized = applyPatterns(input.messages, [
    stripUnsignedThinking({ preserve: shouldPreserveUnsignedThinking(input.model.model) }),
    audioToPlaceholder,
  ]);
  return normalized.flatMap((message) =>
    lowerMessage(message, acceptedMimes).map((wire) => ({ source: message, message: wire })),
  );
}

export interface AnthropicRequestParams {
  readonly params: Anthropic.MessageCreateParamsStreaming;
  readonly betas: readonly string[];
  readonly useBetaApi: boolean;
}

export interface AnthropicFormatOptions {
  readonly betaApi?: boolean;
}

export interface AnthropicRequestParts {
  readonly messages: readonly AnthropicWireMessage[];
  readonly tools: readonly Record<string, unknown>[];
  readonly kwargs: Readonly<Record<string, unknown>>;
  readonly betaApi: boolean;
}

export interface AnthropicRequestAssembly {
  readonly params: Record<string, unknown>;
  readonly betas: readonly string[];
  readonly useBetaApi: boolean;
}

export function assembleAnthropicRequest(
  input: FormatRequestInput,
  parts: AnthropicRequestParts,
): AnthropicRequestAssembly {
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

export function encodeAnthropicRequest(
  assembly: AnthropicRequestAssembly,
): AnthropicRequestParams {
  return {
    params: assembly.params as unknown as Anthropic.MessageCreateParamsStreaming,
    betas: assembly.betas,
    useBetaApi: assembly.useBetaApi,
  };
}

export function createAnthropicFormat(): ProtocolFormat<AnthropicRawStreamEvent> {
  return {
    createStreamParser() {
      return (chunk, sink) => {
        if (chunk.type === 'message_start') {
          const messageId = chunk.message?.id;
          if (typeof messageId === 'string' && messageId.length > 0) {
            sink.onMessageId?.(messageId);
          }
          const usage = parseRawUsage(chunk.message?.usage);
          if (usage !== undefined) {
            const inputUsage = { ...usage };
            delete inputUsage.output;
            sink.onUsage?.(inputUsage);
          }
          return;
        }
        if (chunk.type === 'message_delta') {
          const usage = parseRawUsage(chunk.usage);
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

export const anthropicFormat: ProtocolFormat<AnthropicRawStreamEvent> = createAnthropicFormat();

export function convertAnthropicError(
  error: unknown,
  convertErrorHook?: (error: unknown) => LlmRemoteErrorMessage | undefined,
): LlmRemoteErrorMessage {
  if (isAbortError(error)) {
    return toLlmErrorMessage(error);
  }
  const hooked = convertErrorHook?.(error);
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
