import { GoogleGenAI as GenAIClient, type GenerateContentParameters } from '@google/genai';

import type { ToolDescription } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import type { ProtocolBase, ProtocolRequesterOptions, TraitContext } from '#/llm/protocol/base';
import { resolveMaxCompletionCap, type FormatRequestInput } from '#/llm/protocol/format';
import { asLowered } from '#/llm/protocol/protocol';
import { composeProtocolRequest } from '#/llm/protocol/runner';
import { applyThinking, type ThinkingStrategy } from '#/llm/protocol/thinking';
import { encodeGoogleGenAISampling } from './sampling';
import type { LlmClientContext, LlmRequesterOptions } from '#/llm/requester/requester';

import {
  applyResponseFormat,
  assemble,
  convertError,
  createFormat,
  defaultTool,
  encodeMaxTokens,
  encode,
  encodeThinking,
  lower,
  type Request,
  type NativeMessage,
} from './codec';

export type {
  Request as GoogleGenAIRequest,
  NativeMessage as GoogleGenAINativeMessage,
  NativePart as GoogleGenAINativePart,
} from './codec';

export interface GoogleGenAIExtraParams {
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly candidateCount?: number;
  readonly seed?: number;
  readonly stopSequences?: readonly string[];
  readonly presencePenalty?: number;
  readonly frequencyPenalty?: number;
  readonly thinkingConfig?: { includeThoughts?: boolean; thinkingBudget?: number };
}

const GEMINI_CATALOGUED_PREFIXES = [
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-pro',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
] as const;

const GEMINI_MULTIMODAL_TOOL_CAPABILITY = Object.freeze({
  image_in: true,
  video_in: true,
  audio_in: true,
  thinking: false,
  tool_use: true,
});

const GEMINI_THINKING_MULTIMODAL_TOOL_CAPABILITY = Object.freeze({
  image_in: true,
  video_in: true,
  audio_in: true,
  thinking: true,
  tool_use: true,
});

export function getGoogleGenAIModelCapability(modelName: string) {
  const normalized = modelName.toLowerCase();
  if (!normalized.startsWith('gemini-')) return undefined;
  if (!GEMINI_CATALOGUED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return undefined;
  }

  if (normalized.startsWith('gemini-2.5-') || normalized.includes('thinking')) {
    return GEMINI_THINKING_MULTIMODAL_TOOL_CAPABILITY;
  }
  return GEMINI_MULTIMODAL_TOOL_CAPABILITY;
}

export interface GoogleGenAITrait {
  readonly thinking?: ThinkingStrategy;

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
}

export interface GoogleGenAIRequesterOptions
  extends ProtocolRequesterOptions<GoogleGenAITrait>,
    LlmRequesterOptions<GenAIClient> {
  readonly vertexai?: boolean;
  readonly extras?: GoogleGenAIExtraParams;
}

export interface GoogleGenAIRequestPreparationOptions {
  readonly trait?: GoogleGenAITrait;
  readonly extras?: GoogleGenAIExtraParams;
}

export async function prepareGoogleGenAIRequest(
  input: FormatRequestInput,
  options?: GoogleGenAIRequestPreparationOptions,
): Promise<Request> {
  const trait = options?.trait;
  return composeProtocolRequest<
    NativeMessage,
    Record<string, unknown>,
    Request,
    GoogleGenAITrait
  >(input, trait, {
    encodeSampling: encodeGoogleGenAISampling,
    extras: options?.extras,
    encodeKwargs: (current, currentTrait, ctx) => {
      let kwargs: Record<string, unknown> = {};
      let preserveThinking = false;
      if (current.thinking !== undefined) {
        const applied = applyThinking(
          kwargs,
          current.thinking,
          currentTrait?.thinking,
          ctx,
          (thinking, thinkingCtx) => ({
            thinkingConfig: encodeThinking(thinkingCtx.model.model, thinking.effort),
          }),
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
      return { kwargs, preserveThinking };
    },
    lower: async (current) => asLowered(await lower(current)),
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

function createClient(
  model: LlmModel,
  headers: Record<string, string> | undefined,
  vertexai: boolean,
): GenAIClient {
  const httpOptions: { headers?: Record<string, string>; baseUrl?: string } = {};
  if (headers !== undefined) {
    httpOptions.headers = headers;
  }
  if (model.baseUrl !== undefined) {
    httpOptions.baseUrl = model.baseUrl;
  }
  return new GenAIClient({
    apiKey: model.apiKey,
    vertexai: vertexai ? true : undefined,
    httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
  });
}

function createAbortException(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

async function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    throw createAbortException();
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(createAbortException());
      },
      { once: true },
    );
  });
}

async function* abortableStream<T>(
  stream: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  for await (const chunk of stream) {
    if (signal.aborted) {
      throw createAbortException();
    }
    yield chunk;
  }
}

export function bindGoogleGenAI(options?: GoogleGenAIRequesterOptions) {
  const connection = options?.connection;
  const trait = options?.trait;
  const classifyError = options?.classifyError;
  const format = createFormat();
  const vertexai = options?.vertexai === true;
  const resolveClient =
    options?.clientFactory ??
    ((request: LlmClientContext) =>
      createClient(request.model, request.headers, vertexai || request.model.vertexai === true));
  return {
    connection,
    prepare: (input: FormatRequestInput) =>
      prepareGoogleGenAIRequest(input, { trait, extras: options?.extras }),
    createClient: resolveClient,
    requestHeaders: (request: Request) => request.headers,
    send: async (client: GenAIClient, request: Request, signal: AbortSignal) => {
      const models = client.models as unknown as {
        generateContentStream(
          params: GenerateContentParameters,
        ): Promise<AsyncIterable<Record<string, unknown>>>;
      };
      const stream = await Promise.race([
        models.generateContentStream(request.params),
        abortPromise(signal),
      ]);
      return { stream: abortableStream(stream, signal) };
    },
    createStreamParser: () => format.createStreamParser(),
    classifyError: (error: unknown) => convertError(error, (e) => classifyError?.(e)),
  };
}

export function createGoogleGenAIBase(
  options?: Pick<GoogleGenAIRequesterOptions, 'clientFactory' | 'vertexai' | 'extras'>,
): ProtocolBase<GoogleGenAITrait> {
  return {
    capability: getGoogleGenAIModelCapability,
    bind: (bindOptions) => bindGoogleGenAI({ ...options, ...bindOptions }),
  };
}

export const googleGenAIBase: ProtocolBase<GoogleGenAITrait> = createGoogleGenAIBase();
