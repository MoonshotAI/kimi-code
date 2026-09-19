import OpenAI from 'openai';

import { headersToRecord } from '#/llm/errors';
import type { Message, ToolDescription } from '#/llm/message';
import { modelKey, type LlmModel } from '#/llm/model';
import type { ProtocolBase, ProtocolRequesterOptions, TraitContext } from '#/llm/protocol/base';
import { resolveMaxCompletionCap, type FormatRequestInput } from '#/llm/protocol/format';
import type { ProtocolHandle } from '#/llm/protocol/protocol';
import { composeProtocolRequest } from '#/llm/protocol/runner';
import { applyThinking, type ThinkingStrategy } from '#/llm/protocol/thinking';
import { encodeOpenAISampling } from './sampling';
import type {
  LlmClientContext,
  LlmRequesterOptions,
  ToolCallIdPolicy,
  ToolMessageConversion,
} from '#/llm/requester/requester';
import { encodeReasoningEffortFallback } from '#/llm/thinking';

import { sanitizeToolCallId } from '#/llm/protocol/tool-call-id';
import {
  applyResponseFormat,
  assemble,
  convertError,
  createFormat,
  defaultTool,
  encodeCacheKey,
  encodeMaxTokens,
  encode,
  encodeThinkHistory,
  lower,
  parseUsage,
  type RawChunk,
  type RawUsage,
  type Request,
  type NativeMessage,
} from './codec';
import { DEFAULT_REASONING_KEY, ReasoningKeyDialect } from './reasoning-key';

export type {
  RawChunk as OpenAIRawChunk,
  RawStreamToolCallDelta as OpenAIRawStreamToolCallDelta,
  RawUsage as OpenAIRawUsage,
  Request as OpenAIRequest,
  NativeMessage as OpenAINativeMessage,
  NativePart as OpenAINativePart,
  NativeToolCall as OpenAINativeToolCall,
} from './codec';

export interface OpenAIExtraParams {
  readonly temperature?: number;
  readonly top_p?: number;
  readonly stop?: string | readonly string[];
  readonly n?: number;
  readonly seed?: number;
  readonly presence_penalty?: number;
  readonly frequency_penalty?: number;
  readonly logit_bias?: Record<string, number>;
  readonly logprobs?: boolean;
  readonly top_logprobs?: number;
  readonly parallel_tool_calls?: boolean;
  readonly service_tier?: string;
  readonly user?: string;
  readonly extra_body?: Record<string, unknown>;
}

export const OPENAI_REASONING_CAPABILITY = Object.freeze({
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
});

export const OPENAI_VISION_TOOL_CAPABILITY = Object.freeze({
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
});

export const OPENAI_TEXT_TOOL_CAPABILITY = Object.freeze({
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
});

export const OPENAI_VISION_TOOL_PREFIXES = ['gpt-4o', 'gpt-4-turbo', 'gpt-4.1', 'gpt-4.5'] as const;

export function isOpenAIReasoningModel(normalizedModelName: string): boolean {
  return /^o\d/.test(normalizedModelName);
}

export function hasModelPrefix(modelName: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => modelName.startsWith(prefix));
}

export function getOpenAILegacyModelCapability(modelName: string) {
  const normalized = modelName.toLowerCase();
  if (isOpenAIReasoningModel(normalized)) {
    return OPENAI_REASONING_CAPABILITY;
  }
  if (hasModelPrefix(normalized, OPENAI_VISION_TOOL_PREFIXES)) {
    return OPENAI_VISION_TOOL_CAPABILITY;
  }
  if (normalized.startsWith('gpt-3.5-turbo')) {
    return OPENAI_TEXT_TOOL_CAPABILITY;
  }
  return undefined;
}

export interface OpenAITrait {
  readonly reasoningKey?: string;
  readonly toolCallIdPolicy?: ToolCallIdPolicy;
  readonly toolMessageConversion?: ToolMessageConversion;
  readonly strictThinkingValidation?: boolean;

  readonly thinking?: ThinkingStrategy;

  encodeCacheKey?(key: string, ctx: TraitContext): Record<string, unknown> | undefined;

