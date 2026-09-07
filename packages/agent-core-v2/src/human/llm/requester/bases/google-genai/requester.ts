import { GoogleGenAI as GenAIClient, type GenerateContentParameters } from '@google/genai';

import type { LlmModel } from '#/llm/model';
import { toLlmSyntaxErrorMessage } from '#/llm/syntax-errors';
import type { ProtocolBase, ProtocolWiring } from '#/llm/protocol/base';
import { resolveModelConnection } from '#/llm/protocol/connection';
import type { ProtocolHookContext } from '#/llm/protocol/context';
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
import { convertGoogleGenAIError, googleGenAIFormat, type GoogleGenAIRequestParams } from './format';

export interface GoogleGenAIBaseOptions extends LlmRequesterOptions<GenAIClient> {
  vertexai?: boolean;
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
  readonly wiring: ProtocolWiring | undefined;
  readonly ctx: ProtocolHookContext;
  readonly resolveClient: (request: LlmClientContext) => GenAIClient;
  readonly signal: AbortSignal;
  readonly onEvent?: (event: LlmRequestEvent) => void;
}

async function internalGenerate(
  request: GoogleGenAIRequestParams,
  transport: GoogleGenAITransport,
): Promise<void> {
  const { wiring, ctx, resolveClient, signal, onEvent } = transport;
  const client = resolveClient({
    model: ctx.model,
    headers: mergeRequestHeaders(
      mergeRequestHeaders(wiring?.connection?.defaultHeaders?.(ctx), ctx.model.defaultHeaders),
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
  const parse = googleGenAIFormat.createStreamParser({ dialect: wiring?.dialect, ctx });
  let messageId: string | undefined;
  for await (const chunk of stream) {
    if (signal.aborted) {
      throw createAbortException();
    }
    let failed = false;
    parse(chunk, {
      onDelta: (part) => onEvent?.({ type: 'llm.delta', part }),
      onFinish: (finish) => onEvent?.({ type: 'llm.finish', finish }),
      onMessageId: (id) => {
        if (id === messageId) return;
        messageId = id;
        onEvent?.({ type: 'llm.message-id', messageId: id });
      },
      onUsage: (usage) => onEvent?.({ type: 'llm.usage', usage }),
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

export function createGoogleGenAIRequester(
  wiring?: ProtocolWiring,
  options?: GoogleGenAIBaseOptions,
): LlmRequester {
  const vertexai = options?.vertexai === true;
  const resolveClient =
    options?.clientFactory ??
    ((request: LlmClientContext) => createClient(request.model, request.headers, vertexai));
  return {
    async generate(
      config: LlmRequestConfig,
      content: LlmRequestContent,
      control: LlmRequestControl,
    ): Promise<void> {
      const model = resolveModelConnection(config.model, wiring?.connection);
      const { systemPrompt, tools = [] } = config;
      const { messages } = content;
      const { signal, onEvent } = control;
      const ctx: ProtocolHookContext = { model };
      let request: GoogleGenAIRequestParams;
      try {
        request = googleGenAIFormat.formatRequest({
          model,
          messages,
          systemPrompt,
          tools,
          dialect: wiring?.dialect,
          policy: wiring?.policy,
          ctx,
          cacheKey: config.cacheKey,
          thinking: config.thinking,
          responseFormat: config.responseFormat,
          maxCompletionTokens: config.maxCompletionTokens,
          usedContextTokens: content.usedContextTokens,
          maxContextTokens: config.maxContextTokens,
          extraParams: config.extraParams,
        });
      } catch (error) {
        onEvent?.({ type: 'llm.failed.syntax', error: toLlmSyntaxErrorMessage(error) });
        return;
      }
      try {
        await internalGenerate(request, { wiring, ctx, resolveClient, signal, onEvent });
      } catch (error) {
        onEvent?.({
          type: 'llm.failed.remote',
          error: convertGoogleGenAIError(error, (e) => wiring?.connection?.convertError?.(e, ctx)),
        });
      }
    },
  };
}

export function createGoogleGenAIBase(options?: GoogleGenAIBaseOptions): ProtocolBase {
  return {
    capability: getGoogleGenAIModelCapability,
    createRequester: (wiring?: ProtocolWiring) => createGoogleGenAIRequester(wiring, options),
  };
}

export const googleGenAIBase: ProtocolBase = createGoogleGenAIBase();
