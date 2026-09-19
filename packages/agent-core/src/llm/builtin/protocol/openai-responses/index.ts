import OpenAI from 'openai';

import { headersToRecord } from '#/llm/errors';
import type { ToolDescription } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import type { ProtocolBase, ProtocolRequesterOptions, TraitContext } from '#/llm/protocol/base';
import { resolveMaxCompletionCap, type FormatRequestInput } from '#/llm/protocol/format';
import { asLowered, type ProtocolHandle } from '#/llm/protocol/protocol';
import { composeProtocolRequest } from '#/llm/protocol/runner';
import { applyThinking, type ThinkingStrategy } from '#/llm/protocol/thinking';
import { encodeOpenAIResponsesSampling } from './sampling';
import type {
  LlmClientContext,
  LlmRequesterOptions,
  ToolCallIdPolicy,
  ToolMessageConversion,
} from '#/llm/requester/requester';
import { encodeReasoningEffortFallback } from '#/llm/thinking';

import {
  hasModelPrefix,
  isOpenAIReasoningModel,
  OPENAI_REASONING_CAPABILITY,
  OPENAI_VISION_TOOL_CAPABILITY,
  OPENAI_VISION_TOOL_PREFIXES,
} from '../openai/index';
import { convertError } from '../openai/codec';
import { sanitizeOpenAIResponsesCallId } from './tool-call-id';
import {
  applyResponseFormat,
  assemble,
  createFormat,
  defaultTool,
  encodeCacheKey,
  encodeMaxTokens,
  encode,
  lower,
  normalizeReasoning,
  parseUsage,
  type RawChunk,
  type RawUsage,
  type Request,
  type NativeMessage,
} from './codec';

export { sanitizeOpenAIResponsesCallId } from './tool-call-id';
export type {
  RawChunk as OpenAIResponsesRawChunk,
  RawUsage as OpenAIResponsesRawUsage,
  Request as OpenAIResponsesRequest,
  NativeMessage as OpenAIResponsesNativeMessage,
  NativePart as OpenAIResponsesNativePart,
} from './codec';

export interface OpenAIResponsesExtraParams {
  readonly temperature?: number;
  readonly top_p?: number;
  readonly include?: readonly string[];
  readonly metadata?: Record<string, string>;
  readonly parallel_tool_calls?: boolean;
  readonly service_tier?: string;
  readonly store?: boolean;
  readonly truncation?: 'auto' | 'disabled';
  readonly user?: string;
  readonly text?: { verbosity?: 'low' | 'medium' | 'high' };
  readonly reasoning?: { effort?: string; summary?: 'auto' | 'concise' | 'detailed' };
}

export function getOpenAIResponsesModelCapability(modelName: string) {
  const normalized = modelName.toLowerCase();
  if (isOpenAIReasoningModel(normalized)) {
    return OPENAI_REASONING_CAPABILITY;
  }
  if (hasModelPrefix(normalized, OPENAI_VISION_TOOL_PREFIXES)) {
    return OPENAI_VISION_TOOL_CAPABILITY;
  }
  return undefined;
}

export interface OpenAIResponsesTrait {
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

const OPENAI_RESPONSES_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeOpenAIResponsesCallId(id, 64),
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

export interface OpenAIResponsesRequesterOptions
  extends ProtocolRequesterOptions<OpenAIResponsesTrait>,
    LlmRequesterOptions<OpenAI> {
  readonly extras?: OpenAIResponsesExtraParams;
}

export interface OpenAIResponsesRequestPreparationOptions {
  readonly trait?: OpenAIResponsesTrait;
  readonly extras?: OpenAIResponsesExtraParams;
}

export async function prepareOpenAIResponsesRequest(
  input: FormatRequestInput,
  options?: OpenAIResponsesRequestPreparationOptions,
): Promise<Request> {
  const trait = options?.trait;
  return composeProtocolRequest<
    NativeMessage,
    Record<string, unknown>,
    Request,
    OpenAIResponsesTrait
  >(input, trait, {
    encodeSampling: encodeOpenAIResponsesSampling,
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
          ...(currentTrait?.encodeMaxCompletionTokens?.(cap, ctx) ?? encodeMaxTokens(cap)),
        };
      }
      return { kwargs: normalizeReasoning(kwargs), preserveThinking };
    },
    lower: async (current, currentTrait) =>
      asLowered(
        await lower(current, {
          extractText: currentTrait?.toolMessageConversion === 'extract_text',
        }),
      ),
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

export function bindOpenAIResponses(
  options?: OpenAIResponsesRequesterOptions,
): ProtocolHandle<Request, unknown, OpenAI> {
  const connection = options?.connection;
  const trait = options?.trait;
  const classifyError = options?.classifyError;
  const format = createFormat();
  const resolveClient =
    options?.clientFactory ??
    ((request: LlmClientContext) => createClient(request.model, request.headers));
  return {
    connection,
    toolCallIdPolicy: trait?.toolCallIdPolicy ?? OPENAI_RESPONSES_TOOL_CALL_ID_POLICY,
    prepare: (input) => prepareOpenAIResponsesRequest(input, { trait, extras: options?.extras }),
    createClient: resolveClient,
    requestHeaders: (request) => request.headers,
    send: async (client, request, signal) => {
      const { data: stream, response } = await client.responses
        .create(request.params, { signal })
        .withResponse();
      return { stream, headers: headersToRecord(response.headers) ?? {} };
    },
    createStreamParser: () =>
      format.createStreamParser({
        resolveUsage:
          trait?.extractUsage === undefined
            ? undefined
            : (chunk, defaultUsage) => {
                const hooked = trait.extractUsage?.(chunk as RawChunk);
                return hooked !== undefined ? parseUsage(hooked) : defaultUsage;
              },
      }),
    classifyError: (error) => convertError(error, (e) => classifyError?.(e)),
  };
}

export const openAIResponsesBase: ProtocolBase<OpenAIResponsesTrait> = {
  capability: getOpenAIResponsesModelCapability,
  bind: bindOpenAIResponses,
};
