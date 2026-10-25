import { GoogleGenAI as GenAIClient, type GenerateContentParameters } from '@google/genai';

import type { ResolvedEndpoint } from '#/llm/endpoint';
import { defineProtocol } from '#/llm/protocol/protocol';

import { getGoogleGenAIModelCapability } from './capability';
import { createDecoder, decodeError, replay } from './decode';
import type { GoogleGenAIExtraParams } from './extra-params';
import { googleGenAIPipeline, type Request } from './lower';

export type {
  GoogleGenAIParams,
  Request as GoogleGenAIRequest,
  NativeMessage as GoogleGenAINativeMessage,
  NativePart as GoogleGenAINativePart,
} from './lower';

export interface GoogleGenAIOptions {
  readonly vertexai?: boolean;
  readonly extras?: GoogleGenAIExtraParams;
}

function createClient(
  endpoint: ResolvedEndpoint,
  options: GoogleGenAIOptions | undefined,
): GenAIClient {
  const httpOptions: { headers?: Record<string, string>; baseUrl?: string } = {};
  if (endpoint.headers !== undefined) {
    httpOptions.headers = endpoint.headers;
  }
  if (endpoint.baseUrl !== undefined) {
    httpOptions.baseUrl = endpoint.baseUrl;
  }
  return new GenAIClient({
    apiKey: endpoint.apiKey,
    vertexai: options?.vertexai === true ? true : undefined,
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

interface GenAIModels {
  generateContent(params: GenerateContentParameters): Promise<Record<string, unknown>>;
  generateContentStream(
    params: GenerateContentParameters,
  ): Promise<AsyncIterable<Record<string, unknown>>>;
}

function modelsOf(client: GenAIClient): GenAIModels {
  return client.models as unknown as GenAIModels;
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

export const googleGenAIProtocol = defineProtocol({
  ...googleGenAIPipeline,
  capability: getGoogleGenAIModelCapability,
  usesEndpointFetch: false,
  client: createClient,
  send: async (client: GenAIClient, request: Request, signal) => {
    const response = await Promise.race([
      modelsOf(client).generateContent(request.params),
      abortPromise(signal),
    ]);
    return { body: response as unknown };
  },
  sendStream: async (client: GenAIClient, request: Request, signal) => {
    const stream = await Promise.race([
      modelsOf(client).generateContentStream(request.params),
      abortPromise(signal),
    ]);
    return { body: abortableStream(stream, signal) as AsyncIterable<unknown> };
  },
  decoder: (_module, sink) => createDecoder(sink),
  replay: (response: unknown) => replay(response),
  decodeError,
});
