import Anthropic from '@anthropic-ai/sdk';

import { headersToRecord } from '#/llm/errors';
import { providerImagePolicy } from '#/llm/media/image-formats';
import type { Message, ToolDescription } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import type { ProtocolBase, ProtocolRequesterOptions, TraitContext } from '#/llm/protocol/base';
import { resolveMaxCompletionCap, type FormatRequestInput } from '#/llm/protocol/format';
import { composeProtocolRequest } from '#/llm/protocol/runner';
import { applyThinking, type ThinkingStrategy } from '#/llm/protocol/thinking';
import { encodeAnthropicSampling } from './sampling';
import type { LlmClientContext, LlmRequesterOptions, ToolCallIdPolicy } from '#/llm/requester/requester';

import { sanitizeToolCallId } from '#/llm/protocol/tool-call-id';
import {
  applyResponseFormat,
  applyThinkingKeep,
  assemble,
  convertError,
  createFormat,
  defaultMergeHistory,
  defaultTool,
  encodeMaxTokens,
  encode,
  lower,
  type FormatOptions,
  type Assembled,
  type Request,
  type NativeMessage,
} from './codec';
import { encodeThinking, INTERLEAVED_THINKING_BETA, resolveDefaultMaxTokens } from './profile';

export type {
  FormatOptions as AnthropicFormatOptions,
  RawBlock as AnthropicRawBlock,
  RawChunk as AnthropicRawChunk,
  RawUsage as AnthropicRawUsage,
  Request as AnthropicRequest,
  NativePart as AnthropicNativePart,
  NativeMessage as AnthropicNativeMessage,
} from './codec';
export { CONTEXT_MANAGEMENT_BETA } from './codec';

export interface AnthropicExtraParams {
  readonly temperature?: number;
  readonly top_p?: number;
  readonly top_k?: number;
  readonly stop_sequences?: readonly string[];
}

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
});

