import OpenAI from 'openai';

import type { ResolvedEndpoint } from '#/llm/endpoint';
import { headersToRecord, requestIdFromHeader } from '#/llm/protocol/kit/http';
import { defineProtocol, type ToolMessageConversion } from '#/llm/protocol/protocol';

import { decodeError } from '../openai/decode';
import { getOpenAIResponsesModelCapability } from './capability';
import { createDecoder, replay, type RawChunk, type RawResponse } from './decode';
import type { OpenAIResponsesExtraParams } from './extra-params';
import {
  openAIResponsesPipeline,
  type NativeMessage,
  type NativeTool,
  type OpenAIResponsesParams,
  type Request,
} from './lower';

export type {
  RawChunk as OpenAIResponsesRawChunk,
  RawResponse as OpenAIResponsesRawResponse,
  RawUsage as OpenAIResponsesRawUsage,
} from './decode';
export { openAIResponsesModelLegality } from './legalize';
export {
  openAIResponsesPipeline,
  type Request as OpenAIResponsesRequest,
  type NativeMessage as OpenAIResponsesNativeMessage,
  type NativePart as OpenAIResponsesNativePart,
  type OpenAIResponsesParams,
} from './lower';

export interface OpenAIResponsesOptions {
  readonly extras?: OpenAIResponsesExtraParams;
  readonly toolMessageConversion?: ToolMessageConversion;
}

function createClient(endpoint: ResolvedEndpoint): OpenAI {
  return new OpenAI({
    apiKey: endpoint.apiKey ?? 'unused',
    baseURL: endpoint.baseUrl,
    defaultHeaders: endpoint.headers,
    maxRetries: 0,
    fetch: endpoint.fetch,
  });
}

export const openAIResponsesProtocol = defineProtocol<
  OpenAIResponsesOptions,
  NativeMessage,
  NativeTool,
  OpenAIResponsesParams,
  Request,
  RawResponse,
  RawChunk,
  OpenAI
>({
  ...openAIResponsesPipeline,
  capability: getOpenAIResponsesModelCapability,
  client: createClient,
  send: async (client: OpenAI, request, signal) => {
    const { data, response } = await client.responses
      .create({ ...request.params, stream: false }, { signal })
      .withResponse();
    return {
      body: data as unknown as RawResponse,
      headers: headersToRecord(response.headers) ?? {},
    };
  },
  sendStream: async (client: OpenAI, request, signal) => {
    const { data, response } = await client.responses
      .create({ ...request.params, stream: true }, { signal })
      .withResponse();
    return { body: data as AsyncIterable<RawChunk>, headers: headersToRecord(response.headers) ?? {} };
  },
  decoder: (_module, sink) => createDecoder(sink),
  replay: (response: RawResponse) => replay(response),
  requestId: requestIdFromHeader('x-request-id'),
  decodeError,
});
