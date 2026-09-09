import { GoogleGenAI as GenAIClient, type GenerateContentParameters } from '@google/genai';
import { assign, shake } from 'radashi';

import type { LlmModel } from '#/llm/model';
import { toLlmSyntaxErrorMessage } from '#/llm/syntax-errors';
import type { ProtocolBase, ProtocolRequesterOptions, TraitContext } from '#/llm/protocol/base';
import { resolveModelConnection } from '#/llm/protocol/connection';
import { applyThinking } from '#/llm/protocol/thinking';
import { resolveMaxCompletionCap, type FormatRequestInput } from '#/llm/protocol/format';
import {
  mergeRequestHeaders,
  type LlmClientContext,
  type LlmRequestConfig,
  type LlmRequestContent,
  type LlmRequestControl,
  type LlmRequester,
  type LlmRequesterOptions,
  type LlmRequestEvent,
} from '#/llm/requester/requester';

import { getGoogleGenAIModelCapability } from './capability';
import type { GoogleGenAITrait } from './trait';
import {
  applyGoogleGenAIResponseFormat,
  assembleGoogleGenAIRequest,
  convertGoogleGenAIError,
  createGoogleGenAIFormat,
  encodeGoogleGenAIMaxOutputTokens,
  encodeGoogleGenAIRequest,
  encodeGoogleGenAIThinking,
  messagesToGoogleGenAIContents,
  toolToGoogleGenAI,
  type GoogleGenAIRequestParams,
} from './format';

export interface GoogleGenAIRequesterOptions
  extends ProtocolRequesterOptions<GoogleGenAITrait>,
    LlmRequesterOptions<GenAIClient> {
  readonly vertexai?: boolean;
}

export interface GoogleGenAIRequestPlanOptions {
  readonly trait?: GoogleGenAITrait;
}

export function planGoogleGenAIRequest(
  input: FormatRequestInput,
  options?: GoogleGenAIRequestPlanOptions,
): GoogleGenAIRequestParams {
  const trait = options?.trait;
  const ctx: TraitContext = { model: input.model };
  let kwargs: Record<string, unknown> = {};
  if (input.thinking !== undefined) {
    kwargs = applyThinking(kwargs, input.thinking, trait?.thinking, ctx, (t, c) => ({
      thinkingConfig: encodeGoogleGenAIThinking(c.model.model, t.effort),
    })).kwargs;
  }
  const cap = resolveMaxCompletionCap(input);
  if (cap !== undefined) {
    kwargs = {
      ...kwargs,
      ...(trait?.maxCompletionTokens?.(cap, ctx) ?? encodeGoogleGenAIMaxOutputTokens(cap)),
    };
  }
  if (input.responseFormat !== undefined) {
    kwargs = applyGoogleGenAIResponseFormat(kwargs, input.responseFormat);
  }
  kwargs = shake(assign(kwargs, input.extraParams?.googleGenai ?? {}));

  const contents = messagesToGoogleGenAIContents(input.messages);
  const merged = trait?.mergeHistory?.(contents, ctx) ?? contents;
  const tools = input.tools.map(
    (tool) => trait?.convertTool?.(tool, ctx) ?? toolToGoogleGenAI(tool),
  );
  const params = assembleGoogleGenAIRequest(input, { contents: merged, tools, kwargs });
  const finalParams = trait?.buildParams?.(params, ctx) ?? params;
  return encodeGoogleGenAIRequest(finalParams);
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

interface GoogleGenAITransport {
  readonly connection: GoogleGenAIRequesterOptions['connection'];
  readonly ctx: TraitContext;
  readonly format: ReturnType<typeof createGoogleGenAIFormat>;
  readonly resolveClient: (request: LlmClientContext) => GenAIClient;
  readonly signal: AbortSignal;
  readonly onEvent?: (event: LlmRequestEvent) => void;
}

async function internalGenerate(
  request: GoogleGenAIRequestParams,
  transport: GoogleGenAITransport,
): Promise<void> {
  const { connection, ctx, format, resolveClient, signal, onEvent } = transport;
  const client = resolveClient({
    model: ctx.model,
    headers: mergeRequestHeaders(
      mergeRequestHeaders(connection?.defaultHeaders?.(ctx), ctx.model.defaultHeaders),
      request.headers,
    ),
  });
  onEvent?.({ type: 'llm.sent' });
  const models = client.models as unknown as {
    generateContentStream(
      params: GenerateContentParameters,
    ): Promise<AsyncIterable<Record<string, unknown>>>;
  };
  const stream = await Promise.race([
    models.generateContentStream(request.params),
    abortPromise(signal),
  ]);
  const parse = format.createStreamParser();
  let messageId: string | undefined;
  for await (const chunk of stream) {
    if (signal.aborted) {
      throw createAbortException();
    }
    let failed = false;
    parse(chunk, {
      onDelta: (part) => onEvent?.({ type: 'llm.streaming.part', part }),
      onFinish: (finish) => onEvent?.({ type: 'llm.streaming.finish', finish }),
      onMessageId: (id) => {
        if (id === messageId) return;
        messageId = id;
        onEvent?.({ type: 'llm.streaming.message_id', messageId: id });
      },
      onUsage: (usage) => onEvent?.({ type: 'llm.streaming.usage', usage }),
      onError: (message) => {
        failed = true;
        onEvent?.({ type: 'llm.failed.remote', error: message });
      },
    });
    if (failed) {
      return;
    }
  }
  onEvent?.({ type: 'llm.done' });
}

export function createGoogleGenAIRequester(options?: GoogleGenAIRequesterOptions): LlmRequester {
  const connection = options?.connection;
  const trait = options?.trait;
  const convertError = options?.convertError;
  const format = createGoogleGenAIFormat();
  const vertexai = options?.vertexai === true;
  const resolveClient =
    options?.clientFactory ??
    ((request: LlmClientContext) =>
      createClient(request.model, request.headers, vertexai || request.model.vertexai === true));
  return {
    async generate(
      config: LlmRequestConfig,
      content: LlmRequestContent,
      control: LlmRequestControl,
    ): Promise<void> {
      const model = resolveModelConnection(config.model, connection);
      const { tools = [] } = config;
      const { messages } = content;
      const { signal, onEvent } = control;
      const ctx: TraitContext = { model };
      let request: GoogleGenAIRequestParams;
      try {
        request = planGoogleGenAIRequest(
          {
            ...config,
            model,
            messages,
            tools,
            usedContextTokens: content.usedContextTokens,
          },
          { trait },
        );
      } catch (error) {
        onEvent?.({ type: 'llm.failed.syntax', error: toLlmSyntaxErrorMessage(error) });
        return;
      }
      try {
        await internalGenerate(request, {
          connection,
          ctx,
          format,
          resolveClient,
          signal,
          onEvent,
        });
      } catch (error) {
        onEvent?.({
          type: 'llm.failed.remote',
          error: convertGoogleGenAIError(error, (e) => convertError?.(e)),
        });
      }
    },
  };
}

export function createGoogleGenAIBase(
  options?: Pick<GoogleGenAIRequesterOptions, 'clientFactory' | 'vertexai'>,
): ProtocolBase<GoogleGenAITrait> {
  return {
    capability: getGoogleGenAIModelCapability,
    createRequester: (requesterOptions) =>
      createGoogleGenAIRequester({ ...options, ...requesterOptions }),
  };
}

export const googleGenAIBase: ProtocolBase<GoogleGenAITrait> = createGoogleGenAIBase();
