import Anthropic, {
  APIConnectionError as RawAnthropicSDKConnectionError,
  APIConnectionTimeoutError as RawAnthropicSDKConnectionTimeoutError,
  APIError as RawAnthropicSDKAPIError,
} from '@anthropic-ai/sdk';
import { assign, shake } from 'radashi';

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
import type { ToolDescription } from '#/llm/message';
import { applyThinking } from '#/llm/protocol/trait';
import { mergeConsecutiveUsers } from '#/llm/protocol/patterns';
import { applyPatterns } from '#/llm/protocol/rewrite';
import type { TokenUsage } from '#/llm/usage';

import { lowerMessage, messageContent, type AnthropicWireMessage } from './lower';
import { audioToPlaceholder, stripUnsignedThinking } from './patterns';
import {
  encodeThinking,
  INTERLEAVED_THINKING_BETA,
  resolveDefaultMaxTokens,
  shouldPreserveUnsignedThinking,
} from './profile';

export { INTERLEAVED_THINKING_BETA } from './profile';
export const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';

const CLEAR_THINKING_EDIT = 'clear_thinking_20251015';

type RawUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

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

export type { AnthropicWireContentBlock, AnthropicWireMessage } from './lower';

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

interface RawContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface RawStreamDelta {
  type?: string;
  text?: string;
  thinking?: string;
  partial_json?: string;
  signature?: string;
  stop_reason?: string | null;
  stop_sequence?: string | null;
}

interface RawStreamEvent {
  type: string;
  index?: number;
  content_block?: RawContentBlock;
  delta?: RawStreamDelta;
  message?: { id?: string; usage?: RawUsage };
  usage?: RawUsage;
}

type RawResponse = { content?: RawContentBlock[]; usage?: RawUsage };

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

function parseRawUsage(usage: RawUsage | undefined): Partial<TokenUsage> | undefined {
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

function applyResponseFormat(
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

function applyThinkingKeep(kwargs: Record<string, unknown>, keep: string): Record<string, unknown> {
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

function resolveRequestKwargs(input: FormatRequestInput): Record<string, unknown> {
  const {
    trait,
    ctx,
    thinking,
    responseFormat,
    maxCompletionTokens,
    usedContextTokens,
    maxContextTokens,
    extraParams,
  } = input;
  let kwargs: Record<string, unknown> = { betaFeatures: [INTERLEAVED_THINKING_BETA] };
  if (thinking !== undefined) {
    kwargs = applyThinking(kwargs, thinking, trait, ctx, (t, c) =>
      encodeThinking(t, c.model),
    ).kwargs;
  }
  if (responseFormat !== undefined) {
    kwargs = applyResponseFormat(kwargs, responseFormat);
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
    cap = resolveDefaultMaxTokens(ctx.model.model, cap);
    const hooked = trait?.withMaxCompletionTokens?.(cap, ctx);
    if (hooked !== undefined) {
      kwargs = { ...kwargs, ...hooked };
    } else {
      kwargs = { ...kwargs, max_tokens: cap };
    }
  }
  kwargs = assign(kwargs, extraParams?.anthropic ?? {});
  if (thinking?.keep !== undefined) {
    kwargs = applyThinkingKeep(kwargs, thinking.keep);
  }
  kwargs = shake(kwargs);
  return kwargs;
}

export interface AnthropicRequestParams {
  readonly params: Anthropic.MessageCreateParamsStreaming;
  readonly betas: readonly string[];
  readonly useBetaApi: boolean;
}

export interface AnthropicFormatOptions {
  readonly betaApi?: boolean;
}

export function createAnthropicFormat(
  options?: AnthropicFormatOptions,
): ProtocolFormat<AnthropicRequestParams, RawResponse, RawStreamEvent> {
  const betaApi = options?.betaApi === true;
  return {
    formatRequest(input) {
      const { messages, systemPrompt, tools, trait, ctx, cacheKey, thinking } = input;
      const kwargs = resolveRequestKwargs(input);
      const normalized = applyPatterns(messages, [
        stripUnsignedThinking({ preserve: shouldPreserveUnsignedThinking(ctx.model.model) }),
        audioToPlaceholder,
      ]);
      const converted = normalized.flatMap((message) => lowerMessage(message, { trait, ctx }));
      const merged =
        (trait?.mergeHistory?.(converted, ctx) as AnthropicWireMessage[] | undefined) ??
        applyPatterns(converted, [
          mergeConsecutiveUsers({
            isUser: (param) => param.role === 'user',
            isToolResultOnly,
            merge: (last, next) => ({
              ...last,
              content: [...messageContent(last), ...messageContent(next)],
            }),
          }),
        ]);
      injectCacheControlOnLastBlock(merged);
      const formattedTools: Record<string, unknown>[] = tools.map(
        (tool) => trait?.convertTool?.(tool, ctx) ?? defaultConvertTool(tool),
      );
      const lastTool = formattedTools.at(-1);
      if (lastTool !== undefined) {
        lastTool['cache_control'] = CACHE_CONTROL;
      }
      const { betaFeatures, ...restKwargs } = kwargs;
      const betas = Array.isArray(betaFeatures) ? (betaFeatures as string[]) : [];
      const useBetaApi = betaApi || thinking?.keep !== undefined;
      const createParams: Record<string, unknown> = {
        model: ctx.model.model,
        max_tokens: resolveDefaultMaxTokens(ctx.model.model),
        metadata: cacheKey === undefined ? undefined : { user_id: cacheKey },
        ...restKwargs,
        system: systemPrompt
          ? [{ type: 'text', text: systemPrompt, cache_control: CACHE_CONTROL }]
          : undefined,
        messages: merged,
        tools: formattedTools.length === 0 ? undefined : formattedTools,
        betas: useBetaApi && betas.length > 0 ? betas : undefined,
        stream: true,
      };
      const finalParams = trait?.buildParams?.(createParams, ctx) ?? createParams;
      return {
        params: finalParams as unknown as Anthropic.MessageCreateParamsStreaming,
        betas,
        useBetaApi,
      };
    },

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

export const anthropicFormat: ProtocolFormat<AnthropicRequestParams, RawResponse, RawStreamEvent> =
  createAnthropicFormat();

function defaultConvertTool(tool: ToolDescription): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

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