  encodeMaxCompletionTokens?(
    maxCompletionTokens: number,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  convertTool?(tool: ToolDescription, ctx: TraitContext): Record<string, unknown> | undefined;

  convertMessage?(
    message: Message,
    converted: NativeMessage,
    ctx: TraitContext,
  ): NativeMessage | null;

  mergeHistory?(
    messages: readonly NativeMessage[],
    ctx: TraitContext,
  ): NativeMessage[] | undefined;

  buildParams?(
    params: Record<string, unknown>,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  extractUsage?(chunk: RawChunk): RawUsage | null | undefined;
}

const OPENAI_CHAT_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
  maxLength: 64,
};

function createClient(model: LlmModel, headers: Record<string, string> | undefined): OpenAI {
  return new OpenAI({
    apiKey: model.apiKey ?? 'unused',
    baseURL: model.baseUrl,
    defaultHeaders: headers,
    maxRetries: 0,
  });
}

export interface OpenAIRequesterOptions
  extends ProtocolRequesterOptions<OpenAITrait>,
    LlmRequesterOptions<OpenAI> {
  readonly extras?: OpenAIExtraParams;
}

export interface OpenAIRequestPreparationOptions {
  readonly trait?: OpenAITrait;
  readonly reasoningKey?: string;
  readonly extras?: OpenAIExtraParams;
}

export async function prepareOpenAIRequest(
  input: FormatRequestInput,
  options?: OpenAIRequestPreparationOptions,
): Promise<Request> {
  const trait = options?.trait;
  return composeProtocolRequest<
    NativeMessage,
    Record<string, unknown>,
    Request,
    OpenAITrait
  >(input, trait, {
    encodeSampling: encodeOpenAISampling,
    extras: options?.extras,
    encodeKwargs: (current, currentTrait, ctx) => {
      let kwargs: Record<string, unknown> = {};
      if (current.cacheKey !== undefined) {
        kwargs = {
          ...kwargs,
          ...(currentTrait?.encodeCacheKey?.(current.cacheKey, ctx) ??
            encodeCacheKey(current.cacheKey)),
        };
      }
      let preserveThinking = false;
      if (current.thinking !== undefined) {
        const applied = applyThinking(
          kwargs,
          current.thinking,
          currentTrait?.thinking,
          ctx,
          (thinking, thinkingCtx) =>
            encodeReasoningEffortFallback(
              thinking,
              thinkingCtx.model,
              currentTrait?.strictThinkingValidation === true,
            ),
        );
        kwargs = applied.kwargs;
        preserveThinking = applied.preserveThinking;
      }
      if (current.responseFormat !== undefined) {
        kwargs = applyResponseFormat(kwargs, current.responseFormat);
      }
      const cap = resolveMaxCompletionCap(current);
      if (cap !== undefined) {
        kwargs = {
          ...kwargs,
          ...(currentTrait?.encodeMaxCompletionTokens?.(cap, ctx) ??
            encodeMaxTokens(ctx.model.model, cap)),
        };
      }
      if (
        currentTrait?.thinking === undefined &&
        current.thinking?.effort !== 'off' &&
        kwargs['reasoning_effort'] === undefined &&
        current.messages.some((message) => message.content.some((part) => part.type === 'think'))
      ) {
        kwargs = { ...kwargs, ...encodeThinkHistory() };
      }
      return { kwargs, preserveThinking };
    },
    lower: (current, currentTrait, _ctx, extras) =>
      lower(current, {
        reasoningKey: options?.reasoningKey ?? DEFAULT_REASONING_KEY,
        preserveThinking: extras.preserveThinking,
        toolMessageConversion: currentTrait?.toolMessageConversion,
      }),
    defaultTool,
    assemble: (current, parts) =>
      assemble(current, {
        messages: parts.messages,
        tools: parts.tools as Record<string, unknown>[],
        kwargs: parts.kwargs,
      }),
    encode: (assembled, applyParams) => encode(applyParams(assembled)),
  });
}

export function bindOpenAI(
  options?: OpenAIRequesterOptions,
): ProtocolHandle<Request, RawChunk, OpenAI> {
  const connection = options?.connection;
  const trait = options?.trait;
  const classifyError = options?.classifyError;
  const format = createFormat();
  const resolveClient =
    options?.clientFactory ??
    ((request: LlmClientContext) => createClient(request.model, request.headers));
  const reasoningByModel = new Map<string, ReasoningKeyDialect>();
  const reasoningFor = (ctx: TraitContext): ReasoningKeyDialect => {
    const key = modelKey(ctx.model);
    let reasoning = reasoningByModel.get(key);
    if (reasoning === undefined) {
      reasoning = new ReasoningKeyDialect(trait?.reasoningKey);
      reasoningByModel.set(key, reasoning);
    }
    return reasoning;
  };
  return {
    connection,
    toolCallIdPolicy: trait?.toolCallIdPolicy ?? OPENAI_CHAT_TOOL_CALL_ID_POLICY,
    prepare: (input, ctx) =>
      prepareOpenAIRequest(input, {
        trait,
        reasoningKey: reasoningFor(ctx).outboundKey(),
        extras: options?.extras,
      }),
    createClient: resolveClient,
    requestHeaders: (request) => request.headers,
    send: async (client, request, signal) => {
      const { data: stream, response } = await client.chat.completions
        .create(request.params, { signal })
        .withResponse();
      return { stream, headers: headersToRecord(response.headers) ?? {} };
    },
    createStreamParser: (ctx) => {
      const parse = format.createStreamParser({
        resolveUsage:
          trait?.extractUsage === undefined
            ? undefined
            : (chunk, defaultUsage) => {
                const hooked = trait.extractUsage?.(chunk);
                return hooked !== undefined ? parseUsage(hooked) : defaultUsage;
              },
      });
      const reasoning = reasoningFor(ctx);
      return (chunk, sink) => {
        reasoning.observe(chunk.choices?.[0]?.delta);
        parse(chunk, sink);
      };
    },
    classifyError: (error) => convertError(error, (e) => classifyError?.(e)),
  };
}

export const openAIBase: ProtocolBase<OpenAITrait> = {
  capability: getOpenAILegacyModelCapability,
  bind: bindOpenAI,
};