const ANTHROPIC_THINKING_VISION_TOOL_CAPABILITY = Object.freeze({
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
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

export interface AnthropicTrait {
  readonly toolCallIdPolicy?: ToolCallIdPolicy;

  readonly thinking?: ThinkingStrategy;

  encodeMaxCompletionTokens?(
    maxCompletionTokens: number,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  convertTool?(tool: ToolDescription, ctx: TraitContext): Record<string, unknown> | undefined;

  acceptedImageMimes?(ctx: TraitContext): ReadonlySet<string> | undefined;

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
}

const ANTHROPIC_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
  maxLength: 64,
};

export interface AnthropicRequesterOptions
  extends ProtocolRequesterOptions<AnthropicTrait>,
    FormatOptions,
    LlmRequesterOptions<Anthropic> {
  readonly extras?: AnthropicExtraParams;
}

function anthropicCustomHeaderEnvNames(): string[] {
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

function buildDefaultHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string | null> {
  const defaultHeaders: Record<string, string | null> = { authorization: null };
  for (const name of anthropicCustomHeaderEnvNames()) {
    defaultHeaders[name] = null;
  }
  for (const [name, value] of Object.entries(headers ?? {})) {
    defaultHeaders[name.toLowerCase()] = value;
  }
  return defaultHeaders;
}

function createClient(model: LlmModel, headers: Record<string, string> | undefined): Anthropic {
  return new Anthropic({
    apiKey: model.apiKey ?? 'unused',
    authToken: null,
    baseURL: model.baseUrl ?? null,
    defaultHeaders: buildDefaultHeaders(headers),
    maxRetries: 0,
  });
}

export interface AnthropicRequestPreparationOptions {
  readonly trait?: AnthropicTrait;
  readonly betaApi?: boolean;
  readonly extras?: AnthropicExtraParams;
}

export async function prepareAnthropicRequest(
  input: FormatRequestInput,
  options?: AnthropicRequestPreparationOptions,
): Promise<Request> {
  const trait = options?.trait;
  return composeProtocolRequest<
    NativeMessage,
    Assembled,
    Request,
    AnthropicTrait
  >(input, trait, {
    encodeSampling: encodeAnthropicSampling,
    extras: options?.extras,
    encodeKwargs: (current, currentTrait, ctx) => {
      let kwargs: Record<string, unknown> = { betaFeatures: [INTERLEAVED_THINKING_BETA] };
      let preserveThinking = false;
      if (current.thinking !== undefined) {
        const applied = applyThinking(
          kwargs,
          current.thinking,
          currentTrait?.thinking,
          ctx,
          (thinking, thinkingCtx) => encodeThinking(thinking, thinkingCtx.model),
        );
        kwargs = applied.kwargs;
        preserveThinking = applied.preserveThinking;
      }
      if (current.responseFormat !== undefined) {
        kwargs = applyResponseFormat(kwargs, current.responseFormat);
      }
      const cap = resolveMaxCompletionCap(current);
      if (cap !== undefined) {
        const capped = resolveDefaultMaxTokens(ctx.model.model, cap);
        kwargs = {
          ...kwargs,
          ...(currentTrait?.encodeMaxCompletionTokens?.(capped, ctx) ?? encodeMaxTokens(capped)),
        };
      }
      return { kwargs, preserveThinking };
    },
    sealKwargs: (kwargs, current) =>
      current.thinking?.keep === undefined
        ? kwargs
        : applyThinkingKeep(kwargs, current.thinking.keep),
    lower: (current, currentTrait) =>
      lower(
        current,
        currentTrait?.acceptedImageMimes?.({ model: current.model }) ??
          providerImagePolicy().acceptedMimes,
      ),
    defaultMergeHistory,
    defaultTool,
    assemble: (current, parts) =>
      assemble(current, {
        messages: parts.messages,
        tools: parts.tools as Record<string, unknown>[],
        kwargs: parts.kwargs,
        betaApi: options?.betaApi === true,
      }),
    encode: (assembled, applyParams) =>
      encode({ ...assembled, params: applyParams(assembled.params) }),
  });
}

export function bindAnthropic(options?: AnthropicRequesterOptions) {
  const connection = options?.connection;
  const trait = options?.trait;
  const classifyError = options?.classifyError;
  const format = createFormat();
  const resolveClient =
    options?.clientFactory ??
    ((request: LlmClientContext) => createClient(request.model, request.headers));
  return {
    connection,
    toolCallIdPolicy: trait?.toolCallIdPolicy ?? ANTHROPIC_TOOL_CALL_ID_POLICY,
    prepare: (input: FormatRequestInput) =>
      prepareAnthropicRequest(input, {
        trait,
        betaApi: options?.betaApi,
        extras: options?.extras,
      }),
    createClient: resolveClient,
    send: async (client: Anthropic, request: Request, signal: AbortSignal) => {
      const betaHeaders =
        !request.useBetaApi && request.betas.length > 0
          ? { 'anthropic-beta': request.betas.join(',') }
          : undefined;
      const requestOptions = { signal, headers: betaHeaders };
      const { data: stream, response } = request.useBetaApi
        ? await client.beta.messages.create(request.params, requestOptions).withResponse()
        : await client.messages.create(request.params, requestOptions).withResponse();
      return { stream, headers: headersToRecord(response.headers) ?? {} };
    },
    createStreamParser: () => format.createStreamParser(),
    classifyError: (error: unknown) => convertError(error, (e) => classifyError?.(e)),
  };
}

export function createAnthropicBase(
  options?: AnthropicRequesterOptions,
): ProtocolBase<AnthropicTrait> {
  return {
    capability: getAnthropicModelCapability,
    bind: (bindOptions) => bindAnthropic({ ...options, ...bindOptions }),
  };
}

export const anthropicBase: ProtocolBase<AnthropicTrait> = createAnthropicBase();

export const anthropicBetaBase: ProtocolBase<AnthropicTrait> = createAnthropicBase({
  betaApi: true,
});
