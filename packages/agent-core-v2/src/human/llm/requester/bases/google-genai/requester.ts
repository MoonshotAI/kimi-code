import { GoogleGenAI as GenAIClient, type GenerateContentParameters } from '@google/genai';

import type { LlmModel } from '#/llm/model';
import { toLlmSyntaxErrorMessage } from '#/llm/syntax-errors';
import type { ProtocolBase, ProtocolRequesterOptions } from '#/llm/protocol/base';
import { resolveModelConnection } from '#/llm/protocol/connection';
import type { DialectContext } from '#/llm/protocol/dialect';
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
import type { GoogleGenAIDialect } from './dialect';
import {
  convertGoogleGenAIError,
  createGoogleGenAIFormat,
  type GoogleGenAIRequestParams,
} from './format';

export interface GoogleGenAIRequesterOptions
  extends ProtocolRequesterOptions<GoogleGenAIDialect>,
    LlmRequesterOptions<GenAIClient> {
  readonly vertexai?: boolean;
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
  readonly ctx: DialectContext;
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
  const dialect = options?.dialect;
  const convertError = options?.convertError;
  const format = createGoogleGenAIFormat(dialect);
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
      const { systemPrompt, tools = [] } = config;
      const { messages } = content;
      const { signal, onEvent } = control;
      const ctx: DialectContext = { model };
      let request: GoogleGenAIRequestParams;
      try {
        request = format.formatRequest({
          model,
          messages,
          systemPrompt,
          tools,
          cacheKey: config.cacheKey,
          thinking: config.thinking,
          responseFormat: config.responseFormat,
          maxCompletionTokens: config.maxCompletionTokens,
          usedContextTokens: content.usedContextTokens,
          maxContextTokens: config.maxContextTokens,
          extraParams: config.extraParams,
          toolMessageConversion: config.toolMessageConversion,
        });
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
): ProtocolBase<GoogleGenAIDialect> {
  return {
    capability: getGoogleGenAIModelCapability,
    createRequester: (requesterOptions) =>
      createGoogleGenAIRequester({ ...options, ...requesterOptions }),
  };
}

export const googleGenAIBase: ProtocolBase<GoogleGenAIDialect> = createGoogleGenAIBase();
